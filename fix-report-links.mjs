#!/usr/bin/env node
/**
 * fix-report-links.mjs — Repair tracker rows whose Report link points at a missing file
 *
 * verify-pipeline.mjs (Check 3) reports `Report not found: ...` for every row
 * whose Report cell links to a file that is not on disk, but it is read-only.
 * This script is the explicit, previewed repair: it rewrites ONLY that one
 * column to `—` (the tracker's existing "no report" value) in the applications
 * table of data/career-ops.db (core/db.mjs). Every other column of the row is
 * left exactly as it was; nothing is re-sorted or re-formatted. All rewrites
 * commit in one db.tx() transaction, which replaces the old backup-then-
 * atomic-replace dance over data/applications.md (retired store).
 *
 * "Broken" is decided by findDeadReportLink() in tracker-utils.mjs, the same
 * function verify-pipeline and merge-tracker use, so the tools always agree on
 * which rows are broken. It does not guess WHY a report is missing (#4748).
 * Links are inspected from the DB's directory (data/, where markdown links
 * were anchored, #760) and from the data root, same as merge-tracker.mjs.
 *
 * A Report cell that is anything other than exactly one markdown link (two
 * links, link plus text) is never rewritten: it is listed under "skipped,
 * please check by hand" instead.
 *
 * Run: node fix-report-links.mjs [--dry-run]
 */

import { existsSync } from 'fs';
import { dirname, basename } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { findDeadReportLink } from './tracker-utils.mjs';
import * as db from './core/db.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const NO_REPORT = '—';

// A Report cell that is exactly one markdown link, nothing else around it.
const SINGLE_LINK_RE = /^\[[^\]]*\]\([^)]+\)$/;

/**
 * Scan application rows and collect dead single-link Report cells to rewrite.
 * Pure: touches neither files nor the DB. Exported so tests can call it
 * directly (it used to take tracker lines; it now takes application rows).
 *
 * @param {object[]} apps - Application rows (db.listApplications() shape).
 * @param {string} trackerDir - Directory report links resolve from (data/).
 * @param {string} dataRoot - Data root.
 * @param {{stat?: Function}} [options] - Test seam for filesystem inspection.
 * @returns {{changed: object[], skipped: object[], inspectionErrors: object[]}}
 */
export function fixReportLinks(apps, trackerDir, dataRoot, options = {}) {
  const changed = [];
  const skipped = [];
  const inspectionErrors = [];
  for (const app of apps) {
    const reportCell = String(app.report ?? '');

    const firstLink = reportCell.match(/\]\(([^)]+)\)/)?.[1] ?? null;
    // Any Report cell that contains a link but is not exactly one bare link is
    // ambiguous by contract. Surface it for manual review before inspecting the
    // first target: otherwise a live first link hides a dead later link.
    if (firstLink !== null && !SINGLE_LINK_RE.test(reportCell)) {
      skipped.push({
        num: app.num, company: app.company, role: app.role,
        link: firstLink, cell: reportCell,
      });
      continue;
    }

    let inspectionFailure = null;
    const link = findDeadReportLink(reportCell, trackerDir, dataRoot, {
      stat: options.stat,
      onInspectionError: (failure) => { inspectionFailure = failure; },
    });
    if (inspectionFailure) {
      inspectionErrors.push({
        num: app.num, company: app.company, role: app.role, cell: reportCell,
        ...inspectionFailure,
      });
      continue;
    }
    if (link === null) continue; // no link (—, N/A, empty) or it resolves

    changed.push({ num: app.num, company: app.company, role: app.role, link, cell: reportCell });
  }
  return { changed, skipped, inspectionErrors };
}

const KNOWN_FLAGS = ['--help', '-h', '--dry-run'];
const USAGE = `Usage: node fix-report-links.mjs [options]

  Rewrites the Report cell of tracker rows whose markdown link points at a
  missing file to "${NO_REPORT}". Nothing else in the row changes.

  Options:
  --dry-run        List the rows that would change without writing the tracker DB
  -h, --help       Show this help and exit
  `;

function describe(info) {
  return `#${info.num} ${info.company} — ${info.role}: ${info.link}`;
}

const IS_CLI = isMainModule(import.meta.url);

if (IS_CLI) {
const args = process.argv.slice(2);

// Unrecognized flags exit 1 naming the flag; --help/-h print USAGE and exit 0.
validateFlags(args, KNOWN_FLAGS, USAGE);

const DRY_RUN = args.includes('--dry-run');
const CAREER_OPS = getCareerOpsRoot();
const DB_FILE = db.resolveDbPath();
// Report links were markdown links relative to data/applications.md, i.e. the
// data/ directory the DB also lives in. Same anchoring as merge-tracker.mjs.
const TRACKER_DIR = dirname(DB_FILE);

if (!existsSync(DB_FILE)) {
  console.log('No tracker database found. Nothing to fix.');
  process.exit(0);
}

const result = fixReportLinks(db.listApplications(), TRACKER_DIR, CAREER_OPS);

for (const c of result.changed) {
  console.log(`${DRY_RUN ? 'Would rewrite' : 'Rewrote'} ${describe(c)}`);
}

if (result.skipped.length > 0) {
  console.log(`\n⚠️  ${result.skipped.length} row(s) skipped, please check by hand (Report cell is not a single link):`);
  for (const s of result.skipped) {
    console.log(`  #${s.num} ${s.company} — ${s.role}: "${s.cell}"`);
  }
}

if (result.inspectionErrors.length > 0) {
  console.log(`\n⚠️  ${result.inspectionErrors.length} row(s) preserved because the report target could not be inspected:`);
  for (const item of result.inspectionErrors) {
    const details = item.errors.map(({ path, error }) => `${path} (${error.code ?? error.message})`).join('; ');
    console.log(`  #${item.num} ${item.company} — ${item.role}: ${details}`);
  }
}

console.log(`\n📊 ${result.changed.length} dead report link(s) ${DRY_RUN ? 'found' : 'fixed'}`);

if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else if (result.changed.length > 0) {
  // One transaction for all rewrites: either every dead link listed above is
  // fixed or none is. SQLite's atomicity replaces the old .bak backup.
  db.tx(() => {
    for (const c of result.changed) {
      db.updateApplication(c.num, { report: NO_REPORT });
    }
  });
  console.log(`✅ Written to ${basename(DB_FILE)}`);
} else {
  console.log('✅ No changes needed');
}
} // end IS_CLI
