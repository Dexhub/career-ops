// auto/test/learning-procedures.test.mjs — T18: scoped procedures, frozen
// evaluation and gated promotion. Everything runs against an isolated mkdtemp
// fixture with injected clocks; synthetic values only; the fixed trusted
// fixture driver is the only case executor — model-generated test code is
// never run. node:test only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(here, '..', '..'));
const FIXTURE_PATH = join(here, 'fixtures', 'learning', 'procedure-evaluation.json');

let fixture;
let ctx;
let procedures;
let commitRecord; let getRecord;
let createLearningContext;
let fixtureData;
let heldOutCases; // frozen evaluation set: derivation + held-out source IDs

const LEARNING_ON = 'schema_version: 1\nenabled: true\nmode: shadow\n';
const LEARNING_AUTO_PROMOTE = 'schema_version: 1\nenabled: true\nmode: shadow\nreview:\n  auto_promote_procedures: true\n';

const SAFE_STEPS = [
  { type: 'open_existing_application' },
  { type: 'recheck_session' },
  { type: 'inspect_fields' },
  { type: 'wait_for_verification' },
  { type: 'resolve_known_question' },
  { type: 'request_human_help' },
];

async function seedProcedure(id, overrides = {}) {
  return commitRecord(ctx, 'procedures', id, {
    scope: { employerId: 'acme', atsTenant: 'acme-wd' },
    preconditions: { startingCondition: 'existing_application_open', tenant: 'acme-wd' },
    steps: SAFE_STEPS,
    expectedObservations: ['fields_inspected'],
    maxRetries: 2,
    maxWaitMs: 600000,
    lastVerifiedAt: null,
    supportingAttemptIds: fixtureData.derivationSourceIds,
    contradictingAttemptIds: [],
    evaluationVersion: null,
    evaluationResult: null,
    ...overrides,
  }, { expectedRevision: 0, status: overrides.__status ?? 'candidate', sourceIds: [] });
}

before(async () => {
  fixture = createLearningFixture();
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_ON);
  // Imports AFTER the fixture sets CAREER_OPS_ROOT/CAREER_OPS_DB.
  procedures = await import('../learning/procedures.mjs');
  ({ commitRecord, getRecord } = await import('../learning/store.mjs'));
  ({ createLearningContext } = await import('../learning/context.mjs'));
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  fixtureData = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
  heldOutCases = { derivationSourceIds: fixtureData.derivationSourceIds, cases: fixtureData.heldOutCases };
});
after(() => fixture.cleanup());

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.dataRoot);
});

test('episodes carry condition, action, result, times, failures, versions; failures and contradictions included', async () => {
  await commitRecord(ctx, 'attempts', 'att-ok-1', {
    applicationId: 'app-1', attemptId: 'att-ok-1', urlKey: 'synthetic-acme-1',
    allowedAction: 'submit', submissionPossible: true,
    policyVersion: 'p1-abc', sourceVersion: 's1-abc', procedureVersion: null,
    employerId: 'acme', tenant: 'acme-wd', requisitionId: 'R1', accountId: 'acc-1',
    allocatedAt: '2026-10-11T00:00:00.000Z', launchedAt: '2026-10-11T00:01:00.000Z', verdicts: [],
  }, { expectedRevision: 0, status: 'confirmed', sourceIds: [] });
  await commitRecord(ctx, 'blockers', 'blk-wait-1', {
    applicationId: 'app-1', attemptId: 'att-ok-1', type: 'verification_pending',
    requestedAt: '2026-10-11T00:02:00.000Z', nextCheckAt: '2026-10-11T00:04:00.000Z',
    resolution: { resolvedAt: '2026-10-11T00:05:00.000Z' },
  }, { expectedRevision: 0, status: 'resolved', sourceIds: [] });
  await commitRecord(ctx, 'attempts', 'att-fail-1', {
    applicationId: 'app-2', attemptId: 'att-fail-1', urlKey: 'synthetic-acme-2',
    allowedAction: 'submit', submissionPossible: true,
    policyVersion: 'p1-abc', sourceVersion: 's1-abc', procedureVersion: null,
    employerId: 'acme', tenant: 'acme-wd', requisitionId: null, accountId: null,
    allocatedAt: '2026-10-11T01:00:00.000Z', launchedAt: null, verdicts: [],
  }, { expectedRevision: 0, status: 'unknown', sourceIds: [] });
  await commitRecord(ctx, 'attempts', 'att-contra-1', {
    applicationId: 'app-3', attemptId: 'att-contra-1', urlKey: 'synthetic-acme-3',
    allowedAction: 'submit', submissionPossible: true,
    policyVersion: 'p1-abc', sourceVersion: 's1-abc', procedureVersion: null,
    employerId: 'acme', tenant: 'acme-wd', requisitionId: null, accountId: null,
    allocatedAt: '2026-10-11T02:00:00.000Z', launchedAt: null, verdicts: [],
  }, { expectedRevision: 0, status: 'confirmed', sourceIds: [] });
  await commitRecord(ctx, 'blockers', 'blk-open-1', {
    applicationId: 'app-3', attemptId: 'att-contra-1', type: 'source_conflict',
    requestedAt: '2026-10-11T02:01:00.000Z',
  }, { expectedRevision: 0, status: 'open', sourceIds: [] });

  const episodes = procedures.extractEpisodes(ctx);
  assert.equal(episodes.length, 3);
  const ok = episodes.find((e) => e.sourceId === 'att-ok-1');
  assert.equal(ok.observedResult, 'confirmed');
  assert.equal(ok.verifiedOutcome, true);
  assert.equal(ok.allowedAction, 'submit');
  assert.equal(ok.policyVersion, 'p1-abc');
  assert.equal(ok.sourceVersion, 's1-abc');
  assert.equal(ok.tenant, 'acme-wd');
  assert.equal(ok.startingCondition.urlKey, 'synthetic-acme-1');
  assert.equal(ok.waitMs, 3 * 60 * 1000); // requestedAt -> resolvedAt
  assert.equal(ok.failures.length, 0);
  const fail = episodes.find((e) => e.sourceId === 'att-fail-1');
  assert.equal(fail.observedResult, 'unknown');
  assert.ok(fail.failures.length > 0); // failures are included, not filtered
  const contra = episodes.find((e) => e.sourceId === 'att-contra-1');
  assert.equal(contra.contradiction, true); // contradictions are included
});

test('candidates are tenant-scoped with exact preconditions and allowlisted declarative steps only', () => {
  const episodes = procedures.extractEpisodes(ctx);
  const candidates = procedures.deriveCandidateProcedures(ctx, { episodes });
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.deepEqual(c.scope, { employerId: 'acme', atsTenant: 'acme-wd' });
  assert.equal(c.preconditions.tenant, 'acme-wd');
  for (const step of c.steps) {
    assert.ok(procedures.ALLOWED_STEP_TYPES.includes(step.type));
  }
  // Derivation examples recorded; contradicting episodes tracked, not dropped.
  assert.ok(c.derivationSourceIds.includes('att-ok-1'));
  assert.ok(c.contradictingSourceIds.includes('att-fail-1'));
  assert.ok(c.contradictingSourceIds.includes('att-contra-1'));
  // No global candidate exists for episodes without an identified tenant.
  const anon = procedures.deriveCandidateProcedures(ctx, {
    episodes: [{ ...episodes[0], employerId: null, tenant: null }],
  });
  assert.equal(anon.length, 0);
});

test('steps never admit code, shell, secrets, new permissions or a generic final submit', () => {
  const bad = (steps) => assert.throws(() => procedures.validateProcedureSteps(steps),
    (err) => err.code === 'INVALID_PROCEDURE');
  bad([{ type: 'run_shell' }]);
  bad([{ type: 'submit_application' }]);
  bad([{ type: 'final_submit' }]);
  bad([{ type: 'grant_permission' }]);
  bad([{ type: 'inspect_fields', params: { script: 'alert(1)' } }]);
  bad([{ type: 'inspect_fields', params: { command: 'rm -rf /' } }]);
  bad([{ type: 'inspect_fields', params: { apiKey: 'synthetic' } }]);
  bad([{ type: 'inspect_fields', params: { nested: { deep: true } } }]);
  bad([{ type: 'inspect_fields', onError: 'retry' }]);
  assert.equal(procedures.validateProcedureSteps(SAFE_STEPS), true);
});

test('frozen evaluation set: derivation and held-out source IDs stay separate; adverse kinds present', async () => {
  await seedProcedure('proc-main');
  const evaluation = procedures.evaluateProcedure(ctx, { procedureId: 'proc-main', fixtureSet: heldOutCases });
  assert.deepEqual(evaluation.derivationSourceIds, fixtureData.derivationSourceIds);
  assert.equal(evaluation.heldOutSourceIds.length, fixtureData.heldOutCases.length);
  for (const id of evaluation.heldOutSourceIds) {
    assert.ok(!fixtureData.derivationSourceIds.includes(id));
  }
  const kinds = new Set(fixtureData.heldOutCases.map((k) => k.kind));
  for (const kind of ['tenant_mismatch', 'stale_verification', 'changed_options', 'tool_unavailable']) {
    assert.ok(kinds.has(kind), `fixture covers ${kind}`);
  }
  // A case overlapping the derivation list is excluded from scoring.
  const overlapping = {
    derivationSourceIds: ['ep-held-0001', ...fixtureData.derivationSourceIds],
    cases: fixtureData.heldOutCases,
  };
  const ev2 = procedures.evaluateProcedure(ctx, { procedureId: 'proc-main', fixtureSet: overlapping });
  assert.equal(ev2.sampleSize, fixtureData.heldOutCases.length - 1);
  // All-overlap means there is nothing held out to evaluate.
  assert.throws(() => procedures.evaluateProcedure(ctx, {
    procedureId: 'proc-main',
    fixtureSet: {
      derivationSourceIds: fixtureData.heldOutCases.map((k) => k.sourceId),
      cases: fixtureData.heldOutCases,
    },
  }), (err) => err.code === 'INVALID_FIXTURE');
});

test('evaluation never runs model-generated test code: executable-shaped cases are refused', () => {
  assert.throws(() => procedures.evaluateProcedure(ctx, {
    procedureId: 'proc-main',
    fixtureSet: { cases: [{ id: 'c1', sourceId: 's1', baseline: { actions: 1, outcome: 'completed' }, code: 'assert(true)' }] },
  }), (err) => err.code === 'INVALID_FIXTURE');
  assert.throws(() => procedures.evaluateProcedure(ctx, {
    procedureId: 'proc-main',
    fixtureSet: { cases: [{ id: 'c1', sourceId: 's1', baseline: { actions: 1, outcome: 'completed' }, setup: { script: 'x' } }] },
  }), (err) => err.code === 'INVALID_FIXTURE');
});

test('required acceptance: zero violations, zero regressions, unapproved promotion rejects', async () => {
  const procedureId = 'proc-main';
  const evaluation = procedures.evaluateProcedure(ctx,{procedureId,fixtureSet:heldOutCases});
  assert.equal(evaluation.safetyViolations,0);
  assert.equal(evaluation.regressions,0);
  const { promoteProcedure } = procedures;
  await assert.rejects(promoteProcedure(ctx,{procedureId,evaluationId:evaluation.id,approval:null}));
  // Sample size and failures are reported; improvement is measured.
  assert.equal(evaluation.sampleSize, 7);
  assert.deepEqual(evaluation.failures, []);
  assert.ok(evaluation.actionDelta < 0, 'fewer actions than baseline');
  assert.equal(evaluation.passed, true);
  // Tenant mismatch aborts safely before any action.
  const mismatch = evaluation.results.find((r) => r.caseId === 'case-tenant-mismatch');
  assert.equal(mismatch.outcome, 'aborted');
  assert.equal(mismatch.actions, 0);
});

test('an unsafe procedure accrues safety violations and truthfulness regressions', async () => {
  await seedProcedure('proc-unsafe', {
    steps: [{ type: 'open_existing_application' }, { type: 'resolve_known_question' }],
  });
  const ev = procedures.evaluateProcedure(ctx, { procedureId: 'proc-unsafe', fixtureSet: heldOutCases });
  assert.ok(ev.safetyViolations > 0);
  assert.ok(ev.regressions > 0);
  assert.equal(ev.passed, false);
  assert.ok(ev.failures.length > 0);
  const stale = ev.results.find((r) => r.caseId === 'case-changed-options');
  assert.ok(stale.violations.includes('answered_with_stale_options'));
});

test('evaluation persists through commitRecord in reviewRuns; default status is tested, never active', async () => {
  const evaluation = procedures.evaluateProcedure(ctx, { procedureId: 'proc-main', fixtureSet: heldOutCases });
  const { reviewRun, procedure } = await procedures.persistEvaluation(ctx, evaluation);
  const reloaded = getRecord(ctx, 'reviewRuns', evaluation.id);
  assert.equal(reloaded.status, 'completed');
  assert.equal(reloaded.data.outcomes.procedureId, 'proc-main');
  assert.equal(reloaded.data.outcomes.procedureRevision, evaluation.procedureRevision);
  assert.equal(reloaded.data.outcomes.fixtureDigest, evaluation.fixtureDigest);
  assert.deepEqual(reloaded.data.outcomes.heldOutSourceIds, evaluation.heldOutSourceIds);
  assert.deepEqual(reloaded.data.outcomes.derivationSourceIds, evaluation.derivationSourceIds);
  assert.equal(reloaded.data.processed, evaluation.sampleSize);
  assert.equal(reviewRun.id, evaluation.id);
  // Awaiting D04: tested, not active.
  assert.equal(procedure.status, 'tested');
  assert.equal(getRecord(ctx, 'procedures', 'proc-main').status, 'tested');
});

test('promotion reloads the persisted record: missing/stale IDs and caller-supplied passed:true never authorize', async () => {
  const token = procedures.createPromotionApproval({ approvedBy: 'test-harness' });
  // Missing evaluation id — even with a valid token and passed:true asserted.
  await assert.rejects(
    procedures.promoteProcedure(ctx, { procedureId: 'proc-main', evaluationId: 'proceval-does-not-exist', approval: token, passed: true }),
    (err) => err.code === 'EVALUATION_MISSING');
  // A failed persisted evaluation cannot be overridden by passed:true.
  const badEval = procedures.evaluateProcedure(ctx, { procedureId: 'proc-unsafe', fixtureSet: heldOutCases });
  await procedures.persistEvaluation(ctx, badEval);
  await assert.rejects(
    procedures.promoteProcedure(ctx, { procedureId: 'proc-unsafe', evaluationId: badEval.id, approval: token, passed: true }),
    (err) => err.code === 'EVALUATION_FAILED');
  // A plain object claiming approval is not a harness token.
  const good = procedures.evaluateProcedure(ctx, { procedureId: 'proc-main', fixtureSet: heldOutCases });
  await procedures.persistEvaluation(ctx, good);
  await assert.rejects(
    procedures.promoteProcedure(ctx, {
      procedureId: 'proc-main', evaluationId: good.id,
      approval: { kind: 'procedure_promotion_approval', approvedBy: 'agent' },
    }),
    (err) => err.code === 'APPROVAL_REQUIRED');
});

test('approved promotion activates; a step change makes the old evaluation stale', async () => {
  const token = procedures.createPromotionApproval({ approvedBy: 'operator' });
  const evaluation = procedures.evaluateProcedure(ctx, { procedureId: 'proc-main', fixtureSet: heldOutCases });
  await procedures.persistEvaluation(ctx, evaluation); // idempotent: same deterministic id
  const promoted = await procedures.promoteProcedure(ctx, { procedureId: 'proc-main', evaluationId: evaluation.id, approval: token });
  assert.equal(promoted.status, 'active');
  assert.ok(promoted.data.lastVerifiedAt);
  assert.equal(promoted.data.evaluationVersion, evaluation.id);
  // Change the behavior-bearing steps: the old evaluation no longer authorizes.
  const current = getRecord(ctx, 'procedures', 'proc-main');
  await commitRecord(ctx, 'procedures', 'proc-main', {
    ...current.data,
    steps: [...SAFE_STEPS, { type: 'inspect_fields' }],
  }, { expectedRevision: current.revision, status: 'tested', sourceIds: current.sourceIds });
  await assert.rejects(
    procedures.promoteProcedure(ctx, { procedureId: 'proc-main', evaluationId: evaluation.id, approval: token }),
    (err) => err.code === 'EVALUATION_STALE');
});

test("one tenant's success cannot promote a global rule", async () => {
  const token = procedures.createPromotionApproval({ approvedBy: 'operator' });
  await commitRecord(ctx, 'procedures', 'proc-global', {
    scope: {}, preconditions: {}, steps: SAFE_STEPS, expectedObservations: [],
    maxRetries: 2, maxWaitMs: 600000, lastVerifiedAt: null,
    supportingAttemptIds: [], contradictingAttemptIds: [],
    evaluationVersion: null, evaluationResult: null,
  }, { expectedRevision: 0, status: 'candidate', sourceIds: [] });
  const singleTenant = {
    derivationSourceIds: [],
    cases: fixtureData.heldOutCases.filter((k) => k.tenant === 'acme-wd'),
  };
  const ev = procedures.evaluateProcedure(ctx, { procedureId: 'proc-global', fixtureSet: singleTenant });
  assert.equal(ev.passed, true);
  assert.deepEqual(ev.tenants, ['acme-wd']);
  await procedures.persistEvaluation(ctx, ev);
  await assert.rejects(
    procedures.promoteProcedure(ctx, { procedureId: 'proc-global', evaluationId: ev.id, approval: token }),
    (err) => err.code === 'SCOPE_TOO_BROAD');
  // The scoped candidate committer refuses a global candidate outright.
  await assert.rejects(
    procedures.commitCandidateProcedure(ctx, {
      id: 'proc-global-2', scope: {}, steps: SAFE_STEPS, maxRetries: 2, maxWaitMs: 600000,
    }),
    (err) => err.code === 'SCOPE_TOO_BROAD');
});

test('auto-promotion stays off by default and only ever covers allowlisted data-only procedures', async () => {
  const dataOnlySteps = [
    { type: 'recheck_session' }, { type: 'inspect_fields' },
    { type: 'wait_for_verification' }, { type: 'request_human_help' },
  ];
  await seedProcedure('proc-dataonly', { steps: dataOnlySteps });
  const ev = procedures.evaluateProcedure(ctx, { procedureId: 'proc-dataonly', fixtureSet: heldOutCases });
  assert.equal(ev.passed, true);
  await procedures.persistEvaluation(ctx, ev);
  // Default config: no auto-promotion for anything.
  await assert.rejects(
    procedures.promoteProcedure(ctx, { procedureId: 'proc-dataonly', evaluationId: ev.id, approval: null }),
    (err) => err.code === 'APPROVAL_REQUIRED');
  const configPath = join(fixture.dataRoot, 'config', 'learning.yml');
  writeFileSync(configPath, LEARNING_AUTO_PROMOTE);
  try {
    // Explicitly enabled: a data-only procedure within limits may auto-promote.
    const promoted = await procedures.promoteProcedure(ctx, { procedureId: 'proc-dataonly', evaluationId: ev.id, approval: null });
    assert.equal(promoted.status, 'active');
    // A form-filling procedure still requires the harness token.
    const current = getRecord(ctx, 'procedures', 'proc-main');
    const ev2 = procedures.evaluateProcedure(ctx, { procedureId: 'proc-main', fixtureSet: heldOutCases });
    await procedures.persistEvaluation(ctx, ev2);
    assert.equal(current.data.steps.some((s) => s.type === 'resolve_known_question'), true);
    await assert.rejects(
      procedures.promoteProcedure(ctx, { procedureId: 'proc-main', evaluationId: ev2.id, approval: null }),
      (err) => err.code === 'APPROVAL_REQUIRED');
  } finally {
    writeFileSync(configPath, LEARNING_ON);
  }
});

test('active version, last verification, contradictions and revocation are tracked; changed flow goes stale', async () => {
  await seedProcedure('proc-track');
  const ev = procedures.evaluateProcedure(ctx, { procedureId: 'proc-track', fixtureSet: heldOutCases });
  await procedures.persistEvaluation(ctx, ev);
  const token = procedures.createPromotionApproval({ approvedBy: 'operator' });
  const promoted = await procedures.promoteProcedure(ctx, { procedureId: 'proc-track', evaluationId: ev.id, approval: token });
  assert.equal(promoted.status, 'active');
  assert.ok(promoted.data.lastVerifiedAt, 'last verification time is tracked');
  assert.equal(promoted.data.evaluationVersion, ev.id, 'active version records its evaluation');
  // Selection only ever returns active, scope-matching procedures.
  const selected = procedures.selectProcedure(ctx, { employerId: 'acme', tenant: 'acme-wd' });
  assert.ok(selected, 'an active scoped procedure is selectable');
  assert.equal(selected.procedureVersion, `${selected.procedureId}@${selected.version}`);
  const withContra = await procedures.recordContradiction(ctx, { procedureId: 'proc-track', attemptId: 'att-contra-1' });
  assert.ok(withContra.data.contradictingAttemptIds.includes('att-contra-1'));
  assert.equal(withContra.status, 'active');
  // Employer changed the flow: stale for new attempts.
  const stale = await procedures.markProcedureStale(ctx, { procedureId: 'proc-track' });
  assert.equal(stale.status, 'stale');
  const after2 = procedures.selectProcedure(ctx, { employerId: 'acme', tenant: 'acme-wd' });
  assert.ok(!after2 || after2.procedureId !== 'proc-track');
  const revoked = await procedures.revokeProcedure(ctx, { procedureId: 'proc-track' });
  assert.equal(revoked.status, 'revoked');
});

test('rollback restores the previous procedure for new attempts without altering an active attempt', async () => {
  const token = procedures.createPromotionApproval({ approvedBy: 'operator' });
  // v1: promote the original safe steps.
  await seedProcedure('proc-roll');
  const ev1 = procedures.evaluateProcedure(ctx, { procedureId: 'proc-roll', fixtureSet: heldOutCases });
  await procedures.persistEvaluation(ctx, ev1);
  await procedures.promoteProcedure(ctx, { procedureId: 'proc-roll', evaluationId: ev1.id, approval: token });
  const v1 = getRecord(ctx, 'procedures', 'proc-roll');
  const v1Steps = v1.data.steps;
  // v2: a changed flow is evaluated and promoted.
  const v2Steps = [...SAFE_STEPS, { type: 'inspect_fields' }];
  await commitRecord(ctx, 'procedures', 'proc-roll', { ...v1.data, steps: v2Steps },
    { expectedRevision: v1.revision, status: 'tested', sourceIds: v1.sourceIds });
  const ev2 = procedures.evaluateProcedure(ctx, { procedureId: 'proc-roll', fixtureSet: heldOutCases });
  await procedures.persistEvaluation(ctx, ev2);
  const v2 = await procedures.promoteProcedure(ctx, { procedureId: 'proc-roll', evaluationId: ev2.id, approval: token });
  // An in-flight attempt pins v2 at the safe boundary (before launch).
  const pinned = `proc-roll@${v2.revision}`;
  await commitRecord(ctx, 'attempts', 'att-pinned-1', {
    applicationId: 'app-9', attemptId: 'att-pinned-1', urlKey: 'synthetic-acme-9',
    allowedAction: 'submit', submissionPossible: true,
    policyVersion: 'p1-abc', sourceVersion: 's1-abc', procedureVersion: pinned,
    employerId: 'acme', tenant: 'acme-wd', requisitionId: null, accountId: null,
    allocatedAt: '2026-10-11T03:00:00.000Z', launchedAt: '2026-10-11T03:01:00.000Z', verdicts: [],
  }, { expectedRevision: 0, status: 'launched', sourceIds: [] });

  // Rollback requires harness approval and restores v1 behavior as a NEW revision.
  await assert.rejects(
    procedures.rollbackProcedure(ctx, { procedureId: 'proc-roll', approval: null }),
    (err) => err.code === 'APPROVAL_REQUIRED');
  const rolled = await procedures.rollbackProcedure(ctx, { procedureId: 'proc-roll', approval: token });
  assert.equal(rolled.status, 'active');
  assert.ok(rolled.revision > v2.revision);
  assert.deepEqual(rolled.data.steps, v1Steps);
  // New attempts adopt the restored version at the safe boundary...
  assert.equal(procedures.procedureDigest(rolled.data), procedures.procedureDigest(v1.data));
  // ...while the active attempt keeps its pinned version, untouched.
  const attempt = getRecord(ctx, 'attempts', 'att-pinned-1');
  assert.equal(attempt.data.procedureVersion, pinned);
  assert.equal(attempt.status, 'launched');
  assert.equal(attempt.revision, 1);
});
