#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch tracker additions into the applications
 * table of data/career-ops.db (core/db.mjs)
 *
 * Handles multiple TSV formats:
 * - Headed (preferred): a first row of column LABELS, then one data row. Column
 *   order is then irrelevant — fields resolve by name through the same alias
 *   table as the tracker itself (#3517).
 * - 9-col headerless: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes
 * - 8-col headerless: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport (no notes)
 * - Pipe-delimited (markdown table row): | col | col | ... |
 *
 * Dedup: company normalized + role fuzzy match + report number match
 * If duplicate with higher score → update in-place, update report link
 * Validates status against states.yml (rejects non-canonical, logs warning)
 *
 * Run: node merge-tracker.mjs [--dry-run] [--verify]
 */

import { readFileSync, readdirSync, mkdirSync, renameSync, existsSync, statSync } from 'fs';
import { join, basename, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { normalizeReportLink as normalizeLink } from './tracker-links.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { TSV_REQUIRED_FIELDS, resolveScoreStatus, looksLikeTsvHeaderRow, resolveTsvColumns, looksLikeScoreCell, normalizeVia, normalizeTextKey, extractReqNumber } from './tracker-parse.mjs';
// Corporate-form vocabulary, shared with invite-match.mjs rather than copied,
// for the same reason normalizeCompany lives in tracker-utils: a second private
// list is how company identity drifts between scripts (#2445, #3665).
import { LEGAL_SUFFIXES, GENERIC_DESCRIPTORS } from './invite-match.mjs';
import { trackerLockDirFor, acquireTrackerLock, normalizeCompany, cell, loadCanonicalStates, findDeadReportLink } from './tracker-utils.mjs';
import * as db from './core/db.mjs';
// Canonical posting-URL key. Kept in its own module so scan.mjs / scan-history
// can adopt the same key later without the definitions drifting.
import { normalizeUrl, isAggregatorUrl, aggregatorPostingId } from './url-key.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const MERGE_TRACKER_USAGE = `Usage: node merge-tracker.mjs [options]

Options:
  --dry-run        Preview the merge without writing files
  --verify         Run pipeline verification after a successful merge
  --migrate        Rewrite legacy report links relative to the tracker
  --migrate-via    Add the Via column to a legacy tracker
  --backfill-urls  Add the URL column and populate it from report metadata
  -h, --help       Show this help and exit`;
// The flags below are read with process.argv.includes(), so a flag this script
// does not know was dropped without a word: `--dryrun` ran the real merge,
// rewrote applications.md and moved the TSVs into merged/ -- the one outcome
// --dry-run exists to prevent. Reject it before anything is read or written.
const MERGE_TRACKER_KNOWN_FLAGS = ['--dry-run', '--verify', '--migrate', '--migrate-via', '--backfill-urls', '--help', '-h'];
validateFlags(process.argv.slice(2), MERGE_TRACKER_KNOWN_FLAGS, MERGE_TRACKER_USAGE);

// Executable hooks live beside this script even when user data is redirected
// through CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR / .career-ops-data.
const CAREER_OPS_CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
// The applications table lives in data/career-ops.db (CAREER_OPS_DB overrides;
// resolution lives in core/db.mjs so every tracker writer agrees).
const DB_FILE = db.resolveDbPath();
// Report links are stored relative to the data/ directory (the old tracker's
// home), so link normalization and dead-link checks keep resolving from there.
const TRACKER_DIR = dirname(DB_FILE);
// CAREER_OPS_ADDITIONS overrides the additions dir (used by tests, mirrors CAREER_OPS_TRACKER).
const ADDITIONS_DIR = process.env.CAREER_OPS_ADDITIONS
  ? process.env.CAREER_OPS_ADDITIONS
  : join(DATA_ROOT, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
// CAREER_OPS_BATCH_STATE overrides the batch-state.tsv path (used by tests).
const BATCH_STATE_FILE = process.env.CAREER_OPS_BATCH_STATE
  ? process.env.CAREER_OPS_BATCH_STATE
  : join(DATA_ROOT, 'batch/batch-state.tsv');

// Cross-check against batch-state.tsv (found 2026-07-30): a worker can write
// a well-formed tracker TSV even when its own JSON result said "failed" --
// e.g. two workers that fabricated a placeholder score (0.0/5, "Suspicious")
// for a posting they never actually read, after being unable to extract the
// JD. batch-runner.sh's JSON-status detection is the authority on whether an
// offer really succeeded; a TSV whose report number maps to a "failed" row
// there is fabricated evidence, not just cosmetically ambiguous like the
// score/status column-swap check below -- it must never merge, however
// well-formed the TSV itself looks in isolation.
function reportNumbersWithStatus(path, wanted) {
  const nums = new Set();
  if (!existsSync(path)) return nums;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('id\t')) continue;
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const status = cols[2];
    const reportNum = cols[5];
    if (status === wanted && reportNum && reportNum !== '-') {
      // Digits only, positive, safe: parseInt would accept "12abc" and
      // 9007199254740992, and an unsafe number in the occupied set makes
      // reserveReportNumbers throw "No safe report-number range remains".
      const n = /^\d+$/.test(reportNum) ? Number(reportNum) : NaN;
      if (Number.isSafeInteger(n) && n > 0) nums.add(n);
    }
  }
  return nums;
}
function loadFailedReportNumbers(path) {
  return reportNumbersWithStatus(path, 'failed');
}
const FAILED_REPORT_NUMBERS = loadFailedReportNumbers(BATCH_STATE_FILE);
// Read only to explain a skip, never to lift one. Before #4391, a failed
// worker's released number could be handed to the next offer, so one number
// carries both a "failed" and a "completed" row. The guard still has to hold
// there (the failed worker may have written a TSV under that number too), but
// the warning can say what the user is most likely looking at (#4505).
const COMPLETED_REPORT_NUMBERS = reportNumbersWithStatus(BATCH_STATE_FILE, 'completed');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const MIGRATE = process.argv.includes('--migrate');
const MIGRATE_VIA = process.argv.includes('--migrate-via');
const BACKFILL_URLS = process.argv.includes('--backfill-urls');
const MERGE_HOLD_MS = Number(process.env.CAREER_OPS_MERGE_HOLD_MS) || 0;
const MERGE_READY_IPC = process.env.CAREER_OPS_MERGE_READY_IPC === '1';

const TRACKER_LOCK_DIR = trackerLockDirFor(DB_FILE);

// The reports/ dir sits at the workspace root (the data/ directory's parent).
const REPORTS_ROOT = DATA_ROOT;

/**
 * Normalize report links before writing them into the applications table.
 *
 * TSV additions use root-relative report links so they are easy for agents to
 * generate. Stored links stay relative to the data/ directory (the database's
 * home), so this wrapper binds the data and reports directories before
 * delegating to the shared link normalizer.
 *
 * @param {string} reportField - Raw report cell from a TSV addition.
 * @returns {string} Markdown report link relative to the data/ directory.
 */
const normalizeReportLink = (reportField) => normalizeLink(reportField, TRACKER_DIR, REPORTS_ROOT);

// Ensure required directories exist (fresh setup)
mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

/**
 * Pause the async merge flow for a fixed number of milliseconds.
 *
 * Used by the regression test hook (`CAREER_OPS_MERGE_HOLD_MS`), which
 * deliberately holds the first merge after it reads `applications.md` so a
 * second merge can try to enter the same critical section. (The lock retry
 * loop's own sleep lives in tracker-utils.mjs with the lock.)
 *
 * @param {number} ms - Milliseconds to wait before resolving.
 * @returns {Promise<void>} Resolves after the requested delay.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let trackerLock;
try {
  trackerLock = await acquireTrackerLock(TRACKER_LOCK_DIR, {
    timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
    retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
    staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
    tracker: DB_FILE,
  });
  process.once('exit', () => trackerLock?.release());
  if (trackerLock.waitMs > 0 || trackerLock.staleRecovered) {
    console.log(`🔒 Tracker merge lock acquired (wait_ms=${trackerLock.waitMs} | attempts=${trackerLock.attempts} | stale_recovered=${trackerLock.staleRecovered})`);
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

// Canonical states — loaded from templates/states.yml, the single source of truth.
// Adding a state or alias there is all that is needed; no code change required here.
const _CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const _STATES_FILE = existsSync(join(_CODE_ROOT, 'templates/states.yml'))
  ? join(_CODE_ROOT, 'templates/states.yml')
  : join(_CODE_ROOT, 'states.yml');
// A missing or unreadable states file is a broken install, not a reason to abort
// the merge on a raw ENOENT. Say so once, then merge each status as written:
// validateStatus() only rewrites to "Evaluated" when it has states to check.
let _canonicalStates = [];
try {
  _canonicalStates = loadCanonicalStates(_STATES_FILE);
} catch (err) {
  console.warn(`⚠️  Cannot read canonical states (${err.message}): statuses are merged as written. Restore templates/states.yml, then run node normalize-statuses.mjs`);
}
const _aliasMap = Object.fromEntries(
  _canonicalStates.flatMap(s => s.aliases.map(a => [a.toLowerCase(), s.label]))
);

/**
 * Convert raw addition status text into one canonical tracker state.
 *
 * Batch workers and older tracker additions may emit Spanish labels, bold
 * Markdown, legacy date suffixes, or repost markers. The merge script normalizes
 * all of those variants here so applications.md keeps the states defined by
 * templates/states.yml.
 *
 * @param {string} status - Raw status string from a TSV or pipe-delimited row.
 * @returns {string} Canonical tracker status.
 */
function validateStatus(status) {
  const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  // Label match (case-insensitive)
  for (const s of _canonicalStates) {
    if (s.label.toLowerCase() === lower) return s.label;
  }

  // Alias match
  if (_aliasMap[lower]) return _aliasMap[lower];

  // DUPLICADO/Repost → Discarded
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

  // No states loaded (see above): keep the row's own status rather than record
  // an "Evaluated" it never claimed.
  if (!_canonicalStates.length && clean) return clean;

  console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}

// normalizeVia (Unicode-aware Via/agency key, #1596/#1603) lives in
// tracker-parse.mjs so merge-tracker and analyze-patterns share ONE normalizer
// and agency identity can't drift between scripts. (normalizeCompany lives in
// tracker-utils.mjs since #1460 so every tracker writer shares one company key.)

/**
 * Extract the bracketed report number from a Markdown report link.
 *
 * Report-number equality is an exact duplicate signal, but only after company
 * equality is confirmed by the caller. This helper reads links such as
 * `[123](../reports/123-company-role-date.md)` and returns the numeric id.
 *
 * Rows migrated from legacy layouts without a dedicated Report column embed
 * the link in Notes prose instead, so the Notes cell is scanned as a fallback
 * — scoped to links that point into reports/ so a job-posting URL in the same
 * prose can't match.
 *
 * @param {string} reportStr - Raw report cell from applications.md or TSV input.
 * @param {string} [notesStr] - Notes cell, scanned when the report cell has none.
 * @returns {number|null} Parsed report number, or null when absent.
 */
function extractReportNum(reportStr, notesStr = '') {
  const m = String(reportStr ?? '').match(/\[(\d+)\]/);
  if (m) return parseInt(m[1]);
  const n = String(notesStr ?? '').match(/\[(\d+)\]\([^)]*reports\/[^)]+\)/);
  return n ? parseInt(n[1]) : null;
}

/**
 * Derive a posting URL from a row's linked report (`**URL:**` header).
 *
 * ONE derivation shared by the merge loop and --backfill-urls. The key has to be
 * written on the way IN, not only by a migration: the documented TSV is nine
 * columns with the URL optional, so a row added through the normal batch flow
 * carries no URL of its own and Pass 0 would have nothing to match until a human
 * remembered to run the backfill. A dedup key that only exists after a manual
 * step is a dedup key that is usually absent.
 *
 * @param {string} reportField - Report cell, e.g. `[42](reports/042-acme.md)`.
 * @returns {{url: string, reason: 'ok'|'no-report'|'no-url'}} The URL plus why
 *   it is empty, so the backfill can report the two cases separately.
 */
/**
 * Resolve a report cell to the absolute path of the report file it links to,
 * or null when the link is missing, escapes REPORTS_ROOT, or the file doesn't
 * exist. Factored out of resolveReportUrl() so the merge loop's dedup tiers
 * can compare two report cells for literal same-file identity (#4506)
 * without also needing to read and parse the file's `**URL:**` header.
 *
 * @param {string} reportField - Report cell, e.g. `[42](reports/042-acme.md)`.
 * @returns {string|null} The resolved absolute path, or null.
 */
function resolveReportPath(reportField) {
  const linkMatch = (reportField || '').match(/\]\(([^)]+)\)/);
  if (!linkMatch) return null;
  // Containment, not cosmetics: resolve and assert the path stays under
  // REPORTS_ROOT. Stripping leading `../` alone still let an embedded
  // `reports/../../..` walk out of the tree, and the tracker is user-editable.
  const reportPath = resolve(REPORTS_ROOT, linkMatch[1].trim().replace(/^(\.\.\/)+/, ''));
  if (!reportPath.startsWith(REPORTS_ROOT + sep)) return null;
  // existsSync alone accepts a directory, which would let the new Pass 0.5
  // dedup tier treat two additions whose report link happens to resolve to
  // the same directory as report-identical without ever reading a file.
  if (!existsSync(reportPath) || !statSync(reportPath).isFile()) return null;
  return reportPath;
}

function resolveReportUrl(reportField) {
  const reportPath = resolveReportPath(reportField);
  if (!reportPath) return { url: '', reason: 'no-report' };
  // [ \t]* NOT \s*: \s matches newlines, so an empty `**URL:**` header swallowed
  // the line break and captured the NEXT header's text. Every such report then
  // minted the same bogus key (`**Legitimacy:**`), and the backfill counted it
  // as a successful fill. `\S+` cannot cross a newline, so an empty header now
  // just fails to match at that position instead of reaching into the next line.
  //
  // Deliberately NOT anchored to line start. AGENTS.md requires `**URL:**` "in
  // the header (between Score and PDF)" — that is, INLINE:
  //   **Score:** 4.1/5 | **URL:** https://… | **Legitimacy:** High | **PDF:** …
  // which a `^`-anchored pattern cannot see. Every report written in the
  // documented format reported "no **URL:** header" and silently fell back to
  // fuzzy company+role dedup — the exact matching that let a new Google req
  // overwrite a different, concurrently-live one. Checked against all 399
  // reports: 376 match both ways and agree on the URL 376/376, so dropping the
  // anchor cannot change a URL that already resolved.
  const m = readFileSync(reportPath, 'utf-8').match(/\*\*URL:\*\*[ \t]*(\S+)/);
  if (!m) return { url: '', reason: 'no-url' };
  // Strip a markdown autolink wrapper and trailing punctuation, then require a
  // real http(s) URL. `**URL:** N/A` is legitimate for recruiter-sourced roles,
  // and normalizeUrl deliberately yields no key for it — writing the placeholder
  // into the column would hand every such row the same key.
  const raw = m[1].replace(/^<|>$/g, '').replace(/[),.;]+$/, '');
  return normalizeUrl(raw) ? { url: raw, reason: 'ok' } : { url: '', reason: 'no-url' };
}

/**
 * Company equality for duplicate detection.
 *
 * normalizeCompany() strips everything outside [a-z0-9], so a company name
 * written entirely in a non-Latin script (CJK, Cyrillic, Arabic, …) normalizes
 * to the empty string — and every such name would compare equal to every other
 * one. That collapses DIFFERENT companies into one row as soon as their roles
 * fuzzy-match (six Japanese companies posting データエンジニア → one row).
 * When the normalized key carries no signal, fall back to raw trimmed
 * equality so distinct non-Latin companies stay distinct; the unknown-employer
 * `?` marker still matches itself, so the #1596 cross-channel guard keeps its
 * existing behavior.
 *
 * @param {string} a - Company cell from one side of the comparison.
 * @param {string} b - Company cell from the other side.
 * @returns {boolean} True when the two cells name the same company.
 */
function companiesMatch(a, b) {
  const key = normalizeCompany(String(a));
  if (key !== normalizeCompany(String(b))) return false;
  return key !== '' || String(a).trim() === String(b).trim();
}

// Words that name a legal form or a generic business descriptor rather than the
// employer. Both lists come from invite-match.mjs; the union is safe here in a
// way chaining them there is not, because the prefix rule below never lets two
// names disagree on a substantive token.
const CORPORATE_FORM_WORDS = new Set([...LEGAL_SUFFIXES, ...GENERIC_DESCRIPTORS]);

// A one-token stem carries almost no identity, and a two-letter one is usually
// an initialism that several unrelated employers share. Refusing them costs the
// duplicate row that exists today; accepting them risks deleting a real one.
const MIN_STEM_CHARS = 3;

/**
 * True when two company cells are the same employer written with a different
 * corporate suffix ("Acme" vs "Acme Technologies Inc.").
 *
 * normalizeCompany() folds case, punctuation and width but not corporate
 * forms, so a suffix variant of one employer never reaches the fuzzy
 * company+role tier and the same opening is written twice (#3665). This is the
 * narrow second tier that closes that, used ONLY where the role title already
 * fuzzy-matches and neither a req-number nor an employer-board URL has proved
 * the rows distinct. The exact tier above is untouched.
 *
 * The rule is a token PREFIX plus a corporate-form tail, not a stripped key.
 * Stripping suffixes before comparing looks equivalent and is not: it maps
 * "Acme Solutions" and "Acme Technologies" to the same "acme", which folds two
 * genuinely different employers and deletes one row. Requiring the shorter name
 * to be a prefix of the longer makes that structurally impossible, since
 * neither of those is a prefix of the other. It also means an extra token that
 * is NOT a corporate form ("Acme Robotics") still reads as a different
 * employer, which is the conservative direction: over-merging is unrecoverable
 * here (dedup-tracker.mjs drops the losing line, and applications.md is
 * gitignored with no backup), while under-merging leaves a duplicate row the
 * user can already see.
 *
 * Tokens come from normalizeTextKey(name, ' ') so this shares the Unicode,
 * NFKC and Turkish dotted-I handling every other identity key uses (#2445,
 * #2736) instead of a private strip. Scripts written without spaces produce a
 * single token and never match here, so CJK corporate forms are unaffected and
 * remain #2570's subject.
 *
 * @param {string} a - Company cell from one side of the comparison.
 * @param {string} b - Company cell from the other side.
 * @returns {boolean} True when the two cells name the same employer under a
 *   different corporate form.
 */
function companiesMatchIgnoringCorporateForm(a, b) {
  const ta = normalizeTextKey(a, ' ').split(' ').filter(Boolean);
  const tb = normalizeTextKey(b, ' ').split(' ').filter(Boolean);
  const [stem, full] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // Equal lengths are either the exact tier's business or a genuine
  // disagreement on a substantive token. An empty stem is the blind-employer
  // `?` marker and every other punctuation-only cell, which must never match a
  // named employer.
  if (stem.length === 0 || stem.length === full.length) return false;
  if (stem.join('').length < MIN_STEM_CHARS) return false;
  if (stem.some((token, i) => token !== full[i])) return false;
  return full.slice(stem.length).every(token => CORPORATE_FORM_WORDS.has(token));
}

/**
 * Combine an existing row's Notes with a re-evaluation's Notes.
 *
 * The update path used to overwrite Notes with
 * `Re-eval {date} ({old}→{new}). {new notes}`, discarding the existing cell
 * outright (#2392 gap 2). The Notes column is not decoration: it carries the
 * `Applied YYYY-MM-DD` marker that followup-cadence.mjs prefers over the Date
 * column (dropping it silently resets the follow-up clock to the evaluation
 * date), the req/job number that this script's OWN sibling-req guard reads back
 * via extractReqNumber(), contact addresses, and whatever the user wrote with
 * `set-status --note`. None of it is recoverable: applications.md is gitignored
 * and no .bak is written.
 *
 * Format: the existing notes are kept verbatim and FIRST, with the re-eval
 * marker and any new notes appended after them. Order is deliberate, not
 * cosmetic — parseAppliedDate() and extractReqNumber() both return their FIRST
 * match, so leading with the established text keeps a row's apply date and req
 * number stable across re-evaluations instead of letting each new evaluation's
 * text take over. The cost is that Notes grows by one clause per re-evaluation.
 *
 * @param {string} existingNotes - Notes cell currently on the tracker row.
 * @param {object} addition - Parsed TSV addition (uses `notes` and `date`).
 * @param {number} oldScore - Score currently on the row.
 * @param {number} newScore - Score from the addition.
 * @param {string} [extraMarker] - Appended to the re-eval marker, before any
 *   incoming notes. Used by the downgrade path to record the superseded report
 *   (#2411). It rides on the marker rather than on `addition.notes` so that the
 *   repeat detection below keeps comparing the user's own text against the
 *   user's own text — a generated fragment in that comparison would make every
 *   downgrade look like a new note and defeat it.
 * @returns {string} Combined Notes cell.
 */
function mergeNotes(existingNotes, addition, oldScore, newScore, extraMarker = '') {
  // Trailing period trimmed only so the '. ' join does not produce '..'; no
  // other character of the existing text is touched. The tracker's "no data"
  // sentinels (the looksLikeScoreCell set minus the score-only DUP) count as
  // empty here: a placeholder cell collapses to the marker instead of gaining
  // a `—. ` separator the row never had (#2483).
  const prevRaw = String(existingNotes ?? '').trim();
  const prev = ['—', '-', 'N/A'].includes(prevRaw)
    ? ''
    : prevRaw.replace(/\s*\.\s*$/, '');
  const incoming = String(addition.notes ?? '').trim();
  const marker = extraMarker
    ? `Re-eval ${addition.date} (${oldScore}→${newScore}) — ${extraMarker}`
    : `Re-eval ${addition.date} (${oldScore}→${newScore})`;
  // Re-running the same evaluation would otherwise repeat its own text; the
  // marker still records that the re-evaluation happened. Repeats are detected
  // per CLAUSE — the same '. ' separator this function joins with — not by raw
  // substring: `prev.includes(incoming)` dropped any new note that happened to
  // appear INSIDE an existing clause ("Remote" vanished against "Remote OK").
  // A clause equals the incoming text either bare or in the marker-prefixed
  // form a previous run of this function appended (`{marker}: {incoming}`).
  const clause = (s) => s.replace(/\.+$/, '').trim();
  const incomingClause = clause(incoming);
  const isRepeat = incoming !== '' && prev.split(/\.\s+/).map(clause)
    .some(c => c === incomingClause || c.endsWith(`: ${incomingClause}`));
  const tail = incoming && !isRepeat ? `${marker}: ${incoming}` : marker;
  return prev ? `${prev}. ${tail}` : tail;
}

/**
 * Parse a score cell into a numeric value for score-upgrade decisions.
 *
 * The merge path compares old and new scores to decide whether to update an
 * existing duplicate row. Markdown bolding and `/5` suffixes are presentation
 * details, so only the first numeric value is used.
 *
 * @param {string} s - Raw score cell such as `4.2/5`.
 * @returns {number} Parsed score, or 0 when no numeric value is present.
 */
function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * True when a Score cell is a documented "no score" sentinel rather than a
 * number. AGENTS.md names `N/A`, `—` and `-` as the values a row carries when it
 * was added without an evaluation, or when a re-eval could not be scored (#1799).
 *
 * parseScore() maps all of these to 0, so the merge path cannot tell them apart
 * from a genuine zero on its own — callers that must not treat "no score" as
 * "scored zero" ask here first (#2803).
 *
 * @param {string} s - Raw score cell.
 * @returns {boolean}
 */
function isUnscoreable(s) {
  return ['—', '-', 'N/A'].includes(String(s).replace(/\*\*/g, '').trim());
}

/**
 * Load the generated-PDF manifest from the pdf_index table.
 *
 * Only report PDFs count here (kind != 'cover'): the row's PDF flag describes
 * the tailored report PDF, never a cover letter.
 *
 * @returns {Map<string,string>} Normalized report# → PDF path.
 */
function loadPdfIndex() {
  const map = new Map();
  for (const entry of db.listPdfIndex()) {
    if (entry.kind === 'cover' || !entry.pdf) continue;
    map.set(entry.report_norm, entry.pdf);
  }
  return map;
}

/**
 * Flip stale PDF flags to ✅ when the generated-PDF manifest has the row's
 * report number.
 *
 * @param {Array<object>} existingApps - Application rows (mutated in place).
 * @param {Map<string,string>} pdfIndex - Normalized report# → PDF path.
 * @returns {number} Number of tracker rows updated.
 */
function syncPdfFlags(existingApps, pdfIndex) {
  let changed = 0;
  if (pdfIndex.size === 0) return changed;

  for (const app of existingApps) {
    const reportNum = extractReportNum(app.report, app.notes);
    if (!reportNum || !pdfIndex.has(String(reportNum)) || app.pdf !== '❌') continue;

    console.log(`${DRY_RUN ? '🔄 PDF sync (dry-run)' : '🔄 PDF sync'}: #${app.num} ${app.company} — report ${reportNum} now has a generated PDF`);
    if (!DRY_RUN) {
      db.updateApplication(app.num, { pdf: '✅' });
      app.pdf = '✅';
    }
    changed++;
  }

  return changed;
}

// A trailing field a generator emits for a value it does not have. By shape
// these are not the thing the column is for, and an absent value must read as
// absent rather than as some other column's content — a "N/A" url landing in
// the untagged bucket would be recorded as the row's LOCATION.
const PLACEHOLDER_CELL = /^(n\/?a|tbd|none|null|-|—|–)$/i;

/**
 * Split one addition row into cells. Tab-delimited by default; pipe-delimited
 * (a pasted markdown table row) when the line starts with `|`, in which case the
 * empty cells either side of the outer pipes are dropped.
 *
 * @param {string} line - One line of an addition file.
 * @returns {string[]} Trimmed cells.
 */
function splitAdditionCells(line) {
  if (line.startsWith('|')) {
    const parts = line.split('|').map(s => s.trim());
    if (parts[0] === '') parts.shift();
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  }
  return line.split('\t').map(s => s.trim());
}

/**
 * Resolve the optional trailing TSV fields (index ≥ 9) into { via, location }.
 *
 * Via travels as a TAGGED field (`via=Hays`) rather than another positional
 * slot: TSV writers are LLM agents following prompt instructions, and a writer
 * that skips an empty padding field would silently shift a positional Via into
 * the Location slot (#1596). A single untagged extra remains the legacy
 * positional location (stale prompts stay valid forever). Anything ambiguous —
 * two untagged extras, duplicate via= tags — returns null so the row is
 * rejected loudly instead of merged with scrambled columns.
 *
 * @param {string[]} parts - All fields of the TSV/pipe row.
 * @param {string} filename - Source filename used in warning messages.
 * @returns {{via: string, location: string}|null}
 */
function parseTsvExtras(parts, filename) {
  // Drop placeholders outright. A generator emitting the documented trailing
  // `url` field for a posting that has none writes "N/A"/"TBD"/"—", and by shape
  // that is not a URL — it would fall into the untagged bucket and be recorded
  // as the row's LOCATION. An absent value must read as absent, not as some
  // other column's content.
  const extras = parts.slice(9)
    .map(s => String(s).trim())
    .filter(s => s !== '' && !PLACEHOLDER_CELL.test(s));
  const viaTags = extras.filter(s => /^via=/i.test(s));
  // Classify trailing fields by SHAPE, not position. A URL is
  // unambiguous (starts with http(s)://), so the posting URL and an older
  // location cell are order-independent and a row carrying both is not read as
  // two ambiguous locations. Location-only rows keep working untouched.
  const urls = extras.filter(s => !/^via=/i.test(s) && /^https?:\/\//i.test(s));
  const untagged = extras.filter(s => !/^via=/i.test(s) && !/^https?:\/\//i.test(s));
  if (viaTags.length > 1 || untagged.length > 1 || urls.length > 1) {
    console.warn(`⚠️  Skipping ${filename}: ambiguous extra fields [${extras.join(', ')}] — expected at most one "via=Firm" tag, one location and one URL`);
    return null;
  }
  return {
    via: viaTags.length ? viaTags[0].replace(/^via=/i, '').trim() : '',
    location: untagged[0] || '',
    url: urls[0] || '',
  };
}

/**
 * Parse an addition's tracker number, rejecting anything that is not a whole
 * positive integer.
 *
 * `parseInt` is the wrong tool: it stops at the first character that cannot
 * continue a number, so `17oops` and `17.5` both become 17 and the row merges
 * under a tracker number the file never claimed. The guards downstream cannot
 * see it — by then the damage is a perfectly valid-looking number.
 *
 * Leading zeros are DELIBERATELY allowed, and this is the reason the obvious
 * `/^[1-9]\d*$/` would be wrong here: `reserve-report-num.mjs` returns a
 * zero-padded 3-digit string (`padStart(3, '0')`), and both the batch prompt
 * and `web/src/lib/run-prompts.mjs` hand that value straight to the `num` cell.
 * So `035` is the canonical shape of every report under 100, not a malformed
 * row, and rejecting it would drop those evaluations on the floor.
 *
 * @param {string} text - Raw cell contents.
 * @returns {number|null} The tracker number, or null when the cell is not one.
 */
function parseTrackerNum(text) {
  const t = String(text ?? '').trim();
  if (!/^0*[1-9]\d*$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a HEADED addition: a row of column labels followed by exactly one data
 * row. Fields resolve by NAME, so no column order is privileged and the
 * score/status pair needs no content sniffing.
 *
 * This is the form that has no undecidable case. `resolveScoreStatus` cannot
 * order a discarded, never-scored row (`—` is both a score sentinel and a
 * status meaning Discarded), so the headerless path refuses it; a header row
 * answers it outright (#3517).
 *
 * @param {string[]} lines - Non-empty lines of the addition file.
 * @param {string} filename - Source filename used in warning messages.
 * @returns {object|null} Parsed tracker addition, or null when malformed.
 */
function parseHeadedAddition(lines, filename) {
  const { map, missing, duplicates, unknown } = resolveTsvColumns(splitAdditionCells(lines[0]));
  if (duplicates.length) {
    console.warn(`⚠️  Skipping ${filename}: header labels the same column twice (${[...new Set(duplicates)].join(', ')}) — refusing to guess which one carries the value`);
    return null;
  }
  if (missing.length) {
    console.warn(`⚠️  Skipping ${filename}: header is missing required column(s): ${missing.join(', ')}`);
    return null;
  }
  if (unknown.length) {
    // Not fatal: an unrecognized label is a column this version has no meaning
    // for, and dropping it loses nothing the tracker could store anyway. Say so
    // rather than swallowing it, since the usual cause is a typo'd label.
    console.warn(`⚠️  ${filename}: ignoring unrecognized header column(s): ${unknown.join(', ')}`);
  }

  const dataLines = lines.slice(1);
  if (dataLines.length === 0) {
    console.warn(`⚠️  Skipping ${filename}: header row with no data row`);
    return null;
  }
  if (dataLines.length > 1) {
    // One addition per file is the contract every caller assumes (the merge
    // loop takes one addition per TSV). Rejecting is louder than merging the
    // first row and dropping the rest, which would lose evaluations silently.
    console.warn(`⚠️  Skipping ${filename}: ${dataLines.length} data rows — one addition per file`);
    return null;
  }

  const parts = splitAdditionCells(dataLines[0]);
  // Only the REQUIRED cells must actually be there. A row whose trailing
  // optional value is empty is routinely written without its final tab —
  // openrouter-runner emits `…\treport\t\n` for an absent note, and an LLM
  // writer asked for "leave the last field empty" often just stops — so
  // demanding a cell for every label would reject canonical rows. Absent and
  // empty read the same here, which is what the batch and web prompts already
  // promise their writers.
  //
  // This is not the defense against a SHIFTED row: an omitted interior cell
  // slides every later value one column left, which the score corroboration
  // below catches by content regardless of the row's width.
  const shortLabels = Object.entries(map).filter(([, i]) => i >= parts.length).map(([k]) => k);
  const missingRequiredCells = shortLabels.filter(k => TSV_REQUIRED_FIELDS.includes(k));
  if (missingRequiredCells.length) {
    console.warn(`⚠️  Skipping ${filename}: data row has ${parts.length} field(s), missing the required cell(s): ${missingRequiredCells.join(', ')}`);
    return null;
  }

  const at = (k) => (map[k] != null ? String(parts[map[k]] ?? '').trim() : '');
  const optional = (k) => {
    const v = at(k);
    return PLACEHOLDER_CELL.test(v) ? '' : v;
  };

  // A required cell that is PRESENT but blank is a writer that did not supply
  // the value, and blank is never the way to say "none" here: every required
  // field has a documented value, and the "no data" cases have sentinels
  // (`—` / `N/A` for score, `—` for report, `❌` for pdf). Left unchecked, an
  // empty status reaches validateStatus(''), which warns and returns
  // "Evaluated" — recording a real evaluation state the row never claimed.
  const blankRequiredCells = TSV_REQUIRED_FIELDS.filter(k => at(k) === '');
  if (blankRequiredCells.length) {
    console.warn(`⚠️  Skipping ${filename}: required cell(s) present but empty: ${blankRequiredCells.join(', ')} — use the documented sentinel (— / N/A) rather than a blank cell`);
    return null;
  }

  // The optional tail can only be trusted when a short row's missing cells are
  // genuinely its LAST ones. Position cannot tell "notes omitted, url written"
  // from "notes written, url omitted" — both are one cell short — so the one
  // TYPED optional column is the corroboration. A cell that IS a URL, sitting
  // under a label that is not `url` while the `url` label has no cell at all,
  // means every optional value is one column left of its label. Merging that
  // stores the posting URL as the row's NOTES and leaves the dedup key empty,
  // which is precisely the mapping the header exists to protect.
  if (map.url != null && shortLabels.includes('url')) {
    const misplacedUrl = Object.entries(map)
      .filter(([k, i]) => k !== 'url' && i < parts.length && /^https?:\/\/\S*$/i.test(String(parts[i] ?? '').trim()))
      .map(([k]) => k);
    if (misplacedUrl.length) {
      console.warn(`⚠️  Skipping ${filename}: a URL sits under "${misplacedUrl.join('", "')}" while the "url" cell is absent — the optional cells are shifted; write an empty cell for each optional value you omit`);
      return null;
    }
  }

  // Write-canonical: the tracker stores scores unbolded (verify-pipeline
  // rejects bold scores), so strip any markdown bold from the incoming cell.
  const score = at('score').replace(/\*\*/g, '').trim();
  if (!looksLikeScoreCell(score)) {
    // Corroboration, not disambiguation: the header already said which column
    // this is, so this can no longer pick an order — it only asks whether the
    // labelled cell holds what the label promises. It stays a hard gate because
    // the value it catches is an emitter that wrote its VALUES in one order and
    // its LABELS in another, which is the silent swap in a new costume. The
    // headerless path already refuses a score cell of this shape (neither cell
    // score-like → undecidable), so this is the same strictness, not new.
    console.warn(`⚠️  Skipping ${filename}: the column labelled "score" reads "${score}", which is not a score or a documented sentinel (X.X/5, N/A, —, -) — check the header labels match the value order`);
    return null;
  }

  return {
    num: parseTrackerNum(at('num')),
    date: at('date'),
    company: at('company'),
    role: at('role'),
    status: validateStatus(at('status')),
    score,
    pdf: at('pdf'),
    report: at('report'),
    notes: optional('notes'),
    // A `via` COLUMN carries the agency name plainly; tolerate a writer that
    // also brings the headerless form's `via=` tag along.
    via: optional('via').replace(/^via=/i, '').trim(),
    location: optional('location'),
    url: optional('url'),
  };
}

/**
 * Parse a tracker-addition file into a structured addition object.
 *
 * Two forms. A HEADED file (labels row + one data row) resolves fields by name
 * and is the form writers should emit. A headerless file is the legacy
 * positional form: 9-column TSV, 8-column TSV, or a pipe-delimited Markdown
 * row, whose score/status pair is disentangled by content because the two
 * orders in circulation disagree. Both validate status and reject additions
 * without a usable tracker number, so malformed batch output cannot corrupt
 * the applications table.
 *
 * @param {string} content - Raw file content from batch/tracker-additions.
 * @param {string} filename - Source filename used in warning messages.
 * @returns {object|null} Parsed tracker addition, or null when malformed.
 */
function parseTsvContent(content, filename) {
  // Split the RAW content: trimming the whole file strips the data row's
  // trailing tab, and that tab IS the final empty cell (`…\tnotes\t` for an
  // absent url). Trimming first made a row's last column disappear, so the
  // width check then read the row as one cell short of its own header.
  const rawLines = String(content ?? '').split(/\r?\n/).filter(l => l.trim() !== '');
  content = String(content ?? '').trim();
  if (!content) return null;

  // Headed additions resolve by name; everything below is the legacy positional
  // path, unchanged — it keeps parsing the trimmed content, byte-for-byte as
  // before. Detection reads only the first line.
  if (looksLikeTsvHeaderRow(splitAdditionCells(rawLines[0]))) {
    const headed = parseHeadedAddition(rawLines, filename);
    if (!headed) return null;
    // Number.isSafeInteger rather than isNaN: parseTrackerNum returns null for a
    // cell that is not a whole positive integer, and isNaN(null) is false.
    if (!Number.isSafeInteger(headed.num) || headed.num <= 0) {
      console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
      return null;
    }
    return headed;
  }

  let parts;
  let addition;

  // Detect pipe-delimited (markdown table row)
  if (content.startsWith('|')) {
    parts = content.split('|').map(s => s.trim());
    if (parts[0] === '') parts.shift();
    if (parts[parts.length - 1] === '') parts.pop();
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
    // Format: num | date | company | role | score | status | pdf | report | notes [| location]
    // Identify score vs status by content, not position, so a swapped row can't
    // merge silently (#1427).
    const resolved = resolveScoreStatus(parts[4], parts[5]);
    if (!resolved) {
      console.warn(`⚠️  Skipping ${filename}: cannot tell score from status in columns 5–6 ("${parts[4]}" | "${parts[5]}") — refusing to merge a possible column swap`);
      return null;
    }
    addition = {
      num: parseTrackerNum(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      // Write-canonical: the tracker stores scores unbolded (verify-pipeline
      // rejects bold scores), so strip any markdown bold from the incoming cell.
      score: resolved.score.replace(/\*\*/g, '').trim(),
      status: validateStatus(resolved.status),
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
    const extras = parseTsvExtras(parts, filename);
    if (!extras) return null;
    Object.assign(addition, extras);
  } else {
    // Tab-separated
    parts = content.split('\t');
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }

    // Column order varies: batch TSVs write (status, score), applications.md is
    // (score, status). Identify each by content — the score cell is recognizable
    // by pattern, a status never is — so a reordered TSV merges correctly and an
    // undecidable row is skipped loudly instead of merging swapped data (#1427).
    const resolved = resolveScoreStatus(parts[4].trim(), parts[5].trim());
    if (!resolved) {
      console.warn(`⚠️  Skipping ${filename}: cannot tell score from status in columns 5–6 ("${parts[4].trim()}" | "${parts[5].trim()}") — refusing to merge a possible column swap`);
      return null;
    }

    addition = {
      num: parseTrackerNum(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      status: validateStatus(resolved.status),
      // Write-canonical: strip any markdown bold so the stored score stays
      // unbolded (verify-pipeline rejects bold scores).
      score: resolved.score.replace(/\*\*/g, '').trim(),
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
    const extras = parseTsvExtras(parts, filename);
    if (!extras) return null;
    Object.assign(addition, extras);
  }

  // See the headed guard above: null must be rejected, and isNaN(null) is false.
  if (!Number.isSafeInteger(addition.num) || addition.num <= 0) {
    console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  return addition;
}

// ---- Main ----

// Read the applications table
if (!existsSync(DB_FILE)) {
  console.log('No tracker database found. Nothing to merge into.');
  process.exit(0);
}
const existingApps = db.listApplications();
// Test-only synchronization hook: the concurrent merge test waits for the
// first worker to read the tracker while still holding the lock, then starts a
// second worker to prove the lock prevents the old lost-update race.
if (MERGE_READY_IPC && typeof process.send === 'function') {
  process.send({ type: 'merge-tracker-ready' });
}
if (MERGE_HOLD_MS > 0) {
  await sleep(MERGE_HOLD_MS);
}

// One-time migration: rewrite existing report links so they resolve relative
// to the data/ directory (see #760). Run with: node merge-tracker.mjs --migrate
if (MIGRATE) {
  let changed = 0;
  for (const app of existingApps) {
    const normalized = normalizeReportLink(app.report || '');
    if (normalized !== (app.report || '')) {
      changed++;
      if (!DRY_RUN) db.updateApplication(app.num, { report: normalized });
    }
  }
  if (DRY_RUN) {
    console.log(`🔎 Migration (dry-run): ${changed} row(s) would be rewritten in ${basename(DB_FILE)}`);
  } else {
    console.log(`✅ Migration: rewrote ${changed} report link(s) in ${basename(DB_FILE)} relative to ${TRACKER_DIR === DATA_ROOT ? 'repo root' : 'data/'}`);
  }
  process.exit(0);
}

// Opt-in migration (#1596): insert a Via column after Company. The applications
// table always carries a via column, so this is now a no-op kept for CLI
// compatibility. Run with: node merge-tracker.mjs --migrate-via [--dry-run]
if (MIGRATE_VIA) {
  console.log('✅ Via column already present — nothing to migrate.');
  process.exit(0);
}

let maxNum = db.maxApplicationNum();

// One-time backfill populating the url column on existing rows from each row's
// linked report (`**URL:**` header). This is the EXPAND phase — the key must
// exist before the merge relies on it. Idempotent: only fills rows whose URL
// is empty, so re-running is safe.
// Run with: node merge-tracker.mjs --backfill-urls [--dry-run]
if (BACKFILL_URLS) {
  let filled = 0, noReport = 0, noUrl = 0, already = 0;
  for (const app of existingApps) {
    if ((app.url || '').trim()) { already++; continue; }
    // Shared derivation with the merge loop — one place that knows how to turn a
    // report link into the posting URL. Tracker links may be root-relative
    // (`reports/...`) or data-relative (`../reports/...`); both resolve.
    const resolved = resolveReportUrl(app.report);
    if (resolved.reason === 'no-report') { noReport++; continue; }
    if (resolved.reason === 'no-url') { noUrl++; continue; }
    filled++;
    if (!DRY_RUN) db.updateApplication(app.num, { url: resolved.url });
  }
  const summary = `${filled} filled, ${already} already set, ${noReport} no/missing report, ${noUrl} report has no **URL:**`;
  if (DRY_RUN) {
    console.log(`🔎 Backfill URLs (dry-run): would fill ${filled} row(s). (${summary})`);
  } else {
    console.log(`✅ Backfill URLs: ${summary}.`);
  }
  trackerLock.release();
  process.exit(0);
}
// Full set of numbers already on the tracker (#1704): a number once assigned is
// taken and must never be handed out again, so a new entry's number is checked
// against every number actually in the table, not just the largest one.
const usedNumbers = new Set(existingApps.map(app => app.num));

console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);
let added = 0;
let updated = 0;
let skipped = 0;
let missingReports = 0;
const pdfIndex = loadPdfIndex();
const pdfSynced = syncPdfFlags(existingApps, pdfIndex);
updated += pdfSynced;

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  if (DRY_RUN) console.log('(dry-run — no changes written)');
  trackerLock.release();
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  if (DRY_RUN) console.log('(dry-run — no changes written)');
  trackerLock.release();
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  const numA = parseInt(/^(\d+)/.exec(a)?.[1] ?? '', 10) || 0;
  const numB = parseInt(/^(\d+)/.exec(b)?.[1] ?? '', 10) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

// TSVs whose evaluation could not be applied to the tracker. They are kept out
// of merged/ so a re-run picks them up, and they make the process exit non-zero
// instead of reporting a success that did not happen.
const failedAdditions = [];

for (const file of tsvFiles) {
  // NOT trimmed here: a trailing tab is the row's final empty cell, and
  // parseTsvContent needs to see it. It trims internally for the legacy path.
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8');
  const addition = parseTsvContent(content, file);
  if (!addition) { skipped++; continue; }

  // Normalize the report link to be relative to the data/ directory. The TSV
  // convention carries a root-relative `reports/...` link; rewrite it so it
  // resolves consistently with existing rows (see #760).
  addition.report = normalizeReportLink(addition.report);

  // Derive the key from the linked report when the TSV did not carry one, so a
  // row added through the normal nine-column flow is born WITH its key. This
  // must run before the dedup below reads addition.url — deriving it afterwards
  // would populate the column while leaving Pass 0 nothing to match on, which is
  // the original bug with extra steps.
  if (!addition.url) addition.url = resolveReportUrl(addition.report).url;

  // Check for duplicate by:
  // 0. Exact normalized posting URL (deterministic, authoritative)
  // 1. Exact report number match
  // 2. Company + role fuzzy match
  const reportNum = extractReportNum(addition.report, addition.notes);

  if (reportNum && FAILED_REPORT_NUMBERS.has(reportNum)) {
    console.warn(`⚠️  Skipping ${file}: report #${reportNum} is marked "failed" in batch-state.tsv — refusing to merge a tracker line for an offer the batch runner itself recorded as failed (possible fabricated result)`);
    if (COMPLETED_REPORT_NUMBERS.has(reportNum)) {
      console.warn(`   batch-state.tsv also has a "completed" row for #${reportNum}: the number was likely reused after a failure by an older batch runner. If this report is the completed offer's, set report_num to "-" on the failed row and re-run.`);
    }
    skipped++;
    continue;
  }

  // #4748: the report cell is copied into the tracker as-is, so a link to a
  // report that is not on disk would otherwise go in silently and only surface
  // later in verify-pipeline. Warn, but still merge: the application record is
  // the user's data and must not be lost or rewritten because a report is
  // missing. Cells with no link (—, N/A, empty) are the documented "no report"
  // convention and are not flagged. Checked against the same two bases
  // verify-pipeline's Check 3 uses (the tracker's own directory, then the data
  // root for legacy root-relative links), so a link warned about here is
  // exactly one verify-pipeline would flag later. resolveReportPath() is NOT
  // used: it strips leading `../` and so can accept a link verify-pipeline
  // rejects (e.g. `../../stray.md`).
  // The rule itself lives in tracker-utils.mjs (findDeadReportLink), shared with
  // verify-pipeline's Check 3 and fix-report-links.mjs: a directory (e.g. a link
  // to `reports/`) is not a report, so a regular file is required.
  const deadLink = findDeadReportLink(addition.report, TRACKER_DIR, DATA_ROOT);
  if (deadLink !== null) {
    const linked = deadLink.trim();
    console.warn(`⚠️  ${file}: ${addition.company} — ${addition.role}: report link "${linked}" does not resolve to a file (checked from ${TRACKER_DIR} and ${DATA_ROOT}) — the row is not rewritten; verify-pipeline will flag it until the report exists`);
    missingReports++;
  }

  let duplicate = null;
  // True only for a tier-1 match (report number + company): the one heuristic
  // tier where the addition is provably the same evaluation as the existing
  // row, so its role title may replace the row's. Tier-2 (entry num) and
  // tier-3 (fuzzy role) matches keep the existing title — a fuzzy false
  // positive that also rewrites the title destroys the evidence that two reqs
  // were distinct. Pass 0 (URL) grants the same trust for the same reason; it
  // tracks that separately in `dupReason`.
  let reportNumMatched = false;

  // Pass 0 — the posting URL is the stable natural key. When it hits it is
  // authoritative and no heuristic runs. Tiers 1-3 below remain the fallback
  // for rows with no URL yet.
  const addUrl = normalizeUrl(addition.url);
  let dupReason = null;
  if (addUrl) {
    duplicate = existingApps.find(a => a.url && normalizeUrl(a.url) === addUrl);
    if (duplicate) dupReason = 'url';
  }

  // Guard the report/num/fuzzy fallback against collapsing distinct postings.
  //
  // ONLY TWO PRESENT-AND-DIFFERENT KEYS ARE EVIDENCE. A key that is absent on
  // either side says nothing at all, so it must let the tier proceed and decide
  // on its own signals. This is SQL's three-valued logic: a comparison against
  // an unknown is UNKNOWN, not "different" — the same reason `x = NULL` is never
  // true. The earlier version returned true when the ADDITION had no key, which
  // silently turned "I don't know" into "definitely a different posting" and
  // made every URL-bearing row unmatchable by the documented 9-column TSV: a
  // routine re-evaluation appended a duplicate row instead of updating, both
  // rows pointing at the same report. Record-linkage practice names this
  // directly — treating missing as disagreement is a known bias, not a safe
  // default.
  // Two present-and-different keys are PROOF the rows are distinct postings —
  // but only while both name an EMPLOYER-CONTROLLED board, where one URL is one
  // requisition. An aggregator re-lists a requisition the employer hosts
  // elsewhere, so a single opening routinely carries a LinkedIn URL on the row
  // it entered by and an Indeed or employer-ATS URL on the row a later sighting
  // brought in. Those two keys differ because the two BOARDS differ, which is
  // not information about the posting: it is the same UNKNOWN as an absent key,
  // and must let the tier decide on company and title instead. The project
  // already holds this for the mirror-image case — detect-reposts skips
  // `aggregator: true` companies because "same company + same title" stops
  // meaning "same opening" there (#2703).
  //
  // WITH ONE EXCEPTION, AND IT IS THE POSTING ID. Reading the whole URL as
  // unknown also swallowed two DIFFERENT requisitions listed on the SAME board:
  // LinkedIn 4001 (already Applied) and LinkedIn 4002 folded into one row that
  // still said Applied while pointing at a posting nobody had applied to, with
  // the first report orphaned and no marker — the silent, unrecoverable
  // direction. The narrower and correct signal is the requisition identity the
  // URL carries: two IDs extracted from the SAME aggregator that differ are two
  // postings. Same ID, one side unextractable, or two different aggregators all
  // stay UNKNOWN, so slug-vs-id spellings and uk./www. region hosts keep
  // collapsing and #3652 is preserved. Gating on the HOST instead was measured
  // to split one posting across two rows, which is why the ID is the gate.
  const urlDiffers = (cand) => {
    const candUrl = normalizeUrl(cand.url);
    if (!candUrl || !addUrl) return false;   // unknown → not evidence
    if (isAggregatorUrl(cand.url) || isAggregatorUrl(addition.url)) {
      const candId = aggregatorPostingId(cand.url);
      const addId = aggregatorPostingId(addition.url);
      // Comparable only on one board: a LinkedIn id and an Indeed id differing
      // says the two BOARDS differ, which is the non-signal above.
      return Boolean(candId && addId && candId.domain === addId.domain && candId.id !== addId.id);
    }
    return candUrl !== addUrl;
  };

  // The heuristic tiers additionally refuse to let an UNKEYED addition claim a
  // row whose posting we do know. That asymmetry is the point of the whole
  // change: tier 1 matches on the report number, which is provable identity, so
  // an absent key there must not block — it is UNKNOWN, not "different", and
  // treating it as different is what made a routine nine-column re-evaluation
  // append a duplicate row. Tiers 2 and 3 match on an entry number or a fuzzy
  // title, which are guesses; there, "this row is a specific known posting and
  // you have not told me which posting you are" is a good reason to stay out.
  const urlBlocksHeuristic = (cand) => {
    if (urlDiffers(cand)) return true;
    return Boolean(normalizeUrl(cand.url)) && !addUrl;
  };

  const additionReqNum = extractReqNumber(addition.notes);
  // Req IDs are evidence against a heuristic match only when both sides carry
  // one and they disagree. Missing on either side stays unknown, matching the
  // existing tier-3 guard and the URL guard above.
  const reqNumDiffers = (cand) => {
    const appReqNum = extractReqNumber(cand.notes);
    return Boolean(additionReqNum && appReqNum && additionReqNum !== appReqNum);
  };

  // Pass 0.5 — the addition's own report link and an existing row's report
  // link resolve to the LITERAL SAME FILE on disk. This is unambiguous proof
  // of identity, stronger than tier 1 below (bracket-number equality): a
  // report file is written once, for one specific posting, so two additions
  // that reference the identical reports/*.md path cannot be two distinct
  // postings that happen to share a number — unlike a bare number match,
  // there is no "report-file sequence vs. tracker-row sequence drifted"
  // explanation available here (#912's reason for tier 1's company guard).
  // So this tier, unlike tier 1, does not require the company to also match.
  //
  // Closes #4506: two concurrent sessions each wrote a TSV addition for the
  // same report, one spelled the company "Revera" and the other "Revera
  // (Cogir Senior Living)" — different enough that tier 1's company guard
  // refused the match, so a second tracker row was appended pointing at the
  // exact same report file. A same-file match here needs no such guard.
  if (!duplicate) {
    const addPath = resolveReportPath(addition.report);
    if (addPath) {
      duplicate = existingApps.find(app => !urlDiffers(app) && resolveReportPath(app.report) === addPath);
      if (duplicate) { dupReason = 'report-file'; reportNumMatched = true; }
    }
  }

  if (!duplicate && reportNum) {
    // Report-number match must also confirm company (#912). Report-file
    // sequence and tracker-row sequence are independent, so the same number
    // appearing for two different companies is sequence drift, not a duplicate.
    // Without the company guard, a NewCo TSV with report [1] silently overwrites
    // the existing tracker row [1] belonging to an unrelated company.
    duplicate = existingApps.find(app => {
      // Provable tier: only a CONFLICT disqualifies, never a missing key.
      if (urlDiffers(app)) return false;
      const existingReportNum = extractReportNum(app.report, app.notes);
      return existingReportNum === reportNum && companiesMatch(app.company, addition.company);
    });
    if (duplicate) reportNumMatched = true;
  }

  if (!duplicate) {
    // Exact entry number match — but only when the company also matches.
    // The TSV `num` doubles as the tracker row id, yet report-file numbering
    // and tracker-row numbering can drift out of sync (e.g. reports maxed at
    // 067 while the tracker was already at #69). A bare num collision across
    // *different* companies is that drift, not a duplicate — matching on num
    // alone silently merges a brand-new role into an unrelated existing row.
    duplicate = existingApps.find(app =>
      !urlBlocksHeuristic(app) && app.num === addition.num && companiesMatch(app.company, addition.company)
      && !reqNumDiffers(app)
      // Same-run num collisions are reservation races, not row-id references:
      // two TSVs that both claimed num=5 for DIFFERENT roles at one company
      // are two distinct evaluations, and folding them keeps the first title
      // with the second score (main renumbers and keeps both via the
      // #1704/#1733 path). For a row queued THIS run, only accept the num
      // match when the roles also fuzzy-match — consistent with tier-3's
      // cross-run semantics. For rows already on disk, num remains the
      // tracker row id and behavior is unchanged.
      && (!app.addedThisRun || roleFuzzyMatch(addition.role, app.role))
    );
  }

  if (!duplicate) {
    // Company + role fuzzy match
    // Two passes, exact company first. With a single find() the wider
    // corporate-form comparison (#3665) let an EARLIER "Acme Technologies" row
    // claim an addition for "Acme" while an exact "Acme" row sat further down
    // the table: the duplicate that comparison exists to prevent was written
    // to a second time and the exact row never updated.
    const fuzzyTierMatch = (app, widenToCorporateForm) => {
      // Two different posting URLs are two different postings — a fuzzy title
      // collision must never collapse them. This is the structural version of
      // the #1524 req-number guard, and the tier where an unkeyed addition is
      // also held back from claiming a row whose posting is known.
      if (urlBlocksHeuristic(app)) return false;
      // Corporate-form variants of one employer are accepted HERE and nowhere
      // else (#3665). The tiers above match on a report or entry number, which
      // is an identity claim on its own, so a wider company match there would
      // let sequence drift across two employers write to the wrong row. This
      // tier already requires a fuzzy role match, and the req-number and URL
      // guards below and above still get to prove the rows distinct.
      if (!companiesMatch(app.company, addition.company)
          && !(widenToCorporateForm && companiesMatchIgnoringCorporateForm(app.company, addition.company))) return false;
      if (!roleFuzzyMatch(addition.role, app.role)) return false;
      // Cross-channel guard (#1596): unknown-employer rows (`?`) all normalize
      // to the same empty company key, but the same role via two DIFFERENT
      // agencies is two real submissions — merging them silently is exactly
      // the double-submission hazard the Via column exists to surface. Only
      // the same channel (the agency re-blasting one listing) is a duplicate.
      // Via comparison is Unicode-aware (#1603): normalizeCompany() would
      // collapse distinct non-Latin agency names to the same empty key.
      //
      // ON A TRACKER THAT HAS A VIA COLUMN, both vias must be PRESENT and equal,
      // not merely equal (#3410). Rejecting only on a difference let two empty
      // ones compare equal, so two unrelated `?` rows with no Via fell through
      // to the fuzzy title match and merged. Measured: an existing
      // `? / Program Manager` (4.2, Applied, report [1]) and an unrelated
      // `? / Senior Program Manager` became ONE row carrying the addition's
      // date, score, PDF flag and report link, with the surviving note calling
      // report [1] "Superseded" — which it was not. The tracker is gitignored
      // and no .bak is written, so nothing recovers it.
      //
      // This is the same three-valued logic Pass 0 states above — an absent key
      // is UNKNOWN, never "equal" — landing the other way here, on purpose.
      // There, company and role still carry identity, so an unknown URL must not
      // block a tier that has other evidence. Here the company key is empty BY
      // CONSTRUCTION: `?` means "employer not disclosed", so a fuzzy role match
      // is all that is left, and it is not identity. With nothing to tell the
      // channels apart, not merging is the recoverable answer — a visible
      // duplicate row the user can fix, rather than a silent overwrite of a row
      // whose report link now points at a different job.
      //
      if (String(addition.company).trim() === '?' || String(app.company).trim() === '?') {
        const additionVia = normalizeVia(addition.via || '');
        const appVia = normalizeVia(app.via || '');
        if (!additionVia || !appVia || additionVia !== appVia) return false;
      }
      // Req/job-number guard (#1524, widened by #4275): a similarly-worded
      // title at the same company can still be a genuinely distinct posting
      // when a req/job number in the Notes column proves it (employers like
      // TD commonly run concurrent near-identical L&D/HR titles distinguished
      // only by req#). Originally this only counted when BOTH sides carried
      // an extractable number and they disagreed — an existing row written
      // before req numbers were consistently captured has none, so a new
      // addition FOR A GENUINELY DIFFERENT POSTING that happens to have a req
      // number fell through to "not proven distinct" and got silently merged,
      // corrupting the old row's date/score/report/notes.
      //
      // The fix is direction-sensitive, not symmetric: only block when the
      // ADDITION carries a number the existing row can't confirm or deny.
      // The other direction — existing row has a req number, addition does
      // not — is the ordinary re-evaluation shape (a fresh TSV re-scoring the
      // same posting typically writes new commentary like "re-scored: JD
      // refreshed" without repeating the req number already sitting in the
      // row's Notes) and must keep merging; blocking that direction too would
      // turn every such re-eval into a spurious duplicate row instead.
      const appReqNum = extractReqNumber(app.notes);
      if (reqNumDiffers(app)) return false;
      if (additionReqNum && !appReqNum) return false;
      return true;
    };
    duplicate = existingApps.find(app => fuzzyTierMatch(app, false))
      || existingApps.find(app => fuzzyTierMatch(app, true));
  }

  if (duplicate) {
    // An unscoreable re-eval (N/A/—/-) carries no score to write through. Its
    // score parses to 0, so the downgrade path below would read it as a genuine
    // zero and overwrite a real score with the sentinel — unrecoverably, since
    // the tracker is gitignored and no .bak is written (#2803). A failed fetch is
    // "no new score", not "scored zero": leave the row's score, report and PDF as
    // they stand. When the row itself is not yet scored there is nothing to lose,
    // so let the normal path refresh its date/notes/report from the re-eval.
    if (isUnscoreable(addition.score) && !isUnscoreable(duplicate.score)) {
      console.log(
        `⏭️  Skipping ${file}: re-eval of #${duplicate.num} ${addition.company} — `
        + `${addition.role} produced no score (${String(addition.score).trim()}); `
        + `keeping ${duplicate.score}`,
      );
      skipped++;
      continue;
    }
    const newScore = parseScore(addition.score);
    const oldScore = parseScore(duplicate.score);

    // A re-evaluation writes through in BOTH directions. A lower score is not
    // noise to discard — it is newer information, and often the most valuable
    // kind: a targeting/policy change, a freshly-discovered staleness signal (a
    // requisition turning out to be a year old), or a gap re-weighted from
    // "ramp-up item" to "decisive gate". The former `newScore > oldScore` gate
    // sent all of those to a bare `else`, so the tracker kept asserting a stale
    // optimistic score, the new report was orphaned, and the TSV was archived to
    // merged/ as if it had landed (#2411). Equal scores write through too, since
    // the notes and report link are still fresher than what the row holds.
    //
    // Because the fuzzy matcher can mis-pair genuinely different roles (see
    // role-matcher.mjs — "Senior" is a stopword and short tokens are dropped), a
    // downgrade records the superseded report number so a bad match stays
    // recoverable from the tracker alone. mergeNotes() keeps the existing cell
    // verbatim and first, so a second downgrade preserves the earlier marker
    // rather than overwriting it.
    const downgrade = newScore < oldScore;
    const oldReportNum = extractReportNum(duplicate.report, duplicate.notes);
    const supersededNote = downgrade && oldReportNum && oldReportNum !== reportNum
      ? `Superseded report [${oldReportNum}] (was ${oldScore}/5)`
      : '';

    console.log(
      `${downgrade ? '🔽' : '🔄'} Update: #${duplicate.num} ${addition.company} — ${addition.role} (${oldScore}→${newScore})`
      + (downgrade ? ' — DOWNGRADE, re-eval scored lower' : ''),
    );
    // The PDF flag describes THE ROW'S REPORT, and this branch replaces that
    // report link. Inheriting duplicate.pdf across a report change carried the
    // superseded report's ✅ onto the new one: the row then claimed a tailored
    // PDF exists for a report that has none, and the only PDF on disk belonged
    // to the evaluation that was just superseded. Fall back to the existing
    // flag only when the report is unchanged; when it changes, the manifest is
    // the sole authority (#2594).
    // "different, INCLUDING one-side-absent". Requiring both to be truthy meant
    // a row whose report cell is `—` had oldReportNum === null, so reportChanged
    // was falsy and the stale ✅ was inherited exactly as before this fix — and a
    // `—` row with a ✅ is ordinary, it is what a tracker entry added before its
    // evaluation looks like. Both absent stays "unchanged", which is correct.
    const reportChanged = String(reportNum ?? '') !== String(oldReportNum ?? '');
    const pdf = reportNum && pdfIndex.has(String(reportNum))
      ? '✅'
      : (reportChanged ? '❌' : duplicate.pdf);
    const updatedRow = {
      num: duplicate.num, date: addition.date,
      // A corporate-form match (#3665) pairs the row with a VARIANT spelling of
      // its employer, so the row keeps the name it was filed under, the same
      // rule the fuzzy tiers apply to the role below. Renaming it breaks every
      // company-keyed join (company-history, blacklist, follow-ups,
      // linkedin-join) and, on a table already holding both spellings, leaves
      // two rows under one literal name. An exact, URL or report match carries
      // the incoming spelling, as before.
      company: cell((reportNumMatched || dupReason === 'url' || companiesMatch(duplicate.company, addition.company))
        ? addition.company : duplicate.company),
      // A URL match is a CONFIRMED same-posting identity, so the incoming title
      // is authoritative the same way a report-number match is — employers do
      // edit a live posting's title. The fuzzy tiers stay conservative and keep
      // the existing role, since there the pairing is only a guess.
      role: cell((reportNumMatched || dupReason === 'url') ? addition.role : duplicate.role),
      via: cell(addition.via || duplicate.via) || '—',
      location: cell(addition.location || duplicate.location) || '—',
      score: addition.score, status: duplicate.status, pdf,
      report: addition.report,
      notes: cell(mergeNotes(duplicate.notes, addition, oldScore, newScore, supersededNote)),
      // Carry the key forward. Without this the update path rewrites the row
      // with an empty URL and the posting loses the very key that matched it,
      // silently demoting every later merge back to the fuzzy tiers.
      url: cell(addition.url || duplicate.url || ''),
    };
    try {
      if (!DRY_RUN) db.upsertApplication(updatedRow);
      // Refresh the cached row from what was just written (#2392): a SECOND
      // addition matching this same row in one run must compare against the
      // post-update score/notes, not the pre-update ones, or which of several
      // re-evaluations survives depends on TSV filename sort order. (In a dry
      // run the same refresh models what the write would have produced, so
      // intra-run dedup behaves identically.) syncPdfFlags() has always kept
      // its cache in step this way.
      Object.assign(duplicate, updatedRow);
      updated++;
    } catch (err) {
      // A row we cannot write means the addition was NOT applied, so say so,
      // keep the TSV out of merged/, and fail the run.
      console.error(
        `❌ ${file}: could not update tracker row #${duplicate.num} ` +
        `(${duplicate.company} — ${duplicate.role}): ${err.message}; this evaluation was NOT merged.`,
      );
      failedAdditions.push(file);
    }
  } else {
    // New entry - preserve the TSV's reserved ID whenever it is actually
    // free. Parallel workers can finish out of order, so a valid reservation
    // may be lower than the current tracker maximum (#1733). Renumber only on
    // a real collision, using the next free ID above the current maximum and
    // warning loudly so report/tracker drift is visible (#1704).
    let entryNum;
    if (!usedNumbers.has(addition.num)) {
      entryNum = addition.num;
    } else {
      entryNum = maxNum + 1;
      while (usedNumbers.has(entryNum)) entryNum++;
      console.warn(
        `⚠️  Tracker #${addition.num} already used; assigning #${entryNum} to ` +
        `${addition.company} — ${addition.role}. Report link remains ${addition.report}.`,
      );
    }
    usedNumbers.add(entryNum);
    if (entryNum > maxNum) maxNum = entryNum;

    const pdf = reportNum && pdfIndex.has(String(reportNum)) ? '✅' : addition.pdf;
    const newRow = {
      num: entryNum, date: addition.date,
      company: cell(addition.company), role: cell(addition.role),
      via: cell(addition.via) || '—',
      location: cell(addition.location) || '—',
      score: addition.score, status: addition.status, pdf,
      report: addition.report, notes: cell(addition.notes),
      // Write the key on the way in. Backfill is the one-time EXPAND phase for
      // rows that predate the column; a row added today must carry its own URL
      // or Pass 0 can never match it and dedup stays fuzzy-only for new work.
      url: cell(addition.url || ''),
    };
    try {
      if (!DRY_RUN) db.upsertApplication(newRow);
    } catch (err) {
      console.error(`❌ ${file}: could not insert tracker row #${entryNum} (${addition.company} — ${addition.role}): ${err.message}; this evaluation was NOT merged.`);
      failedAdditions.push(file);
      continue;
    }
    // Register the row with the dedup index right away (#2392 gap 3). All
    // three dedup tiers search `existingApps`, which only ever held rows read
    // from the table, so two TSVs for the same company+role in ONE run both
    // appended and the tracker gained duplicate rows — the exact outcome
    // CLAUDE.md's "NEVER create new entries if company+role already exists"
    // rule forbids. A later higher-scored addition in the same run then
    // updates it in place just like a row already on disk.
    existingApps.push({ ...newRow, addedThisRun: true });
    added++;
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
  }
}

// Rows are written to the applications table as they merge (ordered by num on
// every read), so there is no document write-back step. Archive the processed
// TSVs — but only the ones actually applied. Archiving a TSV whose row never
// reached the tracker is what turns a bug into permanent data loss, since the
// tracker is gitignored and no backup is written.
if (!DRY_RUN) {
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  const archivable = tsvFiles.filter(f => !failedAdditions.includes(f));
  for (const file of archivable) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${archivable.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped${failedAdditions.length ? `, ❌${failedAdditions.length} NOT merged` : ''}`);
if (missingReports > 0) console.log(`⚠️  ${missingReports} row(s) link to a report that is not on disk (see warnings above)`);
if (DRY_RUN) console.log('(dry-run — no changes written)');
trackerLock.release();

// Sync PDF flags (idempotent; uses its own lock/transaction)
if (!DRY_RUN) {
  try {
    execFileSync(process.execPath, [join(CAREER_OPS_CODE_ROOT, 'sync-pdf-flags.mjs')], { stdio: 'inherit' });
  } catch (e) {
    console.warn(`⚠️  Failed to sync PDF flags: ${e.message}`);
  }
}

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync(process.execPath, [join(CAREER_OPS_CODE_ROOT, 'verify-pipeline.mjs')], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}

// Any addition that could not be applied fails the run. The TSVs stay in the
// additions dir, so re-running after the tracker is repaired merges them once.
if (failedAdditions.length > 0) {
  console.error(
    `\n❌ ${failedAdditions.length} addition(s) were NOT merged and were left in ${ADDITIONS_DIR}: ` +
    failedAdditions.join(', '),
  );
  process.exit(1);
}
