// auto/test/learning-tracker-sync.test.mjs — T15: canonical tracker
// synchronization as an independently retryable task. Everything runs against
// an isolated mkdtemp fixture with an injected tracker reader and status
// executor: no real tracker file, scripts, worker, or live data is ever
// touched. node:test only; synthetic values only.
//
// The boundary under test: a confirmed submission commits trackerSync
// 'pending' with a deterministic task id in the SAME job update; every sync
// attempt resolves the report from the job's own report basename, verifies
// requisition identity before writing, rereads the canonical tracker after
// writing, preserves rows that already moved past Applied, retains failures
// as retryable task state, and NEVER invokes the application worker.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

let fixture;
let ctx;
let state;
let workflow;
let getRecord;
let listRecords;
let createLearningContext;

before(async () => {
  fixture = createLearningFixture();
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'),
    'schema_version: 1\nenabled: true\nmode: shadow\n');
  state = await import('../state.mjs');
  workflow = await import('../learning/workflow.mjs');
  ({ getRecord, listRecords } = await import('../learning/store.mjs'));
  ({ createLearningContext } = await import('../learning/context.mjs'));
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
});
after(() => fixture.cleanup());

// ---------------------------------------------------------------------------
// Synthetic fixtures

let reportSeq = 7000;
function seedSubmittedJob(company, { reportNum = (reportSeq += 1), markPending = true } = {}) {
  const url = `https://jobs.example.test/${company}/${reportNum}`;
  const { job } = state.createJob({ url, company, role: 'Engineer', ats: 'synthetic' });
  for (const stage of ['evaluated', 'queued', 'resume_ready', 'applying', 'submitted']) {
    state.transition(job, stage, {});
  }
  job.reportPath = `reports/${reportNum}-synthetic.md`;
  job.auditDir = join(fixture.dataRoot, 'output', company, 'audit');
  if (markPending) {
    job.trackerSync = { status: 'pending', taskId: workflow.trackerSyncTaskId(job) };
  }
  state.saveJob(job);
  return { job: state.loadJob(job.urlKey), reportNum };
}

/** In-memory canonical tracker + sanctioned-script stand-ins. */
function fakeTracker(rows) {
  const calls = { merge: 0, setStatus: [] };
  const tracker = { listApplications: () => rows.map((r) => ({ ...r })) };
  const executor = {
    mergeTracker() { calls.merge += 1; return { status: 0 }; },
    setStatus({ reportNum, status }) {
      calls.setStatus.push({ reportNum, status });
      const row = rows.find((r) => String(r.report).includes(`reports/${reportNum}-`));
      if (!row) return { status: 2, stdout: '{"error":"not-found"}' };
      row.status = status;
      return { status: 0, stdout: JSON.stringify({ changed: true, num: row.num }) };
    },
  };
  return { rows, calls, tracker, executor };
}

const trackerRow = (num, reportNum, { company = 'synthco', status = 'Evaluated', url = null } = {}) => ({
  num, company, role: 'Engineer', status,
  report: `[${reportNum}](reports/${reportNum}-synthetic.md)`, notes: '', url,
});

const taskFor = (job) => getRecord(ctx, 'syncTasks', workflow.trackerSyncTaskId(job));

async function runSync(job, t, extra = {}) {
  return workflow.syncSubmittedJobs(ctx, {
    taskId: workflow.trackerSyncTaskId(job),
    executeStatus: t.executor, tracker: t.tracker, jobs: state, ...extra,
  });
}

// ---------------------------------------------------------------------------

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.dataRoot);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fixture.dataRoot + sep));
});

test('task id is deterministic from the job record alone (crash-reconstructable)', () => {
  const { job } = seedSubmittedJob('detco');
  assert.equal(workflow.trackerSyncTaskId(job), workflow.trackerSyncTaskId(state.loadJob(job.urlKey)));
  assert.match(workflow.trackerSyncTaskId(job), /^sync-[0-9a-f]{40}$/);
});

test('report number comes from the report basename, never the first number in a path', () => {
  assert.equal(workflow.reportNumFromJob({ reportPath: 'reports/2405-unknown-2026-10-09.md' }), 2405);
  assert.equal(workflow.reportNumFromJob({ reportPath: '/users/42/career/reports/0117-x.md' }), 117);
  assert.equal(workflow.reportNumFromJob({ reportPath: 'reports/no-number.md' }), null);
  assert.equal(workflow.reportNumFromJob({ reportPath: '' }), null);
});

test('happy path: pending task syncs, verifies the reread row, completes task and job', async () => {
  const { job, reportNum } = seedSubmittedJob('happyco');
  const t = fakeTracker([trackerRow(1, reportNum, { company: 'happyco', url: job.urlKey })]);
  await workflow.ensureSyncTask(ctx, { job });

  const summary = await runSync(job, t);
  assert.equal(summary.completed, 1);
  assert.deepEqual(t.calls.setStatus, [{ reportNum, status: 'Applied' }]);
  assert.equal(t.rows[0].status, 'Applied');
  const task = taskFor(job);
  assert.equal(task.status, 'done');
  assert.equal(task.data.lastError, null);
  const after = state.loadJob(job.urlKey);
  assert.equal(after.stage, 'submitted');
  assert.equal(after.trackerSync.status, 'complete');
  assert.equal(after.trackerSync.taskId, task.id);
});

test('crash recovery: committed pending job with no task record is reconstructed and synced', async () => {
  const { job, reportNum } = seedSubmittedJob('crashco');
  // No ensureSyncTask call — simulates a crash right after the job commit.
  assert.equal(taskFor(job), null);
  const t = fakeTracker([trackerRow(2, reportNum, { company: 'crashco', url: job.urlKey })]);
  const summary = await runSync(job, t);
  assert.equal(summary.reconstructed >= 1, true);
  assert.equal(summary.completed, 1);
  assert.equal(taskFor(job).status, 'done');
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'complete');
});

test('locked/missing tracker: failure retains submitted + pending with error, backoff and attempt count', async () => {
  const { job } = seedSubmittedJob('lockco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([]);
  t.tracker.listApplications = () => { throw new Error('tracker locked by another writer'); };

  const summary = await runSync(job, t, { now: new Date('2026-10-11T00:00:00Z') });
  assert.equal(summary.failed, 1);
  const task = taskFor(job);
  assert.equal(task.status, 'failed');
  assert.equal(task.data.attempts, 1);
  assert.match(task.data.lastError, /tracker locked/);
  // First retry is one base-backoff away from the injected clock.
  assert.equal(task.data.nextAttemptAt,
    new Date(Date.parse('2026-10-11T00:00:00Z') + workflow.TRACKER_SYNC_BACKOFF_BASE_MS).toISOString());
  const after = state.loadJob(job.urlKey);
  assert.equal(after.stage, 'submitted');
  assert.equal(after.trackerSync.status, 'pending');
  assert.equal(t.calls.setStatus.length, 0);
});

test('backoff gate: an untargeted sweep skips a failed task until nextAttemptAt, then retries it', async () => {
  const { job, reportNum } = seedSubmittedJob('retryco');
  await workflow.ensureSyncTask(ctx, { job });
  const broken = fakeTracker([]);
  broken.tracker.listApplications = () => { throw new Error('still locked'); };
  await runSync(job, broken, { now: new Date('2026-10-11T00:00:00Z') });
  assert.equal(taskFor(job).status, 'failed');

  // Untargeted sweep before the backoff elapses: skipped, not retried.
  const fixed = fakeTracker([trackerRow(3, reportNum, { company: 'retryco', url: job.urlKey })]);
  const early = await workflow.syncSubmittedJobs(ctx, {
    executeStatus: fixed.executor, tracker: fixed.tracker, jobs: state,
    now: new Date('2026-10-11T00:01:00Z'),
  });
  assert.equal(taskFor(job).status, 'failed');
  assert.ok(early.skipped >= 1);

  // After the backoff: the independent sweep (no worker involved) completes it.
  await workflow.syncSubmittedJobs(ctx, {
    executeStatus: fixed.executor, tracker: fixed.tracker, jobs: state,
    now: new Date('2026-10-11T01:00:00Z'),
  });
  const task = taskFor(job);
  assert.equal(task.status, 'done');
  assert.equal(task.data.attempts, 2);
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'complete');
});

test('merge failure while the row is missing: task failed, nothing written', async () => {
  const { job } = seedSubmittedJob('mergefailco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([]); // row missing entirely
  t.executor.mergeTracker = () => ({ status: 4 }); // LOCK_TIMEOUT
  const summary = await runSync(job, t);
  assert.equal(summary.failed, 1);
  assert.match(taskFor(job).data.lastError, /merge-tracker failed \(exit 4\)/);
  assert.equal(t.calls.setStatus.length, 0);
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'pending');
});

test('missing row: recreated only via sanctioned tracker-additions + merge, then verified', async () => {
  const { job, reportNum } = seedSubmittedJob('recreateco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([]);
  // The sanctioned merge consumes the addition the sync wrote and surfaces the row.
  t.executor.mergeTracker = () => {
    t.calls.merge += 1;
    if (t.calls.merge >= 2 && t.rows.length === 0) {
      const addition = readFileSync(
        join(fixture.dataRoot, 'batch', 'tracker-additions', `${reportNum}-recreateco.tsv`), 'utf8');
      assert.match(addition, /recreateco\t/); // real company, not "unknown"
      assert.ok(addition.includes(job.urlKey));
      t.rows.push(trackerRow(9, reportNum, { company: 'recreateco', url: job.urlKey }));
    }
    return { status: 0 };
  };
  const summary = await runSync(job, t);
  assert.equal(summary.completed, 1);
  assert.equal(t.rows[0].status, 'Applied');
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'complete');
});

test('ambiguous rows: two rows link the report and identity cannot disambiguate -> blocker, no write', async () => {
  const { job, reportNum } = seedSubmittedJob('ambco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([
    trackerRow(10, reportNum, { company: 'ambco' }),
    trackerRow(11, reportNum, { company: 'ambco' }),
  ]);
  const summary = await runSync(job, t);
  assert.equal(summary.blocked, 1);
  assert.equal(t.calls.setStatus.length, 0);
  const task = taskFor(job);
  assert.equal(task.status, 'failed');
  assert.match(task.data.lastError, /cannot disambiguate/);
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'blocked');
  const blockers = listRecords(ctx, 'blockers', { limit: 500 }).items
    .filter((b) => b.data.applicationId === job.applicationId && b.data.type === 'source_conflict');
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].status, 'open');
});

test('report remapping: the linked row identifies a DIFFERENT requisition -> blocked, never relabeled', async () => {
  const { job, reportNum } = seedSubmittedJob('remapco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([
    trackerRow(12, reportNum, { company: 'otherco', url: 'https://jobs.example.test/otherco/999' }),
  ]);
  const summary = await runSync(job, t);
  assert.equal(summary.blocked, 1);
  assert.equal(t.calls.setStatus.length, 0);
  assert.equal(t.rows[0].status, 'Evaluated'); // untouched
  assert.match(taskFor(job).data.lastError, /different requisition/);
});

test('already Applied: idempotent completion without a second status write', async () => {
  const { job, reportNum } = seedSubmittedJob('idemco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([trackerRow(13, reportNum, { company: 'idemco', status: 'Applied', url: job.urlKey })]);
  const summary = await runSync(job, t);
  assert.equal(summary.completed, 1);
  assert.equal(t.calls.setStatus.length, 0); // no write at all
  assert.equal(taskFor(job).status, 'done');
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'complete');
});

test('later outcome preserved: a row already at Interview is reconciled, never forced back to Applied', async () => {
  const { job, reportNum } = seedSubmittedJob('laterco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([trackerRow(14, reportNum, { company: 'laterco', status: 'Interview', url: job.urlKey })]);
  const summary = await runSync(job, t);
  assert.equal(summary.reconciled, 1);
  assert.equal(t.calls.setStatus.length, 0);
  assert.equal(t.rows[0].status, 'Interview'); // canonical outcome untouched
  assert.equal(taskFor(job).status, 'done');
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'reconciled');
});

test('crash after tracker write: rerun verifies the canonical row and completes without rewriting', async () => {
  const { job, reportNum } = seedSubmittedJob('postcrashco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([trackerRow(15, reportNum, { company: 'postcrashco', url: job.urlKey })]);
  // First attempt wrote Applied to the tracker but "crashed" before the task
  // record could be settled: simulate by running the core alone.
  const first = await workflow.executeTrackerSync({
    job, dataRoot: ctx.dataRoot, executor: t.executor, tracker: t.tracker,
  });
  assert.equal(first.outcome, 'completed');
  assert.equal(taskFor(job).status, 'pending'); // task never settled
  // The retry sees Applied already on the verified row — idempotent completion.
  const summary = await runSync(job, t);
  assert.equal(summary.completed, 1);
  assert.equal(t.calls.setStatus.length, 1); // only the pre-crash write
  assert.equal(taskFor(job).status, 'done');
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'complete');
});

test('post-write verification failure: a write the canonical tracker does not reflect stays failed', async () => {
  const { job, reportNum } = seedSubmittedJob('phantomco');
  await workflow.ensureSyncTask(ctx, { job });
  const t = fakeTracker([trackerRow(16, reportNum, { company: 'phantomco', url: job.urlKey })]);
  t.executor.setStatus = (args) => { t.calls.setStatus.push(args); return { status: 0, stdout: '{}' }; }; // claims success, writes nothing
  const summary = await runSync(job, t);
  assert.equal(summary.failed, 1);
  assert.match(taskFor(job).data.lastError, /post-write verification failed/);
  assert.equal(state.loadJob(job.urlKey).trackerSync.status, 'pending');
});

test('sync retry never invokes the application worker', () => {
  const source = readFileSync(join(repoRoot, 'auto', 'learning', 'workflow.mjs'), 'utf8');
  assert.ok(!source.includes('apply-worker'), 'workflow.mjs must not reference the application worker');
  assert.ok(!/runApply/.test(source));
});

test('flag off: syncSubmittedJobs and ensureSyncTask refuse on a disabled context', async () => {
  const { mkdirSync } = await import('node:fs');
  const offRoot = join(fixture.dataRoot, 'off-root');
  mkdirSync(join(offRoot, 'config'), { recursive: true });
  writeFileSync(join(offRoot, 'config', 'learning.yml'),
    'schema_version: 1\nenabled: false\nmode: shadow\n');
  const disabled = createLearningContext({
    codeRoot: fixture.codeRoot, dataRoot: offRoot, now: fixedClock(),
  });
  await assert.rejects(() => workflow.syncSubmittedJobs(disabled, {}), /disabled/i);
  await assert.rejects(() => workflow.ensureSyncTask(disabled, { job: { urlKey: 'x' } }), /disabled/i);
});
