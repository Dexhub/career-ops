#!/usr/bin/env node

/**
 * tracker.mjs — CLI over the applications table in the career-ops SQLite DB.
 *
 * data/career-ops.db (core/db.mjs) is the single source of truth for tracker
 * data. The old data/applications.md markdown table and the derived
 * applications.db index are retired; `sync` is kept as a no-op alias so
 * existing automation that calls it keeps working.
 *
 * Usage:
 *   node tracker.mjs sync [--check]             # no-op: the DB is authoritative
 *   node tracker.mjs query [--status Applied] [--company acme] [--role designer]
 *                          [--since 2026-01-01] [--id N] [--limit 20] [--json]
 *   node tracker.mjs history --id N             # status transition log
 *   node tracker.mjs export [--out FILE] [--force]  # DB → markdown table (stdout by default)
 *   node tracker.mjs delete --num N [--dry-run] # remove one application row
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { writeFileAtomic } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import * as db from './core/db.mjs';

// templates/states.yml ships with the code, so it is resolved from this module's
// own directory (#3500/#3508: never cwd, never the data root).
const CODEBASE_ROOT = dirname(fileURLToPath(import.meta.url));
const STATES_PATH = join(CODEBASE_ROOT, 'templates/states.yml');
const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEPARATOR = '|---|------|---------|------|-------|--------|-----|--------|-------|';

// ── Canonical states (templates/states.yml is the source of truth) ──

function loadStates() {
  if (!existsSync(STATES_PATH)) {
    console.error(`Error: ${STATES_PATH} not found — cannot validate statuses (broken install: templates/states.yml ships with career-ops).`);
    process.exit(1);
  }
  const doc = yaml.load(readFileSync(STATES_PATH, 'utf-8'));
  const byKey = new Map(); // lowercased label/alias → canonical label
  const labels = [];
  for (const s of doc?.states || []) {
    if (!s?.label) continue;
    labels.push(s.label);
    byKey.set(s.label.toLowerCase(), s.label);
    if (s.id) byKey.set(String(s.id).toLowerCase(), s.label);
    for (const alias of s.aliases || []) byKey.set(String(alias).toLowerCase(), s.label);
  }
  return { byKey, labels };
}

// Strip markdown bold, trailing dates, and surrounding noise, then resolve
// against canonical labels/aliases. Returns the canonical label or null.
function normalizeStatus(raw, states) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\*\*/g, '')
    .replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '')
    .trim()
    .toLowerCase();
  return states.byKey.get(cleaned) || null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseApplicationId(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ── Query helpers ───────────────────────────────────────────────────

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const kv = args.find(a => a.startsWith(flag + '='));
  return kv ? kv.split('=').slice(1).join('=') : null;
}

// A pipe inside a cell would split the row; a newline would end it.
const cleanCell = (v) => String(v ?? '').replace(/\|/g, '│').replace(/\r?\n/g, ' ');

function rowToMarkdown(r) {
  return `| ${r.id} | ${cleanCell(r.date)} | ${cleanCell(r.company)} | ${cleanCell(r.role)} | ${cleanCell(r.score)} | ${cleanCell(r.status)} | ${cleanCell(r.pdf)} | ${cleanCell(r.report)} | ${cleanCell(r.notes)} |`;
}

// ── Commands ────────────────────────────────────────────────────────

// Historical command from the markdown era (applications.md → derived index).
// The DB is now the single store, so there is nothing to sync — kept as an
// alias so scripts and docs that call `tracker.mjs sync` keep working.
async function sync(args) {
  const count = db.get('SELECT COUNT(*) AS n FROM applications').n;
  console.error(`Tracker data lives in ${db.resolveDbPath()} (${count} applications) — sync is a no-op; the DB is authoritative.`);
  if (args.includes('--check')) console.error('(--check — nothing to diagnose; reads and writes go straight to the DB)');
}

async function query(args) {
  const states = loadStates();

  const where = [];
  const params = [];
  const status = flagValue(args, '--status');
  if (status) {
    const canonical = normalizeStatus(status, states);
    if (!canonical) { console.error(`Error: unknown status "${status}". Canonical: ${states.labels.join(', ')}`); process.exit(1); }
    where.push('status = ?'); params.push(canonical);
  }
  const company = flagValue(args, '--company');
  if (company) { where.push('company LIKE ?'); params.push(`%${company}%`); }
  const role = flagValue(args, '--role');
  if (role) { where.push('role LIKE ?'); params.push(`%${role}%`); }
  const since = flagValue(args, '--since');
  if (since) {
    if (!DATE_RE.test(since)) { console.error('Error: --since must be YYYY-MM-DD'); process.exit(1); }
    where.push('date >= ?'); params.push(since);
  }
  const idRaw = flagValue(args, '--id');
  if (args.some(arg => arg === '--id' || arg.startsWith('--id='))) {
    const id = parseApplicationId(idRaw);
    if (id === null) { console.error('Error: --id must be a positive integer'); process.exit(1); }
    where.push('num = ?'); params.push(id);
  }

  let sql = 'SELECT num AS id, date, company, role, score, status, pdf, report, notes FROM applications'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY num DESC';
  const limit = parseInt(flagValue(args, '--limit') || '0', 10);
  if (limit > 0) { sql += ' LIMIT ?'; params.push(limit); }

  const rows = db.all(sql, params);
  if (args.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(HEADER);
    console.log(SEPARATOR);
    for (const r of rows) console.log(rowToMarkdown(r));
    console.error(`\n${rows.length} row(s)`); // stderr so stdout stays pipeable
  }
}

async function history(args) {
  const id = parseApplicationId(flagValue(args, '--id'));
  if (id === null) { console.error('Error: history requires --id N (a positive integer)'); process.exit(1); }
  const app = db.getApplication(id);
  if (!app) { console.error(`Error: no application with id ${id}`); process.exit(1); }
  console.log(`#${app.num} ${app.company} — ${app.role}`);
  for (const e of db.listStatusEvents(id)) {
    console.log(`  ${e.event_date}  ${e.to_status}`);
  }
}

// ── Export (DB → markdown table) ────────────────────────────────────
// Renders the applications table as markdown — a human-readable view the user
// can save or diff. The DB stays the source of truth; the export is never read
// back by any career-ops script.

async function exportMd(args) {
  const outPath = flagValue(args, '--out');
  if (outPath && existsSync(outPath) && statSync(outPath).isDirectory()) {
    console.error(`Error: --out ${outPath} is a directory — pass a file path.`);
    process.exit(1);
  }

  const rows = db.listApplications();
  // Optional columns appear only when some row actually carries a value, in the
  // positions merge-tracker's conventions put them (Via after Company,
  // Location after Role, URL last before Notes stays simplest at the end).
  const hasVia = rows.some(r => r.via);
  const hasLocation = rows.some(r => r.location);
  const hasUrl = rows.some(r => r.url);

  const labels = ['#', 'Date', 'Company'];
  if (hasVia) labels.push('Via');
  labels.push('Role');
  if (hasLocation) labels.push('Location');
  labels.push('Score', 'Status', 'PDF', 'Report');
  if (hasUrl) labels.push('URL');
  labels.push('Notes');

  const header = `| ${labels.join(' | ')} |`;
  const separator = `|${labels.map(l => '-'.repeat(Math.max(3, l.length + 2))).join('|')}|`;
  const body = rows.map((r) => {
    const cells = [r.num, r.date, r.company];
    if (hasVia) cells.push(r.via || '—');
    cells.push(r.role);
    if (hasLocation) cells.push(r.location || '—');
    cells.push(r.score || '—', r.status, r.pdf || '❌', r.report || '—');
    if (hasUrl) cells.push(r.url || '');
    cells.push(r.notes || '');
    return `| ${cells.map(cleanCell).join(' | ')} |`;
  });

  const out = ['# Applications Tracker', '', header, separator, ...body, ''].join('\n');

  if (!outPath) {
    process.stdout.write(out);
    return;
  }
  mkdirSync(dirname(outPath) || '.', { recursive: true });
  // Never silently clobber — whatever was there is backed up first.
  if (existsSync(outPath)) {
    copyFileSync(outPath, outPath + '.bak');
    console.error(`Existing ${outPath} backed up to ${outPath}.bak`);
  }
  writeFileAtomic(outPath, out);
  console.error(`Exported ${body.length} applications to ${outPath}`);
}

// ── Delete ──────────────────────────────────────────────────────────

// `delete --num N` removes one application row (and its status events /
// follow-up links) from the DB.
async function deleteApp(args) {
  const num = parseApplicationId(flagValue(args, '--num'));
  if (num === null) {
    console.error('Usage: node tracker.mjs delete --num <N> [--dry-run]   (remove one application row by its number)');
    process.exit(1);
  }
  const app = db.getApplication(num);
  if (!app) {
    console.error(`No application numbered ${num} in ${db.resolveDbPath()}.`);
    process.exit(1);
  }
  if (args.includes('--dry-run')) {
    console.error(`Would remove application ${num} (${app.company} — ${app.role}).`);
    if (app.report && app.report !== '—' && app.report !== '-') console.error(`(report file would be orphaned: ${app.report})`);
    return;
  }
  db.deleteApplication(num);
  console.error(`Removed application ${num} (${app.company} — ${app.role}).`);
  if (app.report && app.report !== '—' && app.report !== '-') console.error(`Note: report file may now be orphaned — ${app.report}`);
}

// ── Main ────────────────────────────────────────────────────────────

const COMMANDS = { sync, query, history, export: exportMd, delete: deleteApp };

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.log('Usage: node tracker.mjs <sync|query|history|export|delete> [flags]');
    console.log('See the header comment of this file for examples, or docs/SCRIPTS.md.');
    process.exit(command ? 1 : 0);
  }
  await fn(args);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
