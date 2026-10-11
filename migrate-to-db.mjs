#!/usr/bin/env node
// migrate-to-db.mjs — one-time import of every file-based data store into
// data/career-ops.db (see core/db.mjs). Idempotent: re-running upserts.
//
//   node migrate-to-db.mjs            import + verify counts
//   node migrate-to-db.mjs --archive  also move the old files to
//                                     data/migrated-archive-<date>/
//
// Faithfulness: applications.md is parsed with the SAME parser the tracker
// scripts use (tracker-parse.mjs resolveColumns/parseTrackerRow); scan-history
// with lib/scan-history-columns.mjs.

import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { resolveColumns, parseTrackerRow, isSeparatorRow, isHeaderRow } from './tracker-parse.mjs';
import { parseScanHistoryLine } from './lib/scan-history-columns.mjs';
import * as db from './core/db.mjs';

const ROOT = getCareerOpsRoot();
const DATA = join(ROOT, 'data');
const p = (...s) => join(DATA, ...s);
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf-8').split(/\r?\n/) : []);
const counts = {};

function importApplications() {
  const lines = readLines(p('applications.md'));
  if (!lines.length) return;
  const colmap = resolveColumns(lines);
  let n = 0;
  db.tx(() => {
    for (const line of lines) {
      if (!line.startsWith('|') || isSeparatorRow(line) || isHeaderRow(line)) continue;
      const row = parseTrackerRow(line, colmap);
      if (!row || !Number.isInteger(row.num)) continue;
      db.upsertApplication({
        num: row.num, date: row.date ?? '', company: row.company ?? '', role: row.role ?? '',
        via: row.via ?? '', location: row.location ?? '', score: row.score ?? '',
        status: row.status ?? '', pdf: row.pdf ?? '', report: row.report ?? '',
        notes: row.notes ?? '', url: row.url ?? '',
      });
      n++;
    }
  });
  counts.applications = n;
}

function importStatusLog() {
  let n = 0;
  db.tx(() => {
    for (const line of readLines(p('status-log.tsv'))) {
      if (!line.trim()) continue;
      const [num, date, from, to, source, note] = line.split('\t');
      if (!/^\d+$/.test(num ?? '')) continue;
      db.appendStatusEvent({ appNum: Number(num), eventDate: date ?? '', fromStatus: from ?? '', toStatus: to ?? '', source: source ?? '', note: note ?? '' });
      n++;
    }
  });
  counts.status_events = n;
}

function importFollowUps() {
  let rows = 0; let nexts = 0;
  db.tx(() => {
    for (const line of readLines(p('follow-ups.md'))) {
      const t = line.trim();
      const next = t.match(/^- next #(\d+)\s+(\S+)\s+\(set\s+(\S+)\)/);
      if (next) { db.setFollowUpNext(Number(next[1]), next[2], next[3]); nexts++; continue; }
      if (!t.startsWith('|') || isSeparatorRow(t)) continue;
      const cells = t.slice(1, -1).split('|').map((c) => c.trim());
      if (!/^\d+$/.test(cells[0] ?? '')) continue; // header or junk
      const appNum = (cells[1] ?? '').replace(/^#/, '');
      db.upsertFollowUp({
        num: Number(cells[0]), app_num: /^\d+$/.test(appNum) ? Number(appNum) : 0,
        date: cells[2] ?? '', company: cells[3] ?? '', role: cells[4] ?? '',
        channel: cells[5] ?? '', contact: cells[6] ?? '', notes: cells[7] ?? '',
      });
      rows++;
    }
  });
  counts.follow_ups = rows;
  counts.follow_up_next = nexts;
}

function importPipeline() {
  let n = 0;
  let section = 'pending';
  db.tx(() => {
    for (const line of readLines(p('pipeline.md'))) {
      if (/^##\s+Processed/i.test(line)) { section = 'processed'; continue; }
      if (/^##\s+Pending/i.test(line)) { section = 'pending'; continue; }
      const m = line.match(/^- \[( |x)\]\s+(.*)$/);
      if (!m) continue;
      const checked = m[1] === 'x' ? 1 : 0;
      const body = m[2].trim();
      // URL is the first http(s) token in the line (pending lines are bare
      // URLs; processed lines are "#N | url | company | ..." or "[N](report) | url | ...").
      const url = (body.match(/https?:\/\/\S+/) || [body])[0].replace(/\|$/, '').trim();
      if (!url) continue;
      // A URL present in both sections must end up processed/checked.
      const existing = db.get('SELECT section, checked FROM pipeline_items WHERE url = ?', [url]);
      if (existing) {
        if (section === 'processed' && existing.section !== 'processed') {
          db.updatePipelineItem(url, { section, checked, raw: line });
        }
        continue;
      }
      db.addPipelineItem({ url, section, checked, raw: line });
      n++;
    }
  });
  counts.pipeline_items = n;
}

function importScanHistory() {
  const seen = new Set();
  db.tx(() => {
    for (const line of readLines(p('scan-history.tsv'))) {
      if (!line.trim()) continue;
      const row = parseScanHistoryLine(line);
      if (!row.url || row.url === 'url') continue; // header
      db.upsertScanHistory(row); // append-only file: latest row for a URL wins
      seen.add(row.url);
    }
  });
  counts.scan_history = seen.size;
}

function importScanRuns() {
  let n = 0;
  db.tx(() => {
    for (const line of readLines(p('scan-runs.tsv'))) {
      if (!line.trim() || line.startsWith('timestamp\t')) continue;
      const cells = line.split('\t');
      const row = Object.fromEntries(db.SCAN_RUN_FIELDS.map((f, i) => [f, cells[i] ?? '']));
      db.appendScanRun(row);
      n++;
    }
  });
  counts.scan_runs = n;
}

function importPortalHealth() {
  let n = 0;
  db.tx(() => {
    for (const line of readLines(p('portal-health.tsv'))) {
      if (!line.trim() || line.startsWith('timestamp\t')) continue;
      const [timestamp, company, status] = line.split('\t');
      db.appendPortalHealth({ timestamp, company, status });
      n++;
    }
  });
  counts.portal_health = n;
}

function importDeadBoards() {
  let n = 0;
  db.tx(() => {
    for (const line of readLines(p('dead-boards.tsv'))) {
      if (!line.trim() || line.startsWith('ats\t')) continue;
      const [ats, board, misses, last_checked] = line.split('\t');
      if (!ats || !board) continue;
      db.upsertDeadBoard({ ats, board, misses: Number(misses) || 0, last_checked: last_checked ?? '' });
      n++;
    }
  });
  counts.dead_boards = n;
}

function importPdfIndex() {
  let n = 0;
  db.tx(() => {
    for (const line of readLines(p('pdf-index.tsv'))) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [report, pdf, html, format, date, kind] = line.split('\t');
      if (!report) continue;
      db.upsertPdfIndexEntry({ report, pdf: pdf ?? '', html: html ?? '', format: format ?? '', date: date ?? '', kind: kind ?? '' });
      n++;
    }
  });
  counts.pdf_index = n;
}

function importBatchState() {
  const file = join(ROOT, 'batch', 'batch-state.tsv');
  let n = 0;
  db.tx(() => {
    for (const line of readLines(file)) {
      if (!line.trim() || line.startsWith('id\t')) continue;
      const cols = line.split('\t');
      if (!cols[0]) continue;
      db.upsertBatchState({ id: cols[0], status: cols[2] ?? '', report_num: cols[5] ?? '', row: line });
      n++;
    }
  });
  counts.batch_state = n;
}

function importAutoJobs() {
  const dir = p('auto', 'jobs');
  let n = 0;
  if (!existsSync(dir)) { counts.auto_jobs = 0; return; }
  db.tx(() => {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const job = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        if (!job.urlKey) job.urlKey = basename(file, '.json');
        db.saveAutoJob(job);
        n++;
      } catch (err) {
        console.error(`  skipping ${file}: ${err.message}`);
      }
    }
  });
  counts.auto_jobs = n;
}

function verify() {
  console.log(`\nDB: ${db.resolveDbPath()}`);
  let ok = true;
  for (const [table, imported] of Object.entries(counts)) {
    const inDb = db.get(`SELECT COUNT(*) AS c FROM ${table}`).c;
    const mark = inDb >= imported ? 'ok' : 'MISMATCH';
    if (inDb < imported) ok = false;
    console.log(`  ${table.padEnd(16)} imported=${String(imported).padStart(5)}  in-db=${String(inDb).padStart(5)}  ${mark}`);
  }
  return ok;
}

function archiveOldFiles() {
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = p(`migrated-archive-${stamp}`);
  mkdirSync(dest, { recursive: true });
  const files = ['applications.md', 'pipeline.md', 'follow-ups.md', 'status-log.tsv',
    'scan-history.tsv', 'scan-runs.tsv', 'portal-health.tsv', 'dead-boards.tsv', 'pdf-index.tsv'];
  for (const f of files) {
    if (existsSync(p(f))) renameSync(p(f), join(dest, f));
  }
  const batch = join(ROOT, 'batch', 'batch-state.tsv');
  if (existsSync(batch)) renameSync(batch, join(dest, 'batch-state.tsv'));
  if (existsSync(p('auto', 'jobs'))) renameSync(p('auto', 'jobs'), join(dest, 'auto-jobs'));
  console.log(`\nArchived old stores to ${dest}`);
}

importApplications();
importStatusLog();
importFollowUps();
importPipeline();
importScanHistory();
importScanRuns();
importPortalHealth();
importDeadBoards();
importPdfIndex();
importBatchState();
importAutoJobs();
const ok = verify();
if (ok && process.argv.includes('--archive')) archiveOldFiles();
db.closeDb();
process.exit(ok ? 0 : 1);
