// auto/test/learning-blockers.test.mjs — T13: persisted answer blockers.
// Everything runs against an isolated mkdtemp fixture with injected clocks;
// no real browser, Gmail, model, or live data is ever touched. node:test only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

let fixture;
let ctx;
let state;
let workflow;
let commitRecord; let getRecord;
let invalidateSource; let hashText;
let createLearningContext;

const LEARNING_ON = 'schema_version: 1\nenabled: true\nmode: shadow\n';
const LEARNING_OFF = 'schema_version: 1\nenabled: false\nmode: shadow\n';

function seedJob(url, company) {
  const { job } = state.createJob({ url, company, role: 'Engineer', ats: 'synthetic' });
  for (const stage of ['evaluated', 'queued', 'resume_ready', 'applying']) state.transition(job, stage, {});
  state.saveJob(job);
  return state.loadJob(job.urlKey); // migrated view carries applicationId
}

async function seedApprovedAnswer(id, familyId, sourceRefs = []) {
  return commitRecord(ctx, 'answers', id, {
    questionFamilyId: familyId,
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs,
    scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
}

before(async () => {
  fixture = createLearningFixture();
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_ON);
  // Imports AFTER the fixture sets CAREER_OPS_ROOT/CAREER_OPS_DB.
  state = await import('../state.mjs');
  workflow = await import('../learning/workflow.mjs');
  ({ commitRecord, getRecord } = await import('../learning/store.mjs'));
  ({ invalidateSource, hashText } = await import('../learning/answers.mjs'));
  ({ createLearningContext } = await import('../learning/context.mjs'));
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
});
after(() => fixture.cleanup());

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.dataRoot);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fixture.dataRoot + sep));
});

test('checkpointAttempt: CAS phase update bound to the owning attempt', async () => {
  let job = seedJob('https://jobs.example.test/ck-co/1', 'ck-co');
  job = await state.updateJob(job.urlKey, { patch: { execution: { attemptId: 'att-ck-1', phase: 'in_progress' } } });

  const updated = await workflow.checkpointAttempt(ctx, {
    applicationId: job.applicationId, attemptId: 'att-ck-1',
    expectedVersion: job.recordVersion, phase: 'preparing', evidenceRefs: ['learning/input-1.json'],
  }, { jobs: state });
  assert.equal(updated.execution.phase, 'preparing');
  assert.equal(updated.applicationId, job.applicationId);

  // A foreign attempt can never move the job.
  await assert.rejects(workflow.checkpointAttempt(ctx, {
    applicationId: job.applicationId, attemptId: 'att-other',
    expectedVersion: updated.recordVersion, phase: 'finished',
  }, { jobs: state }), /does not own/);

  // Invalid phase is refused, never guessed.
  await assert.rejects(workflow.checkpointAttempt(ctx, {
    applicationId: job.applicationId, attemptId: 'att-ck-1',
    expectedVersion: updated.recordVersion, phase: 'done',
  }, { jobs: state }), /invalid phase/);

  // Stale expectedVersion loses with VERSION_CONFLICT instead of overwriting.
  await assert.rejects(workflow.checkpointAttempt(ctx, {
    applicationId: job.applicationId, attemptId: 'att-ck-1',
    expectedVersion: 1, phase: 'finished',
  }, { jobs: state }), (err) => err.code === 'VERSION_CONFLICT');
});

test('missing_answer blocker: open idempotently, resolve only with an APPROVED answer, resume same application', async () => {
  let job = seedJob('https://jobs.example.test/ans-co/1', 'ans-co');
  job = await state.updateJob(job.urlKey, { patch: { execution: { attemptId: 'att-ans-1', phase: 'in_progress' } } });
  const originalApplicationId = job.applicationId;

  const { blocker, created } = await workflow.openBlocker(ctx, {
    applicationId: job.applicationId, attemptId: 'att-ans-1',
    type: 'missing_answer', question: 'What is your notice period?',
    requiredResolution: 'fam-notice', resumePoint: 'preparing',
  });
  assert.ok(created);
  // Blocked record carries request time and the safe resume point.
  assert.equal(blocker.data.requestedAt, '2026-10-11T00:00:00.000Z');
  assert.equal(blocker.data.resumePoint, 'preparing');

  // Re-opening the same wait returns the SAME record.
  const again = await workflow.openBlocker(ctx, {
    applicationId: job.applicationId, attemptId: 'att-ans-1',
    type: 'missing_answer', question: 'What is your notice period?',
    requiredResolution: 'fam-notice',
  });
  assert.equal(again.created, false);
  assert.equal(again.blocker.id, blocker.id);

  // findOpenAttemptBlocker (worker completion routing) sees the live wait.
  assert.equal(workflow.findOpenAttemptBlocker(ctx, 'att-ans-1')?.id, blocker.id);

  // No approved answer yet: resolution is refused, never invented.
  await assert.rejects(workflow.resolveBlocker(ctx, {
    blockerId: blocker.id, resolution: { answerId: 'ans-missing' },
  }, { jobs: state }), /APPROVED answer/);

  // A merely proposed answer is also refused.
  await commitRecord(ctx, 'answers', 'ans-proposed', {
    questionFamilyId: 'fam-notice', kind: 'draft', authority: 'generated',
  }, { expectedRevision: 0, status: 'proposed', sourceIds: [] });
  await assert.rejects(workflow.resolveBlocker(ctx, {
    blockerId: blocker.id, resolution: { answerId: 'ans-proposed' },
  }, { jobs: state }), /APPROVED answer/);

  // Approved answer with a pinned source version resolves the wait.
  const refs = [{ fileKey: 'standing', sha256: hashText('custom:\n  notice_period: "4 weeks"\n') }];
  await seedApprovedAnswer('ans-notice', 'fam-notice', refs);
  const result = await workflow.resolveBlocker(ctx, {
    blockerId: blocker.id, resolution: { answerId: 'ans-notice' },
  }, { jobs: state });

  // Resume loads the approved source version, same operation, reread required.
  assert.deepEqual(result.sourceVersion, refs);
  assert.equal(result.rereadRequired, true);
  assert.equal(result.resumePoint, 'preparing');
  assert.equal(result.job.applicationId, originalApplicationId);
  assert.equal(result.job.execution.phase, 'preparing');
  assert.equal(result.job.execution.blockerId, null);
  assert.equal(getRecord(ctx, 'blockers', blocker.id).status, 'resolved');

  // A settled wait cannot resolve twice.
  await assert.rejects(workflow.resolveBlocker(ctx, {
    blockerId: blocker.id, resolution: { answerId: 'ans-notice' },
  }, { jobs: state }), /only open\/waiting/);
});

test('T08 notification consumed: invalidateSource bumps the bound blocker; sweep resolves once approved', async () => {
  let job = seedJob('https://jobs.example.test/sweep-co/1', 'sweep-co');
  job = await state.updateJob(job.urlKey, { patch: { execution: { attemptId: 'att-sw-1', phase: 'blocked' } } });

  const oldHash = hashText('old standing answers');
  const future = '2099-01-01T00:00:00.000Z';
  const { blocker } = await workflow.openBlocker(ctx, {
    applicationId: job.applicationId, attemptId: 'att-sw-1',
    type: 'missing_answer', question: 'Which additional language do you speak?',
    requiredResolution: 'fam-lang', nextCheckAt: future,
    sourceVersions: [{ fileKey: 'standing', sha256: oldHash }],
  });

  // Not due: the sweep leaves it alone even though it is open.
  let swept = await workflow.sweepDueBlockers(ctx, { jobs: state });
  assert.ok(swept.skipped.includes(blocker.id));
  assert.equal(swept.resolved.length, 0);

  // T08: a source edit notifies ONLY the bound blocker (nextCheckAt -> now).
  const summary = await invalidateSource(ctx, { fileKey: 'standing', oldHash, newHash: hashText('new standing answers') });
  assert.ok(summary.notifiedBlockers.includes(blocker.id));
  const notified = getRecord(ctx, 'blockers', blocker.id);
  assert.notEqual(notified.data.nextCheckAt, future);

  // Still no approved answer: due but unresolved — stays open, never guessed.
  swept = await workflow.sweepDueBlockers(ctx, { jobs: state });
  assert.equal(swept.resolved.length, 0);
  assert.equal(getRecord(ctx, 'blockers', blocker.id).status, 'open');

  // Answer approved while the browser is closed: the sweep resumes the SAME
  // application at its safe resume point.
  await seedApprovedAnswer('ans-lang', 'fam-lang');
  swept = await workflow.sweepDueBlockers(ctx, { jobs: state });
  assert.equal(swept.resolved.length, 1);
  assert.equal(swept.resolved[0].blockerId, blocker.id);
  const resumed = state.loadJob(job.urlKey);
  assert.equal(resumed.applicationId, job.applicationId);
  assert.equal(resumed.execution.phase, 'preparing');
  assert.equal(resumed.execution.blockerId, null);
});

test('captcha blocker: never auto-resolved or bypassed — explicit human approval only', async () => {
  const job = seedJob('https://jobs.example.test/captcha-co/1', 'captcha-co');
  const { blocker } = await workflow.openBlocker(ctx, {
    applicationId: job.applicationId, attemptId: 'att-cap-1',
    type: 'captcha', question: 'CAPTCHA shown on the synthetic form',
  });

  // The sweep skips it entirely.
  const swept = await workflow.sweepDueBlockers(ctx, { jobs: state });
  assert.ok(swept.skipped.includes(blocker.id));

  await assert.rejects(workflow.resolveBlocker(ctx, { blockerId: blocker.id }, { jobs: state }),
    /human approval/);
  const result = await workflow.resolveBlocker(ctx, {
    blockerId: blocker.id, approval: { approvedBy: 'fixture-human' },
  }, { jobs: state });
  assert.equal(result.job.execution.phase, 'preparing');
  assert.equal(getRecord(ctx, 'blockers', blocker.id).data.resolution.by, 'fixture-human');
});

test('flag off: every workflow entry point refuses; nothing is written', async () => {
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_OFF);
  try {
    const offCtx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
    for (const call of [
      () => workflow.checkpointAttempt(offCtx, { applicationId: 'x', attemptId: 'y', phase: 'preparing' }, { jobs: state }),
      () => workflow.openBlocker(offCtx, { applicationId: 'x', type: 'captcha', question: 'q' }),
      () => workflow.resolveBlocker(offCtx, { blockerId: 'blk-x' }, { jobs: state }),
      () => workflow.sweepDueBlockers(offCtx, { jobs: state }),
      () => workflow.ensureAccount(offCtx, { tenant: 't', employerId: 'e', loginIdentityRef: 'l' }),
    ]) {
      await assert.rejects(call(), /learning is disabled/);
    }
  } finally {
    writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_ON);
  }
});
