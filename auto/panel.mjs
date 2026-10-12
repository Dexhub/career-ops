#!/usr/bin/env node
// auto/panel.mjs — Mission Control: the single UI for career-ops.
//
// One origin, http://127.0.0.1:3001 —
//   /auto            the automation dashboard (auto/panel.html)
//   /api/auto/*      panel API (status, jobs, drill-down, operator view,
//                    start/stop/pause, requeue single or bulk)
//   everything else  reverse-proxied to the upstream web UI on 127.0.0.1:3003
//                    (Host/Origin rewritten so its origin-guard passes; a small
//                    floating "Mission Control" link is injected into HTML)
//
// The upstream app under web/ is never patched — `npm run update` stays safe.
// The panel never applies to anything by itself; it only spawns/kills the
// same `node auto/run.mjs` the user would run in a terminal.
//
//   node auto/panel.mjs               # serve on 127.0.0.1:3001
//   node auto/panel.mjs --port 3001
//   node auto/panel.mjs --self-test

import './lib/sanitize-env.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJobs, loadJob, pickOrder, queueOrderOptions, saveJob, transition, updateJob, submittedCountOn, STAGES } from './state.mjs';
import { AUTO_CONFIG_PATH, loadAutoConfig, POLICY_RANGES, previewPolicyEnforcement, resolveExecutionPolicy } from './lib/config.mjs';
import { loadRadar, saveRadar } from './radar.mjs';
import { agentFlags, setAgentEnabled } from './lib/agent-flags.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { createLearningContext } from './learning/context.mjs';
import { reviewStatus as learningReviewStatus } from './learning/reviewer.mjs';
import { slugifySegment } from '../application-artifacts.mjs';
import { handleLearningRequest, API_BASE as LEARNING_API_BASE, ASSET_BASE as LEARNING_ASSET_BASE } from './learning/api.mjs';
import { ORDER_MODES, freshnessBucket, postedAgeDays } from './learning/freshness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_OWNER = join(ROOT, 'data', 'auto', 'orchestrator.lock', 'owner.json');
const RUN_LOG = join(ROOT, 'data', 'auto', 'run.log');
const OUTPUT_ROOT = join(ROOT, 'output');
const PANEL_HTML = join(ROOT, 'auto', 'panel.html');
const PAUSE_FLAG = join(ROOT, 'data', 'auto', 'pause-requested');
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.CAREER_OPS_WEB_PORT) || 3003 };

// T21: fixed-name learning UI asset manifest (CONTRACTS G). No user paths, no
// wildcards — only these exact names resolve, all beneath auto/ui/learning/.
// T22/T23 create the remaining files; an unbuilt name is a plain 404.
const LEARNING_UI_ROOT = join(ROOT, 'auto', 'ui', 'learning');
const LEARNING_ASSET_MANIFEST = Object.freeze({
  'client.mjs': 'client.mjs',
  'index.mjs': 'index.mjs',
  'questions.mjs': 'questions.mjs',
  'profile.mjs': 'profile.mjs',
  'intelligence.mjs': 'intelligence.mjs',
  'operations.mjs': 'operations.mjs',
  'proposals.mjs': 'proposals.mjs',
  'learning.css': 'learning.css',
});

let panelChild = null; // cycle process started by this panel

// Desired-state file: records whether a cycle *should* be running (set on
// start, cleared on explicit stop or clean completion by run.mjs). The
// watchdog below restarts a dead cycle while this says running — e.g. after
// a crash, system sleep, or network outage — resuming from persisted state.
const DESIRED_FILE = join(ROOT, 'data', 'auto', 'desired-cycle.json');

export function writeDesired(obj) {
  try { writeFileSync(DESIRED_FILE, JSON.stringify({ ...obj, updated_at: new Date().toISOString() })); } catch { /* best effort */ }
}

export function readDesired() {
  try { return JSON.parse(readFileSync(DESIRED_FILE, 'utf8')); } catch { return null; }
}

// ---------- cycle control ----------

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function cycleState() {
  if (panelChild && processAlive(panelChild.pid)) {
    return { running: true, pid: panelChild.pid, source: 'panel', since: panelChild.startedAt };
  }
  try {
    const owner = JSON.parse(readFileSync(LOCK_OWNER, 'utf8'));
    if (owner?.pid && processAlive(owner.pid)) {
      return { running: true, pid: owner.pid, source: 'external', since: owner.started_at ?? null };
    }
  } catch { /* no lock, no cycle */ }
  return { running: false };
}

export function startCycle({ skipScan = false, cmd = null } = {}) {
  const state = cycleState();
  if (state.running) return { ok: false, error: `cycle already running (pid ${state.pid}, ${state.source})` };
  try { unlinkSync(PAUSE_FLAG); } catch { /* no stale pause */ }
  const logFd = openSync(RUN_LOG, 'a');
  const [bin, ...args] = cmd ?? [process.execPath, join(ROOT, 'auto', 'run.mjs'), ...(skipScan ? ['--skip-scan'] : [])];
  const child = spawn(bin, args, { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd); // the child holds its own copy
  child.startedAt = new Date().toISOString();
  child.on('exit', () => { if (panelChild === child) panelChild = null; });
  child.unref();
  panelChild = child;
  if (!cmd) writeDesired({ running: true, skipScan }); // real cycles only, not self-test cmds
  return { ok: true, pid: child.pid };
}

export function stopCycle() {
  const state = cycleState();
  if (!state.running) return { ok: false, error: 'no cycle running' };
  writeDesired({ running: false, reason: 'stopped' }); // before the kill: no watchdog restart
  try {
    if (state.source === 'panel') process.kill(-state.pid, 'SIGTERM'); // whole group: run.mjs + stage children
    else process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: `kill failed: ${err.message}` };
  }
  if (state.source === 'panel') panelChild = null;
  return { ok: true, stopped: state.pid, source: state.source };
}

/** Graceful pause: the orchestrator finishes the in-flight apply, then stops
 *  before picking the next job (run.mjs checks the flag at the loop top). */
export function requestPause() {
  if (!cycleState().running) return { ok: false, error: 'no cycle running' };
  writeFileSync(PAUSE_FLAG, new Date().toISOString());
  return { ok: true };
}

export function cancelPause() {
  try { unlinkSync(PAUSE_FLAG); return { ok: true }; } catch { return { ok: false, error: 'no pause requested' }; }
}

// ---------- watchdog ----------
// A cycle that should be running but has died (crash, kill -9, reboot, system
// sleep gone wrong) is restarted as soon as the network is reachable. Job
// state persists in the auto_jobs table (data/career-ops.db), so the restarted
// cycle resumes where the dead one stopped (stale `applying` rows are
// recovered by run.mjs itself).

async function probeNetwork() {
  try {
    await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

export async function watchdogTick({ probe = probeNetwork, start = startCycle, log = console.log } = {}) {
  const desired = readDesired();
  if (!desired?.running) return { acted: false, why: 'not desired' };
  if (cycleState().running) return { acted: false, why: 'already running' };
  if (!(await probe())) return { acted: false, why: 'network down' };
  const res = start({ skipScan: desired.skipScan !== false });
  log(`panel: watchdog restarted cycle (${res.ok ? `pid ${res.pid}` : res.error}) — desired running, process was dead`);
  try { appendFileSync(RUN_LOG, `panel: watchdog restarted cycle (${res.ok ? `pid ${res.pid}` : res.error})\n`); } catch { /* best effort */ }
  return { acted: true, result: res };
}

export function pauseRequested() {
  return existsSync(PAUSE_FLAG);
}

// ---------- data readers ----------

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function jobSummaries() {
  const order = Object.fromEntries(STAGES.map((s, i) => [s, i]));
  return listJobs()
    .map((j) => ({
      urlKey: j.urlKey, url: j.url, company: j.company, role: j.role, ats: j.ats,
      stage: j.stage, score: j.score, attempts: j.attempts, evalAttempts: j.evalAttempts || 0, lastError: j.lastError,
      priority: j.priority || 0, held: !!j.held,
      auditDir: j.auditDir, updatedAt: j.timestamps?.at(-1)?.at ?? null,
      // T11: verified publication metadata (null = honestly unknown; legacy
      // records have no dates block). Display-only — the queue order itself
      // comes from the shared comparator via pickOrder + queueOrderOptions.
      postedAt: j.dates?.postedAt ?? null, repostedAt: j.dates?.repostedAt ?? null,
      // T22: full verified-date block for the queue freshness labels (display
      // only; null = honestly unknown — the UI never invents a date).
      dates: j.dates ?? null,
    }))
    .sort((a, b) =>
      (order[a.stage] ?? 99) - (order[b.stage] ?? 99)
      || (b.score ?? 0) - (a.score ?? 0) // within a stage, highest score = next up
      || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/** Full detail for one job: state file plus every audit attempt with artifacts. */
export function jobDetail(urlKey) {
  const job = listJobs().find((j) => j.urlKey === urlKey);
  if (!job) return null;
  const attempts = [];
  if (job.auditDir) {
    const auditRoot = dirname(resolve(ROOT, job.auditDir));
    if (existsSync(auditRoot)) {
      for (const d of readdirSync(auditRoot, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith('attempt-')) continue;
        const dir = join(auditRoot, d.name);
        const rel = (f) => join(dir, f).slice(ROOT.length + 1);
        attempts.push({
          name: d.name,
          result: readJsonSafe(join(dir, 'result.json')),
          verdict: readJsonSafe(join(dir, 'verdict.json')),
          shots: readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map(rel),
          answersPath: existsSync(join(dir, 'answers.json')) ? rel('answers.json') : null,
        });
      }
      attempts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
  }
  return { job, attempts };
}

/** Serve a file strictly inside ROOT/output (audit artifacts only). */
export function safeOutputPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const abs = resolve(ROOT, relPath);
  if (!abs.startsWith(OUTPUT_ROOT + '/')) return null;
  if (!['.png', '.json', '.md', '.txt', '.yml', '.log'].includes(extname(abs))) return null;
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

/**
 * parked/failed → queued with attempts reset. The state machine enforces
 * legality. For jobs whose failure indicates an unknown submission outcome
 * (confirmation_text empty / no-confirmation patterns — T0.3), this is a
 * safety-blocked operation: the caller must pass force:true and the response
 * carries a warning string so the UI can surface it before allowing the requeue.
 *
 * @param {string} urlKey
 * @param {{force?: boolean}} [opts]  force:true bypasses the T0.3 unknown-outcome block
 * @returns {Promise<{ok, stage?, error?, code?, warning?}>}
 */
export async function requeueJob(urlKey, { force = false } = {}) {
  // T0.3: pre-flight the unknown-outcome check before the state-machine write,
  // so we can attach a warning even when force:true is passed.
  let unknownOutcomeWarning = null;
  const job = loadJob(urlKey);
  if (job) {
    const err = String(job.lastError ?? '');
    if (/confirmation_text[\s_]empty|no[-_]confirmation|confirmation.*empty|unknown.*submission|submission.*unknown/i.test(err)) {
      unknownOutcomeWarning = 'attempt may have actually submitted — verify with the employer before requeueing';
      if (!force) {
        return {
          ok: false,
          code: 'SUBMISSION_OUTCOME_UNKNOWN',
          error: `${job.urlKey} failed with an unknown submission outcome — ${unknownOutcomeWarning}`,
          warning: unknownOutcomeWarning,
        };
      }
    }
  }
  try {
    const updated = await updateJob(urlKey, {
      transitionTo: 'queued',
      patch: { attempts: 0, lastError: null, ...(force ? { force: true } : {}) },
    });
    return {
      ok: true,
      stage: updated.stage,
      ...(unknownOutcomeWarning ? { warning: unknownOutcomeWarning } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err.code === 'JOB_NOT_FOUND' ? 'job not found' : err.message,
      // T14 / T0.3: surface the typed refusal so bulk/panel callers can tell
      // a safety refusal from a plain error.
      ...(err.code ? { code: err.code } : {}),
      ...(unknownOutcomeWarning ? { warning: unknownOutcomeWarning } : {}),
    };
  }
}

/**
 * Bulk retry: requeue each key independently; one refusal never blocks the rest.
 * @param {string[]} keys
 * @param {{force?: boolean}} [opts]
 */
export async function requeueJobs(keys, { force = false } = {}) {
  const results = [];
  for (const key of (Array.isArray(keys) ? keys : [])) results.push({ key, ...(await requeueJob(key, { force })) });
  return { ok: results.every((r) => r.ok), requeued: results.filter((r) => r.ok).length, results };
}

/**
 * Re-rank: send a never-scored job back through the ranker. Clears the retry
 * counter + error so the next cycle's eval pass picks it up again. Legal for
 * `discovered` (still waiting) and `parked` jobs that never got a score;
 * anything already scored is refused — use requeue for apply-side retries.
 */
export async function rerankJob(urlKey) {
  const job = loadJob(urlKey);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.score != null) return { ok: false, error: `already scored ${job.score} — re-rank is for unscored jobs` };
  try {
    let updated;
    if (job.stage === 'parked') {
      updated = await updateJob(urlKey, { transitionTo: 'discovered', patch: { evalAttempts: 0, lastError: null } });
    } else if (job.stage === 'discovered') {
      updated = await updateJob(urlKey, { patch: { evalAttempts: 0, lastError: null } });
    } else {
      return { ok: false, error: `cannot re-rank from stage ${job.stage}` };
    }
    return { ok: true, stage: updated.stage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Bulk re-rank; one refusal never blocks the rest. */
export async function rerankJobs(keys) {
  const results = [];
  for (const key of (Array.isArray(keys) ? keys : [])) results.push({ key, ...(await rerankJob(key)) });
  return { ok: results.every((r) => r.ok), reranked: results.filter((r) => r.ok).length, results };
}

/**
 * Queue edits: bump a job to the front of the pick order, or bench it
 * without parking. Both touch panel-owned fields only (priority, held) —
 * never the stage, so the state machine stays authoritative.
 */
export async function editQueue(urlKey, action) {
  let patch;
  if (action === 'bump') {
    const top = Math.max(0, ...listJobs(['resume_ready', 'applying']).map((j) => j.priority || 0));
    patch = { priority: top + 1, held: false };
  } else if (action === 'unbump') patch = { priority: 0 };
  else if (action === 'hold') patch = { held: true, priority: 0 };
  else if (action === 'release') patch = { held: false };
  else return { ok: false, error: `unknown action "${action}"` };
  try {
    const job = await updateJob(urlKey, { patch });
    return { ok: true, priority: job.priority || 0, held: !!job.held };
  } catch (err) {
    return { ok: false, error: err.code === 'JOB_NOT_FOUND' ? 'job not found' : err.message };
  }
}

// ---------- config editing (whitelisted auto.yml fields) ----------

// Policy fields take their kind/min/max from POLICY_RANGES — the SAME table
// resolveExecutionPolicy() validates against (T12), so the panel can never
// accept a value the dispatcher refuses, or vice versa.
export const EDITABLE_CONFIG = Object.freeze({
  score_threshold:        { ...POLICY_RANGES.score_threshold,         label: 'Score threshold', help: 'jobs scoring ≥ this are queued to apply' },
  daily_soft_limit:       { ...POLICY_RANGES.daily_soft_limit,        label: 'Daily submit limit', help: 'applies stop for the day once reached' },
  jitter_min_minutes:     { ...POLICY_RANGES.jitter_min_minutes,      label: 'Jitter min (minutes)', help: 'random pause between applies, lower bound' },
  jitter_max_minutes:     { ...POLICY_RANGES.jitter_max_minutes,      label: 'Jitter max (minutes)', help: 'random pause between applies, upper bound' },
  max_attempts:           { ...POLICY_RANGES.max_attempts,            label: 'Max apply attempts', help: 'after this many errors a job is failed/parked' },
  'agent.timeout_minutes': { ...POLICY_RANGES['agent.timeout_minutes'], label: 'Apply timeout (minutes)', help: 'hard wall-clock cap per apply attempt' },
  'eval.model':           { kind: 'string', pattern: '^[\\w./:@-]+$', label: 'Eval model', help: 'model id on the local eval endpoint' },
  'eval.limit_per_cycle': { kind: 'int',    min: 1, max: 500,  label: 'Evals per cycle', help: 'max new postings ranked each cycle' },
});

/** Pure: apply whitelisted edits to the auto.yml text, preserving comments. */
export function applyConfigEdits(text, patch) {
  const changed = []; const errors = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    const spec = EDITABLE_CONFIG[key];
    if (!spec) { errors.push(`${key}: not editable`); continue; }
    let v;
    if (spec.kind === 'string') {
      v = String(raw).trim();
      if (!new RegExp(spec.pattern).test(v)) { errors.push(`${key}: invalid value`); continue; }
    } else {
      v = Number(raw);
      const bad = !Number.isFinite(v) || v < spec.min || v > spec.max || (spec.kind === 'int' && !Number.isInteger(v));
      if (bad) { errors.push(`${key}: must be a${spec.kind === 'int' ? 'n integer' : ' number'} ${spec.min}–${spec.max}`); continue; }
    }
    const [head, leaf] = key.includes('.') ? key.split('.') : [null, key];
    const indent = head ? '  ' : '';
    const re = new RegExp(`^${indent}${leaf}:[^\\n]*$`, 'm');
    if (!re.test(text)) { errors.push(`${key}: line not found in auto.yml`); continue; }
    text = text.replace(re, `${indent}${leaf}: ${v}`);
    changed.push(key);
  }
  return { text, changed, errors };
}

export function configPayload() {
  const cfg = loadAutoConfig({ fresh: true });
  const get = (k) => k.split('.').reduce((o, p) => (o ? o[p] : undefined), cfg);
  return {
    fields: Object.entries(EDITABLE_CONFIG).map(([key, spec]) => ({ key, ...spec, value: get(key) ?? null })),
    path: 'config/auto.yml',
  };
}

export function updateConfig(patch) {
  const raw = readFileSync(AUTO_CONFIG_PATH, 'utf8');
  const { text, changed, errors } = applyConfigEdits(raw, patch);
  if (changed.length) {
    writeFileSync(AUTO_CONFIG_PATH, text, 'utf8');
    loadAutoConfig({ fresh: true });
  }
  return { ok: errors.length === 0, changed, errors, note: changed.length ? 'applies from the next cycle start' : null };
}

// ---------- analytics ----------

export function analyticsPayload() {
  const jobs = listJobs();
  const submittedByDay = {}; const discoveredByDay = {};
  const scoreDist = {}; const reasonMap = {}; const applies = [];
  for (const j of jobs) {
    for (const t of j.timestamps ?? []) {
      const day = t.at.slice(0, 10);
      if (t.stage === 'discovered') discoveredByDay[day] = (discoveredByDay[day] || 0) + 1;
      if (t.stage === 'submitted') submittedByDay[day] = (submittedByDay[day] || 0) + 1;
    }
    if (j.score != null) { const b = String(Math.round(j.score)); scoreDist[b] = (scoreDist[b] || 0) + 1; }
    if ((j.stage === 'parked' || j.stage === 'failed') && j.lastError) {
      const r = j.lastError.slice(0, 90);
      reasonMap[r] = reasonMap[r] || { count: 0, stage: j.stage, companies: [] };
      reasonMap[r].count += 1;
      if (reasonMap[r].companies.length < 6) reasonMap[r].companies.push(j.company);
    }
    if (j.stage === 'submitted') {
      const sub = j.timestamps?.findLast?.((t) => t.stage === 'submitted');
      const appl = j.timestamps?.filter((t) => t.stage === 'applying').at(-1);
      if (sub && appl) {
        const minutes = Math.round((new Date(sub.at) - new Date(appl.at)) / 6000) / 10;
        if (minutes >= 0 && minutes < 24 * 60) applies.push({ company: j.company, role: j.role, minutes, day: sub.at.slice(0, 10) });
      }
    }
  }
  applies.sort((a, b) => b.day.localeCompare(a.day));
  const mins = applies.map((a) => a.minutes).sort((a, b) => a - b);
  const funnel = {};
  for (const j of jobs) funnel[j.stage] = (funnel[j.stage] || 0) + 1;
  return {
    total: jobs.length, funnel, submittedByDay, discoveredByDay, scoreDist,
    reasons: Object.entries(reasonMap).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count),
    applies,
    timePerApply: {
      count: mins.length,
      avg: mins.length ? Math.round(mins.reduce((s, m) => s + m, 0) / mins.length * 10) / 10 : null,
      median: mins.length ? mins[Math.floor(mins.length / 2)] : null,
    },
  };
}

// ---------- user-triggered one-shots: job scan + mail sync ----------
// Nothing scans or reads mail on a schedule (user directive 2026-10-12):
// both run ONLY when the user clicks the panel button (or runs the CLI).

const SCAN_ONESHOT_LOG = join(ROOT, 'data', 'auto', 'scan-manual.log');
const MAIL_SYNC_LOG = join(ROOT, 'data', 'auto', 'mail-sync.log');
let scanChild = null;
let mailSyncChild = null;

export function startJobScan({ cmd = null } = {}) {
  if (scanChild && processAlive(scanChild.pid)) return { ok: false, error: 'scan already running' };
  const fd = openSync(SCAN_ONESHOT_LOG, 'a');
  const [bin, ...args] = cmd ?? [process.execPath, join(ROOT, 'scan.mjs'), '--quiet'];
  const child = spawn(bin, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.on('exit', () => { if (scanChild === child) scanChild = null; });
  child.unref();
  scanChild = child;
  return { ok: true, pid: child.pid };
}

export function startMailSync({ cmd = null } = {}) {
  if (mailSyncChild && processAlive(mailSyncChild.pid)) return { ok: false, error: 'mail sync already running' };
  const fd = openSync(MAIL_SYNC_LOG, 'a');
  const [bin, ...args] = cmd ?? [process.execPath, join(ROOT, 'auto', 'mail-sync.mjs')];
  const child = spawn(bin, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.on('exit', () => { if (mailSyncChild === child) mailSyncChild = null; });
  child.unref();
  mailSyncChild = child;
  return { ok: true, pid: child.pid };
}

export function oneShotState() {
  return {
    scanning: !!(scanChild && processAlive(scanChild.pid)),
    mailSyncing: !!(mailSyncChild && processAlive(mailSyncChild.pid)),
  };
}

// ---------- radar (startup intel) ----------

const RADAR_LOG = join(ROOT, 'data', 'auto', 'radar.log');
const RADAR_STATUSES = ['watching', 'reach_out', 'contacted', 'dismissed'];
let radarChild = null;

export function startRadarScan({ refresh = false, cmd = null } = {}) {
  if (radarChild && processAlive(radarChild.pid)) return { ok: false, error: 'radar scan already running' };
  const fd = openSync(RADAR_LOG, 'a');
  const [bin, ...args] = cmd ?? [process.execPath, join(ROOT, 'auto', 'radar.mjs'), ...(refresh ? ['--refresh'] : [])];
  const child = spawn(bin, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.on('exit', () => { if (radarChild === child) radarChild = null; });
  child.unref();
  radarChild = child;
  return { ok: true, pid: child.pid };
}

export function radarPayload() {
  let tail = '';
  try { tail = readFileSync(RADAR_LOG, 'utf8').split('\n').filter(Boolean).slice(-12).join('\n'); } catch { /* no log yet */ }
  return { ...loadRadar(), scanning: !!(radarChild && processAlive(radarChild.pid)), logTail: tail };
}

export function updateRadarEntry(id, patch = {}) {
  const radar = loadRadar();
  const entry = radar.companies.find((c) => c.id === id);
  if (!entry) return { ok: false, error: 'company not found' };
  if (patch.status !== undefined) {
    if (!RADAR_STATUSES.includes(patch.status)) return { ok: false, error: `status must be one of ${RADAR_STATUSES.join(', ')}` };
    entry.status = patch.status;
  }
  if (patch.notes !== undefined) entry.notes = String(patch.notes).slice(0, 2000);
  saveRadar(radar);
  return { ok: true };
}

function logTail(lines = 200) {
  try {
    const text = readFileSync(RUN_LOG, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// ---------- operator view: what each worker is doing right now ----------

/** Same app key the apply worker uses for output/<key>/audit/attempt-N. */
function appKeyFor(job) {
  const num = (job.reportPath?.match(/(\d+)/) || [])[1] || '000';
  return `${num}-${slugifySegment(job.company)}-${slugifySegment(job.role, 'role')}`;
}

/** Pure: classify run.log lines into worker streams and find the live task. */
export function parseWorkers(tail, running) {
  const lines = tail.split('\n').filter(Boolean);
  const last = (pred) => { for (let i = lines.length - 1; i >= 0; i--) if (pred(lines[i])) return { line: lines[i], i }; return null; };
  const lastEvalStart = last((l) => l.startsWith('eval-queue: evaluating '));
  const lastEvalDone = last((l) => l.startsWith('eval-queue: done'));
  const evalCurrent = running && lastEvalStart && (!lastEvalDone || lastEvalDone.i < lastEvalStart.i)
    ? lastEvalStart.line.replace('eval-queue: evaluating ', '') : null;

  const tailLine = lines.at(-1) ?? '';
  let activity = 'idle';
  if (running) {
    if (tailLine.startsWith('apply-worker:')) activity = 'applying';
    else if (tailLine.startsWith('run: jitter sleep')) activity = 'waiting (jitter between applies)';
    else if (tailLine.startsWith('eval-queue:')) activity = 'ranking';
    else if (tailLine.startsWith('resume-select:')) activity = 'selecting resumes';
    else if (lastEvalStart && evalCurrent) activity = 'ranking';
    else activity = tailLine.startsWith('run:') ? tailLine.replace(/^run:\s*/, '') : 'scanning / working';
  }
  const streamTail = (prefix, n = 8) => lines.filter((l) => l.startsWith(prefix)).slice(-n);
  return {
    activity,
    lastLine: tailLine,
    eval: { current: evalCurrent, recent: streamTail('eval-queue:') },
    apply: { recent: streamTail('apply-worker:') },
    scan: { recent: streamTail('scan') },
  };
}

/** Live detail of the in-flight apply attempt: audit files as they appear. */
function liveAttempt() {
  const applying = listJobs('applying')[0];
  if (!applying) return null;
  const job = loadJob(applying.urlKey);
  // UUID-named attempt dirs are recorded on the job at claim time; the
  // numbered reconstruction remains as the legacy fallback.
  const attemptDir = job.auditDir || join(OUTPUT_ROOT, appKeyFor(job), 'audit', `attempt-${job.attempts || 1}`);
  const startedAt = job.timestamps?.findLast?.((t) => t.stage === 'applying')?.at ?? null;
  let files = [];
  if (existsSync(attemptDir)) {
    files = readdirSync(attemptDir)
      .map((name) => {
        const abs = join(attemptDir, name);
        try {
          const st = statSync(abs);
          return { name, p: abs.slice(ROOT.length + 1), mtime: st.mtime.toISOString(), size: st.size };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }
  const shots = files.filter((f) => f.name.endsWith('.png'));
  return {
    urlKey: job.urlKey, company: job.company, role: job.role,
    attempt: job.attempts || 1, startedAt,
    attemptDir: attemptDir.slice(ROOT.length + 1),
    latestShot: shots[0] ?? null,
    files: files.slice(0, 20),
    result: readJsonSafe(join(attemptDir, 'result.json')),
  };
}

// ---------- T2.3: stale-activity alarm ----------

// Threshold: if the cycle is running and no activity signal (run.log mtime or
// job-record update) moved in this many milliseconds, something is stuck.
const STALE_ACTIVITY_THRESHOLD_MS = 2 * 60 * 60 * 1000;

// Debounce: fire the macOS notification at most once per half-hour to avoid
// spam if the panel is polled repeatedly while the cycle is stuck.
let lastStaleNotifyAt = 0;
const STALE_NOTIFY_DEBOUNCE_MS = 30 * 60 * 1000;

/**
 * Check whether the cycle is running but has been silent for > 2h.
 * Pure computation — does not fire the notification itself (see statusPayload).
 *
 * @param {object} cycle — from cycleState()
 * @param {string|null} lastActivityAt — ISO timestamp of last run.log mtime, or null
 * @param {number} [nowMs] — injectable for tests
 * @returns {{ stale: boolean, silenceMs: number|null, lastActivityAt: string|null }}
 */
export function staleActivityAlarm(cycle, lastActivityAt, nowMs = Date.now()) {
  if (!cycle?.running) return { stale: false, silenceMs: null, lastActivityAt };
  if (!lastActivityAt) return { stale: false, silenceMs: null, lastActivityAt: null };
  const silenceMs = nowMs - new Date(lastActivityAt).getTime();
  const stale = silenceMs > STALE_ACTIVITY_THRESHOLD_MS;
  return { stale, silenceMs, lastActivityAt };
}

/**
 * Freshest activity timestamp across BOTH signals: run.log mtime (only moves
 * when the cycle runs under launchd, which redirects stdout there) and the
 * newest job-record update (DB-backed — moves on every transition regardless
 * of how the cycle was launched). Manually-launched cycles never touch
 * run.log, so the job signal is what prevents a permanent false alarm.
 *
 * @param {Array<{updatedAt?: string|null}>} [jobs] — pre-loaded summaries; loads fresh when omitted
 * @returns {string|null} ISO timestamp or null when neither signal exists
 */
function lastActivityIso(jobs = null) {
  let logMtime = null;
  try { logMtime = statSync(RUN_LOG).mtime.toISOString(); } catch { /* no log yet */ }
  let jobAt = null;
  for (const j of (jobs ?? jobSummaries())) {
    const at = j.updatedAt ?? null;
    if (at && (!jobAt || at > jobAt)) jobAt = at;
  }
  return [logMtime, jobAt].filter(Boolean).sort().at(-1) ?? null;
}

/** Fire a macOS notification for the stale-activity alarm (debounced). */
function maybeNotifyStale(alarmInfo) {
  if (!alarmInfo.stale) return;
  const now = Date.now();
  if (now - lastStaleNotifyAt < STALE_NOTIFY_DEBOUNCE_MS) return;
  lastStaleNotifyAt = now;
  const hours = (alarmInfo.silenceMs / 3_600_000).toFixed(1);
  const msg = `Auto pipeline appears stuck — no activity for ${hours}h`;
  try {
    spawnSync('osascript', ['-e',
      `display notification ${JSON.stringify(msg)} with title "career-ops auto ⚠️"`]);
  } catch { /* best effort */ }
}


export function operatorPayload() {
  const cycle = cycleState();
  const lastActivityAt = lastActivityIso();
  const alarm = staleActivityAlarm(cycle, lastActivityAt);
  return {
    cycle,
    pauseRequested: pauseRequested(),
    lastActivityAt,
    staleActivityAlarm: alarm,
    workers: parseWorkers(logTail(400), cycle.running),
    applying: liveAttempt(),
    agents: agentFlags(),
  };
}

// T19: purely informational, learning-gated review-due check. Strictly
// read-only — the panel may surface that a review is due, but it never runs
// one, and the reviewer itself can never start a cycle, submit, or change
// desired application-running state. Disabled learning reads as "not due".
function learningReviewInfo() {
  try {
    const ctx = createLearningContext({ codeRoot: ROOT, dataRoot: getCareerOpsRoot(), now: () => new Date() });
    return learningReviewStatus(ctx);
  } catch {
    return { enabled: false, reviewEnabled: false, due: false };
  }
}

function statusPayload() {
  const jobs = jobSummaries();
  const counts = {};
  for (const j of jobs) counts[j.stage] = (counts[j.stage] ?? 0) + 1;
  const applying = jobs.find((j) => j.stage === 'applying');
  let dailyLimit = null; let maxAttempts = 2;
  try {
    const cfg = loadAutoConfig();
    dailyLimit = cfg.daily_soft_limit ?? null;
    maxAttempts = cfg.max_attempts ?? 2;
  } catch { /* config absent */ }
  const day = new Date().toISOString().slice(0, 10);
  const cycle = cycleState();

  // T2.3: heartbeat + stale-activity alarm (activity = max of run.log mtime
  // and freshest job update — see lastActivityIso)
  const lastActivityAt = lastActivityIso(jobs);
  const alarm = staleActivityAlarm(cycle, lastActivityAt);
  // Fire macOS notification if stale (debounced — won't spam on every /api/auto/status poll)
  if (alarm.stale) maybeNotifyStale(alarm);

  return {
    cycle,
    pauseRequested: pauseRequested(),
    counts,
    maxAttempts,
    total: jobs.length,
    submittedToday: submittedCountOn(day),
    dailyLimit,
    workingOn: applying ? `${applying.company} — ${applying.role}` : null,
    digestToday: existsSync(join(ROOT, 'data', 'auto', `digest-${day}.md`)),
    learningReview: learningReviewInfo(),
    // T2.3: heartbeat line — panel clients poll /api/auto/status; this tells them
    // the panel is alive and when the pipeline last showed activity.
    heartbeat: { at: new Date().toISOString(), lastActivityAt },
    // T2.3: stale-activity alarm — prominently surfaces stuck cycles
    staleActivity: alarm.stale
      ? { stale: true, silenceMs: alarm.silenceMs, lastActivityAt: alarm.lastActivityAt,
          message: `⚠️  Pipeline appears stuck — no activity for ${((alarm.silenceMs ?? 0) / 3_600_000).toFixed(1)}h` }
      : { stale: false },
    logTail: logTail(),
  };
}

function digestToday() {
  const day = new Date().toISOString().slice(0, 10);
  const p = join(ROOT, 'data', 'auto', `digest-${day}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ---------- reverse proxy to the upstream web UI ----------

// A "Mission Control" section is injected into the upstream app's own left
// sidebar (<aside><nav>), cloning the look of its existing links. Pages
// without a sidebar fall back to the floating brand pill. The observer
// re-inserts after Next.js re-renders the nav.
const NAV_LINKS = [
  ['Overview', '/auto'], ['Operator', '/auto#operator'], ['Queue', '/auto#queue'],
  ['Errors', '/auto#errors'], ['Analytics', '/auto#analytics'], ['Radar', '/auto#radar'],
  ['Settings', '/auto#settings'],
];
const NAV_SNIPPET = `<script>(function(){
var LINKS=${JSON.stringify(NAV_LINKS)};
function insert(){
  var any=false;
  document.querySelectorAll('aside nav').forEach(function(nav){
    if(nav.querySelector('[data-mc]')){any=true;return;}
    var tpl=nav.querySelector('a[class*="text-muted"]')||nav.querySelector('a');
    var sect=document.createElement('div');sect.setAttribute('data-mc','1');
    var h=document.createElement('div');h.textContent='Mission Control';
    h.style.cssText='margin:18px 0 4px;padding:0 12px;font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:hsl(26 73% 51%)';
    sect.appendChild(h);
    LINKS.forEach(function(l){
      var a=document.createElement('a');a.href=l[1];a.textContent=l[0];
      if(tpl){a.className=tpl.className.replace(/bg-brand-soft|text-brand-text/g,'').trim();}
      else{a.style.cssText='display:block;padding:8px 12px;font-size:14px;color:inherit;text-decoration:none';}
      sect.appendChild(a);
    });
    nav.appendChild(sect);any=true;
  });
  return any;
}
function pill(){
  if(document.querySelector('[data-mc-pill]'))return;
  var a=document.createElement('a');a.setAttribute('data-mc-pill','1');a.href='/auto';a.textContent='Mission Control';
  a.style.cssText='position:fixed;right:16px;bottom:16px;z-index:99999;background:hsl(26 73% 51%);color:hsl(24 30% 12%);border-radius:999px;padding:8px 16px;font:500 13px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.15),0 4px 14px rgba(0,0,0,.18)';
  if(document.body)document.body.appendChild(a);
}
function go(){if(!insert())pill();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();
new MutationObserver(function(){insert();}).observe(document.documentElement,{childList:true,subtree:true});
})();</script>`;

/** Pure: headers for the proxied upstream request (Host/Origin/Referer rewritten). */
export function rewriteProxyHeaders(headers) {
  const h = { ...headers };
  h.host = `${UPSTREAM.host}:${UPSTREAM.port}`;
  delete h['accept-encoding']; // identity responses so HTML can be injected
  if (h.origin) h.origin = `http://${UPSTREAM.host}:${UPSTREAM.port}`;
  if (h.referer) h.referer = h.referer.replace(/^https?:\/\/[^/]+/, `http://${UPSTREAM.host}:${UPSTREAM.port}`);
  return h;
}

/** Pure: inject the Mission Control link into an upstream HTML page. */
export function injectNav(html) {
  return html.includes('</body>') ? html.replace('</body>', `${NAV_SNIPPET}</body>`) : html + NAV_SNIPPET;
}

function proxyToUpstream(req, res) {
  const up = httpRequest({
    host: UPSTREAM.host, port: UPSTREAM.port, path: req.url,
    method: req.method, headers: rewriteProxyHeaders(req.headers),
  }, (ur) => {
    const type = ur.headers['content-type'] ?? '';
    if (type.includes('text/html')) {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const body = injectNav(Buffer.concat(chunks).toString('utf8'));
        const h = { ...ur.headers };
        delete h['content-length']; delete h['transfer-encoding']; delete h['content-encoding'];
        res.writeHead(ur.statusCode, { ...h, 'content-length': Buffer.byteLength(body) });
        res.end(body);
      });
    } else {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    }
  });
  up.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<body style="background:#101014;color:#d8d8e0;font:14px ui-monospace,monospace;padding:40px">'
      + '<h2>Upstream web UI is not responding</h2>'
      + `<p>Expected on ${UPSTREAM.host}:${UPSTREAM.port} (launchd service io.career-ops.web-ui).</p>`
      + '<p><a style="color:#58a6ff" href="/auto">&larr; Mission Control still works</a></p></body>');
  });
  req.pipe(up);
}

// ---------- http ----------

function hostAllowed(req) {
  const host = (req.headers.host ?? '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

export function createPanelServer() {
  return createServer(async (req, res) => {
    if (!hostAllowed(req)) return send(res, 403, { error: 'loopback only' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/auto' || p === '/auto/')) {
        return send(res, 200, readFileSync(PANEL_HTML, 'utf8'), 'text/html; charset=utf-8');
      }
      // T21: learning API and fixed-manifest assets (handler in learning/api.mjs).
      if (p === LEARNING_API_BASE || p.startsWith(`${LEARNING_API_BASE}/`) || p.startsWith(LEARNING_ASSET_BASE)) {
        await handleLearningRequest(req, res, {
          assetRoot: LEARNING_UI_ROOT, assetManifest: LEARNING_ASSET_MANIFEST,
        });
        return undefined;
      }
      if (p.startsWith('/api/auto/')) {
        if (req.method === 'GET' && p === '/api/auto/status') return send(res, 200, statusPayload());
        if (req.method === 'GET' && p === '/api/auto/jobs') return send(res, 200, { jobs: jobSummaries() });
        // T22: read-only ordering preview — the SAME shared comparator
        // (pickOrder -> learning/freshness.mjs orderJobs) under a requested
        // mode. Never changes the live order: liveMode stays whatever
        // queueOrderOptions() says, and nothing is written.
        if (req.method === 'GET' && p === '/api/auto/queue-preview') {
          const mode = url.searchParams.get('mode') || 'existing';
          if (!ORDER_MODES.includes(mode)) {
            return send(res, 422, { error: `unknown mode "${mode}"`, modes: [...ORDER_MODES] });
          }
          const now = new Date();
          const ordered = pickOrder(listJobs(), 2, { mode, now });
          return send(res, 200, {
            mode, modes: [...ORDER_MODES], liveMode: queueOrderOptions().mode,
            items: ordered.map((j, i) => ({
              rank: i + 1, urlKey: j.urlKey, company: j.company, role: j.role,
              stage: j.stage, priority: j.priority || 0, score: j.score ?? null,
              dates: j.dates ?? null,
              firstSeen: j.dates?.firstSeenAt ?? j.timestamps?.[0]?.at ?? null,
              lastTransition: j.timestamps?.at(-1)?.at ?? null,
              ageDays: postedAgeDays(j.dates ?? {}, now),
              bucket: freshnessBucket(j.dates ?? {}, now),
            })),
          });
        }
        if (req.method === 'GET' && p === '/api/auto/job') {
          const detail = jobDetail(url.searchParams.get('key'));
          return detail ? send(res, 200, detail) : send(res, 404, { error: 'job not found' });
        }
        if (req.method === 'GET' && p === '/api/auto/file') {
          const abs = safeOutputPath(url.searchParams.get('p'));
          if (!abs) return send(res, 404, { error: 'not found' });
          const types = { '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain', '.yml': 'text/plain', '.log': 'text/plain' };
          return send(res, 200, readFileSync(abs), types[extname(abs)]);
        }
        if (req.method === 'GET' && p === '/api/auto/operator') return send(res, 200, operatorPayload());
        if (req.method === 'GET' && p === '/api/auto/digest') {
          const text = digestToday();
          return text ? send(res, 200, text, 'text/plain; charset=utf-8') : send(res, 404, { error: 'no digest today' });
        }
        if (req.method === 'POST' && p === '/api/auto/start') {
          const body = await readBody(req);
          return send(res, 200, startCycle({ skipScan: !!body.skipScan }));
        }
        if (req.method === 'POST' && p === '/api/auto/stop') return send(res, 200, stopCycle());
        if (req.method === 'POST' && p === '/api/auto/pause') return send(res, 200, requestPause());
        if (req.method === 'POST' && p === '/api/auto/resume') return send(res, 200, cancelPause());
        if (req.method === 'POST' && p === '/api/auto/requeue') {
          const body = await readBody(req);
          const force = !!body.force;
          return send(res, 200, body.keys ? await requeueJobs(body.keys, { force }) : await requeueJob(body.key, { force }));
        }
        if (req.method === 'POST' && p === '/api/auto/rerank') {
          const body = await readBody(req);
          return send(res, 200, body.keys ? await rerankJobs(body.keys) : await rerankJob(body.key));
        }
        if (req.method === 'POST' && p === '/api/auto/agent') {
          const body = await readBody(req);
          return send(res, 200, setAgentEnabled(body.agent, !!body.enabled));
        }
        if (req.method === 'POST' && p === '/api/auto/queue-edit') {
          const body = await readBody(req);
          return send(res, 200, await editQueue(body.key, body.action));
        }
        if (req.method === 'GET' && p === '/api/auto/config') return send(res, 200, configPayload());
        if (req.method === 'GET' && p === '/api/auto/policy-preview') {
          // Read-only: what the current policy would block in the existing
          // backlog, plus historical submissions outside the allowlist
          // (surfaced for reconciliation, never retro-labeled).
          try {
            const policy = resolveExecutionPolicy({ cfg: loadAutoConfig({ fresh: true }) });
            return send(res, 200, { policy, preview: previewPolicyEnforcement(listJobs(), policy) });
          } catch (err) {
            return send(res, 500, { error: err.message, code: err.code ?? null });
          }
        }
        if (req.method === 'POST' && p === '/api/auto/config') {
          const body = await readBody(req);
          return send(res, 200, updateConfig(body.patch ?? body));
        }
        if (req.method === 'GET' && p === '/api/auto/analytics') return send(res, 200, analyticsPayload());
        if (req.method === 'GET' && p === '/api/auto/radar') return send(res, 200, radarPayload());
        if (req.method === 'POST' && p === '/api/auto/radar/scan') {
          const body = await readBody(req);
          return send(res, 200, startRadarScan({ refresh: !!body.refresh }));
        }
        if (req.method === 'POST' && p === '/api/auto/scan') return send(res, 200, startJobScan());
        if (req.method === 'POST' && p === '/api/auto/mail-sync') return send(res, 200, startMailSync());
        if (req.method === 'GET' && p === '/api/auto/oneshots') return send(res, 200, oneShotState());
        if (req.method === 'POST' && p === '/api/auto/radar/update') {
          const body = await readBody(req);
          return send(res, 200, updateRadarEntry(body.id, body.patch ?? {}));
        }
        return send(res, 404, { error: 'not found' });
      }
      return proxyToUpstream(req, res);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
}

// ---------- self-test / main ----------

function isMainModule(metaUrl) {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

async function selfTest() {
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`); if (!ok) failed++; };

  const s = statusPayload();
  check('status payload has cycle/counts/submittedToday/dailyLimit',
    'cycle' in s && 'counts' in s && typeof s.submittedToday === 'number' && 'dailyLimit' in s);
  check('panel.html exists', existsSync(PANEL_HTML));
  check('file guard rejects traversal', safeOutputPath('../cv.md') === null && safeOutputPath('/etc/passwd') === null);
  check('file guard rejects non-artifact extensions', safeOutputPath('output/x/audit/attempt-1/evil.sh') === null);

  const up = `${UPSTREAM.host}:${UPSTREAM.port}`;
  const h = rewriteProxyHeaders({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001', 'accept-encoding': 'gzip', referer: 'http://127.0.0.1:3001/jobs' });
  check('proxy rewrites host/origin/referer to upstream', h.host === up && h.origin === `http://${up}`
    && h.referer === `http://${up}/jobs` && !('accept-encoding' in h));
  const injected = injectNav('<html><body>x</body></html>');
  check('nav injection lands before </body>', injected.includes('Mission Control')
    && injected.includes('data-mc-pill') && injected.trimEnd().endsWith('</body></html>'));

  // config editing: pure text patcher
  const yml = 'score_threshold: 4.0 # keep\ndaily_soft_limit: 100\neval:\n  model: old/model\n  limit_per_cycle: 20\n';
  const ed = applyConfigEdits(yml, { score_threshold: 3.5, 'eval.model': 'new/model-2', bogus_key: 1 });
  check('applyConfigEdits patches whitelisted lines only',
    ed.text.includes('score_threshold: 3.5') && ed.text.includes('  model: new/model-2')
    && ed.changed.length === 2 && ed.errors.length === 1 && ed.errors[0].startsWith('bogus_key'));
  const bad = applyConfigEdits(yml, { daily_soft_limit: 'lots', max_attempts: 99 });
  check('applyConfigEdits rejects invalid values', bad.changed.length === 0 && bad.errors.length === 2);
  check('config payload lists all editable fields with values',
    configPayload().fields.length === Object.keys(EDITABLE_CONFIG).length
    && configPayload().fields.every((f) => f.label && f.value !== undefined));

  const an = analyticsPayload();
  check('analytics payload has funnel/scoreDist/reasons/timePerApply',
    'funnel' in an && 'scoreDist' in an && Array.isArray(an.reasons) && 'timePerApply' in an);

  const w = parseWorkers('eval-queue: evaluating acme — CTO\napply-worker: spawning claude (timeout 25m)', true);
  check('parseWorkers: applying wins the activity line', w.activity === 'applying');
  check('parseWorkers: current eval surfaced', w.eval.current === 'acme — CTO');
  const w2 = parseWorkers('eval-queue: evaluating acme — CTO\neval-queue: done — 1 evaluated', true);
  check('parseWorkers: eval done clears current', w2.eval.current === null);
  check('parseWorkers: idle when not running', parseWorkers('x', false).activity === 'idle');
  const op = operatorPayload();
  check('operator payload has cycle/workers/applying', 'cycle' in op && 'workers' in op && 'applying' in op);
  check('file guard accepts .log inside output', safeOutputPath('output/../x.log') === null);

  // requeue against a throwaway DB — never touches real state
  const os = await import('node:os');
  const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'auto-panel-'));
  const prevDb = process.env.CAREER_OPS_DB;
  process.env.CAREER_OPS_DB = join(tmp, 'test.db');
  try {
    const { createJob } = await import('./state.mjs');
    const { job } = createJob({ url: 'https://boards.greenhouse.io/acme/jobs/123', company: 'acme', role: 'cto' });
    for (const st of ['evaluated', 'queued', 'resume_ready', 'applying', 'failed']) transition(job, st, { attempts: 2 });
    const r = await requeueJob(job.urlKey);
    check('requeue failed→queued resets attempts', r.ok === true && loadJob(job.urlKey).stage === 'queued' && loadJob(job.urlKey).attempts === 0);
    check('requeue refuses an illegal stage', (await requeueJob(job.urlKey)).ok === false); // already queued
    const bulk = await requeueJobs([job.urlKey, 'nonexistent']);
    check('bulk requeue reports per-key results', bulk.ok === false && bulk.results.length === 2 && bulk.requeued === 0);

    // queue edits in the same temp dir
    const b = await editQueue(job.urlKey, 'bump');
    check('bump sets priority above the pool', b.ok === true && loadJob(job.urlKey).priority === 1);
    const h = await editQueue(job.urlKey, 'hold');
    check('hold benches the job and clears priority',
      h.ok === true && loadJob(job.urlKey).held === true && loadJob(job.urlKey).priority === 0
      && pickOrder([loadJob(job.urlKey)], 2, queueOrderOptions()).length === 0);
    check('release returns it to the pool', (await editQueue(job.urlKey, 'release')).ok === true && loadJob(job.urlKey).held === false);
    check('queue edit rejects unknown action/key',
      (await editQueue(job.urlKey, 'explode')).ok === false && (await editQueue('nonexistent', 'bump')).ok === false);

    // re-rank: a never-scored parked job goes back to discovered; scored jobs are refused
    const { job: rj } = createJob({ url: 'https://boards.greenhouse.io/beta/jobs/9', company: 'beta', role: 'vp' });
    transition(rj, 'parked', { lastError: 'eval failed 3× (last: timeout)', evalAttempts: 3 });
    const rr = await rerankJob(rj.urlKey);
    const rjAfter = loadJob(rj.urlKey);
    check('rerank parked-unscored → discovered, counter reset',
      rr.ok === true && rjAfter.stage === 'discovered' && rjAfter.evalAttempts === 0 && rjAfter.lastError === null);
    rjAfter.lastError = 'eval failed: flaky'; rjAfter.evalAttempts = 2; saveJob(rjAfter);
    check('rerank discovered-with-error clears retry state in place',
      (await rerankJob(rj.urlKey)).ok === true && loadJob(rj.urlKey).evalAttempts === 0 && loadJob(rj.urlKey).lastError === null);
    const scored = loadJob(job.urlKey); scored.score = 4.5; saveJob(scored);
    check('rerank refuses a scored job', (await rerankJob(job.urlKey)).ok === false);
    check('bulk rerank reports per-key results', (await rerankJobs([rj.urlKey, 'nonexistent'])).ok === false);

    // per-agent stop flags round-trip (real flag dir — restore at the end)
    const { agentEnabled } = await import('./lib/agent-flags.mjs');
    const before = agentFlags();
    try {
      check('agent toggle rejects unknown agent', setAgentEnabled('mystery', false).ok === false);
      setAgentEnabled('rank', false);
      check('stop flag disables the agent', agentEnabled('rank') === false && agentFlags().rank === false);
      setAgentEnabled('rank', true);
      check('resume clears the flag', agentEnabled('rank') === true);
    } finally {
      for (const [a, on] of Object.entries(before)) setAgentEnabled(a, on);
    }
  } finally {
    (await import('../core/db.mjs')).closeDb();
    if (prevDb === undefined) delete process.env.CAREER_OPS_DB;
    else process.env.CAREER_OPS_DB = prevDb;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // start/stop checks only when no real cycle is running: stopCycle on an
  // external cycle would kill the user's live run (that is its job).
  if (cycleState().running) {
    console.log('skip - start/stop checks (a real cycle is running right now)');
  } else {
    const started = startCycle({ cmd: ['/bin/sleep', '30'] });
    check('startCycle spawns', started.ok === true && processAlive(started.pid));
    check('second start refused while running', startCycle({ cmd: ['/bin/sleep', '30'] }).ok === false);
    check('pause flag set while running', requestPause().ok === true && pauseRequested());
    check('cancel pause clears the flag', cancelPause().ok === true && !pauseRequested());
    const stopped = stopCycle();
    check('stopCycle kills the group', stopped.ok === true && stopped.source === 'panel');
    await new Promise((r) => setTimeout(r, 300));
    check('cycle reports not running after stop', cycleState().running === false);
  }

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await selfTest();
  } else {
    const port = Number(args[args.indexOf('--port') + 1]) || 3001;
    createPanelServer().listen(port, '127.0.0.1', () => {
      console.log(`mission control: http://127.0.0.1:${port}/auto (loopback only; proxies ${UPSTREAM.host}:${UPSTREAM.port})`);
    });
    setInterval(() => { watchdogTick().catch(() => {}); }, 60_000).unref();
  }
}
