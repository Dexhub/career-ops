// auto/test/learning-submission-recovery.test.mjs — T14: submission-outcome
// recovery (CONTRACTS D4 + reconcileAttempt). Everything runs against an
// isolated mkdtemp fixture with injected executors and clocks: no real
// browser, model, agent CLI, or live data is ever touched. node:test only;
// synthetic values only.
//
// The safety boundary under test: once an attempt persists submission intent,
// a crash/kill/timeout can never be classified "didn't submit" from worker
// narrative — only bound structured evidence or an explicit human/portal
// resolution settles it, unknown parks behind a submission_unknown blocker,
// and the SHARED requeue path refuses with SUBMISSION_OUTCOME_UNKNOWN.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

let fixture;
let ctx;
let state;
let workflow;
let runApply;
let getRecord;
let createLearningContext;

const LEARNING_ON = 'schema_version: 1\nenabled: true\nmode: shadow\n';
const LEARNING_OFF = 'schema_version: 1\nenabled: false\nmode: shadow\n';
const TENANT = 'jobs.example.test';

before(async () => {
  fixture = createLearningFixture();
  // Config BEFORE any import that resolves roots at module load.
  writeFileSync(join(fixture.dataRoot, 'config', 'auto.yml'),
    'score_threshold: 4.0\nats_allowlist:\n  - synthetic\n');
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_ON);
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'),
    'filled_in_by_user: true\n');
  writeFileSync(join(fixture.dataRoot, 'config', 'profile.yml'), 'name: Fixture Person\n');
  writeFileSync(join(fixture.dataRoot, 'cv.md'), '# Synthetic CV\n');
  writeFileSync(join(fixture.dataRoot, 'resume.pdf'), 'synthetic-pdf');

  state = await import('../state.mjs');
  workflow = await import('../learning/workflow.mjs');
  ({ runApply } = await import('../apply-worker.mjs'));
  ({ getRecord } = await import('../learning/store.mjs'));
  ({ createLearningContext } = await import('../learning/context.mjs'));
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
});
after(() => fixture.cleanup());

let reportSeq = 500;
function seedJob(url, company) {
  const { job } = state.createJob({ url, company, role: 'Engineer', ats: 'synthetic' });
  for (const stage of ['evaluated', 'queued', 'resume_ready']) state.transition(job, stage, {});
  Object.assign(job, {
    resumePdf: join(fixture.dataRoot, 'resume.pdf'),
    resumeVariant: 'default',
    reportPath: `reports/${reportSeq += 1}-synthetic.md`,
    score: 4.5,
  });
  state.saveJob(job);
  return state.loadJob(job.urlKey);
}

/** Allocate + persist intent + CAS-claim an attempt, mirroring the worker. */
async function claimAttempt(urlKey, { launched = true } = {}) {
  let job = state.loadJob(urlKey);
  const attempt = state.allocateAttempt({
    job, auditRoot: join(fixture.dataRoot, 'output', job.company, 'audit'),
    policyVersion: 'pol-1', sourceVersion: 'src-1',
  });
  mkdirSync(join(attempt.auditDir, 'learning'), { recursive: true });
  await workflow.recordAttemptIntent(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId, urlKey,
    policyVersion: 'pol-1', sourceVersion: 'src-1',
    employerId: job.company, tenant: TENANT, allocatedAt: attempt.allocatedAt,
  });
  job = await state.updateJob(urlKey, {
    transitionTo: 'applying',
    patch: {
      attempts: 1, auditDir: attempt.auditDir,
      execution: {
        attemptId: attempt.attemptId, phase: 'in_progress',
        submissionPossible: true, submissionOutcome: null,
      },
    },
  });
  if (launched) await workflow.markAttemptLaunched(ctx, { attemptId: attempt.attemptId });
  return { job, attempt };
}

function writeBoundConfirmation(auditDir, { attemptId, employerId, tenant = TENANT, ...overrides }) {
  writeFileSync(join(auditDir, 'learning', 'confirmation.json'), JSON.stringify({
    attemptId, employerId, tenant,
    sourceArtifact: 'learning/confirmation-page.json',
    capturedAt: new Date(Date.now() + 60_000).toISOString(), // after allocation
    ...overrides,
  }));
}

const requeue = (urlKey) =>
  state.updateJob(urlKey, { transitionTo: 'queued', patch: { attempts: 0, lastError: null } });

// ---------------------------------------------------------------------------

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.dataRoot);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fixture.dataRoot + sep));
});

test('crash before launch: intent persisted but never launched -> definitely_not_submitted, retry allowed', async () => {
  const seeded = seedJob(`https://${TENANT}/pre-launch/1`, 'prelaunch-co');
  const { job, attempt } = await claimAttempt(seeded.urlKey, { launched: false });

  const rec = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: state });
  assert.equal(rec.status, 'definitely_not_submitted');

  const fresh = state.loadJob(job.urlKey);
  assert.equal(fresh.execution.submissionOutcome, 'definitely_not_submitted');
  // Reconciled non-submission is the ONE outcome the shared requeue accepts.
  await state.updateJob(job.urlKey, { transitionTo: 'parked', patch: {} });
  const requeued = await requeue(job.urlKey);
  assert.equal(requeued.stage, 'queued');
});

test('crash after launch, before any capture: unknown + submission_unknown blocker + requeue refused', async () => {
  const seeded = seedJob(`https://${TENANT}/post-launch/1`, 'postlaunch-co');
  const { job, attempt } = await claimAttempt(seeded.urlKey);

  const rec = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: state });
  assert.equal(rec.status, 'unknown');
  assert.ok(rec.blockerId);

  const blocker = getRecord(ctx, 'blockers', rec.blockerId);
  assert.equal(blocker.data.type, 'submission_unknown');
  assert.equal(blocker.status, 'open');

  const fresh = state.loadJob(job.urlKey);
  assert.equal(fresh.execution.submissionOutcome, 'unknown');
  assert.equal(fresh.execution.phase, 'blocked');
  assert.equal(fresh.execution.blockerId, rec.blockerId);

  await state.updateJob(job.urlKey, { transitionTo: 'parked', patch: {} });
  await assert.rejects(requeue(job.urlKey), (error) => error.code === 'SUBMISSION_OUTCOME_UNKNOWN');
});

test('crash after submit click: agent success sentence + screenshot existence are NOT confirmation', async () => {
  const seeded = seedJob(`https://${TENANT}/after-click/1`, 'afterclick-co');
  const { job, attempt } = await claimAttempt(seeded.urlKey);
  // What a dying worker leaves behind: a narrative and a file — no bound capture.
  writeFileSync(join(attempt.auditDir, 'result.json'),
    JSON.stringify({ status: 'submitted', confirmation_text: 'Thank you for applying!' }));
  writeFileSync(join(attempt.auditDir, '02-confirmation.png'), 'png');

  const rec = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: state });
  assert.equal(rec.status, 'unknown');

  // ...and the worker's own "failed / never submitted" claim can't clear the
  // conservative flag either: still unknown, never definitely_not_submitted.
  writeFileSync(join(attempt.auditDir, 'result.json'),
    JSON.stringify({ status: 'failed', reason: 'I never clicked submit' }));
  const rec2 = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: state });
  assert.equal(rec2.status, 'unknown');
});

test('crash after confirmation, before local persistence: bound capture reconciles to confirmed', async () => {
  const seeded = seedJob(`https://${TENANT}/confirmed/1`, 'confirmed-co');
  const { job, attempt } = await claimAttempt(seeded.urlKey);
  writeBoundConfirmation(attempt.auditDir, { attemptId: attempt.attemptId, employerId: 'confirmed-co' });

  const rec = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: state });
  assert.equal(rec.status, 'confirmed');
  assert.deepEqual(rec.evidenceRefs, ['learning/confirmation-page.json']);

  const fresh = state.loadJob(job.urlKey);
  assert.equal(fresh.execution.submissionOutcome, 'confirmed');
  assert.equal(fresh.execution.confirmationRef, 'learning/confirmation-page.json');
});

test('mismatched evidence: a thank-you page from the wrong tenant/employer is a contradiction -> unknown', async () => {
  const seeded = seedJob(`https://${TENANT}/mismatch/1`, 'mismatch-co');
  const { job, attempt } = await claimAttempt(seeded.urlKey);
  writeBoundConfirmation(attempt.auditDir, {
    attemptId: attempt.attemptId, employerId: 'mismatch-co', tenant: 'jobs.other-tenant.test',
  });
  const rec = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: state });
  assert.equal(rec.status, 'unknown');
  assert.match(rec.reason, /contradicts/);

  // Incomplete binding (no employer/tenant at all) is unknown too.
  const rec2 = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { confirmation: { attemptId: attempt.attemptId, sourceArtifact: 'x.json', capturedAt: '2026-10-11T00:05:00.000Z' } },
  }, { jobs: state });
  assert.equal(rec2.status, 'unknown');
});

test('old capture reused under a new attempt never confirms the new attempt', async () => {
  const seeded = seedJob(`https://${TENANT}/stale-capture/1`, 'stale-co');
  const first = await claimAttempt(seeded.urlKey);
  // The old attempt's genuine capture...
  writeBoundConfirmation(first.attempt.auditDir, { attemptId: first.attempt.attemptId, employerId: 'stale-co' });
  // ...settled, requeued, and a NEW attempt claimed.
  await workflow.reconcileAttempt(ctx, {
    applicationId: first.job.applicationId, attemptId: first.attempt.attemptId,
    evidence: { resolution: { outcome: 'not_submitted', by: 'operator-review' } },
  }, { jobs: state });
  await state.updateJob(seeded.urlKey, { transitionTo: 'parked', patch: {} });
  await requeue(seeded.urlKey);
  await state.updateJob(seeded.urlKey, { transitionTo: 'resume_ready', patch: {} });
  const second = await claimAttempt(seeded.urlKey);

  // The old capture presented as the new attempt's evidence: attempt binding fails.
  const stale = JSON.parse(JSON.stringify({
    attemptId: first.attempt.attemptId, employerId: 'stale-co', tenant: TENANT,
    sourceArtifact: 'learning/confirmation-page.json', capturedAt: '2026-10-11T00:05:00.000Z',
  }));
  const rec = await workflow.reconcileAttempt(ctx, {
    applicationId: second.job.applicationId, attemptId: second.attempt.attemptId,
    evidence: { confirmation: stale },
  }, { jobs: state });
  assert.equal(rec.status, 'unknown');
  assert.match(rec.reason, /stale or foreign capture/);

  // A capture predating the attempt's allocation is refused even with the id forged.
  const forged = { ...stale, attemptId: second.attempt.attemptId, capturedAt: '2020-01-01T00:00:00.000Z' };
  const rec2 = await workflow.reconcileAttempt(ctx, {
    applicationId: second.job.applicationId, attemptId: second.attempt.attemptId,
    evidence: { confirmation: forged },
  }, { jobs: state });
  assert.equal(rec2.status, 'unknown');
  assert.match(rec2.reason, /predates/);
});

test('verdict history: later reconciliations retain original evidence and prior verdicts', async () => {
  const seeded = seedJob(`https://${TENANT}/history/1`, 'history-co');
  const { job, attempt } = await claimAttempt(seeded.urlKey);

  const first = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId, evidence: {},
  }, { jobs: state });
  assert.equal(first.status, 'unknown');

  // A read-only portal review (human) later settles it as submitted.
  const second = await workflow.reconcileAttempt(ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { resolution: { outcome: 'submitted', by: 'operator-portal-review' } },
  }, { jobs: state });
  assert.equal(second.status, 'confirmed');

  const intent = getRecord(ctx, 'attempts', attempt.attemptId);
  assert.equal(intent.status, 'confirmed');
  assert.equal(intent.data.verdicts.length, 2);
  assert.equal(intent.data.verdicts[0].status, 'unknown'); // prior verdict retained
  assert.equal(intent.data.verdicts[1].status, 'confirmed');

  // The submission_unknown blocker resolved with the outcome.
  assert.equal(getRecord(ctx, 'blockers', first.blockerId).status, 'resolved');

  // A confirmed submission still never re-enters the queue.
  await state.updateJob(job.urlKey, { transitionTo: 'parked', patch: {} });
  await assert.rejects(requeue(job.urlKey), (error) => error.code === 'SUBMISSION_OUTCOME_UNKNOWN');
});

test('END TO END — timeout with ambiguous evidence: parked, generic requeue refuses, exactly one submit click', async () => {
  const seeded = seedJob(`https://${TENANT}/e2e-ambiguous/1`, 'e2e-ambiguous-co');
  const fakeBrowser = {
    submitClicks: 0,
    capabilities: () => ({
      tools: ['browseros_snapshot', 'browseros_act', 'browseros_read'],
      boundary: 'restricted', taskOwnedTabs: true,
    }),
    async run({ auditDir }) {
      // One genuine submit click, then the process dies: only a narrative and
      // a screenshot survive — nothing bound to the attempt.
      fakeBrowser.submitClicks += 1;
      writeFileSync(join(auditDir, 'answers.json'), JSON.stringify([]));
      writeFileSync(join(auditDir, '01-form-filled.png'), 'png');
      writeFileSync(join(auditDir, '02-confirmation.png'), 'png');
      writeFileSync(join(auditDir, 'result.json'),
        JSON.stringify({ status: 'submitted', confirmation_text: 'Thanks! (synthetic)' }));
      return { timedOut: true };
    },
  };

  const res = await runApply({ needle: 'e2e-ambiguous', submit: true, executor: fakeBrowser, log: () => {} });
  assert.equal(res.verdict.status, 'parked');
  assert.equal(res.job.stage, 'parked');
  const attemptId = res.job.execution.attemptId;
  const applicationId = res.job.applicationId;
  assert.equal(res.job.execution.submissionOutcome, 'unknown');

  const requeueFixtureJob = () => requeue(res.job.urlKey);
  const ambiguousEvidence = { auditDir: res.auditDir };

  const result = await workflow.reconcileAttempt(ctx,
    { applicationId, attemptId, evidence: ambiguousEvidence }, { jobs: state });
  assert.equal(result.status, 'unknown');
  await assert.rejects(requeueFixtureJob(), (error) => error.code === 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal(fakeBrowser.submitClicks, 1);
});

test('END TO END — process timeout after genuine confirmation: reconciled to submitted, never retried', async () => {
  const seeded = seedJob(`https://${TENANT}/e2e-confirmed/1`, 'e2e-confirmed-co');
  const fakeBrowser = {
    submitClicks: 0,
    capabilities: () => ({
      tools: ['browseros_snapshot', 'browseros_act', 'browseros_read'],
      boundary: 'restricted', taskOwnedTabs: true,
    }),
    async run({ auditDir, attemptId }) {
      fakeBrowser.submitClicks += 1;
      writeFileSync(join(auditDir, 'answers.json'), JSON.stringify([]));
      writeFileSync(join(auditDir, '01-form-filled.png'), 'png');
      writeFileSync(join(auditDir, 'learning', 'confirmation.json'), JSON.stringify({
        attemptId, employerId: 'e2e-confirmed-co', tenant: TENANT,
        sourceArtifact: 'learning/confirmation-page.json',
        capturedAt: new Date().toISOString(),
      }));
      return { timedOut: true }; // dies before it can report success
    },
  };

  const res = await runApply({ needle: 'e2e-confirmed', submit: true, executor: fakeBrowser, log: () => {} });
  assert.equal(res.verdict.status, 'submitted');
  assert.equal(res.job.stage, 'submitted');
  assert.equal(res.job.execution.submissionOutcome, 'confirmed');
  assert.equal(fakeBrowser.submitClicks, 1);
  assert.equal(getRecord(ctx, 'attempts', res.job.execution.attemptId).status, 'confirmed');
});

test('END TO END — retry pick of a crashed submission attempt reconciles instead of relaunching', async () => {
  const seeded = seedJob(`https://${TENANT}/e2e-crash/1`, 'e2e-crash-co');
  const { attempt } = await claimAttempt(seeded.urlKey); // launched, then "the process died"
  writeFileSync(join(attempt.auditDir, 'result.json'),
    JSON.stringify({ status: 'submitted', confirmation_text: 'Thanks!' })); // narrative only

  const sentinel = {
    runCalls: 0,
    capabilities: () => ({
      tools: ['browseros_snapshot', 'browseros_act', 'browseros_read'],
      boundary: 'restricted', taskOwnedTabs: true,
    }),
    async run() { sentinel.runCalls += 1; throw new Error('must never relaunch an unreconciled submission attempt'); },
  };
  const res = await runApply({ needle: 'e2e-crash', submit: true, executor: sentinel, log: () => {} });
  assert.equal(sentinel.runCalls, 0); // no relaunch, no second submit
  assert.equal(res.verdict.status, 'parked');
  assert.equal(res.job.stage, 'parked');
  await assert.rejects(requeue(seeded.urlKey), (error) => error.code === 'SUBMISSION_OUTCOME_UNKNOWN');
});

test('gating: learning off refuses the workflow; legacy jobs requeue exactly as before', async () => {
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_OFF);
  try {
    await assert.rejects(workflow.reconcileAttempt(ctx, {
      applicationId: 'app-x', attemptId: 'att-x', evidence: {},
    }, { jobs: state }), /learning is disabled/);

    // A legacy job (no persisted submission intent) keeps the unchanged
    // failed -> queued requeue: the guard keys ONLY on persisted intent.
    const legacy = seedJob(`https://${TENANT}/legacy/1`, 'legacy-co');
    await state.updateJob(legacy.urlKey, { transitionTo: 'applying', patch: { attempts: 3 } });
    await state.updateJob(legacy.urlKey, { transitionTo: 'failed', patch: { lastError: 'synthetic' } });
    const requeued = await requeue(legacy.urlKey);
    assert.equal(requeued.stage, 'queued');
  } finally {
    writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_ON);
  }
});
