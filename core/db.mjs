// core/db.mjs — THE single data layer for career-ops.
//
// One SQLite database (data/career-ops.db) is the sole source of truth for
// all tracker, pipeline, scan, follow-up, PDF-index, and auto-pipeline state.
// The old markdown/TSV stores (applications.md, pipeline.md, follow-ups.md,
// status-log.tsv, scan-history.tsv, scan-runs.tsv, portal-health.tsv,
// dead-boards.tsv, pdf-index.tsv, data/auto/jobs/*.json) are retired; see
// migrate-to-db.mjs for the one-time import.
//
// Design rules:
//  - node:sqlite (DatabaseSync), WAL mode, busy_timeout 5000ms. Multiple
//    processes (web server, auto cycle, panel, CLI scripts) share the file;
//    SQLite serializes writers, so the old directory-lock protocols
//    (tracker lock, pipeline lock, portal-health lock, follow-ups lock) are
//    unnecessary for storage integrity. tx() gives multi-statement atomicity.
//  - Every consumer goes through this module. Do not open the DB file
//    directly elsewhere, and do not re-introduce file-based stores.
//  - Path resolution honors the same env overrides the file stores used
//    (CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR), plus CAREER_OPS_DB for tests.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { SCAN_HISTORY_COLUMNS } from '../lib/scan-history-columns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolveDbPath() {
  if (process.env.CAREER_OPS_DB) return process.env.CAREER_OPS_DB;
  const root = getCareerOpsRoot();
  return join(root, 'data', 'career-ops.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  num        INTEGER PRIMARY KEY,
  date       TEXT NOT NULL DEFAULT '',
  company    TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT '',
  via        TEXT NOT NULL DEFAULT '',
  location   TEXT NOT NULL DEFAULT '',
  score      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  pdf        TEXT NOT NULL DEFAULT '',
  report     TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_applications_status  ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);
CREATE INDEX IF NOT EXISTS idx_applications_date    ON applications(date);

CREATE TABLE IF NOT EXISTS status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_num     INTEGER NOT NULL,
  event_date  TEXT NOT NULL DEFAULT '',
  from_status TEXT NOT NULL DEFAULT '',
  to_status   TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_status_events_app ON status_events(app_num);

CREATE TABLE IF NOT EXISTS follow_ups (
  num     INTEGER PRIMARY KEY,
  app_num INTEGER NOT NULL DEFAULT 0,
  date    TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  role    TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  notes   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_app ON follow_ups(app_num);

CREATE TABLE IF NOT EXISTS follow_up_next (
  app_num   INTEGER PRIMARY KEY,
  next_date TEXT NOT NULL DEFAULT '',
  set_date  TEXT NOT NULL DEFAULT ''
);

-- data/pipeline.md replacement. section: 'pending' | 'processed'.
-- raw preserves the original annotated line for processed entries.
CREATE TABLE IF NOT EXISTS pipeline_items (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  section  TEXT NOT NULL DEFAULT 'pending',
  url      TEXT NOT NULL,
  checked  INTEGER NOT NULL DEFAULT 0,
  raw      TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_items_url ON pipeline_items(url);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_section ON pipeline_items(section, checked);

CREATE TABLE IF NOT EXISTS scan_history (
  url                TEXT PRIMARY KEY,
  first_seen         TEXT NOT NULL DEFAULT '',
  portal             TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  company            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  fingerprint        TEXT NOT NULL DEFAULT '',
  posted_at          TEXT NOT NULL DEFAULT '',
  trust_score        TEXT NOT NULL DEFAULT '',
  trust_flags        TEXT NOT NULL DEFAULT '',
  normalized_company TEXT NOT NULL DEFAULT '',
  requisition_id     TEXT NOT NULL DEFAULT '',
  language           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_scan_history_fingerprint ON scan_history(fingerprint);
CREATE INDEX IF NOT EXISTS idx_scan_history_company ON scan_history(normalized_company);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT '',
  status    TEXT NOT NULL DEFAULT '',
  companies TEXT NOT NULL DEFAULT '',
  boards    TEXT NOT NULL DEFAULT '',
  found     TEXT NOT NULL DEFAULT '',
  filtered_title TEXT NOT NULL DEFAULT '',
  filtered_tier TEXT NOT NULL DEFAULT '',
  filtered_location TEXT NOT NULL DEFAULT '',
  filtered_posting_age TEXT NOT NULL DEFAULT '',
  filtered_salary TEXT NOT NULL DEFAULT '',
  filtered_content TEXT NOT NULL DEFAULT '',
  filtered_cooldown TEXT NOT NULL DEFAULT '',
  dupes     TEXT NOT NULL DEFAULT '',
  new_added TEXT NOT NULL DEFAULT '',
  errors    TEXT NOT NULL DEFAULT '',
  filtered_blacklist TEXT NOT NULL DEFAULT '',
  filtered_visa TEXT NOT NULL DEFAULT '',
  filtered_posted_date TEXT NOT NULL DEFAULT '',
  filtered_country_eligibility TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_timestamp ON scan_runs(timestamp);

CREATE TABLE IF NOT EXISTS portal_health (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT '',
  company   TEXT NOT NULL DEFAULT '',
  status    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_portal_health_company ON portal_health(company);

CREATE TABLE IF NOT EXISTS dead_boards (
  ats          TEXT NOT NULL,
  board        TEXT NOT NULL,
  misses       INTEGER NOT NULL DEFAULT 0,
  last_checked TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ats, board)
);

CREATE TABLE IF NOT EXISTS pdf_index (
  report TEXT PRIMARY KEY,
  pdf    TEXT NOT NULL DEFAULT '',
  html   TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  date   TEXT NOT NULL DEFAULT '',
  kind   TEXT NOT NULL DEFAULT ''
);

-- Raw rows of the dormant legacy batch runner's batch-state.tsv
-- (batch-runner.sh). Readers only check status/report_num; row keeps the
-- original TSV line verbatim.
CREATE TABLE IF NOT EXISTS batch_state (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT '',
  report_num TEXT NOT NULL DEFAULT '',
  row        TEXT NOT NULL DEFAULT ''
);

-- auto/ pipeline job state (replaces data/auto/jobs/*.json).
-- data holds the full job object JSON; the typed columns mirror hot fields
-- for querying and MUST be kept in sync by saveAutoJob().
CREATE TABLE IF NOT EXISTS auto_jobs (
  url_key    TEXT PRIMARY KEY,
  url        TEXT NOT NULL DEFAULT '',
  company    TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT '',
  ats        TEXT NOT NULL DEFAULT '',
  stage      TEXT NOT NULL DEFAULT '',
  score      REAL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  priority   INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_auto_jobs_stage ON auto_jobs(stage);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`;

let _db = null;
let _dbPath = null;

export function openDb() {
  const path = resolveDbPath();
  if (_db && _dbPath === path) return _db;
  if (_db) { try { _db.close(); } catch { /* ignore */ } _db = null; }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  _db = db;
  _dbPath = path;
  return db;
}

export function closeDb() {
  if (_db) { try { _db.close(); } catch { /* ignore */ } }
  _db = null;
  _dbPath = null;
}

/** Run fn inside an IMMEDIATE transaction. Nested calls join the outer tx. */
let _txDepth = 0;
export function tx(fn) {
  const db = openDb();
  if (_txDepth > 0) return fn(db);
  db.exec('BEGIN IMMEDIATE');
  _txDepth++;
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    _txDepth--;
  }
}

// ---------- generic helpers ----------
export function all(sql, params = []) { return openDb().prepare(sql).all(...params); }
export function get(sql, params = []) { return openDb().prepare(sql).get(...params); }
export function run(sql, params = []) { return openDb().prepare(sql).run(...params); }

// ---------- applications ----------
export const APPLICATION_FIELDS = ['num', 'date', 'company', 'role', 'via', 'location', 'score', 'status', 'pdf', 'report', 'notes', 'url'];

export function listApplications({ status, company } = {}) {
  let sql = 'SELECT * FROM applications';
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (company) { where.push('company = ? COLLATE NOCASE'); params.push(company); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY num';
  return all(sql, params);
}

export function getApplication(num) {
  return get('SELECT * FROM applications WHERE num = ?', [num]);
}

export function maxApplicationNum() {
  return get('SELECT COALESCE(MAX(num), 0) AS n FROM applications').n;
}

export function upsertApplication(app) {
  const a = { via: '', location: '', pdf: '', report: '', notes: '', url: '', score: '', status: '', date: '', company: '', role: '', ...app };
  run(`INSERT INTO applications (num, date, company, role, via, location, score, status, pdf, report, notes, url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(num) DO UPDATE SET
         date=excluded.date, company=excluded.company, role=excluded.role,
         via=excluded.via, location=excluded.location, score=excluded.score,
         status=excluded.status, pdf=excluded.pdf, report=excluded.report,
         notes=excluded.notes, url=excluded.url, updated_at=excluded.updated_at`,
    [a.num, a.date, a.company, a.role, a.via, a.location, a.score, a.status, a.pdf, a.report, a.notes, a.url]);
}

export function updateApplication(num, patch) {
  const cols = Object.keys(patch).filter((k) => APPLICATION_FIELDS.includes(k) && k !== 'num');
  if (!cols.length) return;
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  run(`UPDATE applications SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE num = ?`,
    [...cols.map((c) => patch[c]), num]);
}

export function deleteApplication(num) {
  tx(() => {
    run('DELETE FROM applications WHERE num = ?', [num]);
    run('DELETE FROM status_events WHERE app_num = ?', [num]);
    run('DELETE FROM follow_ups WHERE app_num = ?', [num]);
    run('DELETE FROM follow_up_next WHERE app_num = ?', [num]);
  });
}

// ---------- status events ----------
export function appendStatusEvent({ appNum, eventDate, fromStatus = '', toStatus = '', source = '', note = '' }) {
  run('INSERT INTO status_events (app_num, event_date, from_status, to_status, source, note) VALUES (?, ?, ?, ?, ?, ?)',
    [appNum, eventDate, fromStatus, toStatus, source, note]);
}

export function listStatusEvents(appNum = null) {
  return appNum == null
    ? all('SELECT * FROM status_events ORDER BY id')
    : all('SELECT * FROM status_events WHERE app_num = ? ORDER BY id', [appNum]);
}

// ---------- follow-ups ----------
export function listFollowUps() { return all('SELECT * FROM follow_ups ORDER BY num'); }
export function maxFollowUpNum() { return get('SELECT COALESCE(MAX(num), 0) AS n FROM follow_ups').n; }
export function upsertFollowUp(f) {
  run(`INSERT INTO follow_ups (num, app_num, date, company, role, channel, contact, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(num) DO UPDATE SET app_num=excluded.app_num, date=excluded.date,
         company=excluded.company, role=excluded.role, channel=excluded.channel,
         contact=excluded.contact, notes=excluded.notes`,
    [f.num, f.app_num ?? f.appNum ?? 0, f.date ?? '', f.company ?? '', f.role ?? '', f.channel ?? '', f.contact ?? '', f.notes ?? '']);
}
export function listFollowUpNext() { return all('SELECT * FROM follow_up_next ORDER BY next_date'); }
export function setFollowUpNext(appNum, nextDate, setDate) {
  run(`INSERT INTO follow_up_next (app_num, next_date, set_date) VALUES (?, ?, ?)
       ON CONFLICT(app_num) DO UPDATE SET next_date=excluded.next_date, set_date=excluded.set_date`,
    [appNum, nextDate, setDate]);
}
export function clearFollowUpNext(appNum) { run('DELETE FROM follow_up_next WHERE app_num = ?', [appNum]); }

// ---------- pipeline items (inbox) ----------
export function listPipelineItems({ section, checked } = {}) {
  let sql = 'SELECT * FROM pipeline_items';
  const where = [];
  const params = [];
  if (section) { where.push('section = ?'); params.push(section); }
  if (checked !== undefined) { where.push('checked = ?'); params.push(checked ? 1 : 0); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY seq';
  return all(sql, params);
}
export function hasPipelineUrl(url) {
  return !!get('SELECT 1 FROM pipeline_items WHERE url = ?', [url]);
}
export function addPipelineItem({ url, section = 'pending', checked = 0, raw = '' }) {
  run(`INSERT INTO pipeline_items (section, url, checked, raw) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO NOTHING`, [section, url, checked ? 1 : 0, raw]);
}
export function updatePipelineItem(url, patch) {
  const allowed = ['section', 'checked', 'raw'];
  const cols = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!cols.length) return;
  run(`UPDATE pipeline_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE url = ?`,
    [...cols.map((c) => (c === 'checked' ? (patch[c] ? 1 : 0) : patch[c])), url]);
}
export function deletePipelineItem(url) { run('DELETE FROM pipeline_items WHERE url = ?', [url]); }

// ---------- scan history ----------
export const SCAN_HISTORY_FIELDS = [...SCAN_HISTORY_COLUMNS]; // url, first_seen, ..., requisition_id, language
export function getScanHistory(url) { return get('SELECT * FROM scan_history WHERE url = ?', [url]); }
export function listScanHistory() { return all('SELECT * FROM scan_history'); }
export function upsertScanHistory(row) {
  const r = Object.fromEntries(SCAN_HISTORY_FIELDS.map((f) => [f, row[f] ?? '']));
  run(`INSERT INTO scan_history (${SCAN_HISTORY_FIELDS.join(', ')})
       VALUES (${SCAN_HISTORY_FIELDS.map(() => '?').join(', ')})
       ON CONFLICT(url) DO UPDATE SET ${SCAN_HISTORY_FIELDS.filter((f) => f !== 'url').map((f) => `${f}=excluded.${f}`).join(', ')}`,
    SCAN_HISTORY_FIELDS.map((f) => r[f]));
}

// ---------- scan runs ----------
export const SCAN_RUN_FIELDS = ['timestamp', 'status', 'companies', 'boards', 'found', 'filtered_title', 'filtered_tier', 'filtered_location', 'filtered_posting_age', 'filtered_salary', 'filtered_content', 'filtered_cooldown', 'dupes', 'new_added', 'errors', 'filtered_blacklist', 'filtered_visa', 'filtered_posted_date', 'filtered_country_eligibility'];
export function appendScanRun(row) {
  run(`INSERT INTO scan_runs (${SCAN_RUN_FIELDS.join(', ')}) VALUES (${SCAN_RUN_FIELDS.map(() => '?').join(', ')})`,
    SCAN_RUN_FIELDS.map((f) => String(row[f] ?? '')));
}
export function listScanRuns() { return all('SELECT * FROM scan_runs ORDER BY id'); }

// ---------- portal health ----------
export function appendPortalHealth({ timestamp, company, status }) {
  run('INSERT INTO portal_health (timestamp, company, status) VALUES (?, ?, ?)', [timestamp ?? '', company ?? '', status ?? '']);
}
export function listPortalHealth() { return all('SELECT * FROM portal_health ORDER BY id'); }

// ---------- dead boards ----------
export function listDeadBoards() { return all('SELECT * FROM dead_boards'); }
export function upsertDeadBoard({ ats, board, misses, last_checked }) {
  run(`INSERT INTO dead_boards (ats, board, misses, last_checked) VALUES (?, ?, ?, ?)
       ON CONFLICT(ats, board) DO UPDATE SET misses=excluded.misses, last_checked=excluded.last_checked`,
    [ats, board, misses ?? 0, last_checked ?? '']);
}
export function deleteDeadBoard(ats, board) { run('DELETE FROM dead_boards WHERE ats = ? AND board = ?', [ats, board]); }

// ---------- pdf index ----------
export function getPdfIndexEntry(report) { return get('SELECT * FROM pdf_index WHERE report = ?', [report]); }
export function listPdfIndex() { return all('SELECT * FROM pdf_index'); }
export function upsertPdfIndexEntry({ report, pdf = '', html = '', format = '', date = '', kind = '' }) {
  run(`INSERT INTO pdf_index (report, pdf, html, format, date, kind) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(report) DO UPDATE SET pdf=excluded.pdf, html=excluded.html,
         format=excluded.format, date=excluded.date, kind=excluded.kind`,
    [report, pdf, html, format, date, kind]);
}

// ---------- batch state (legacy batch runner, dormant) ----------
export function listBatchState() { return all('SELECT * FROM batch_state'); }
export function upsertBatchState({ id, status = '', report_num = '', row = '' }) {
  run(`INSERT INTO batch_state (id, status, report_num, row) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, report_num=excluded.report_num, row=excluded.row`,
    [id, status, report_num, row]);
}

// ---------- auto jobs ----------
export function listAutoJobs(stages = null) {
  const rows = stages && stages.length
    ? all(`SELECT data FROM auto_jobs WHERE stage IN (${stages.map(() => '?').join(',')})`, stages)
    : all('SELECT data FROM auto_jobs');
  return rows.map((r) => JSON.parse(r.data));
}
export function loadAutoJob(urlKey) {
  const row = get('SELECT data FROM auto_jobs WHERE url_key = ?', [urlKey]);
  return row ? JSON.parse(row.data) : null;
}
export function saveAutoJob(job) {
  run(`INSERT INTO auto_jobs (url_key, url, company, role, ats, stage, score, attempts, priority, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(url_key) DO UPDATE SET url=excluded.url, company=excluded.company,
         role=excluded.role, ats=excluded.ats, stage=excluded.stage, score=excluded.score,
         attempts=excluded.attempts, priority=excluded.priority, data=excluded.data,
         updated_at=excluded.updated_at`,
    [job.urlKey, job.url ?? '', job.company ?? '', job.role ?? '', job.ats ?? '',
      job.stage ?? '', job.score ?? null, job.attempts ?? 0, job.priority ?? 0,
      JSON.stringify(job)]);
}
export function deleteAutoJob(urlKey) { run('DELETE FROM auto_jobs WHERE url_key = ?', [urlKey]); }

// ---------- meta ----------
export function getMeta(key) { return get('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null; }
export function setMeta(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}
