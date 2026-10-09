#!/usr/bin/env node
// auto/run.mjs — orchestrator: one full pipeline cycle under a run lock.
//
//   scan -> eval (background) + resume-select -> apply loop (jitter, soft limit)
//
// Eval runs concurrently with the apply loop: already-queued jobs apply
// immediately; when the queue drains the loop waits for eval, re-runs
// resume-select, and continues with newly ranked jobs.
//
// Designed to run unattended from launchd every 6h (see auto/README.md for
// the plist). A second concurrent invocation exits immediately instead of
// queueing. Stage failures are isolated: a scan error never blocks evals,
// and an eval error never blocks applies of already-ready jobs.
//
// Usage:
//   node auto/run.mjs               # full cycle
//   node auto/run.mjs --skip-scan   # skip the (slow) network scan stage
//   node auto/run.mjs --no-submit   # single dry-run apply instead of the loop
//   node auto/run.mjs --self-test

import './lib/sanitize-env.mjs';

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquirePipelineLock } from '../pipeline-lock.mjs';
import { hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { loadAutoConfig } from './lib/config.mjs';
import { listJobs, loadJob, pickOrder, saveJob, submittedCountOn, transition } from './state.mjs';
import { runApply } from './apply-worker.mjs';
import { agentEnabled } from './lib/agent-flags.mjs';
import { writeDigest } from './digest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Sentinel path for the run lock. pipeline-lock derives a .lock dir next to
// it; this is a dedicated orchestrator lock, not the data/pipeline.md lock.
const LOCK_SENTINEL = join(ROOT, 'data', 'auto', 'orchestrator');
// Graceful pause: Mission Control (or `touch`) creates this flag; the apply
// loop finishes the in-flight job and stops before picking the next one.
const PAUSE_FLAG = join(ROOT, 'data', 'auto', 'pause-requested');

/** Run one pipeline stage as a child process; a failure warns and moves on. */
function stage(name, args, log = console.log) {
  log(`run: [${name}] node ${args.join(' ')}`);
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    console.warn(`run: [${name}] exited ${res.status ?? res.signal} — continuing`);
    return false;
  }
  return true;
}

/**
 * Run a stage as a background child; resolves true on exit 0. Used for the
 * eval stage so a slow local-model ranking run never starves the apply loop
 * (observed 2026-10-09: one slow eval blocked 10 ready jobs for hours).
 */
function stageAsync(name, args, log = console.log) {
  log(`run: [${name}] node ${args.join(' ')} (background)`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', (err) => {
      console.warn(`run: [${name}] spawn failed: ${err.message} — continuing`);
      resolve(false);
    });
    child.on('exit', (status, signal) => {
      if (status !== 0) console.warn(`run: [${name}] exited ${status ?? signal} — continuing`);
      resolve(status === 0);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cheap connectivity probe; applies must not spawn a 25-min agent offline. */
export async function networkUp(probeUrl = 'https://www.google.com/generate_204') {
  try {
    await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

export function jitterMs(cfg, rand = Math.random) {
  const min = (cfg.jitter_min_minutes ?? 2) * 60_000;
  const max = (cfg.jitter_max_minutes ?? 10) * 60_000;
  return Math.round(min + rand() * Math.max(0, max - min));
}

/** True when the sanctioned AGENTS.md override is in place. */
export function overridePresent() {
  const res = spawnSync(process.execPath,
    [join(ROOT, 'auto', 'patches', 'apply-ethical-override.mjs'), '--check'],
    { cwd: ROOT, stdio: 'ignore' });
  return res.status === 0;
}

export async function runCycle({ skipScan = false, noSubmit = false, applyOnly = false, log = console.log, apply = runApply } = {}) {
  const cfg = loadAutoConfig({ fresh: true });

  // Scan → eval runs as a background chain (scan feeds the rows eval ranks),
  // in parallel with resume-select + the apply loop, so already-queued jobs
  // apply immediately. When the apply queue drains we wait for the chain,
  // re-select, and continue with newly ranked jobs.
  let bgPending = null;
  if (!applyOnly) {
    bgPending = (async () => {
      if (!skipScan && agentEnabled('scan')) await stageAsync('scan', [join(ROOT, 'scan.mjs'), '--quiet'], log);
      else if (!skipScan) log('run: scan agent stopped from Mission Control — skipping scan stage');
      if (agentEnabled('rank')) await stageAsync('eval', [join(ROOT, 'auto', 'eval-queue.mjs')], log);
      else log('run: ranking agent stopped from Mission Control — skipping rank stage');
    })();
    stage('select', [join(ROOT, 'auto', 'resume-select.mjs')], log);
  }
  // The cycle must not end (and release its lock) while background children
  // are still writing state — a next cycle could race them.
  const awaitEval = async () => {
    if (!bgPending) return false;
    log('run: waiting for background scan/eval to finish');
    await bgPending;
    bgPending = null;
    return true;
  };

  if (noSubmit) {
    // Testing lane: a dry run never mutates state, so looping would re-pick
    // the same job forever. Do exactly one.
    apply({ submit: false, agent: cfg.agent?.primary ?? 'claude', log });
    await awaitEval();
    return;
  }

  if (!overridePresent()) {
    console.warn('run: AGENTS.md ethical override missing (re-run auto/patches/apply-ethical-override.mjs) — skipping applies this cycle');
    await awaitEval();
    return;
  }

  // Recovery: a job left in `applying` at max attempts (e.g. the worker was
  // killed mid-apply on its last try) can never complete — mark it failed so
  // it stops shadowing the queue and shows up in the digest.
  for (const stale of listJobs('applying')) {
    if ((stale.attempts || 0) >= (cfg.max_attempts ?? 2)) {
      const job = loadJob(stale.urlKey);
      transition(job, 'failed', { lastError: job.lastError || 'exhausted attempts (stale applying)' });
      saveJob(job);
      log(`run: recovered stale applying job ${job.company} -> failed`);
    }
  }

  const limit = cfg.daily_soft_limit ?? 100;
  const applied = new Set(); // one attempt per job per cycle
  for (;;) {
    if (existsSync(PAUSE_FLAG)) {
      try { unlinkSync(PAUSE_FLAG); } catch { /* already gone */ }
      log('run: pause requested — stopping before the next apply');
      break;
    }
    if (!agentEnabled('apply')) {
      log('run: submission agent stopped from Mission Control — stopping before the next apply');
      break;
    }
    // Network outage: wait instead of spawning a doomed 25-min agent run
    // (burns an attempt per job). Re-loops so pause/agent-stop still work.
    if (!(await networkUp())) {
      log('run: network down — waiting 60s before retrying');
      await sleep(60_000);
      continue;
    }
    const today = new Date().toISOString().slice(0, 10);
    const submittedToday = submittedCountOn(today);
    if (submittedToday >= limit) {
      log(`run: daily soft limit reached (${submittedToday}/${limit}) — stopping applies`);
      break;
    }
    const next = pickOrder(listJobs(['resume_ready', 'applying']), cfg.max_attempts ?? 2)
      .find((j) => !applied.has(j.urlKey));
    if (!next) {
      // Drained — but a background eval may still be queueing jobs. Wait for
      // it once, promote the new rows, and keep applying.
      if (await awaitEval()) {
        stage('select', [join(ROOT, 'auto', 'resume-select.mjs')], log);
        continue;
      }
      log('run: apply queue drained');
      break;
    }
    applied.add(next.urlKey);

    try {
      apply({ needle: next.urlKey, agent: cfg.agent?.primary ?? 'claude', log });
    } catch (err) {
      console.warn(`run: apply error for ${next.company}: ${err.message} — continuing`);
    }

    const more = listJobs(['resume_ready']).some((j) => !applied.has(j.urlKey));
    if (more && submittedCountOn(today) < limit) {
      const ms = jitterMs(cfg);
      log(`run: jitter sleep ${Math.round(ms / 1000)}s before next apply`);
      await sleep(ms);
    }
  }

  // Pause/limit/agent-stop can break the loop with eval still running.
  await awaitEval();

  if (!applyOnly) {
    try { writeDigest({ log }); } catch (err) { console.warn(`run: digest failed: ${err.message}`); }
  }
}

// ---------------------------------------------------------------------------
async function selfTest() {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createJob, loadJob: lj, transition: tr, saveJob: sj } = await import('./state.mjs');

  let failures = 0;
  const check = (name, cond) => {
    if (cond) console.log(`ok - ${name}`);
    else { console.error(`FAIL - ${name}`); failures += 1; }
  };

  const cfg = { jitter_min_minutes: 2, jitter_max_minutes: 10 };
  check('jitter at rand=0 is min', jitterMs(cfg, () => 0) === 120_000);
  check('jitter at rand=1 is max', jitterMs(cfg, () => 1) === 600_000);
  check('jitter defaults sane', jitterMs({}, () => 0.5) > 0);
  check('override check runs', typeof overridePresent() === 'boolean');
  check('lock sentinel path under data/auto', LOCK_SENTINEL.includes(join('data', 'auto')));

  // runCycle recovery + apply loop against a temp jobs dir.
  const tmp = mkdtempSync(join(tmpdir(), 'auto-run-test-'));
  process.env.CAREER_OPS_AUTO_JOBS_DIR = tmp;
  try {
    const seed = (url, company, stages, patch = {}) => {
      let { job } = createJob({ url, company });
      for (const s of stages) tr(job, s, {});
      Object.assign(job, patch);
      sj(job);
      return job.urlKey;
    };
    const staleKey = seed('https://x.test/jobs/stale', 'stalecorp',
      ['evaluated', 'queued', 'resume_ready', 'applying'], { attempts: 2 });
    const readyKey = seed('https://x.test/jobs/ready', 'readycorp',
      ['evaluated', 'queued', 'resume_ready']);

    const calls = [];
    await runCycle({
      applyOnly: true,
      log: () => {},
      apply: ({ needle }) => {
        calls.push(needle);
        const job = lj(readyKey);
        tr(job, 'applying', { attempts: 1 });
        tr(job, 'submitted', {});
        sj(job);
        return {};
      },
    });

    check('stale applying job recovered to failed', lj(staleKey).stage === 'failed');
    check('ready job applied exactly once', calls.length === 1 && calls[0] === readyKey);
    check('ready job reached submitted', lj(readyKey).stage === 'submitted');
  } finally {
    delete process.env.CAREER_OPS_AUTO_JOBS_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures > 0) { console.error(`self-test: ${failures} failure(s)`); process.exit(1); }
  console.log('self-test: all checks passed');
}

// ---------------------------------------------------------------------------
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, ['--skip-scan', '--no-submit', '--self-test'],
    'usage: node auto/run.mjs [--skip-scan] [--no-submit] [--self-test]');

  if (hasFlag(args, '--self-test')) {
    selfTest();
  } else {
    let lock;
    try {
      lock = await acquirePipelineLock(LOCK_SENTINEL, { maxWaitMs: 1000 });
    } catch {
      console.log('run: another orchestrator cycle is active — exiting');
      process.exit(0);
    }
    // A pause from a past cycle is stale. Cleared here (lock held, real cycle
    // only) — NOT in runCycle, which self-tests call as a library: a library
    // caller must never eat a live pause request (2026-10-09 incident).
    try { unlinkSync(PAUSE_FLAG); } catch { /* no stale pause */ }
    // Desired-state handshake with the panel watchdog: running until this
    // cycle completes cleanly. A crash/kill leaves it `running: true`, so the
    // watchdog restarts the cycle once the machine/network recovers.
    const DESIRED_FILE = join(ROOT, 'data', 'auto', 'desired-cycle.json');
    const skipScan = hasFlag(args, '--skip-scan');
    try {
      writeFileSync(DESIRED_FILE, JSON.stringify({ running: true, skipScan, updated_at: new Date().toISOString() }));
    } catch { /* best effort */ }
    try {
      await runCycle({
        skipScan,
        noSubmit: hasFlag(args, '--no-submit'),
      });
      console.log('run: cycle complete');
      try {
        writeFileSync(DESIRED_FILE, JSON.stringify({ running: false, reason: 'cycle complete', updated_at: new Date().toISOString() }));
      } catch { /* best effort */ }
    } finally {
      lock.release();
    }
  }
}
