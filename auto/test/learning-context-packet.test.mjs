// auto/test/learning-context-packet.test.mjs — T09: small, source-bound
// answer and experience packets. Every source/value here is synthetic fixture
// data; no real personal fact, employer, or secret appears ('fixture-secret-
// password' is a canary that must never leave the fixture files).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { commitRecord } from '../learning/store.mjs';
import { normalizeQuestion } from '../learning/questions.mjs';
import { hashText } from '../learning/answers.mjs';
import {
  buildContextPacket, storeDraftAnswer, extractExperienceStories, clearContextPacketCache,
} from '../learning/retrieval.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const fixturesPath = fileURLToPath(new URL('./fixtures/learning/observations.json', import.meta.url));
const F = JSON.parse(readFileSync(fixturesPath, 'utf-8'));
const { noticeQuestion, currentAuthorization, totalCompensationCAD, employerSpecificAcme, employerSpecificMaple } = F;

// Synthetic free-text question for story/draft scenarios.
const motivationQuestion = {
  ...noticeQuestion,
  questionId: 'q-motivation',
  stepId: 'step-9',
  fieldId: 'field-motivation',
  fieldType: 'textarea',
  originalText: 'Why do you want to work on synthetic robotics planning?',
  options: [],
  unit: null,
};

const STANDING_YML = [
  'custom:',
  '  notice_period: "4 weeks"',
  // Secret-bearing key: the loader must skip it entirely.
  '  internal_password: "fixture-secret-password"',
  '',
].join('\n');

const CV_MD = [
  '# Synthetic Robotics Engineer',
  '',
  '## Planning Pipeline Project',
  '- Built a synthetic robotics planning pipeline for fixture testing',
  '- Reduced synthetic cycle time by 37% across 4 fixture runs',
  'password: fixture-secret-password',
  '',
  '## Unrelated Gardening Hobby',
  '- Grew synthetic tomatoes',
  '',
].join('\n');

let fixture;
let ctx;
let standingHash;

async function seedAnswer({ famId, ansId, definitionId, sha, selector = 'custom.notice_period', scope = {} }) {
  await commitRecord(ctx, 'families', famId, {
    label: `synthetic ${famId}`, questionIds: [definitionId], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'answers', ansId, {
    questionFamilyId: famId,
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector, sha256: sha }],
    scope,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    dependencies: [],
    approvalRef: null,
    publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z',
    template: null,
  }, { expectedRevision: 0, status: 'approved', sourceIds: [`standing@${sha}`] });
}

before(async () => {
  fixture = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  clearContextPacketCache();
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'), STANDING_YML);
  writeFileSync(join(fixture.dataRoot, 'cv.md'), CV_MD);
  standingHash = hashText(STANDING_YML);
  // The one relevant answer, bound to the current standing hash.
  const noticeDef = normalizeQuestion(noticeQuestion);
  await seedAnswer({ famId: 'fam-notice', ansId: 'ans-notice', definitionId: noticeDef.id, sha: standingHash });
  // Large unrelated history: 30 approved answers for questions never observed.
  for (let i = 0; i < 30; i += 1) {
    await seedAnswer({
      famId: `fam-noise-${i}`, ansId: `ans-noise-${i}`,
      definitionId: `qd-${String(i).padStart(4, '0')}${'f'.repeat(44)}`,
      sha: standingHash, selector: `custom.noise_${i}`,
    });
  }
});
after(() => fixture.cleanup());

test('fixture isolation: everything happens under the scratch root, never the live checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
});

test('plan-required: large history, one relevant answer, caps and secret canary', () => {
  const applicationId = noticeQuestion.applicationId;
  const packet = buildContextPacket(ctx,{applicationId,observations:[noticeQuestion],maxBytes:24000});
  assert.ok(packet.bytes<=24000);
  assert.equal(packet.answers.length,1);
  assert.ok(packet.versions.sourceHashes.includes(standingHash));
  assert.equal(JSON.stringify(packet).includes('fixture-secret-password'),false);
  assert.equal(packet.answers[0].value, '4 weeks');
  assert.equal(packet.answers[0].sourceRefs[0].sha256, standingHash);
  console.log(`[T09] cold packet bytes=${packet.bytes}`);
});

test('cache: warm repeat is a hit with zero model calls; changed source invalidates', () => {
  clearContextPacketCache();
  let modelCalls = 0;
  const policy = { allowDraft: true, modelClient: { draft: () => { modelCalls += 1; } } };
  const args = { applicationId: 'app-fixture-014', observations: [noticeQuestion, motivationQuestion], maxBytes: 24000, policy };
  const cold = buildContextPacket(ctx, args);
  const coldCalls = modelCalls;
  assert.equal(coldCalls, 1, 'cold build drafts the free-text question once');
  const warm = buildContextPacket(ctx, args);
  assert.equal(modelCalls, coldCalls, 'warm repeat resolves nothing: zero further model calls');
  assert.deepEqual(warm, cold);
  console.log(`[T09] cold bytes=${cold.bytes} modelCalls=${coldCalls}; warm bytes=${warm.bytes} modelCalls=${modelCalls - coldCalls}`);

  // Changed source: new hash, cache unreachable, bound answer goes stale.
  const changedYml = STANDING_YML.replace('4 weeks', '2 weeks');
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'), changedYml);
  try {
    const invalidated = buildContextPacket(ctx, { ...args, observations: [noticeQuestion] });
    assert.equal(invalidated.answers.length, 0, 'changed source stops reuse');
    const gap = invalidated.gaps.find((g) => g.status === 'stale');
    assert.ok(gap, 'the stale answer is a visible gap');
    assert.ok(invalidated.versions.sourceHashes.includes(hashText(changedYml)));
    assert.ok(!invalidated.versions.sourceHashes.includes(standingHash));
  } finally {
    writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'), STANDING_YML);
  }
});

test('insufficient facts: unknown question becomes a missing-information gap, never an invention', () => {
  const packet = buildContextPacket(ctx, {
    applicationId: currentAuthorization.applicationId,
    observations: [currentAuthorization], maxBytes: 24000,
  });
  assert.equal(packet.answers.length, 0);
  assert.equal(packet.gaps.length, 1);
  assert.equal(packet.gaps[0].status, 'blocked');
  assert.match(packet.gaps[0].reason, /missing_information/);
});

test('country/employer separation: an Acme-scoped answer is never reused for Maple or CA', async () => {
  const acmeDef = normalizeQuestion(employerSpecificAcme);
  await seedAnswer({
    famId: 'fam-acme-prior', ansId: 'ans-acme-prior', definitionId: acmeDef.id,
    sha: standingHash, selector: 'custom.notice_period', scope: { employerId: 'co-synthetic-acme', country: 'US' },
  });
  const maple = buildContextPacket(ctx, {
    applicationId: employerSpecificMaple.applicationId,
    observations: [employerSpecificMaple], maxBytes: 24000,
  });
  assert.equal(maple.answers.length, 0, 'employer-specific history never crosses employers');
  const ca = buildContextPacket(ctx, {
    applicationId: totalCompensationCAD.applicationId,
    observations: [totalCompensationCAD], maxBytes: 24000,
  });
  assert.equal(ca.answers.length, 0, 'US-scoped facts never answer a CA question');
});

test('stories: verbatim source spans only, secret lines dropped, relevance ranked', () => {
  const cvHash = hashText(CV_MD);
  const stories = extractExperienceStories({ fileKey: 'cv', text: CV_MD, sha256hex: cvHash });
  assert.ok(stories.length >= 2);
  for (const story of stories) {
    assert.equal(story.sourceRef.sha256, cvHash);
    for (const claim of story.claims) {
      assert.ok(CV_MD.includes(claim), 'claims are verbatim source lines, never synthesized');
      assert.ok(!claim.includes('fixture-secret-password'));
    }
  }
  const packet = buildContextPacket(ctx, {
    applicationId: motivationQuestion.applicationId,
    observations: [motivationQuestion], maxBytes: 24000,
  });
  assert.ok(packet.stories.length >= 1, 'free-text questions get experience stories');
  assert.ok(packet.stories[0].label.toLowerCase().includes('planning'), 'most relevant story first');
  assert.equal(JSON.stringify(packet).includes('fixture-secret-password'), false);
});

test('oversized material: stories are dropped before mandatory parts and the cap holds', () => {
  const bigCv = `# Big\n\n## Huge Section\n${'- synthetic filler line about robotics planning\n'.repeat(400)}`;
  writeFileSync(join(fixture.dataRoot, 'cv.md'), bigCv);
  try {
    const packet = buildContextPacket(ctx, {
      applicationId: motivationQuestion.applicationId,
      observations: [noticeQuestion, motivationQuestion], maxBytes: 2000,
    });
    assert.ok(packet.bytes <= 2000, `bytes ${packet.bytes} must respect the cap`);
    assert.equal(packet.answers.length, 1, 'the relevant answer survives the squeeze');
    assert.ok(Array.isArray(packet.versions.sourceHashes) && packet.versions.sourceHashes.length > 0,
      'provenance is reserved space, never dropped');
  } finally {
    writeFileSync(join(fixture.dataRoot, 'cv.md'), CV_MD);
  }
});

test('unsupported metrics: a draft metric absent from source is flagged; stored as draft, never a fact', async () => {
  const packet = buildContextPacket(ctx, {
    applicationId: motivationQuestion.applicationId,
    observations: [motivationQuestion], maxBytes: 24000,
  });
  const supported = await storeDraftAnswer(ctx, {
    observation: motivationQuestion,
    draftText: 'I reduced synthetic cycle time by 37% on a planning pipeline.',
    packet,
  });
  assert.deepEqual(supported.findings, [], 'a metric present verbatim in the source passes');
  const unsupported = await storeDraftAnswer(ctx, {
    observation: motivationQuestion,
    draftText: 'I grew revenue by 250% and managed 90 robots.',
    packet,
  });
  assert.ok(unsupported.findings.some((f) => f.kind === 'unsupported_metric' && f.metric.includes('250')));
  // Draft lives as a reviewable proposal; no personal fact was created.
  const { getRecord } = await import('../learning/store.mjs');
  const proposal = getRecord(ctx, 'proposals', unsupported.proposalId);
  assert.equal(proposal.status, 'draft');
  assert.equal(getRecord(ctx, 'answers', unsupported.proposalId), null);
});
