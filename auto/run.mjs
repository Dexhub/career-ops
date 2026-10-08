#!/usr/bin/env node
// auto/run.mjs — orchestrator: one full pipeline cycle under a run lock.
//
//   scan -> eval/promote -> resume-select -> apply loop (jitter, soft limit)
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

import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  try { unlinkSync(PAUSE_FLAG); } catch { /* a pause from a past cycle is stale */ }

  if (!applyOnly) {
    if (!skipScan && agentEnabled('scan')) stage('scan', [join(ROOT, 'scan.mjs'), '--quiet'], log);
    else if (!skipScan) log('run: scan agent stopped from Mission Control — skipping scan stage');
    if (agentEnabled('rank')) stage('eval', [join(ROOT, 'auto', 'eval-queue.mjs')], log);
    else log('run: ranking agent stopped from Mission Control — skipping rank stage');
    stage('select', [join(ROOT, 'auto', 'resume-select.mjs')], log);
  }

  if (noSubmit) {
    // Testing lane: a dry run never mutates state, so looping would re-pick
    // the same job forever. Do exactly one.
    apply({ submit: false, agent: cfg.agent?.primary ?? 'claude', log });
    return;
  }

  if (!overridePresent()) {
    console.warn('run: AGENTS.md ethical override missing (re-run auto/patches/apply-ethical-override.mjs) — skipping applies this cycle');
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
    const today = new Date().toISOString().slice(0, 10);
    const submittedToday = submittedCountOn(today);
    if (submittedToday >= limit) {
      log(`run: daily soft limit reached (${submittedToday}/${limit}) — stopping applies`);
      break;
    }
    const next = pickOrder(listJobs(['resume_ready', 'applying']), cfg.max_attempts ?? 2)
      .find((j) => !applied.has(j.urlKey));
    if (!next) { log('run: apply queue drained'); break; }
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
    try {
      await runCycle({
        skipScan: hasFlag(args, '--skip-scan'),
        noSubmit: hasFlag(args, '--no-submit'),
      });
      console.log('run: cycle complete');
    } finally {
      lock.release();
    }
  }
}
