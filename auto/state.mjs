#!/usr/bin/env node
/**
 * auto/state.mjs — per-job state machine for the autonomous apply pipeline.
 *
 * One JSON file per job under data/auto/jobs/, named by a hash of the job's
 * canonical URL key (url-key.mjs normalizeUrl). Flat files, atomic tmp+rename
 * writes, no DB. The state JSON + the audit dir ARE the guard — no broker or
 * canary layers (deliberate; see auto/README.md and the plan's non-goals).
 *
 *   discovered → evaluated → queued → resume_ready → applying → submitted
 *                    ↓          ↓          ↓             ↓   ↘ parked
 *                 skipped    skipped                  failed
 *
 * `applying → applying` is the retry edge (attempts++). `parked → queued`
 * lets a user re-queue a job after clearing the obstacle manually.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { validateFlags } from '../lib/cli-flags.mjs';

const ROOT = getCareerOpsRoot();

/**
 * Resolved at CALL time, not module load, so tests can point it at a temp dir
 * via CAREER_OPS_AUTO_JOBS_DIR after import.
 */
export function jobsDir() {
  return process.env.CAREER_OPS_AUTO_JOBS_DIR || join(ROOT, 'data/auto/jobs');
}

export const STAGES = Object.freeze([
  'discovered', 'evaluated', 'queued', 'skipped',
  'resume_ready', 'applying', 'submitted', 'parked', 'failed',
]);

/** Legal transitions. A missing key or absent target is an illegal move. */
export const LEGAL_TRANSITIONS = Object.freeze({
  discovered:   ['evaluated', 'skipped', 'parked'],
  evaluated:    ['queued', 'skipped'],
  queued:       ['resume_ready', 'parked', 'skipped'],
  resume_ready: ['applying', 'parked', 'skipped'],
  applying:     ['applying', 'submitted', 'failed', 'parked'],
  submitted:    [],
  parked:       ['queued', 'skipped'],
  failed:       [],
  skipped:      [],
});

/**
 * Filesystem name for a job, derivable from the URL alone (company may be
 * unknown at discovery time). sha256 prefix is collision-safe at this scale.
 * @param {string} urlKey - normalizeUrl() output. '' is NOT a key.
 * @returns {string} e.g. "a3f09b2c41d7e8f0.json"
 */
export function jobFileName(urlKey) {
  if (!urlKey) throw new Error('jobFileName: empty urlKey — refuse to key a job on nothing');
  return `${createHash('sha256').update(urlKey).digest('hex').slice(0, 16)}.json`;
}

export function jobPath(urlKey) {
  return join(jobsDir(), jobFileName(urlKey));
}

/**
 * Create a new job record (stage: discovered). Does not overwrite an existing
 * record — idempotent against re-scans.
 * @returns {{job: object, created: boolean}}
 */
export function createJob({ url, company = '', role = '', ats = '' }) {
  const urlKey = normalizeUrl(url);
  if (!urlKey) throw new Error(`createJob: not a keyable posting URL: ${url}`);
  const existing = loadJob(urlKey);
  if (existing) return { job: existing, created: false };
  const job = {
    urlKey,
    url,
    company,
    role,
    ats,
    stage: 'discovered',
    score: null,
    reportPath: null,
    resumeVariant: null,
    resumePdf: null,
    attempts: 0,
    lastError: null,
    auditDir: null,
    timestamps: [{ stage: 'discovered', at: new Date().toISOString() }],
  };
  saveJob(job);
  return { job, created: true };
}

/** @returns {object|null} */
export function loadJob(urlKey) {
  const p = jobPath(urlKey);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

/** Atomic tmp+rename write. */
export function saveJob(job) {
  if (!job?.urlKey) throw new Error('saveJob: job has no urlKey');
  mkdirSync(jobsDir(), { recursive: true });
  const p = jobPath(job.urlKey);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(job, null, 2) + '\n', 'utf-8');
  renameSync(tmp, p);
  return job;
}

/**
 * Validate + apply a stage transition, stamp it, persist atomically.
 * The persisted record is the source of truth: every transition is saved
 * BEFORE its side effect is relied on (crash-safety contract).
 * @param {object} job
 * @param {string} nextStage
 * @param {object} [patch] - extra fields to merge (score, lastError, ...).
 * @returns {object} the updated job
 */
export function transition(job, nextStage, patch = {}) {
  if (!STAGES.includes(nextStage)) {
    throw new Error(`transition: unknown stage "${nextStage}"`);
  }
  const allowed = LEGAL_TRANSITIONS[job.stage] || [];
  if (!allowed.includes(nextStage)) {
    throw new Error(`transition: illegal ${job.stage} → ${nextStage} for ${job.urlKey}`);
  }
  Object.assign(job, patch);
  job.stage = nextStage;
  job.timestamps.push({ stage: nextStage, at: new Date().toISOString() });
  return saveJob(job);
}

/**
 * All job records, optionally filtered by stage.
 * @param {string|string[]} [stages]
 * @returns {object[]}
 */
export function listJobs(stages) {
  if (!existsSync(jobsDir())) return [];
  const want = stages ? new Set([].concat(stages)) : null;
  const jobs = [];
  for (const f of readdirSync(jobsDir())) {
    if (!f.endsWith('.json')) continue;
    try {
      const job = JSON.parse(readFileSync(join(jobsDir(), f), 'utf-8'));
      if (!want || want.has(job.stage)) jobs.push(job);
    } catch {
      console.warn(`auto/state: skipping unreadable job file ${f}`);
    }
  }
  return jobs;
}

/** Count of jobs submitted on the given local calendar day (YYYY-MM-DD). */
export function submittedCountOn(day) {
  let n = 0;
  for (const job of listJobs('submitted')) {
    const sub = job.timestamps.findLast?.((t) => t.stage === 'submitted')
      ?? [...job.timestamps].reverse().find((t) => t.stage === 'submitted');
    if (sub && sub.at.startsWith(day)) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Self-test (runs against a temp dir; never touches real state)
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'auto-state-'));
  process.env.CAREER_OPS_AUTO_JOBS_DIR = tmp;
  // jobsDir() resolves the env var at call time, so the module's own exports
  // can be exercised directly against the temp dir.
  const mod = { createJob, loadJob, transition, listJobs, submittedCountOn, jobFileName };
  const url = 'https://job-boards.greenhouse.io/example/jobs/123?utm_source=x';
  let pass = 0; let fail = 0;
  const check = (name, fn) => {
    try { fn(); pass += 1; } catch (e) { fail += 1; console.error(`  ✗ ${name}: ${e.message}`); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  check('createJob creates with stage discovered', () => {
    const { job, created } = mod.createJob({ url, company: 'example', role: 'VP Eng', ats: 'greenhouse' });
    assert(created === true, 'expected created');
    assert(job.stage === 'discovered', `stage ${job.stage}`);
  });
  check('createJob is idempotent on url-key (tracking params stripped)', () => {
    const { created } = mod.createJob({ url: 'https://job-boards.greenhouse.io/example/jobs/123' });
    assert(created === false, 'expected existing record (utm stripped → same key)');
  });
  const key = normalizeUrl(url);
  check('legal transition chain to submitted', () => {
    let job = mod.loadJob(key);
    job = mod.transition(job, 'evaluated', { score: 4.5 });
    job = mod.transition(job, 'queued');
    job = mod.transition(job, 'resume_ready', { resumePdf: '/tmp/cv.pdf' });
    job = mod.transition(job, 'applying');
    job = mod.transition(job, 'applying', { attempts: job.attempts + 1 });
    job = mod.transition(job, 'submitted');
    assert(job.stage === 'submitted', job.stage);
    assert(job.timestamps.length === 7, `timestamps ${job.timestamps.length}`); // 1 create + 6 transitions
  });
  check('illegal transition throws and does not persist', () => {
    const job = mod.loadJob(key);
    let threw = false;
    try { mod.transition(job, 'queued'); } catch { threw = true; }
    assert(threw, 'submitted → queued must throw');
    assert(mod.loadJob(key).stage === 'submitted', 'stage must stay submitted');
  });
  check('listJobs filter', () => {
    assert(mod.listJobs('submitted').length === 1, 'one submitted job');
    assert(mod.listJobs('queued').length === 0, 'no queued jobs');
  });
  check('submittedCountOn today', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert(mod.submittedCountOn(today) === 1, 'one submission today');
  });
  check('jobFileName refuses empty key', () => {
    let threw = false;
    try { mod.jobFileName(''); } catch { threw = true; }
    assert(threw, 'empty key must throw');
  });

  rmSync(tmp, { recursive: true, force: true });
  console.log(`auto/state self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = `auto/state.mjs — job state machine

  --self-test      Run the built-in transition tests (temp dir, no real state)
  --list [stage]   Print jobs, optionally filtered by stage
  --help           Show this help`;
  validateFlags(args, ['--self-test', '--list', '--help', '-h'], usage, { valueFlags: ['--list'] });
  if (args.includes('--self-test')) {
    await runSelfTest();
  } else if (args[0] === '--list' || args[0]?.startsWith('--list=')) {
    const stage = args[0].includes('=') ? args[0].split('=')[1] : args[1];
    const jobs = listJobs(stage && STAGES.includes(stage) ? stage : undefined);
    for (const j of jobs) {
      console.log(`${j.stage.padEnd(12)} ${String(j.score ?? '-').padEnd(4)} ${j.company} — ${j.role}`);
    }
    console.log(`${jobs.length} job(s)`);
  } else {
    console.log(usage);
  }
}
