#!/usr/bin/env node
/**
 * auto/reply-ingest.mjs — Propose-only reply ingestion for the auto pipeline.
 *
 * PRIVACY LINE: this tool NEVER reads any mailbox. All input is either:
 *   (a) pasted text / a .txt file of email snippets  (--file / --text)
 *   (b) an existing data/reply-candidates.json written by paste-reply.mjs
 *   (c) the tracker-rot scan (--scan-tracker-rot)
 *
 * Output: data/reply-candidates.json entries (appended, never auto-applied).
 * Shape per entry:
 *   { company, role, detectedOutcome, evidenceSnippet, matchedAppRef, confidence, source, addedAt }
 *
 * The --scan-tracker-rot flag scans the live tracker for Applied rows whose
 * notes carry a known "Gmail decision verified … declined/rejected" pattern
 * while their status is still "Applied". These are emitted as high-confidence
 * status-correction proposals.
 *
 * NEVER auto-changes tracker status. Proposals are review-only.
 *
 * Usage:
 *   node auto/reply-ingest.mjs --scan-tracker-rot [--json] [--dry-run]
 *   node auto/reply-ingest.mjs --file email.txt [--company Acme] [--dry-run] [--json]
 *   node auto/reply-ingest.mjs --text "Subject: ... From: ... Body: ..." [--dry-run] [--json]
 *
 * Worker C interface:
 *   import { scanTrackerRot, ingestText } from './auto/reply-ingest.mjs';
 *   const proposals = await scanTrackerRot();   // returns proposal[]
 *   const proposal  = await ingestText(raw, { company, role });
 *
 * Exit codes: 0 success · 1 error
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localToday } from '../lib/local-today.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { renameSyncWithRetry } from '../tracker-utils.mjs';

const ROOT = getCareerOpsRoot();
export const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || join(ROOT, 'data', 'reply-candidates.json');

// ── tracker-rot patterns ──────────────────────────────────────────────────────

// Matches the manually-written note pattern: "Gmail decision verified YYYY-MM-DD:
// <Company> <verb> the <Role> application on YYYY-MM-DD"
// Also catches simpler "declined" / "rejected" anywhere in notes.
const GMAIL_VERIFIED_RE = /gmail\s+decision\s+verified\s+(\d{4}-\d{2}-\d{2}):\s*([^;]+?)(?:explicitly\s+)?(declined|rejected)[^;]*/i;
const REJECT_IN_NOTES_RE = /\b(declined|rejected)\b/i;

// Matches "Applied" status (normalized)
function isAppliedStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'applied';
}

/**
 * Legacy-consumer compatibility fields for tracker-rot proposals (same shape
 * classifyEmail-based proposals carry): message_id, from, subject,
 * body_snippet. reply-matcher resolves candidates by message_id and matches
 * on from/subject/body_snippet, so these must be present and stable.
 */
function trackerRotCompatFields(app, snippet) {
  const idHash = createHash('sha1')
    .update(`tracker-rot::${app.num}::${snippet}`)
    .digest('hex')
    .slice(0, 16);
  return {
    message_id: `tracker-rot::${idHash}`,
    from: '',
    subject: `${app.company || ''} — ${app.role || ''}`.replace(/ — $/, '').trim(),
    body_snippet: snippet,
    // Both tracker-rot branches detect rejections. The consumer's keyword list
    // deliberately excludes bare "declined"/"rejected" (collision risk), but
    // classifyReply honors an explicit rejection signal (reply-matcher.mjs
    // `signal === 'rejection'`), so carry it so these proposals classify as
    // Rejected instead of Unknown.
    signal: 'rejection',
  };
}

/**
 * Scan the live tracker for Applied rows with rejection signals in notes.
 * Returns proposals WITHOUT writing anything.
 *
 * @returns {Promise<Proposal[]>}
 */
export async function scanTrackerRot() {
  const db = await import('../core/db.mjs');
  const allApps = db.listApplications();
  const proposals = [];

  for (const app of allApps) {
    if (!isAppliedStatus(app.status)) continue;
    const notes = String(app.notes || '');

    // High-confidence: explicit "Gmail decision verified ... declined" pattern
    const m = notes.match(GMAIL_VERIFIED_RE);
    if (m) {
      const verifiedDate = m[1];
      const snippet = m[0].slice(0, 200);
      proposals.push({
        matchedAppRef: app.num,
        company: app.company,
        role: app.role || null,
        detectedOutcome: 'rejected',
        evidenceSnippet: snippet,
        confidence: 'high',
        source: 'tracker-rot-scan',
        currentStatus: app.status,
        proposedStatus: 'Rejected',
        verifiedDate,
        addedAt: localToday(),
        ...trackerRotCompatFields(app, snippet),
      });
      continue;
    }

    // Medium-confidence: "declined" or "rejected" in notes + still Applied
    if (REJECT_IN_NOTES_RE.test(notes)) {
      const match = notes.match(REJECT_IN_NOTES_RE);
      const idx = match?.index ?? 0;
      const snippet = notes.slice(Math.max(0, idx - 30), idx + 80).replace(/\s+/g, ' ').trim();
      proposals.push({
        matchedAppRef: app.num,
        company: app.company,
        role: app.role || null,
        detectedOutcome: 'rejected',
        evidenceSnippet: snippet,
        confidence: 'medium',
        source: 'tracker-rot-scan',
        currentStatus: app.status,
        proposedStatus: 'Rejected',
        verifiedDate: null,
        addedAt: localToday(),
        ...trackerRotCompatFields(app, snippet),
      });
    }
  }

  return proposals;
}

// ── text ingestion ────────────────────────────────────────────────────────────

/**
 * Parse a raw email text block into subject/from/body.
 * Handles paste-reply.mjs's "--file format" (Subject:/From: headers optional).
 * @param {string} raw
 * @returns {{ subject: string, from: string, body: string }}
 */
export function parseEmailText(raw) {
  const lines = String(raw).split('\n');
  let subject = '';
  let from = '';
  let bodyStart = 0;

  // Look for header lines at top
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^subject:\s*/i.test(line)) {
      subject = line.replace(/^subject:\s*/i, '').trim();
      i++;
    } else if (/^from:\s*/i.test(line)) {
      from = line.replace(/^from:\s*/i, '').trim();
      i++;
    } else if (line.trim() === '') {
      i++;
      bodyStart = i;
      break;
    } else {
      // No headers found — whole thing is body
      break;
    }
  }
  const body = lines.slice(bodyStart).join('\n').trim();
  return { subject, from, body };
}

/**
 * Classify a parsed email and produce a proposal object.
 * Uses reply-matcher.mjs's classifyReply for outcome detection.
 *
 * @param {object} parsed - { subject, from, body }
 * @param {object} [opts]
 * @param {string} [opts.company]
 * @param {string} [opts.role]
 * @returns {Promise<Proposal>}
 */
export async function classifyEmail(parsed, opts = {}) {
  const { classifyReply, matchCandidates } = await import('../reply-matcher.mjs');
  const db = await import('../core/db.mjs');

  const cand = {
    subject: parsed.subject,
    from: parsed.from,
    body_snippet: parsed.body.slice(0, 500),
    signal: null,
    company: opts.company || extractCompanyFromText(parsed.from, parsed.subject, parsed.body),
    role: opts.role || '',
  };

  const classification = classifyReply(cand);

  // Map classifyReply types to our detectedOutcome vocabulary
  const outcomeMap = {
    'Rejected': 'rejected',
    'Interview': 'interview',
    'Responded': 'action-needed',
    'Need Action': 'action-needed',
    'Offer': 'interview',
    'Auto-confirmation': 'other',
    'Noise': 'other',
    'Unknown': 'other',
  };
  const detectedOutcome = outcomeMap[classification.type] || 'other';

  // Try to match against tracker
  const allApps = db.listApplications();
  const company = cand.company || '';
  let matchedAppRef = null;
  let confidence = 'low';

  if (company) {
    // Simple normalized match
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normCo = norm(company);
    const matches = allApps.filter(a => norm(a.company).includes(normCo) || normCo.includes(norm(a.company)));
    if (matches.length === 1) {
      matchedAppRef = matches[0].num;
      confidence = 'medium';
    } else if (matches.length > 1) {
      // Narrow by role if given
      const roleNorm = norm(opts.role || '');
      if (roleNorm) {
        const roleMatch = matches.filter(a => norm(a.role).includes(roleNorm));
        if (roleMatch.length === 1) {
          matchedAppRef = roleMatch[0].num;
          confidence = 'high';
        }
      }
    }
  }

  // High confidence for explicit rejection signals
  if (classification.evidence.length > 0 && detectedOutcome !== 'other') {
    confidence = confidence === 'high' ? 'high' : 'medium';
  }

  // Synthesise a stable unique message_id from the content so consumers that
  // do  candidates.find(c => c.message_id === match.message_id)  always resolve
  // to the right record even when pasted text has no real Message-ID header.
  const msgIdHash = createHash('sha1')
    .update(`${parsed.from}::${parsed.subject}::${parsed.body.slice(0, 300)}`)
    .digest('hex')
    .slice(0, 16);
  const message_id = `pasted::${msgIdHash}`;

  return {
    // ── legacy schema fields consumed by reply-watch.mjs and reply-matcher.mjs ──
    message_id,
    from: parsed.from || '',
    subject: parsed.subject || '',
    body_snippet: parsed.body.slice(0, 500),
    // ── new fields ──────────────────────────────────────────────────────────────
    matchedAppRef,
    company: company || '(unknown)',
    role: opts.role || null,
    detectedOutcome,
    evidenceSnippet: classification.evidence.join('; ').slice(0, 200) || parsed.subject.slice(0, 100),
    confidence,
    source: 'pasted-text',
    currentStatus: matchedAppRef ? (allApps.find(a => a.num === matchedAppRef)?.status || null) : null,
    proposedStatus: classification.suggestedTrackerUpdate !== 'none' ? classification.suggestedTrackerUpdate : null,
    addedAt: localToday(),
  };
}

/**
 * Ingest raw text (single email or file content) and return a proposal.
 * Does NOT write to reply-candidates.json — caller decides.
 *
 * @param {string} raw - Raw email text
 * @param {object} [opts] - { company, role }
 * @returns {Promise<Proposal>}
 */
export async function ingestText(raw, opts = {}) {
  const parsed = parseEmailText(raw);
  return classifyEmail(parsed, opts);
}

// Simple heuristic: extract company from sender domain or subject
function extractCompanyFromText(from, subject, body) {
  // Try sender domain
  const emailMatch = from?.match(/@([\w.-]+)/);
  if (emailMatch) {
    const domain = emailMatch[1].replace(/^mail\.|^noreply\.|^no-reply\.|^careers\.|^recruiting\.|^hr\./i, '');
    const parts = domain.split('.');
    if (parts.length >= 2) return parts[parts.length - 2]; // e.g. 'greenhouse' from mail.greenhouse.io
  }
  return '';
}

// ── candidates file management ────────────────────────────────────────────────

/**
 * Load existing proposals from reply-candidates.json.
 * Returns [] if file missing.
 * Throws if the file exists but cannot be parsed as a JSON array — prevents
 * a corrupt file from being silently replaced with an empty write (F7).
 */
export function loadCandidates(path = CANDIDATES_PATH) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`reply-ingest: cannot parse ${path} as JSON — refusing to proceed to avoid data loss (${err.message})`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`reply-ingest: ${path} is not a JSON array (got ${typeof raw}) — refusing to proceed to avoid data loss`);
  }
  return raw;
}

/**
 * Append proposals to reply-candidates.json (dedup by key).
 * Never overwrites: existing entries survive.
 * Uses write-then-rename so a crash during write cannot corrupt the file (F7).
 *
 * Dedup key (F6):
 *   - When matchedAppRef is set: `<appRef>::<source>::<detectedOutcome>`
 *   - When matchedAppRef is null (unmatched): content hash of company+source+
 *     evidenceSnippet so two distinct employers' rejections don't collide on the
 *     constant `null::pasted-text::rejected` that the old key produced.
 *
 * @param {Proposal[]} newProposals
 * @param {string} [path]
 * @returns {{ added: number, alreadyPresent: number }}
 */
export function appendCandidates(newProposals, path = CANDIDATES_PATH) {
  const existing = loadCandidates(path);

  const key = (p) => {
    if (p.matchedAppRef != null) {
      return `${p.matchedAppRef}::${p.source}::${p.detectedOutcome}`;
    }
    // Unmatched: dedup on message identity. message_id is a stable hash of
    // the original from/subject/body, so two different rejections relayed by
    // the same ATS sender (identical inferred company AND identical classifier
    // evidence phrases) still get distinct keys. Fall back to a content hash
    // over body_snippet (original message text), never evidenceSnippet
    // (generic classifier phrases shared across unrelated emails).
    if (p.message_id) return `unmatched::${p.message_id}`;
    const identity = `${p.company || ''}::${p.source}::${p.detectedOutcome}::${p.body_snippet || p.evidenceSnippet || ''}`;
    const h = createHash('sha1').update(identity).digest('hex').slice(0, 16);
    return `unmatched::${h}`;
  };

  const existingKeys = new Set(existing.map(key));
  const toAdd = newProposals.filter(p => !existingKeys.has(key(p)));
  const merged = [...existing, ...toAdd];

  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crash/signal during write cannot corrupt the file.
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  renameSyncWithRetry(tmpPath, path);

  return { added: toAdd.length, alreadyPresent: newProposals.length - toAdd.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const jsonOut = argv.includes('--json');
  const doRotScan = argv.includes('--scan-tracker-rot');

  let filePath = null;
  let textInput = null;
  let company = null;
  let role = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') filePath = argv[++i];
    else if (argv[i] === '--text') textInput = argv[++i];
    else if (argv[i] === '--company') company = argv[++i];
    else if (argv[i] === '--role') role = argv[++i];
    else if (!['--dry-run', '--json', '--scan-tracker-rot'].includes(argv[i]) && !argv[i - 1]?.startsWith('--')) {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }

  if (!doRotScan && !filePath && !textInput) {
    console.error([
      'Usage:',
      '  node auto/reply-ingest.mjs --scan-tracker-rot [--json] [--dry-run]',
      '  node auto/reply-ingest.mjs --file email.txt [--company Acme] [--dry-run] [--json]',
      '  node auto/reply-ingest.mjs --text "..." [--company Acme] [--dry-run] [--json]',
    ].join('\n'));
    process.exit(1);
  }

  const proposals = [];

  if (doRotScan) {
    const rotProposals = await scanTrackerRot();
    proposals.push(...rotProposals);
    if (!jsonOut) {
      console.log(`\n🔍 Tracker-rot scan: ${rotProposals.length} proposal(s) found\n`);
      for (const p of rotProposals) {
        const conf = p.confidence === 'high' ? '🔴' : '🟡';
        console.log(`${conf} #${p.matchedAppRef} ${p.company}${p.role ? ` — ${p.role}` : ''}`);
        console.log(`   Status: ${p.currentStatus} → proposed: ${p.proposedStatus}`);
        console.log(`   Evidence: ${p.evidenceSnippet.slice(0, 120)}`);
        console.log('');
      }
    }
  }

  if (filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    const proposal = await ingestText(raw, { company, role });
    proposals.push(proposal);
  }

  if (textInput) {
    const proposal = await ingestText(textInput, { company, role });
    proposals.push(proposal);
  }

  if (jsonOut) {
    console.log(JSON.stringify(proposals, null, 2));
  }

  if (!dryRun && proposals.length > 0) {
    const result = appendCandidates(proposals);
    if (!jsonOut) {
      console.log(`📝 reply-candidates.json: +${result.added} added, ${result.alreadyPresent} already present`);
    }
  } else if (dryRun && !jsonOut) {
    console.log(`[dry-run] Would write ${proposals.length} proposal(s) to ${CANDIDATES_PATH}`);
  }

  if (proposals.length === 0 && !jsonOut) {
    console.log('No proposals generated.');
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('reply-ingest:', err.message);
    process.exit(1);
  });
}
