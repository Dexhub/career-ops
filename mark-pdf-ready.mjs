#!/usr/bin/env node

/**
 * mark-pdf-ready.mjs — canonical CLI to flip a tracker row's PDF column ❌→✅ (#2172).
 *
 * The applications table in data/career-ops.db (core/db.mjs) is a shared
 * surface with multiple readers and writers. Before this script, the PDF
 * column had NO canonical writer at all — every caller (the web dashboard's
 * "pdf" mode) hand-edited the tracker via an LLM prompt instruction. This
 * gives it the same one-canonical-write-path treatment set-status.mjs already
 * gives the Status column: same db.tx() write path, same shared
 * tracker-parse/tracker-utils primitives.
 *
 * Usage:
 *   node mark-pdf-ready.mjs <report#> [--dry-run] [--json]
 *
 * Row resolution is by REPORT NUMBER (the NNN in reports/NNN-{slug}-{date}.md),
 * not the tracker `#` column — those two numbers differ by design (see
 * modes/pdf.md step 19's own comment), and callers of this script always have
 * the report number, not the tracker row id. Resolution matches
 * extractTrackerReportNumbers(row.report) against the given report number;
 * zero or 2+ matches fail closed rather than guessing.
 *
 * Idempotent: a row whose PDF cell is already ✅ is a no-op success (changed:
 * false), so a retried render never fails this step.
 *
 * The read-modify-write runs inside one db.tx() transaction (SQLite serializes
 * writers; the old shared tracker directory lock is retired). Only the PDF
 * column of the matched row changes; every other column is untouched.
 *
 * Exit codes: 0 success (including no-op re-runs) · 1 usage error or
 * non-retryable write failure · 2 row not found or missing tracker DB ·
 * 3 ambiguous match (2+ rows link the same report number) ·
 * 4 reserved (was tracker lock timeout — the DB needs no lock).
 */

import { existsSync } from 'fs';
import { extractTrackerReportNumbers } from './tracker-parse.mjs';
import { CLI_EXIT, makeCliFailWith } from './tracker-utils.mjs';
import * as db from './core/db.mjs';

const { OK: EXIT_OK, USAGE: EXIT_USAGE, NOT_FOUND: EXIT_NOT_FOUND, AMBIGUOUS: EXIT_AMBIGUOUS } = CLI_EXIT;

const USAGE = `Usage: node mark-pdf-ready.mjs <report#> [--dry-run] [--json]

  <report#>    The NNN from reports/NNN-{slug}-{date}.md (NOT the tracker # column)
  --dry-run    Resolve and validate, but write nothing
  --json       Machine-readable output on stdout (errors included)`;

// ── argument parsing ─────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const positional = [];
const flags = { dryRun: false, json: false };

for (const a of rawArgs) {
  if (a === '--dry-run') { flags.dryRun = true; }
  else if (a === '--json') { flags.json = true; }
  else if (a.startsWith('--')) { failUsage(`Unknown flag: ${a}`); }
  else { positional.push(a); }
}

if (positional.length !== 1) {
  failUsage(positional.length === 0 ? null : `Expected 1 argument (report#), got ${positional.length}`);
}

const [reportSelector] = positional;

// Shared with set-status.mjs (tracker-utils.mjs) so the JSON-vs-human error
// contract can't drift between the two canonical tracker-writer CLIs.
const failWith = makeCliFailWith(flags.json);

/**
 * Print usage (plus an optional specific complaint) and exit 1.
 *
 * @param {string|null} message - What was wrong with the invocation, if known.
 * @returns {never}
 */
function failUsage(message) {
  const msg = message ?? 'Expected 1 argument: <report#>';
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify({ error: msg, code: 'usage' }));
    console.error(`❌ ${msg}`);
  } else {
    if (message) console.error(`❌ ${message}\n`);
    console.error(USAGE);
  }
  process.exit(EXIT_USAGE);
}

if (!/^\d+$/.test(reportSelector)) {
  failUsage(`"${reportSelector}" is not a valid report number`);
}
const targetReportNum = parseInt(reportSelector, 10);

// ── tracker access ───────────────────────────────────────────────

const DB_FILE = db.resolveDbPath();
if (!existsSync(DB_FILE)) {
  failWith(EXIT_NOT_FOUND, 'no-tracker', `No tracker found at ${DB_FILE}`);
}

const rows = db.listApplications();
if (rows.length === 0) {
  failWith(EXIT_NOT_FOUND, 'empty-tracker', `Tracker at ${DB_FILE} has no data rows`);
}

const matches = rows.filter(r => extractTrackerReportNumbers(r.report).includes(targetReportNum));
if (matches.length === 0) {
  failWith(EXIT_NOT_FOUND, 'not-found', `No tracker row links report #${targetReportNum}`);
}
if (matches.length > 1) {
  // An ambiguous report-number-to-row mapping is a tracker data bug (two rows
  // linking the same report), not a legitimate disambiguation case — refuse
  // to guess which one to mark, same fail-closed stance as set-status.mjs's
  // duplicate-# guard.
  const candidates = matches.map(r => ({ num: r.num, company: r.company, role: r.role }));
  const listing = candidates.map(c => `#${c.num}\t${c.company}\t${c.role}`).join('\n');
  failWith(EXIT_AMBIGUOUS, 'ambiguous',
    `Report #${targetReportNum} is linked by ${matches.length} tracker rows — repair the Report cells:\n${listing}`,
    { candidates });
}
const target = matches[0];

// ── read-modify-write (SQLite serializes writers; db.tx below) ───

const alreadyReady = (target.pdf ?? '').trim() === '✅';
// Matches set-status.mjs's contract: `changed` reflects whether a write WOULD
// happen, computed independent of --dry-run, so a preview call can tell "would
// mark" apart from "already ✅" without actually writing.
const changed = !alreadyReady;

if (changed && !flags.dryRun) {
  try {
    db.tx(() => {
      db.updateApplication(target.num, { pdf: '✅' });
    });
  } catch (err) {
    failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${DB_FILE}: ${err.message}`);
  }
}

// ── report ───────────────────────────────────────────────────────

const result = {
  changed,
  num: target.num,
  company: target.company,
  role: target.role,
  reportNum: targetReportNum,
  ...(flags.dryRun ? { dryRun: true } : {}),
  tracker: DB_FILE,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const verb = flags.dryRun ? (alreadyReady ? 'already' : 'would mark') : changed ? 'marked' : 'already';
  console.log(`✅ #${target.num} ${target.company} — ${target.role}: ${verb} PDF ready`);
}
process.exit(EXIT_OK);
