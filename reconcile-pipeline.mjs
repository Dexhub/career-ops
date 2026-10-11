#!/usr/bin/env node
/**
 * reconcile-pipeline.mjs — Sync pipeline.md "Pendientes" with batch-state.tsv
 *
 * THE PROBLEM
 * batch-runner.sh records every evaluated offer in batch/batch-state.tsv, but
 * it never writes back to data/pipeline.md. Offers processed via batch mode
 * therefore stay in the "Pendientes" section forever — the next scan and the
 * next `/career-ops pipeline` run both re-surface them, and they get evaluated
 * again (duplicate reports, duplicate tracker rows).
 *
 * WHAT THIS DOES
 * For each `completed` / `skipped` entry in batch-state.tsv whose URL is still
 * sitting in pipeline.md "Pendientes", move that line to "Procesadas" with its
 * report link, score and PDF flag.
 *
 * Idempotent: an entry already moved (no longer in Pendientes) is a no-op, and
 * an entry already present in Procesadas is dropped from Pendientes without a
 * second copy. Safe to run after every batch.
 *
 * Run: node reconcile-pipeline.mjs [--dry-run]
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { normalizeReportLink } from './tracker-links.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import * as db from './core/db.mjs';

const CAREER_OPS = getCareerOpsRoot();

const KNOWN_FLAGS = ['--dry-run', '--help', '-h'];
const USAGE = `Usage: node reconcile-pipeline.mjs [--dry-run]
  Moves batch-processed offers out of the pipeline's "Pendientes" into "Procesadas".`;

// An unrecognized flag (typo'd --dry-run, say) used to be silently ignored
// and fall through to a LIVE run that writes the pipeline — the caller
// believed they were in dry-run mode and were not. Fail fast instead.
const args = process.argv.slice(2);
validateFlags(args, KNOWN_FLAGS, USAGE, { requireOperand: true });

const DRY_RUN = args.includes('--dry-run');

const REPORTS_DIR = join(CAREER_OPS, 'reports');
// Report links were historically written relative to data/pipeline.md; keep the
// same base so link text in the db stays byte-compatible with the old rows.
const PIPELINE_LINK_BASE = join(CAREER_OPS, 'data');

// ---- read batch state (batch_state table; `row` holds the original TSV line) ----
// row columns: id  url  status  started_at  completed_at  report_num  score  error  retries
const DONE = new Map(); // url -> { reportNum, score }
for (const rec of db.listBatchState()) {
  const c = String(rec.row || '').split('\t');
  if (c.length < 7) continue;
  const [, url, status, , , reportNum, score] = c;
  // "completed" and "skipped" (below --min-score) both produced a report.
  if (status !== 'completed' && status !== 'skipped') continue;
  if (!url || !url.trim()) continue;
  DONE.set(url.trim(), { reportNum: (reportNum || '').trim(), score: (score || '').trim() });
}

if (DONE.size === 0) {
  console.log('No completed batch entries in batch state — nothing to reconcile.');
  process.exit(0);
}

// ---- report lookup ----
let reportFiles = [];
try { reportFiles = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')); } catch { /* no reports dir */ }

function findReportFile(reportNum) {
  if (!reportNum || reportNum === '-') return null;
  const n = parseInt(reportNum, 10);
  if (Number.isNaN(n)) return null;
  return reportFiles.find(f => {
    const m = f.match(/^(\d+)-/);
    return m && parseInt(m[1], 10) === n;
  }) || null;
}

function readReportField(reportFile, field) {
  if (!reportFile) return null;
  try {
    const txt = readFileSync(join(REPORTS_DIR, reportFile), 'utf-8');
    // An empty header is unknown; never borrow the following URL/PDF line.
    const m = txt.match(new RegExp(`^\\*\\*${field}:\\*\\*([^\\r\\n]*)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function formatScore(value) {
  return /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 5 ? `${value}/5` : null;
}

// A valid numeric state score is authoritative; otherwise fall back to the report.
function resolveScore(stateScore, reportFile) {
  const state = formatScore(stateScore);
  if (state) return state;
  const rep = readReportField(reportFile, 'Score');
  if (rep) {
    // Scores may have Markdown decoration or trailing prose. The first
    // denominator is authoritative even when an annotation precedes it,
    // matching evaluator score cells: "4.2 (strong fit)/10" is not 4.2/5.
    const score = rep.match(/^[*_`]*(\d+(?:\.\d+)?)(?=$|[\s*_`/,(—–-])/);
    if (!score) return 'N/A';
    const denominator = rep.match(/\/[ \t]*(\d+(?:\.\d+)?)/);
    if (denominator) {
      const tail = rep.slice(denominator.index + denominator[0].length);
      if (Number(denominator[1]) !== 5 || (tail && !/^[\s*_`,;:.()\]—–-]/.test(tail))) return 'N/A';
    } else if (/^[*_`]*[ \t]*\//.test(rep.slice(score[0].length))) {
      return 'N/A'; // An explicit but unreadable scale is not a bare score.
    }
    return formatScore(score[1]) || 'N/A';
  }
  return 'N/A';
}

function resolvePdf(reportFile) {
  const rep = readReportField(reportFile, 'PDF');
  if (!rep) return '❌';
  return /not generated/i.test(rep) ? '❌' : '✅';
}

// ---- read the pipeline from the db ----
const PENDING_ITEM_RE = /^- \[ \]\s+/;

function lineUrl(body) {
  // "{url} | company | role"  ->  "{url}"
  const i = body.indexOf(' |');
  return (i >= 0 ? body.slice(0, i) : body).trim();
}

const pipelineRows = db.listPipelineItems();
if (!pipelineRows.length) {
  console.log('Pipeline is empty — nothing to reconcile.');
  process.exit(0);
}
const pendingRows = pipelineRows.filter(r => r.section === 'pending');
const processedRows = pipelineRows.filter(r => r.section === 'processed');

// URLs already in Procesadas — guards against a double copy on re-runs.
const procUrls = new Set();
for (const row of processedRows) {
  const m = row.raw.match(/^- \[x\]\s+(.+)$/i);
  if (!m) continue;
  // "[num](path) | url | company | role | score | PDF x" — url is field 2
  const parts = m[1].split('|').map(s => s.trim());
  if (parts[1]) procUrls.add(parts[1]);
}

// ---- walk Pendientes, decide keep vs. move ----
const moves = []; // { dbUrl, procLine }
const dupDrops = []; // db urls of stale Pendientes copies
const moved = [];
const skippedNoReport = [];

for (const row of pendingRows) {
  if (!PENDING_ITEM_RE.test(row.raw)) continue; // "- [!]" errors → keep
  const body = row.raw.replace(PENDING_ITEM_RE, '');
  const url = lineUrl(body);
  const done = DONE.get(url);
  if (!done) continue; // not processed → keep in Pendientes

  if (procUrls.has(url)) {
    // Already recorded in Procesadas — just drop the stale Pendientes copy.
    dupDrops.push(row.url);
    moved.push({ url, role: '(already in Procesadas)', dup: true });
    continue;
  }

  const reportFile = findReportFile(done.reportNum);
  if (!reportFile) {
    // No report on disk — leave it in Pendientes rather than write a dead link.
    skippedNoReport.push({ url, reportNum: done.reportNum || '?' });
    continue;
  }

  const parts = body.split('|').map(s => s.trim());
  const company = parts[1] || '';
  const role = parts[2] || '';
  const score = resolveScore(done.score, reportFile);
  const pdf = resolvePdf(reportFile);
  const num = parseInt(done.reportNum, 10);

  const reportLink = normalizeReportLink(`[${num}](reports/${reportFile})`, PIPELINE_LINK_BASE, CAREER_OPS);
  moves.push({
    dbUrl: row.url,
    procLine: `- [x] ${reportLink} | ${url} | ${company} | ${role} | ${score} | PDF ${pdf}`,
  });
  moved.push({ url, company, role, num, score });
  procUrls.add(url);
}

// ---- report & exit early if nothing changed ----
console.log('=== Reconcile pipeline ===');
for (const s of skippedNoReport) {
  console.warn(`⚠️  ${s.url} — batch reports report #${s.reportNum} but no reports/${s.reportNum}-*.md found; left in Pendientes.`);
}

if (moves.length === 0 && dupDrops.length === 0) {
  console.log('✅ pipeline already in sync — nothing to reconcile.');
  process.exit(0);
}

const realMoves = moved.filter(m => !m.dup);
console.log(`🔄 ${realMoves.length} processed entr${realMoves.length === 1 ? 'y' : 'ies'} moved Pendientes → Procesadas:`);
for (const m of realMoves) console.log(`   + #${m.num} ${m.company} — ${m.role} (${m.score})`);
const dups = moved.filter(m => m.dup);
if (dups.length) console.log(`🧹 ${dups.length} stale Pendientes entr${dups.length === 1 ? 'y' : 'ies'} dropped (already in Procesadas).`);
const newCount = pendingRows.length - moves.length - dupDrops.length;
console.log(`📋 Pendientes now: ${newCount} entr${newCount === 1 ? 'y' : 'ies'}`);

if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
  process.exit(0);
}

db.tx(() => {
  for (const mv of moves) {
    db.updatePipelineItem(mv.dbUrl, { section: 'processed', checked: 1, raw: mv.procLine });
  }
  for (const staleUrl of dupDrops) db.deletePipelineItem(staleUrl);
});
console.log(`✅ pipeline updated (${db.resolveDbPath()})`);
