#!/usr/bin/env node

/**
 * reserve-report-num.mjs - shared atomic report-number allocator.
 *
 * The CLI and every evaluator use the exported API below. Reservations account
 * for report files, reservation sentinels, tracker row IDs, and report links in
 * the applications table of data/career-ops.db (core/db.mjs — the retired
 * data/applications.md store is no longer read). O_CREAT|O_EXCL sentinel files
 * in reports/ keep claims atomic across processes: the sentinel IS the claim,
 * so no tracker lock is needed — a lost race surfaces as EEXIST and the
 * allocator retries past it. The old shared tracker directory lock only ever
 * guarded the occupancy scan, which SQLite now serializes by itself.
 *
 * Usage:
 *   node reserve-report-num.mjs
 *   node reserve-report-num.mjs --count 8
 *   node reserve-report-num.mjs --release 035
 *   node reserve-report-num.mjs --release 042-049
 *   node reserve-report-num.mjs --gc
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { extractTrackerReportNumbers } from './tracker-parse.mjs';
import * as db from './core/db.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const MAX_SENTINEL_AGE_MS = 4 * 60 * 60 * 1000;
const MAX_RETRIES = 50;
const MAX_COUNT = 50;
const RESERVATION_TOKEN = Symbol('career-ops-report-reservation-token');

/** Format a report ID with a minimum width of three digits. */
export function formatReportNumber(num) {
  if (!Number.isSafeInteger(num) || num < 1) {
    throw new TypeError(`Report number must be a positive integer, got ${num}`);
  }
  return String(num).padStart(3, '0');
}

function reportsDirFor(options = {}) {
  return resolve(options.reportsDir
    || process.env.CAREER_OPS_REPORTS_DIR
    || join(options.rootDir || ROOT, 'reports'));
}

// The tracker DB for a reservation. `CAREER_OPS_DB` wins (same contract as
// core/db.mjs resolveDbPath); otherwise the DB lives in the caller's data root
// so an options.rootDir override keeps pointing the whole set — reports dir,
// batch state, and tracker — at one workspace, as the old trackerPath did.
function dbFileFor(options = {}) {
  if (options.dbFile) return resolve(options.dbFile);
  if (process.env.CAREER_OPS_DB) return resolve(process.env.CAREER_OPS_DB);
  return resolve(join(options.rootDir || ROOT, 'data', 'career-ops.db'));
}

function batchStateFileFor(options = {}) {
  return resolve(options.batchStateFile
    || process.env.CAREER_OPS_BATCH_STATE
    || join(options.rootDir || ROOT, 'batch/batch-state.tsv'));
}

// Mirrors merge-tracker.mjs's loadFailedReportNumbers: a report number the
// batch runner itself recorded as "failed" must not be handed out again, or
// the two scripts disagree by construction — this script re-issues the
// number, then merge-tracker.mjs refuses to merge a tracker line for it.
//
// Failed numbers are read from BOTH the legacy batch/batch-state.tsv (which
// merge-tracker.mjs still reads) AND the DB's batch_state table, so the
// invariant holds through the store migration: a number either store marks
// "failed" is never re-issued.
function occupiedFromFailedBatchState(batchStateFile, dbFile) {
  const failed = new Set();
  // Digits only, positive, safe: parseInt would accept "12abc" and
  // 9007199254740992, and an unsafe number in the occupied set makes
  // reserveReportNumbers throw "No safe report-number range remains".
  const add = (reportNum) => {
    if (!reportNum || reportNum === '-') return;
    const n = /^\d+$/.test(reportNum) ? Number(reportNum) : NaN;
    if (Number.isSafeInteger(n) && n > 0) failed.add(n);
  };
  if (existsSync(batchStateFile)) {
    for (const line of readFileSync(batchStateFile, 'utf-8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('id\t')) continue;
      const cols = line.split('\t');
      if (cols.length < 6) continue;
      if (cols[2] === 'failed') add(cols[5]);
    }
  }
  if (existsSync(dbFile)) {
    withDbAt(dbFile, () => {
      for (const row of db.listBatchState()) {
        if (row.status === 'failed') add(String(row.report_num ?? ''));
      }
    });
  }
  return failed;
}

// A bare date file is not a report. `scan-ats-full.mjs --md-out reports/` writes
// its digest as `reports/YYYY-MM-DD.md`, which matches `/^(\d+)-/` and is read
// as report #2026 — pushing every later reservation to 2027+, silently and
// permanently.
//
// Deliberately narrow: report filenames in the wild are not all
// `NNN-slug-DATE.md` (`1001-taken.md` and `NNN-RESERVED.md` are both real), so
// requiring a trailing date would drop legitimate occupancy. Exclude only names
// that are *entirely* a date. See tests/reserve-report-num.test.mjs.
const BARE_DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

function occupiedFromReports(reportsDir) {
  const occupied = new Set();
  if (!existsSync(reportsDir)) return occupied;
  for (const name of readdirSync(reportsDir)) {
    if (BARE_DATE_FILE_RE.test(name)) continue;
    const match = name.match(/^(\d+)-/);
    if (!match) continue;
    const num = parseInt(match[1], 10);
    if (Number.isInteger(num) && num > 0) occupied.add(num);
  }
  return occupied;
}

// core/db.mjs resolves its connection from CAREER_OPS_DB / the data root on
// every call. Pointing it at this reservation's dbFile for the duration of a
// read keeps an options.rootDir/dbFile override honest instead of silently
// reading the default workspace's occupancy.
function withDbAt(dbFile, fn) {
  const prev = process.env.CAREER_OPS_DB;
  process.env.CAREER_OPS_DB = dbFile;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_DB;
    else process.env.CAREER_OPS_DB = prev;
  }
}

function occupiedFromTracker(dbFile) {
  const occupied = new Set();
  if (!existsSync(dbFile)) return occupied;
  withDbAt(dbFile, () => {
    for (const app of db.listApplications()) {
      if (app.num > 0) occupied.add(app.num);
      for (const reportNum of extractTrackerReportNumbers(app.report)) {
        if (reportNum > 0) occupied.add(reportNum);
      }
    }
  });
  return occupied;
}

function collectOccupied(reportsDir, dbFile, batchStateFile) {
  const occupied = occupiedFromReports(reportsDir);
  for (const num of occupiedFromTracker(dbFile)) occupied.add(num);
  for (const num of occupiedFromFailedBatchState(batchStateFile, dbFile)) occupied.add(num);
  return occupied;
}

function highestNumber(numbers) {
  let max = 0;
  for (const num of numbers) max = Math.max(max, num);
  return max;
}

function sentinelPath(reportsDir, num) {
  return join(reportsDir, `${formatReportNumber(num)}-RESERVED.md`);
}

function claimSlot(reportsDir, num, occupied, token) {
  if (occupied.has(num)) return false;
  try {
    writeFileSync(sentinelPath(reportsDir, num), JSON.stringify({
      pid: process.pid,
      token,
      created_at: new Date().toISOString(),
    }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

function readSentinelOwner(sentinel) {
  try {
    return JSON.parse(readFileSync(sentinel, 'utf-8'));
  } catch {
    return null;
  }
}

function releaseSlot(reportsDir, num, { token, force = false } = {}) {
  const sentinel = sentinelPath(reportsDir, num);
  try {
    if (!force && readSentinelOwner(sentinel)?.token !== token) return false;
    unlinkSync(sentinel);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Reserve one or more contiguous report IDs.
 *
 * @param {number} [count=1] Number of IDs to reserve (1-50).
 * @param {object} [options] Path overrides (rootDir, reportsDir, dbFile, batchStateFile).
 * @returns {Promise<number[]>} Reserved numeric IDs.
 */
export async function reserveReportNumbers(count = 1, options = {}) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new RangeError(`Reservation count must be an integer from 1 to ${MAX_COUNT}`);
  }

  const reportsDir = reportsDirFor(options);
  const dbFile = dbFileFor(options);
  const batchStateFile = batchStateFileFor(options);
  mkdirSync(reportsDir, { recursive: true });

  let occupied = collectOccupied(reportsDir, dbFile, batchStateFile);
  let base = highestNumber(occupied) + 1;
  const token = randomUUID();

  for (let tries = 0; tries < MAX_RETRIES; tries++) {
    const end = base + (count - 1);
    if (!Number.isSafeInteger(base) || !Number.isSafeInteger(end)) {
      throw new RangeError('No safe report-number range remains');
    }
    const claimed = [];
    let failedAt = null;
    for (let num = base; num <= end; num++) {
      if (claimSlot(reportsDir, num, occupied, token)) {
        claimed.push(num);
      } else {
        failedAt = num;
        break;
      }
    }
    if (failedAt == null) {
      Object.defineProperty(claimed, RESERVATION_TOKEN, { value: token });
      return claimed;
    }

    // A racing reserver claimed a slot in our range first. Its sentinel is on
    // disk now, so a fresh occupancy scan sees it; back off past the collision.
    for (const num of claimed) releaseSlot(reportsDir, num, { token });
    occupied = collectOccupied(reportsDir, dbFile, batchStateFile);
    base = Math.max(failedAt + 1, highestNumber(occupied) + 1);
  }

  throw new Error(`Could not claim ${count} report slot(s) after ${MAX_RETRIES} retries`);
}

/**
 * Release reservation sentinels after report creation or on failure.
 * Only the array returned by reserveReportNumbers owns its sentinels. The CLI
 * uses force mode as an explicit administrative cleanup path.
 */
export async function releaseReportNumbers(numbers, options = {}) {
  const reportsDir = reportsDirFor(options);
  const values = Array.isArray(numbers) ? numbers : [numbers];
  for (const num of values) {
    if (!Number.isSafeInteger(num) || num < 1) {
      throw new TypeError(`Report number must be a positive integer, got ${num}`);
    }
  }
  const force = options.force === true;
  const token = options.reservationToken || numbers?.[RESERVATION_TOKEN];
  if (!force && !token) throw new Error('Reservation ownership token is required for release');
  if (!existsSync(reportsDir)) return 0;

  // Unlinking a sentinel is atomic on its own; releaseSlot's token check keeps
  // a release scoped to its own reservation, so no cross-process lock is needed.
  return values.reduce(
    (removed, num) => removed + Number(releaseSlot(reportsDir, num, { token, force })),
    0,
  );
}

/** Remove reservation sentinels older than the configured TTL. */
export async function gcStaleReportReservations(options = {}) {
  const reportsDir = reportsDirFor(options);
  if (!existsSync(reportsDir)) return 0;

  const maxAgeMs = options.maxAgeMs ?? MAX_SENTINEL_AGE_MS;
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(reportsDir)) {
    if (!/^\d+-RESERVED\.md$/.test(name)) continue;
    const fullPath = join(reportsDir, name);
    try {
      if (now - statSync(fullPath).mtimeMs > maxAgeMs) {
        const owner = readSentinelOwner(fullPath);
        if (owner?.pid && processIsAlive(owner.pid)) continue;
        unlinkSync(fullPath);
        removed++;
        process.stderr.write(`reserve-report-num: GC stale sentinel ${name}\n`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  if (removed > 0) {
    process.stderr.write(`reserve-report-num: removed ${removed} stale sentinel(s)\n`);
  }
  return removed;
}

async function runCli() {
  const [,, cmd, arg] = process.argv;
  const options = {};

  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write([
      'Usage: node reserve-report-num.mjs [--count <1-N>] [--release <NNN>[-<MMM>]] [--gc]',
      '',
      '  (no flags)                Reserve 1 report number (default)',
      `  --count <1-${MAX_COUNT}>            Reserve N report numbers, printed as a range`,
      '  --release <NNN>[-<MMM>]  Release a previously reserved number or range',
      '  --gc                      Garbage-collect stale reservation sentinels',
      '',
    ].join('\n'));
    return 0;
  }

  if (cmd === '--release') {
    const match = (arg || '').match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      process.stderr.write('Usage: node reserve-report-num.mjs --release <NNN>[-<MMM>]\n');
      return 1;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    const rangeCount = end - start + 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 1 || end < start || rangeCount > MAX_COUNT) {
      process.stderr.write(`reserve-report-num: --release requires a safe ascending range of at most ${MAX_COUNT} slots\n`);
      return 1;
    }
    await releaseReportNumbers(
      Array.from({ length: rangeCount }, (_, index) => start + index),
      { ...options, force: true },
    );
    return 0;
  }

  if (cmd === '--gc') {
    await gcStaleReportReservations(options);
    return 0;
  }

  let count = 1;
  if (cmd === '--count') {
    if (!/^\d+$/.test(arg || '')) {
      process.stderr.write(`Usage: node reserve-report-num.mjs --count <1-${MAX_COUNT}>\n`);
      return 1;
    }
    count = parseInt(arg, 10);
    if (count < 1 || count > MAX_COUNT) {
      process.stderr.write(`Usage: node reserve-report-num.mjs --count <1-${MAX_COUNT}>\n`);
      return 1;
    }
  }

  try {
    const numbers = await reserveReportNumbers(count, options);
    process.stdout.write(count === 1
      ? `${formatReportNumber(numbers[0])}\n`
      : `${formatReportNumber(numbers[0])}-${formatReportNumber(numbers[numbers.length - 1])}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`reserve-report-num: ${err.message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli();
}
