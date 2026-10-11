// auto/test/learning-invalidation.test.mjs — T08: source invalidation
// (correction / expiry / revocation) and the forget preview. Every record and
// value is a synthetic fixture; no real sources or personal facts appear.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { commitRecord, getRecord } from '../learning/store.mjs';
import { normalizeQuestion } from '../learning/questions.mjs';
import { invalidateSource, previewForget, resolveAnswer } from '../learning/answers.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

let fixture;
let ctx;
before(() => {
  fixture = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
});
after(() => fixture.cleanup());

const answerData = (overrides = {}) => ({
  questionFamilyId: null, kind: 'source_reference', authority: 'user_confirmed',
  sourceRefs: [{ fileKey: 'standing', selector: 'custom.synthetic', sha256: OLD }],
  scope: { employerId: null, country: null, roleFamily: null, locale: null },
  validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, dependencies: [],
  approvalRef: 'appr-synth', publicUse: 'applications_only',
  lastValidatedAt: '2026-10-01T00:00:00.000Z', template: null, ...overrides,
});

test('fixture isolation: everything happens under the scratch root, never the live checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
});

test('invalidateSource validates its input: known read-only source keys and sha256 hashes only', async () => {
  await assert.rejects(invalidateSource(ctx, { fileKey: 'scraped_site', oldHash: OLD, newHash: NEW }),
    (e) => e.code === 'FORBIDDEN_SOURCE');
  await assert.rejects(invalidateSource(ctx, { fileKey: 'standing', oldHash: 'nope', newHash: NEW }),
    (e) => e.code === 'SCHEMA_VALIDATION');
  await assert.rejects(invalidateSource(ctx, { fileKey: 'standing', oldHash: OLD, newHash: 'nope' }),
    (e) => e.code === 'SCHEMA_VALIDATION');
});

test('correction: answers bound to the old hash go stale, unbound answers stay approved, change is durable', async () => {
  await commitRecord(ctx, 'answers', 'ans-bound-1', answerData(),
    { expectedRevision: 0, status: 'approved', sourceIds: [`standing@${OLD}`] });
  await commitRecord(ctx, 'answers', 'ans-unbound-1', answerData({
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.other', sha256: NEW }],
  }), { expectedRevision: 0, status: 'approved', sourceIds: [`standing@${NEW}`] });
  // Grounded-template stories bound to the fact are invalidated the same way.
  await commitRecord(ctx, 'answers', 'ans-story-1', answerData({
    kind: 'grounded_template', template: 'Synthetic story grounded in {{fact}}.',
  }), { expectedRevision: 0, status: 'approved', sourceIds: [`standing@${OLD}`] });

  const summary = await invalidateSource(ctx, { fileKey: 'standing', oldHash: OLD, newHash: NEW });
  assert.deepEqual(summary.staleAnswers.sort(), ['ans-bound-1', 'ans-story-1']);
  assert.deepEqual(summary.revokedAnswers, []);
  assert.equal(getRecord(ctx, 'answers', 'ans-bound-1').status, 'stale');
  assert.equal(getRecord(ctx, 'answers', 'ans-story-1').status, 'stale');
  assert.equal(getRecord(ctx, 'answers', 'ans-unbound-1').status, 'approved', 'unbound answer untouched');
  const change = getRecord(ctx, 'sourceChanges', summary.sourceChangeId);
  assert.equal(change.status, 'recorded');
  assert.deepEqual(change.data.impact.staleAnswers.sort(), ['ans-bound-1', 'ans-story-1']);
  // Durable across a fresh context on the same roots.
  const ctx2 = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  assert.equal(getRecord(ctx2, 'answers', 'ans-bound-1').status, 'stale');
});

test('deletion (newHash null): bound answers are revoked, not merely stale', async () => {
  await commitRecord(ctx, 'answers', 'ans-revoke-1', answerData({
    sourceRefs: [{ fileKey: 'cv', selector: 'cv.synthetic_section', sha256: OLD }],
  }), { expectedRevision: 0, status: 'approved', sourceIds: [`cv@${OLD}`] });
  const summary = await invalidateSource(ctx, { fileKey: 'cv', oldHash: OLD, newHash: null });
  assert.equal(summary.deleted, true);
  assert.deepEqual(summary.revokedAnswers, ['ans-revoke-1']);
  assert.equal(getRecord(ctx, 'answers', 'ans-revoke-1').status, 'revoked');
  assert.equal(getRecord(ctx, 'sourceChanges', summary.sourceChangeId).data.newHash, null);
});

test('an invalidated answer no longer resolves: retrieval refuses the stale fact', async () => {
  const observation = { originalText: 'Synthetic invalidation retrieval question?', fieldType: 'text', locale: 'en-US' };
  const def = normalizeQuestion(observation);
  await commitRecord(ctx, 'families', 'fam-inv-1', {
    label: 'synthetic invalidation family', questionIds: [def.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'answers', 'ans-inv-ret-1', answerData({
    questionFamilyId: 'fam-inv-1',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.inv_ret', sha256: OLD }],
  }), { expectedRevision: 0, status: 'approved', sourceIds: [`standing@${OLD}`] });
  const sourceSnapshot = {
    sources: [{
      fileKey: 'standing', sha256: OLD, publicUse: 'applications_only',
      valuesBySelector: { 'custom.inv_ret': 'Synthetic retained value' },
    }],
    capturedAt: '2026-10-11T00:00:00.000Z',
  };
  const beforeResult = resolveAnswer(ctx, { observation, sourceSnapshot, policy: {} });
  assert.equal(beforeResult.status, 'ready');
  assert.equal(beforeResult.value, 'Synthetic retained value');

  await invalidateSource(ctx, { fileKey: 'standing', oldHash: OLD, newHash: NEW });
  assert.equal(getRecord(ctx, 'answers', 'ans-inv-ret-1').status, 'stale');
  const afterResult = resolveAnswer(ctx, { observation, sourceSnapshot, policy: {} });
  assert.notEqual(afterResult.status, 'ready');
  assert.equal(afterResult.value, null, 'stale fact never fills a form');
});

test('only affected blockers are notified: no unknown-submission requeue, no new application', async () => {
  const blockerData = (type, bound) => ({
    applicationId: 'app-fixture-002', attemptId: 'att-fixture-002', type,
    question: 'synthetic blocker question?', requiredResolution: 'user_input',
    sourceVersions: bound ? [{ fileKey: 'standing', sha256: OLD }] : [{ fileKey: 'standing', sha256: NEW }],
    nextCheckAt: '2026-10-10T00:00:00.000Z', deadline: null, resolution: null,
  });
  await commitRecord(ctx, 'blockers', 'blk-bound', blockerData('missing_answer', true),
    { expectedRevision: 0, status: 'open', sourceIds: [] });
  await commitRecord(ctx, 'blockers', 'blk-unbound', blockerData('missing_answer', false),
    { expectedRevision: 0, status: 'open', sourceIds: [] });
  await commitRecord(ctx, 'blockers', 'blk-unknown-sub', blockerData('submission_unknown', true),
    { expectedRevision: 0, status: 'open', sourceIds: [] });

  const summary = await invalidateSource(ctx, { fileKey: 'standing', oldHash: OLD, newHash: NEW });
  assert.ok(summary.notifiedBlockers.includes('blk-bound'));
  assert.ok(!summary.notifiedBlockers.includes('blk-unbound'));
  assert.ok(!summary.notifiedBlockers.includes('blk-unknown-sub'), 'unknown submission is never auto-requeued');
  assert.equal(getRecord(ctx, 'blockers', 'blk-bound').data.nextCheckAt, ctx.now().toISOString());
  assert.equal(getRecord(ctx, 'blockers', 'blk-unbound').revision, 1, 'untouched');
  assert.equal(getRecord(ctx, 'blockers', 'blk-unknown-sub').revision, 1, 'untouched');
  // Invalidation never creates applications/attempts: nothing outside the
  // learning collections appears in the store.
  assert.equal(existsSync(join(fixture.dataRoot, 'data', 'auto', 'learning', 'records', 'applications')), false);
});

test('cascade: dependent procedures and insights go stale, positioning/answer drafts are rejected', async () => {
  const marker = `standing@${OLD}`;
  await commitRecord(ctx, 'procedures', 'proc-dep-1', { scope: { atsVendor: 'synthetic-ats' }, steps: [] },
    { expectedRevision: 0, status: 'active', sourceIds: [marker] });
  await commitRecord(ctx, 'procedures', 'proc-free-1', { scope: {}, steps: [] },
    { expectedRevision: 0, status: 'active', sourceIds: [`standing@${NEW}`] });
  await commitRecord(ctx, 'insights', 'ins-dep-1', { roleFamily: 'synthetic' },
    { expectedRevision: 0, status: 'published', sourceIds: [marker] });
  await commitRecord(ctx, 'proposals', 'prop-pos-1', {
    kind: 'positioning', evidenceIds: [], intendedBenefit: 'synthetic', risk: 'low',
    baseline: null, evaluationResult: null, requiredApprovals: ['user'], rollbackVersion: null,
    affectedSources: [{ fileKey: 'standing', selector: 'custom.pos', sha256: OLD }], diff: null,
  }, { expectedRevision: 0, status: 'draft', sourceIds: [] });

  const summary = await invalidateSource(ctx, { fileKey: 'standing', oldHash: OLD, newHash: NEW });
  assert.ok(summary.staleProcedures.includes('proc-dep-1'));
  assert.ok(!summary.staleProcedures.includes('proc-free-1'));
  assert.ok(summary.staleInsights.includes('ins-dep-1'));
  assert.ok(summary.rejectedDrafts.includes('prop-pos-1'));
  assert.equal(getRecord(ctx, 'procedures', 'proc-dep-1').status, 'stale');
  assert.equal(getRecord(ctx, 'procedures', 'proc-free-1').status, 'active');
  assert.equal(getRecord(ctx, 'insights', 'ins-dep-1').status, 'stale');
  assert.equal(getRecord(ctx, 'proposals', 'prop-pos-1').status, 'rejected');
});

test('forget preview: lists canonical versions, derived indexes, and surviving originals; never claims erasure', async () => {
  await assert.rejects(previewForget(ctx, { targets: [] }), (e) => e.code === 'SCHEMA_VALIDATION');
  // Target answer with two canonical revisions.
  const data = answerData({ sourceRefs: [{ fileKey: 'standing', selector: 'custom.forget', sha256: NEW }] });
  await commitRecord(ctx, 'answers', 'ans-forget-1', data,
    { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'answers', 'ans-forget-1', data,
    { expectedRevision: 1, status: 'approved', sourceIds: [] });
  // An original audit artifact on disk, referenced by an observation.
  const artifactRel = join('output', 'synthetic-app', 'apply-audit.json');
  const artifactAbs = join(fixture.dataRoot, artifactRel);
  mkdirSync(dirname(artifactAbs), { recursive: true });
  writeFileSync(artifactAbs, '{"synthetic":"audit artifact"}\n');
  await commitRecord(ctx, 'observations', 'obs-forget-1', {
    applicationId: 'app-fixture-003', originalText: 'Synthetic forgotten question?', fieldType: 'text',
    observedAt: '2026-10-11T00:00:00.000Z', answerRef: 'ans-forget-1',
    sourceArtifact: { relativePath: artifactRel, sha256: OLD },
  }, { expectedRevision: 0, status: 'recorded', sourceIds: [] });
  // A derived generated index.
  const indexPath = join(fixture.dataRoot, 'data', 'auto', 'learning', 'indexes', 'gen-synthetic-index.json');
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, '{}\n');

  const preview = await previewForget(ctx, { scope: 'answers', targets: [{ collection: 'answers', id: 'ans-forget-1' }] });
  assert.deepEqual(preview.canonicalVersions, [{ collection: 'answers', id: 'ans-forget-1', revisions: [1, 2] }]);
  assert.ok(preview.derivedIndexes.includes('gen-synthetic-index.json'));
  assert.deepEqual(preview.remainingOriginalAudits, [artifactRel]);
  assert.equal(preview.originalsRemain, true);
  assert.equal(preview.claimsCompleteErasure, false);
  assert.match(preview.note, /NOT erasure/);
  // The preview deleted nothing.
  assert.equal(existsSync(artifactAbs), true, 'original audit artifact survives the preview');
  assert.equal(getRecord(ctx, 'answers', 'ans-forget-1').status, 'approved');
  assert.equal(getRecord(ctx, 'forgetRequests', preview.requestId).status, 'previewed');
});
