// auto/test/learning-reviewer.test.mjs — T19: bounded incremental reviewer.
// Covers restart mid-batch, two panel processes (lease contention),
// future/backward clock shift, sleep/catch-up coalescing, unknown cloud
// outcome, budget exhaustion and rejection of a proposal that attempts to
// grant itself authority. Everything runs against an isolated mkdtemp fixture
// with injected clocks and injected fake transports; synthetic values only;
// no real worker, shell, browser or cloud call is ever started. node:test only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture } from './helpers/learning.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(here, '..', '..'));

const REVIEW_ON = 'schema_version: 1\nenabled: true\nmode: shadow\nreview:\n  enabled: true\n';
const REVIEW_OFF = 'schema_version: 1\nenabled: true\nmode: shadow\n';
const LEARNING_OFF = 'schema_version: 1\nenabled: false\n';
const CLOUD_ON = `${REVIEW_ON}cloud:
  enabled: true
  function_arn: arn:aws:lambda:us-east-1:000000000000:function:synthetic-review
  model_id: anthropic.claude-3-5-haiku-20241022-v1:0
  daily_usd_cap: 5
  max_calls_per_day: 10
`;
const CLOUD_TINY_BUDGET = `${REVIEW_ON}cloud:
  enabled: true
  function_arn: arn:aws:lambda:us-east-1:000000000000:function:synthetic-review
  model_id: anthropic.claude-3-5-haiku-20241022-v1:0
  daily_usd_cap: 0.00000001
  max_calls_per_day: 10
`;

let fixture;
let ctx;
let reviewer;
let commitRecord; let getRecord;
let createLearningContext; let learningDataRoot;

// Injectable, shiftable clock (future/backward shifts are just assignments).
let nowIso = '2026-10-11T00:00:00.000Z';
const clock = () => new Date(nowIso);

function setConfig(yaml) {
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), yaml);
}

let attemptSeq = 0;
async function seedAttempt(status, { tenant = 'acme-wd' } = {}) {
  attemptSeq += 1;
  const id = `att-rev-${String(attemptSeq).padStart(3, '0')}`;
  await commitRecord(ctx, 'attempts', id, {
    applicationId: `app-rev-${attemptSeq}`, attemptId: id, urlKey: `synthetic-rev-${attemptSeq}`,
    allowedAction: 'submit', submissionPossible: true,
    policyVersion: 'p1-rev', sourceVersion: 's1-rev', procedureVersion: null,
    employerId: 'acme', tenant, requisitionId: null, accountId: null,
    allocatedAt: nowIso, launchedAt: null, verdicts: [],
  }, { expectedRevision: 0, status, sourceIds: [] });
  return id;
}

before(async () => {
  fixture = createLearningFixture();
  setConfig(REVIEW_ON);
  // Imports AFTER the fixture sets CAREER_OPS_ROOT/CAREER_OPS_DB.
  reviewer = await import('../learning/reviewer.mjs');
  ({ commitRecord, getRecord } = await import('../learning/store.mjs'));
  ({ createLearningContext, learningDataRoot } = await import('../learning/context.mjs'));
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: clock });
});
after(() => fixture.cleanup());

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.dataRoot);
});

test('reviewer refuses while learning or review is disabled; status reports not due', async () => {
  setConfig(LEARNING_OFF);
  await assert.rejects(() => reviewer.runReview(ctx, { localOnly: true }), { code: 'REVIEW_DISABLED' });
  assert.deepEqual(reviewer.reviewStatus(ctx), { enabled: false, reviewEnabled: false, due: false });
  setConfig(REVIEW_OFF);
  await assert.rejects(() => reviewer.runReview(ctx, { localOnly: true }), { code: 'REVIEW_DISABLED' });
  assert.equal(reviewer.reviewStatus(ctx).due, false);
  setConfig(REVIEW_ON);
});

test('reviewDue: enabled-only cadence, future and backward clock shifts', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  // Interval applies only after enabling: no enabledAt means never due.
  assert.equal(reviewer.reviewDue({ enabledAt: null, dueAt: null, intervalMinutes: 360 }, now), false);
  // Enabled but never scheduled: due immediately.
  assert.equal(reviewer.reviewDue({ enabledAt: '2026-10-11T00:00:00.000Z', dueAt: null, intervalMinutes: 360 }, now), true);
  const state = { enabledAt: '2026-10-11T00:00:00.000Z', dueAt: '2026-10-11T18:00:00.000Z', intervalMinutes: 360 };
  assert.equal(reviewer.reviewDue(state, now), false);                                // not yet
  assert.equal(reviewer.reviewDue(state, new Date('2026-10-11T18:00:00.000Z')), true); // exactly due
  assert.equal(reviewer.reviewDue(state, new Date('2026-10-13T00:00:00.000Z')), true); // forward shift / long sleep
  // Backward clock shift: dueAt now sits more than one interval in the
  // future — one resynchronizing run instead of a frozen reviewer.
  assert.equal(reviewer.reviewDue(state, new Date('2026-10-11T06:00:00.000Z')), true);
  assert.equal(reviewer.reviewDue(state, new Date('2026-10-11T13:00:00.000Z')), false); // within one interval of due
});

test('localOnly run touches no application starter, shell or cloud; cursor persisted', async () => {
  const settled1 = await seedAttempt('confirmed');
  const settled2 = await seedAttempt('definitely_not_submitted');
  const unsettled = await seedAttempt('launched');

  const fakeApplicationStarter = { calls: 0, fn: () => { fakeApplicationStarter.calls += 1; } };
  const fakeShell = { calls: 0, fn: () => { fakeShell.calls += 1; } };
  const fakeCloud = { calls: 0, transport: async () => { fakeCloud.calls += 1; return {}; } };
  // Even if a reviewer bug reached for them, these are the only handles.
  const ctxLocal = {
    ...ctx,
    startCycle: fakeApplicationStarter.fn,
    shell: fakeShell.fn,
    reviewTransports: { cloud: fakeCloud.transport },
  };

  const savedReview = await reviewer.runReview(ctxLocal, { localOnly: true, limit: 25, approvalId: null, owner: 'test-local' });
  assert.equal(fakeApplicationStarter.calls, 0);
  assert.equal(fakeShell.calls, 0);
  assert.equal(fakeCloud.calls, 0);
  assert.ok(savedReview.cursor);

  assert.equal(savedReview.status, 'completed');
  assert.equal(savedReview.processed, 2);
  assert.ok(savedReview.pending.includes(unsettled)); // unsettled stays explicitly pending
  assert.equal(savedReview.cloud, null);              // localOnly: cloud never consulted

  const runRecord = getRecord(ctx, 'reviewRuns', savedReview.runId);
  assert.equal(runRecord.status, 'completed');
  assert.ok(runRecord.data.cursor.updatedAt);
  assert.ok([settled1, settled2].every((id) => runRecord.sourceIds.includes(id)));

  const state = reviewer.readReviewerState(ctx);
  assert.equal(state.cursor.processed[settled1], 1);
  assert.equal(state.cursor.processed[settled2], 1);
  assert.equal(state.activeRunId, null); // released
  assert.equal(state.lease, null);
});

test('restart mid-batch: batch limit stops early, cursor resumes, nothing processed twice', async () => {
  const a = await seedAttempt('confirmed');
  const b = await seedAttempt('confirmed');
  const c = await seedAttempt('confirmed');

  const first = await reviewer.runReview(ctx, { localOnly: true, limit: 1, owner: 'test-restart' });
  assert.equal(first.processed, 1);
  assert.equal(first.stoppedEarly, true);
  const afterFirst = reviewer.readReviewerState(ctx);
  const processedAfterFirst = Object.keys(afterFirst.cursor.processed).length;

  // "Restart": a fresh call (fresh process in production) resumes from the
  // persisted cursor and never reprocesses the first attempt.
  const second = await reviewer.runReview(ctx, { localOnly: true, limit: 25, owner: 'test-restart-2' });
  assert.equal(second.processed, 2);
  const state = reviewer.readReviewerState(ctx);
  assert.equal(Object.keys(state.cursor.processed).length, processedAfterFirst + 2);
  for (const id of [a, b, c]) assert.equal(state.cursor.processed[id], 1);
  // The first run's batch and the second run's batch never overlap.
  const firstRecord = getRecord(ctx, 'reviewRuns', first.runId);
  const secondRecord = getRecord(ctx, 'reviewRuns', second.runId);
  for (const id of firstRecord.sourceIds) assert.ok(!secondRecord.sourceIds.includes(id));
});

test('two panel processes: a live lease refuses the second runner; an expired lease is taken over', async () => {
  const statePath = join(learningDataRoot(ctx), 'reviewer', 'state.json');
  const held = reviewer.readReviewerState(ctx);
  held.lease = { owner: 'panel-A', acquiredAt: nowIso, expiresAt: '2026-10-11T06:00:00.000Z' };
  held.activeRunId = null;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(held, null, 2));

  await assert.rejects(
    () => reviewer.runReview(ctx, { localOnly: true, owner: 'panel-B' }),
    { code: 'REVIEWER_LEASE_HELD' },
  );

  // Crash recovery: the lease expired and the dead runner left an active run
  // record behind — the next runner takes over and marks it aborted.
  await commitRecord(ctx, 'reviewRuns', 'review-stale-crash', {
    startedAt: '2026-10-11T05:00:00.000Z', cursor: { resumedFrom: 0 },
    budget: { kind: 'review_run', limit: 25, timeLimitMs: 60000, localOnly: true },
    processed: {}, outcomes: { result: 'pending' }, errors: [],
  }, { expectedRevision: 0, status: 'running', sourceIds: [] });
  const stale = reviewer.readReviewerState(ctx);
  stale.lease = { owner: 'panel-A', acquiredAt: '2026-10-11T05:00:00.000Z', expiresAt: '2026-10-11T05:30:00.000Z' };
  stale.activeRunId = 'review-stale-crash';
  writeFileSync(statePath, JSON.stringify(stale, null, 2));

  nowIso = '2026-10-11T07:00:00.000Z'; // past the lease expiry
  const report = await reviewer.runReview(ctx, { localOnly: true, owner: 'panel-B' });
  assert.equal(report.status, 'completed');
  assert.equal(getRecord(ctx, 'reviewRuns', 'review-stale-crash').status, 'aborted');
});

test('sleep/catch-up: many missed intervals coalesce into one bounded run', async () => {
  // The machine "slept" for two days: far past dueAt.
  nowIso = '2026-10-13T07:00:00.000Z';
  let state = reviewer.readReviewerState(ctx);
  assert.equal(reviewer.reviewDue(state, clock()), true);
  assert.equal(reviewer.reviewStatus(ctx).due, true);

  await seedAttempt('confirmed');
  const report = await reviewer.runReview(ctx, { localOnly: true, owner: 'test-catchup' });
  assert.equal(report.status, 'completed');

  // ONE catch-up run: the next due time is now+interval, so the reviewer is
  // immediately not-due again — missed intervals are never replayed.
  state = reviewer.readReviewerState(ctx);
  assert.equal(reviewer.reviewDue(state, clock()), false);
  assert.equal(state.dueAt, new Date(clock().getTime() + state.intervalMinutes * 60_000).toISOString());
  assert.equal(reviewer.reviewStatus(ctx).due, false);
});

test('malformed source record is reported and skipped without blocking unrelated records', async () => {
  const good = await seedAttempt('confirmed');
  const badId = 'att-rev-corrupt';
  const badDir = join(learningDataRoot(ctx), 'records', 'attempts', badId);
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, '1.json'), '{ not json');

  const report = await reviewer.runReview(ctx, { localOnly: true, owner: 'test-corrupt' });
  assert.equal(report.status, 'completed');
  assert.ok(report.errors.some((e) => e.sourceId === badId));
  const state = reviewer.readReviewerState(ctx);
  assert.equal(state.cursor.processed[good], 1);        // unrelated record flowed
  assert.equal(state.cursor.processed[badId], undefined); // corrupt source stays pending
});

test('cloud variant requires a recorded D03 approval; AWS config alone is insufficient', async () => {
  setConfig(CLOUD_ON); // credential-style config present — still not approval
  await assert.rejects(
    () => reviewer.runReview(ctx, { localOnly: false, approvalId: null }),
    { code: 'REVIEW_APPROVAL_REQUIRED' },
  );
  // An unapproved or non-D03 record is also insufficient.
  await commitRecord(ctx, 'proposals', 'd03-not-approved', {
    kind: 'config', evidenceIds: [], intendedBenefit: 'enable cloud review', risk: 'low',
    baseline: null, evaluationResult: null, affectedSources: [],
    requiredApprovals: ['user', 'D03'], rollbackVersion: null, diff: null,
  }, { expectedRevision: 0, status: 'proposed', sourceIds: [] });
  await assert.rejects(
    () => reviewer.runReview(ctx, { localOnly: false, approvalId: 'd03-not-approved' }),
    { code: 'REVIEW_APPROVAL_REQUIRED' },
  );
  setConfig(REVIEW_ON);
});

test('budget exhaustion: reservation refused before any transport call; run still completes locally', async () => {
  setConfig(CLOUD_TINY_BUDGET);
  await commitRecord(ctx, 'proposals', 'd03-approval', {
    kind: 'config', evidenceIds: [], intendedBenefit: 'operator-approved cloud review (D03)', risk: 'low',
    baseline: null, evaluationResult: null, affectedSources: [],
    requiredApprovals: ['user', 'D03'], rollbackVersion: null, diff: null,
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  await seedAttempt('definitely_not_submitted', { tenant: 'budget-ats' });
  const fakeCloud = { calls: 0, transport: async () => { fakeCloud.calls += 1; return {}; } };
  const report = await reviewer.runReview(ctx, {
    localOnly: false, approvalId: 'd03-approval', owner: 'test-budget',
    transports: { cloud: fakeCloud.transport },
  });
  assert.equal(report.status, 'completed'); // local summaries remain the result
  assert.equal(report.cloud.skipped, 'CLOUD_BUDGET_EXCEEDED');
  assert.equal(fakeCloud.calls, 0); // budget is reserved BEFORE the transport
  assert.ok(report.summaries.failures.total >= 1);
  setConfig(REVIEW_ON);
});

test('unknown cloud outcome is recorded, leaves the reservation open and is never auto-reissued', async () => {
  setConfig(CLOUD_ON);
  await seedAttempt('definitely_not_submitted', { tenant: 'unknown-ats' });
  const fakeCloud = {
    calls: 0,
    transport: async () => { fakeCloud.calls += 1; throw new Error('socket vanished mid-flight'); },
  };
  const report = await reviewer.runReview(ctx, {
    localOnly: false, approvalId: 'd03-approval', owner: 'test-unknown',
    transports: { cloud: fakeCloud.transport },
  });
  assert.equal(report.status, 'completed');
  assert.equal(report.cloud.result, 'unknown');
  assert.ok(report.cloud.reservationId);
  assert.equal(fakeCloud.calls, 1);
  // The reservation stays open ('running') pending reconciliation.
  assert.equal(getRecord(ctx, 'reviewRuns', report.cloud.reservationId).status, 'running');

  // A second cloud run must NOT reissue the paid request while the first
  // outcome is unresolved: the in-flight guard skips, transport untouched.
  await seedAttempt('definitely_not_submitted', { tenant: 'unknown-ats' });
  const second = await reviewer.runReview(ctx, {
    localOnly: false, approvalId: 'd03-approval', owner: 'test-unknown-2',
    transports: { cloud: fakeCloud.transport },
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.cloud.skipped, 'CLOUD_IN_FLIGHT');
  assert.equal(fakeCloud.calls, 1);
  setConfig(REVIEW_ON);
});

test('proposals: duplicate suppression by component/source/version retains extra evidence', async () => {
  await seedAttempt('definitely_not_submitted', { tenant: 'dup-ats' });
  await seedAttempt('definitely_not_submitted', { tenant: 'dup-ats' });
  const first = await reviewer.runReview(ctx, { localOnly: true, owner: 'test-dup-1' });
  assert.equal(first.proposals.created, 1);
  const id = reviewer.proposalIdFor({ kind: 'procedure', component: 'procedure', source: 'tenant:dup-ats', version: 'v1' });
  const created = getRecord(ctx, 'proposals', id);
  assert.equal(created.status, 'proposed');
  assert.equal(created.data.evidenceIds.length, 2);
  // Why/baseline/scope/evaluation/approval-gate are all recorded.
  assert.ok(created.data.intendedBenefit);
  assert.deepEqual(created.data.baseline, { failures: 2, tenant: 'dup-ats' });
  assert.deepEqual(created.data.affectedSources, ['tenant:dup-ats']);
  assert.equal(created.data.evaluationResult, null);
  assert.ok(created.data.requiredApprovals.includes('user'));

  await seedAttempt('definitely_not_submitted', { tenant: 'dup-ats' });
  await seedAttempt('definitely_not_submitted', { tenant: 'dup-ats' });
  const second = await reviewer.runReview(ctx, { localOnly: true, owner: 'test-dup-2' });
  assert.equal(second.proposals.created, 0); // suppressed duplicate...
  assert.equal(second.proposals.updated, 1); // ...but the evidence is retained
  const updated = getRecord(ctx, 'proposals', id);
  assert.equal(updated.revision, created.revision + 1);
  assert.equal(updated.status, 'proposed');
  assert.equal(updated.data.evidenceIds.length, 4);
  for (const e of created.data.evidenceIds) assert.ok(updated.data.evidenceIds.includes(e));
});

test('a proposal that attempts to grant itself authority is rejected', async () => {
  const base = {
    kind: 'config', component: 'config', source: 'learning.yml', version: 'v1',
    evidenceIds: [], intendedBenefit: 'synthetic', baseline: null, affectedSources: [],
  };
  assert.equal(reviewer.screenProposalCandidate({ ...base, status: 'approved' }).code, 'PROPOSAL_SELF_AUTHORITY');
  assert.equal(reviewer.screenProposalCandidate({ ...base, status: 'applied' }).code, 'PROPOSAL_SELF_AUTHORITY');
  assert.equal(reviewer.screenProposalCandidate({ ...base, requiredApprovals: [] }).code, 'PROPOSAL_SELF_AUTHORITY');
  assert.equal(reviewer.screenProposalCandidate({ ...base, autoApply: true }).code, 'PROPOSAL_SELF_AUTHORITY');
  assert.equal(reviewer.screenProposalCandidate({ ...base, execute: 'node evil.mjs' }).code, 'PROPOSAL_SELF_AUTHORITY');
  assert.equal(reviewer.screenProposalCandidate({ ...base, approvedBy: 'user' }).code, 'PROPOSAL_SELF_AUTHORITY');
  await assert.rejects(
    () => reviewer.persistProposal(ctx, { ...base, status: 'approved' }),
    { code: 'PROPOSAL_SELF_AUTHORITY' },
  );
  // Code/UI proposals are inert: the diff is stored as text, never executed.
  const { envelope } = await reviewer.persistProposal(ctx, {
    ...base, kind: 'code', source: 'reviewer-note', diff: '--- a/x\n+++ b/x\n+inert suggestion',
  });
  assert.equal(envelope.status, 'proposed');
  assert.equal(typeof envelope.data.diff, 'string');
});
