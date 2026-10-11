// auto/test/learning-job-state.test.mjs — T03: CAS job updates, record
// migration, and immutable attempt allocation. Runs entirely against the T01
// fixture root (temp CAREER_OPS_ROOT + CAREER_OPS_DB); never touches live
// state. Contention tests use real child processes against the same fixture
// database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLearningFixture } from './helpers/learning.mjs';

let fx; // fixture: { root, cleanup }
let state; // ../state.mjs, imported only after the fixture env is set
let db; // ../../core/db.mjs
let currentKey; // urlKey used by the requeue test's loadCurrentJob helper

const STATE_URL = new URL('../state.mjs', import.meta.url).href;

before(async () => {
  fx = createLearningFixture();
  state = await import('../state.mjs');
  db = await import('../../core/db.mjs');
});

after(() => {
  db.closeDb();
  fx.cleanup();
});

// ---------- test-local helpers (fixture paths only) ----------

/** Deterministic content hash of a fixture directory (names + bytes). */
function hashDirectory(dir) {
  const h = createHash('sha256');
  for (const name of readdirSync(dir).sort()) {
    h.update(name);
    h.update('\0');
    h.update(readFileSync(join(dir, name)));
  }
  return h.digest('hex');
}

/** Latest state of the job under test in the fixture database. */
async function loadCurrentJob() {
  return state.loadJob(currentKey);
}

/** Run an inline ESM script in a child process sharing the fixture env. */
function runChild(script, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

/** Seed a job and walk it to resume_ready; returns its urlKey. */
async function seedResumeReady(url, company = 'acme') {
  const { job } = state.createJob({ url, company, role: 'cto' });
  await state.updateJob(job.urlKey, { transitionTo: 'evaluated', patch: { score: 4.5 } });
  await state.updateJob(job.urlKey, { transitionTo: 'queued' });
  await state.updateJob(job.urlKey, { transitionTo: 'resume_ready' });
  return job.urlKey;
}

// ---------- isolation first ----------

test('fixture isolation: env points at the helper-created temp root, not the real checkout', () => {
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fx.root), 'CAREER_OPS_DB must live under the fixture root');
  assert.ok(fx.root.includes('career-learning-'), 'fixture root must carry the helper prefix');
  assert.ok(process.env.CAREER_OPS_ROOT === fx.root, 'CAREER_OPS_ROOT must be the fixture root');
});

// ---------- migration ----------

test('legacy version-zero job round-trips with every field preserved', async () => {
  const legacy = {
    urlKey: 'https://legacy.test/jobs/1',
    url: 'https://legacy.test/jobs/1',
    company: 'legacycorp',
    role: 'VP Eng',
    stage: 'submitted',
    score: 4.2,
    attempts: 2,
    priority: 3,
    held: true,
    auditDir: '/old/audit/attempt-1',
    lastError: null,
    timestamps: [
      { stage: 'discovered', at: '2026-01-01T00:00:00Z' },
      { stage: 'submitted', at: '2026-01-02T00:00:00Z' },
    ],
  };
  db.saveAutoJob(legacy); // raw write: no schemaVersion/recordVersion/execution

  const job = state.loadJob(legacy.urlKey);
  assert.equal(job.recordVersion, 0, 'legacy records read as version 0');
  assert.equal(job.schemaVersion, state.JOB_SCHEMA_VERSION);
  assert.equal(job.stage, 'submitted', 'migration must not downgrade a submitted record');
  assert.equal(job.attempts, 2);
  assert.equal(job.priority, 3);
  assert.equal(job.held, true);
  assert.equal(job.auditDir, '/old/audit/attempt-1');
  assert.deepEqual(job.timestamps, legacy.timestamps, 'old timestamps preserved verbatim');
  assert.ok(job.applicationId, 'migration assigns a durable applicationId');
  assert.equal(job.execution.phase, 'not_started');

  // Migration must not requeue it either: submitted is terminal.
  await assert.rejects(
    state.updateJob(legacy.urlKey, { transitionTo: 'queued' }),
    /illegal submitted/,
  );
  assert.equal(state.loadJob(legacy.urlKey).stage, 'submitted');
});

test('unknown future schema version is refused, not guessed at', () => {
  db.saveAutoJob({ urlKey: 'https://future.test/jobs/1', stage: 'discovered', schemaVersion: 99, timestamps: [] });
  assert.throws(() => state.loadJob('https://future.test/jobs/1'),
    (err) => err.code === 'UNSUPPORTED_RECORD_VERSION' && err.foundVersion === 99);
});

// ---------- CAS updates ----------

test('stale write rejects with VERSION_CONFLICT carrying actualVersion', async () => {
  const { job } = state.createJob({ url: 'https://cas.test/jobs/1', company: 'cascorp', role: 'cto' });
  const seen = state.loadJob(job.urlKey).recordVersion;
  await state.updateJob(job.urlKey, { expectedVersion: seen, patch: { score: 3 } }); // first writer wins
  await assert.rejects(
    state.updateJob(job.urlKey, { expectedVersion: seen, patch: { score: 5 } }), // stale
    (err) => err.code === 'VERSION_CONFLICT' && err.actualVersion === seen + 1,
  );
  assert.equal(state.loadJob(job.urlKey).score, 3, 'the stale write must not land');
});

test('updateJob refuses protected fields and rolls back illegal transitions', async () => {
  const { job } = state.createJob({ url: 'https://guard.test/jobs/1', company: 'guardcorp', role: 'cto' });
  await assert.rejects(
    state.updateJob(job.urlKey, { patch: { stage: 'queued' } }),
    (err) => err.code === 'INVALID_PATCH',
  );
  const beforeVersion = state.loadJob(job.urlKey).recordVersion;
  await assert.rejects(
    state.updateJob(job.urlKey, { transitionTo: 'submitted', patch: { score: 9 } }), // discovered → submitted is illegal
    /illegal discovered/,
  );
  const unchanged = state.loadJob(job.urlKey);
  assert.equal(unchanged.stage, 'discovered');
  assert.equal(unchanged.recordVersion, beforeVersion, 'a failed transition persists nothing');
  assert.notEqual(unchanged.score, 9);
});

// ---------- contention (child processes against the same fixture DB) ----------

test('panel hold landed during a worker run survives the worker\'s final patch', async () => {
  const key = await seedResumeReady('https://contend.test/jobs/hold', 'holdcorp');
  // Worker claims the attempt (CAS), then "runs" without holding any lock.
  const claimed = await state.updateJob(key, {
    expectedVersion: state.loadJob(key).recordVersion,
    transitionTo: 'applying',
    patch: { attempts: 1 },
  });
  // Panel decision from another process mid-run.
  const res = await runChild(`
    const { updateJob } = await import(${JSON.stringify(STATE_URL)});
    const job = await updateJob(${JSON.stringify(key)}, { patch: { held: true, priority: 0 } });
    console.log(JSON.stringify({ ok: true, recordVersion: job.recordVersion }));
  `);
  assert.equal(res.code, 0, `panel child failed: ${res.err}`);
  assert.ok(JSON.parse(res.out).recordVersion > claimed.recordVersion);
  // Worker finishes: narrow final patch on the fresh record.
  const done = await state.updateJob(key, { transitionTo: 'failed', patch: { lastError: 'verify failed' } });
  assert.equal(done.held, true, 'the panel hold must not be lost');
  assert.equal(done.stage, 'failed', 'the worker verdict must also land');
  assert.equal(done.lastError, 'verify failed');
});

test('blocker resolution and reviewer metadata update merge without a lost decision', async () => {
  const key = await seedResumeReady('https://contend.test/jobs/blocker', 'blockcorp');
  await state.updateJob(key, { patch: { execution: { blockerId: 'b-1', phase: 'in_progress' } } });
  const resolveBlocker = runChild(`
    const { updateJob } = await import(${JSON.stringify(STATE_URL)});
    await updateJob(${JSON.stringify(key)}, { patch: { execution: { blockerId: null } } });
    console.log('ok');
  `);
  const reviewerUpdate = runChild(`
    const { updateJob } = await import(${JSON.stringify(STATE_URL)});
    await updateJob(${JSON.stringify(key)}, { patch: { reviewNote: 'metadata checked' } });
    console.log('ok');
  `);
  const [a, b] = await Promise.all([resolveBlocker, reviewerUpdate]);
  assert.equal(a.code, 0, `blocker child failed: ${a.err}`);
  assert.equal(b.code, 0, `reviewer child failed: ${b.err}`);
  const job = state.loadJob(key);
  assert.equal(job.execution.blockerId, null, 'blocker resolution not lost');
  assert.equal(job.reviewNote, 'metadata checked', 'reviewer metadata not lost');
  assert.equal(job.execution.phase, 'in_progress', 'untouched nested field preserved');
});

test('two workers competing for one attempt: exactly one execution owner', async () => {
  const key = await seedResumeReady('https://contend.test/jobs/race', 'racecorp');
  const version = state.loadJob(key).recordVersion;
  const claim = (attemptId) => runChild(`
    const { updateJob } = await import(${JSON.stringify(STATE_URL)});
    try {
      const job = await updateJob(${JSON.stringify(key)}, {
        expectedVersion: ${version},
        transitionTo: 'applying',
        patch: { attempts: 1, execution: { attemptId: ${JSON.stringify(attemptId)}, phase: 'in_progress' } },
      });
      console.log(JSON.stringify({ won: true, attemptId: job.execution.attemptId }));
    } catch (err) {
      console.log(JSON.stringify({ won: false, code: err.code, actualVersion: err.actualVersion }));
    }
  `);
  const [a, b] = await Promise.all([claim('worker-a'), claim('worker-b')]);
  assert.equal(a.code, 0, `worker a crashed: ${a.err}`);
  assert.equal(b.code, 0, `worker b crashed: ${b.err}`);
  const results = [JSON.parse(a.out), JSON.parse(b.out)];
  const winners = results.filter((r) => r.won);
  const losers = results.filter((r) => !r.won);
  assert.equal(winners.length, 1, `exactly one worker must own the attempt (got ${JSON.stringify(results)})`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, 'VERSION_CONFLICT', 'the loser gets the typed conflict, not a double apply');
  assert.equal(losers[0].actualVersion, version + 1);
  const job = state.loadJob(key);
  assert.equal(job.execution.attemptId, winners[0].attemptId, 'the stored owner is the winner');
  assert.equal(job.attempts, 1, 'the losing claim burned no attempt');
});

// ---------- immutable attempts + required assertions ----------

test('requeue allocates a fresh attempt; the old audit dir is untouched; the hold survives', async () => {
  currentKey = await seedResumeReady('https://attempt.test/jobs/1', 'attemptcorp');
  const auditRoot = join(fx.root, 'output', 'attemptcorp-cto', 'audit');

  let cur = state.loadJob(currentKey);
  const firstAttempt = state.allocateAttempt({ job: cur, auditRoot, policyVersion: 'p1', sourceVersion: 's1', procedureVersion: 'proc1' });
  assert.ok(existsSync(firstAttempt.auditDir), 'attempt dir is exclusively created');
  assert.equal(firstAttempt.applicationId, cur.applicationId, 'attempt pins the application identity');
  assert.equal(firstAttempt.policyVersion, 'p1');
  await state.updateJob(currentKey, {
    expectedVersion: cur.recordVersion,
    transitionTo: 'applying',
    patch: { attempts: 1, auditDir: firstAttempt.auditDir, execution: { attemptId: firstAttempt.attemptId, phase: 'in_progress' } },
  });
  writeFileSync(join(firstAttempt.auditDir, 'result.json'), JSON.stringify({ status: 'failed', reason: 'form error' }));
  const originalAuditHash = hashDirectory(firstAttempt.auditDir);

  // Panel decisions while the job is out: hold it, then fail + requeue.
  await state.updateJob(currentKey, { patch: { held: true } });
  await state.updateJob(currentKey, { transitionTo: 'failed', patch: { lastError: 'form error' } });
  await state.updateJob(currentKey, { transitionTo: 'queued', patch: { attempts: 0, lastError: null } });
  await state.updateJob(currentKey, { transitionTo: 'resume_ready' });

  // The next claim allocates a brand-new attempt — never the old directory.
  cur = state.loadJob(currentKey);
  assert.equal(cur.attempts, 0, 'requeue reset the retry budget');
  const secondAttempt = state.allocateAttempt({ job: cur, auditRoot });

  assert.notEqual(secondAttempt.attemptId, firstAttempt.attemptId);
  assert.notEqual(secondAttempt.auditDir, firstAttempt.auditDir);
  assert.equal(hashDirectory(firstAttempt.auditDir), originalAuditHash);
  assert.equal((await loadCurrentJob()).held, true);
});
