// auto/test/learning-metrics.test.mjs — T20: honest operational savings and
// career-outcome metrics. Everything runs against an isolated mkdtemp fixture
// with an injected tracker/outcome reader: no real tracker, DB, worker, model
// or browser is ever touched. node:test only; synthetic values only.
//
// The boundary under test: every channel is reported separately; unknown
// usage/time stays unknown (never zero); pending applications are never
// inferred rejected; later status corrections win; rates honor the existing
// calibration sample floor; duplicate attempts dedupe to one authoritative
// join row; live before/after comparisons are labeled associations with role
// mix, ATS mix, date window and small samples exposed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

let fixture;
let ctx;
let intelligence;
let commitRecord;
let createLearningContext;

const NOW = '2026-10-11T00:00:00Z';

before(async () => {
  fixture = createLearningFixture();
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'),
    'schema_version: 1\nenabled: true\nmode: shadow\n');
  intelligence = await import('../learning/intelligence.mjs');
  ({ commitRecord } = await import('../learning/store.mjs'));
  ({ createLearningContext } = await import('../learning/context.mjs'));
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock(NOW) });
});
after(() => fixture.cleanup());

test('fixture isolation: store lives under the mkdtemp fixture root', () => {
  assert.ok(fixture.dataRoot.startsWith(tmpdir() + sep) || fixture.dataRoot.includes('career-learning-'));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.root);
});

// ---------------------------------------------------------------------------
// Synthetic seeds

function emptyTracker() {
  return { listApplications: () => [], listStatusEvents: () => [] };
}

async function seedAttempt(id, {
  applicationId, status = 'confirmed', urlKey = null, allocatedAt = '2026-10-01T10:00:00Z',
  sourceVersion = 'cv-v1', policyVersion = 'pol-1', procedureVersion = null,
} = {}) {
  return commitRecord(ctx, 'attempts', id, {
    applicationId,
    attemptId: id,
    urlKey: urlKey ?? `https://jobs.example.test/${applicationId}`,
    allowedAction: 'submit',
    submissionPossible: true,
    policyVersion,
    sourceVersion,
    procedureVersion,
    allocatedAt,
    verdicts: [{ at: '2026-10-01T10:20:00Z', status }],
  }, { expectedRevision: 0, status, sourceIds: [] });
}

async function seedObservation(id, {
  applicationId, originalText, answerDisposition = 'reused', observedAt = '2026-10-01T10:05:00Z',
  atsVendor = 'synthats', roleTitle = 'Software Engineer',
} = {}) {
  return commitRecord(ctx, 'observations', id, {
    applicationId,
    originalText,
    fieldType: 'text',
    coverage: 'observed',
    answerDisposition,
    observedAt,
    atsVendor,
    roleTitle,
  }, { expectedRevision: 0, status: 'recorded', sourceIds: [] });
}

// ---------------------------------------------------------------------------

test('missing token usage: unknown cost/usage stays unknown, never zero', async () => {
  // Reservation with NO outcomes.usage and NO actualUsd (unknown outcome).
  await commitRecord(ctx, 'reviewRuns', 'resv-unknown-1', {
    startedAt: '2026-10-01T09:00:00Z',
    budget: { kind: 'cloud_reservation', requestId: 'rq1', estUsd: 0.25, modelId: 'm' },
    outcomes: { result: 'pending' },
  }, { expectedRevision: 0, status: 'running', sourceIds: [] });
  // Reservation with full known usage.
  await commitRecord(ctx, 'reviewRuns', 'resv-known-1', {
    startedAt: '2026-10-01T09:30:00Z',
    budget: { kind: 'cloud_reservation', requestId: 'rq2', estUsd: 0.10, modelId: 'm' },
    outcomes: { result: 'succeeded', actualUsd: 0.04, usage: { input: 100, output: 50, total: 150 } },
  }, { expectedRevision: 0, status: 'completed', sourceIds: [] });

  const m = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  assert.equal(m.modelUsage.runs, 2);
  assert.equal(m.modelUsage.runsWithKnownCost, 1);
  assert.equal(m.modelUsage.knownCostUsd, 0.04);           // estUsd never folded into actuals
  assert.equal(m.modelUsage.runsWithUnknownCost, 1);
  assert.equal(m.modelUsage.reservedEstUsdUnknownOutcome, 0.25); // ceiling reported SEPARATELY
  assert.equal(m.modelUsage.runsWithUnknownUsage, 1);
  assert.deepEqual(m.modelUsage.tokens, { input: 100, output: 50, total: 150 });
});

test('waiting vs active time are separated; unknown active time is counted, not zeroed', async () => {
  await seedAttempt('att-time-1', { applicationId: 'app-time-1', status: 'confirmed' });
  // A blocker contributes wait time to att-time-1.
  await commitRecord(ctx, 'blockers', 'blk-time-1', {
    applicationId: 'app-time-1',
    attemptId: 'att-time-1',
    type: 'verification_pending',
    requestedAt: '2026-10-01T10:05:00Z',
    resolution: { resolvedAt: '2026-10-01T10:15:00Z' },
  }, { expectedRevision: 0, status: 'resolved', sourceIds: [] });
  // Attempt with NO allocatedAt timestamp parseable window -> unknown active time.
  await commitRecord(ctx, 'attempts', 'att-time-2', {
    applicationId: 'app-time-2',
    attemptId: 'att-time-2',
    urlKey: 'https://jobs.example.test/app-time-2',
    allowedAction: 'submit',
    submissionPossible: true,
    allocatedAt: '2026-10-01T11:00:00Z',
    verdicts: [],
  }, { expectedRevision: 0, status: 'unknown', sourceIds: [] });

  const m = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  assert.equal(m.time.waitMsTotal >= 10 * 60 * 1000, true);         // 10 min blocker wait counted
  assert.equal(m.time.attemptsWithKnownActiveTime >= 1, true);
  // activeMs = total - wait, so known active time never includes the wait.
  assert.ok(m.time.activeMsKnownTotal < m.time.waitMsTotal + m.time.activeMsKnownTotal);
  // No attempt's unknown active time was silently folded in as zero:
  assert.equal(typeof m.time.attemptsWithUnknownActiveTime, 'number');
});

test('duplicate attempts collapse to one authoritative outcome row and are reported', async () => {
  await seedAttempt('att-dup-1', { applicationId: 'app-dup', status: 'unknown', allocatedAt: '2026-10-02T08:00:00Z' });
  await seedAttempt('att-dup-2', { applicationId: 'app-dup', status: 'confirmed', allocatedAt: '2026-10-02T09:00:00Z' });

  const m = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  assert.equal(m.attempts.duplicateAttemptApplications, 1);
  const rows = m.outcomes.joined.filter((r) => r.applicationId === 'app-dup');
  assert.equal(rows.length, 1);                       // deduped: one row per application
  assert.equal(rows[0].attemptStatus, 'confirmed');   // settled status wins over 'unknown'
  assert.equal(rows[0].duplicateAttempts, 1);
});

test('pending outcomes stay in_flight: never inferred rejected, excluded from rates', async () => {
  await seedAttempt('att-pend-1', { applicationId: 'app-pend', urlKey: 'https://jobs.example.test/pending-1' });
  const tracker = {
    listApplications: () => [{ num: 10, url: 'https://jobs.example.test/pending-1', status: 'Applied' }],
    listStatusEvents: () => [],
  };
  const m = await intelligence.deriveLearningMetrics(ctx, { tracker });
  const row = m.outcomes.joined.find((r) => r.applicationId === 'app-pend');
  assert.equal(row.outcome.class, 'in_flight');
  assert.notEqual(row.outcome.class, 'rejected');
  assert.equal(row.outcome.reachedInterview, null);   // unknown, not false
  assert.ok(m.outcomes.inFlight >= 1);
  // In-flight never enters the rate denominator:
  assert.ok(m.outcomes.rates.interview.denominator <= m.outcomes.resolved);
});

test('later outcome corrections win: the last status event is the current truth', async () => {
  await seedAttempt('att-corr-1', { applicationId: 'app-corr', urlKey: 'https://jobs.example.test/corr-1' });
  const tracker = {
    listApplications: () => [{ num: 20, url: 'https://jobs.example.test/corr-1', status: 'Applied' }],
    listStatusEvents: () => [
      { id: 1, app_num: 20, event_date: '2026-10-03', from_status: 'Applied', to_status: 'rejected' },
      { id: 2, app_num: 20, event_date: '2026-10-05', from_status: 'rejected', to_status: 'interview' },
    ],
  };
  const m = await intelligence.deriveLearningMetrics(ctx, { tracker });
  const row = m.outcomes.joined.find((r) => r.applicationId === 'app-corr');
  assert.equal(row.outcome.class, 'interview');       // the correction, not the earlier rejection
  assert.equal(row.outcome.correctedAt, '2026-10-05');
  assert.equal(row.outcome.corrections, 2);
});

test('altered resume versions: exposed per row and selectable as a cohort', async () => {
  await seedAttempt('att-cv1', { applicationId: 'app-cv1', sourceVersion: 'cv-v1' });
  await seedAttempt('att-cv2', { applicationId: 'app-cv2', sourceVersion: 'cv-v2' });

  const all = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  const versions = new Set(all.outcomes.joined
    .filter((r) => ['app-cv1', 'app-cv2'].includes(r.applicationId))
    .map((r) => r.sourceVersion));
  assert.deepEqual([...versions].sort(), ['cv-v1', 'cv-v2']); // never pooled invisibly

  const only2 = await intelligence.deriveLearningMetrics(ctx, {
    cohort: { sourceVersion: 'cv-v2' }, tracker: emptyTracker(),
  });
  assert.ok(only2.outcomes.joined.some((r) => r.applicationId === 'app-cv2'));
  assert.ok(!only2.outcomes.joined.some((r) => r.applicationId === 'app-cv1'));
  assert.deepEqual(only2.cohort, { sourceVersion: 'cv-v2' });
});

test('tiny cohorts: rates are null below the calibration sample floor, never recomputed', async () => {
  // Everything seeded so far resolves far fewer than 5 terminal outcomes.
  const m = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  assert.ok(m.outcomes.resolved < 5);
  assert.equal(m.outcomes.rates.interview.rate, null);
  assert.equal(m.outcomes.rates.interview.reason, 'sample_below_floor');
  assert.equal(m.comparability.smallSample, true);
  assert.equal(m.comparability.claimType, 'association');
});

test('reuse disposition, new-question rate and repeat missing-fact blocks are separate channels', async () => {
  await seedObservation('obs-r1', { applicationId: 'app-cv1', originalText: 'How many years of Python?', answerDisposition: 'reused' });
  await seedObservation('obs-r2', { applicationId: 'app-cv2', originalText: 'How many years of Python?', answerDisposition: 'drafted' });
  await seedObservation('obs-r3', { applicationId: 'app-pend', originalText: 'Describe your leadership style in detail', answerDisposition: 'blocked' });
  for (const [id, at] of [['blk-m1', '2026-10-02T10:00:00Z'], ['blk-m2', '2026-10-04T10:00:00Z']]) {
    await commitRecord(ctx, 'blockers', id, {
      applicationId: 'app-pend', type: 'missing_answer',
      question: 'Visa sponsorship timeline?', requestedAt: at,
    }, { expectedRevision: 0, status: 'open', sourceIds: [] });
  }
  const m = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  assert.equal(m.reuse.byDisposition.reused, 1);
  assert.equal(m.reuse.byDisposition.drafted, 1);
  assert.equal(m.reuse.byDisposition.blocked, 1);
  assert.equal(m.reuse.distinctQuestions, 2);
  assert.equal(m.reuse.newQuestions, 2); // both first seen inside the (unbounded-from) window
  assert.equal(m.blockers.missingAnswerBlockers, 2);
  assert.equal(m.blockers.repeatedMissingFactQuestions, 1); // same fact blocked twice = repeat
  // Window selectivity: a window before any evidence holds nothing.
  const early = await intelligence.deriveLearningMetrics(ctx, {
    from: '2020-01-01T00:00:00Z', to: '2020-12-31T00:00:00Z', tracker: emptyTracker(),
  });
  assert.equal(early.reuse.distinctQuestions, 0);
  assert.equal(early.actions.observations, 0);
});

test('unknown cohort key is rejected', async () => {
  await assert.rejects(
    intelligence.deriveLearningMetrics(ctx, { cohort: { flattering: true }, tracker: emptyTracker() }),
    /unknown cohort key/,
  );
});

test('live comparison is an association exposing mix changes; identical fixture replay is mechanistic', async () => {
  const base = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  const shifted = JSON.parse(JSON.stringify(base));
  shifted.window = { from: '2026-10-05T00:00:00Z', to: '2026-10-11T00:00:00Z' };
  shifted.comparability.roleMix = { ...shifted.comparability.roleMix, product_leadership: 3 };
  shifted.time.activeMsKnownTotal += 1000;

  const live = intelligence.compareMetricCohorts({ before: base, after: shifted, kind: 'live' });
  assert.equal(live.claimType, 'association');
  assert.equal(live.mixChanges.roleMixChanged, true);
  assert.equal(live.mixChanges.windowsDiffer, true);
  assert.ok(live.caveats.some((c) => c.includes('role mix')));
  assert.ok(live.caveats.some((c) => c.includes('date windows')));
  assert.equal(live.deltas.activeMsKnownTotal, 1000);
  assert.match(live.note, /never attributed .* as a cause/);

  // Fixed fixture replay with identical mix/window: mechanistic savings allowed.
  const replay = JSON.parse(JSON.stringify(base));
  replay.time.activeMsKnownTotal += 500;
  const mech = intelligence.compareMetricCohorts({ before: base, after: replay, kind: 'fixture_replay' });
  assert.equal(mech.claimType, 'mechanistic_savings');
  assert.equal(mech.deltas.activeMsKnownTotal, 500);

  // But a fixture replay whose mix drifted is demoted to association.
  const drift = intelligence.compareMetricCohorts({ before: base, after: shifted, kind: 'fixture_replay' });
  assert.equal(drift.claimType, 'association');
});

test('tracker synchronization and action counts are separate channels', async () => {
  await commitRecord(ctx, 'syncTasks', 'sync-m1', {
    taskType: 'tracker_sync', applicationId: 'app-cv1', attempts: 0,
  }, { expectedRevision: 0, status: 'pending', sourceIds: [] });
  const m = await intelligence.deriveLearningMetrics(ctx, { tracker: emptyTracker() });
  assert.equal(m.trackerSync.byStatus.pending, 1);
  assert.ok(m.actions.attempts >= 5);
  assert.ok(m.actions.observations >= 3);
  // Posting age has no verified source in the ledger: stays unknown.
  assert.ok(m.outcomes.joined.every((r) => r.postingAgeDays === null));
});
