#!/usr/bin/env node

/**
 * sync-pdf-flags.mjs — Reconciles the tracker PDF column against the pdf_index table.
 *
 * When a PDF is generated AFTER the initial evaluation, the tracker's PDF column
 * might still show ❌ (or '—'). This script reads the canonical pdf manifest
 * (the pdf_index table in data/career-ops.db) and upgrades matching tracker
 * rows to ✅ using reportNum as the join key. Cover-letter rows and rows with
 * no pdf path never mark a report ready — same reading of the manifest as
 * merge-tracker.mjs, so the two tools always agree on what counts.
 *
 * Normal sync commits all flag updates in one db.tx() transaction, which
 * replaces the old tracker lock + atomic file replace over the retired
 * data/applications.md and data/pdf-index.tsv stores.
 *
 * Prune mode (--prune) drops manifest rows whose PDF file is no longer on disk.
 * A deleted artifact otherwise keeps the manifest row alive, which causes the next
 * normal sync to re-assert ✅ on the tracker even though no file backs it. Prune
 * is kind-agnostic: it drops any row (CV or cover letter) whose pdf column points
 * at a missing file. It is a dry run by default — add --write to commit changes.
 *
 * Usage:
 *   node sync-pdf-flags.mjs [--dry-run] [--json]
 *   node sync-pdf-flags.mjs --prune [--write] [--json]
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { extractTrackerReportNumbers } from './tracker-parse.mjs';
import { resolveWorkspaceRoot, pathIsInsideCanonical } from './tracker-utils.mjs';
import * as db from './core/db.mjs';

const DB_FILE = db.resolveDbPath();

const flags = { dryRun: false, json: false, prune: false, write: false };
const unknownOptions = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') flags.dryRun = true;
  else if (arg === '--json') flags.json = true;
  else if (arg === '--prune') flags.prune = true;
  else if (arg === '--write') flags.write = true;
  else unknownOptions.push(arg);
}

// --prune is dry-run by default; --write opts in to committing changes.
// Outside prune mode, --write has no meaning — surface it as an unknown option
// to avoid silent surprises.
if (!flags.prune && flags.write) {
  unknownOptions.push('--write');
}

// --dry-run must win over --write
if (flags.dryRun) flags.write = false;

if (unknownOptions.length > 0) {
  const error = `unknown option(s): ${unknownOptions.join(', ')}`;
  if (flags.json) console.error(JSON.stringify({ error, code: 'unknown-option' }));
  else console.error(`Error: ${error}\nUsage: node sync-pdf-flags.mjs [--dry-run] [--json]\n       node sync-pdf-flags.mjs --prune [--write] [--json]`);
  process.exit(1);
}

if (!existsSync(DB_FILE)) {
  if (flags.json) console.log(JSON.stringify({ error: `No tracker found at ${DB_FILE}`, code: 'no-tracker' }));
  else console.error(`❌ No tracker found at ${DB_FILE}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Prune mode: drop manifest rows whose PDF is gone from disk.
// Kind-agnostic — a cover letter whose file was deleted is just as stale as a
// CV's. Flag-clearing (resetting ✅ on the tracker) is the follow-on half once
// #3887 introduces kind-awareness; this half is scoped to the manifest only.
// ---------------------------------------------------------------------------
if (flags.prune) {
  const entries = db.listPdfIndex();

  // The workspace root is needed to resolve the workspace-relative pdf paths
  // stored in the manifest (e.g. "output/042-acme-cv.pdf").
  const workspaceRoot = resolveWorkspaceRoot(DB_FILE);
  const outputDir = resolve(workspaceRoot, 'output');

  const prunedRows = [];

  for (const entry of entries) {
    const relPdf = (entry.pdf ?? '').trim();

    if (!relPdf) {
      // Malformed row (no pdf column) — keep it; not our business to remove it.
      continue;
    }

    const absPath = resolve(workspaceRoot, relPdf);
    if (!pathIsInsideCanonical(absPath, outputDir)) {
      prunedRows.push({ id: entry.id, relPdf, report: entry.report || '' });
      if (!flags.json) {
        const marker = flags.write ? '🗑️ ' : '🔎';
        const action = flags.write ? 'pruned' : 'would prune';
        console.log(`${marker} ${action}: ${relPdf} (report ${entry.report || '?'}) — outside output directory`);
      }
      continue;
    }

    if (!existsSync(absPath)) {
      prunedRows.push({ id: entry.id, relPdf, report: entry.report || '' });
      if (!flags.json) {
        const marker = flags.write ? '🗑️ ' : '🔎';
        const action = flags.write ? 'pruned' : 'would prune';
        console.log(`${marker} ${action}: ${relPdf} (report ${entry.report || '?'}) — file not found`);
      }
    }
  }

  const pruned = prunedRows.length;
  const kept = entries.length - pruned;

  if (pruned > 0 && flags.write) {
    try {
      // One transaction: every stale row drops or none does.
      db.tx(() => {
        for (const row of prunedRows) {
          db.run('DELETE FROM pdf_index WHERE id = ?', [row.id]);
        }
      });
    } catch (err) {
      if (flags.json) {
        console.log(JSON.stringify({ error: `Cannot write manifest: ${err.message}`, code: 'write-failure' }));
      } else {
        console.error(`❌ Cannot write manifest: ${err.message}`);
      }
      process.exit(1);
    }
  }

  const result = { pruned, kept, dryRun: !flags.write };
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const verb = flags.write ? 'pruned' : 'would prune (dry run — pass --write to commit)';
    console.log(`\n📊 Summary: ${pruned} row(s) ${verb}, ${kept} kept`);
    if (pruned > 0 && !flags.write) {
      console.log('ℹ️  Re-run with --write to remove stale rows, then run sync-pdf-flags.mjs to reconcile tracker flags.');
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Normal sync mode: set tracker PDF cell to ✅ for rows present in the manifest.
// ---------------------------------------------------------------------------

// Same manifest reading as merge-tracker.mjs: cover letters and rows without a
// pdf path never mark a report ready. Only purely numeric report keys count —
// draft keys like "4-draft" are ignored, exactly as the retired TSV reader did.
const manifestReports = new Set();
for (const entry of db.listPdfIndex()) {
  if (entry.kind === 'cover' || !entry.pdf) continue;
  const norm = entry.report_norm;
  if (norm && /^\d+$/.test(norm)) {
    const n = parseInt(norm, 10);
    if (n > 0) manifestReports.add(n);
  }
}

let updated = 0;
let unchanged = 0;
const patches = []; // app nums to flip, written in one tx after the scan

for (const app of db.listApplications()) {
  const reportNums = extractTrackerReportNumbers(app.report);
  const hasPdf = reportNums.some(num => manifestReports.has(num));

  if (hasPdf) {
    if (app.pdf !== '✅') {
      patches.push(app.num);
      updated++;
      if (!flags.json && !flags.dryRun) {
        console.log(`✅ #${app.num} ${app.company} — ${app.role}: PDF flag updated to ✅`);
      } else if (!flags.json && flags.dryRun) {
        console.log(`🔎 #${app.num} ${app.company} — ${app.role}: would update PDF flag to ✅`);
      }
    } else {
      unchanged++;
    }
  }
}

if (updated > 0 && !flags.dryRun) {
  try {
    // One transaction for every flag: all flip or none does.
    db.tx(() => {
      for (const num of patches) db.updateApplication(num, { pdf: '✅' });
    });
  } catch (err) {
    if (flags.json) console.log(JSON.stringify({ error: `Cannot write tracker: ${err.message}`, code: 'write-failure' }));
    else console.error(`❌ Cannot write tracker: ${err.message}`);
    process.exit(1);
  }
}

const result = { updated, unchanged, dryRun: flags.dryRun };
if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n📊 Summary: ${updated} PDF flags synced, ${unchanged} unchanged`);
  if (flags.dryRun) console.log('(dry-run — no changes written)');
}

process.exit(0);
