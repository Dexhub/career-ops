// auto/test/learning-answer-resolution.test.mjs — T07: answer resolution by
// authority, context and freshness. All sources/values are synthetic fixture
// data ('4 weeks' included); no real personal fact appears here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { commitRecord } from '../learning/store.mjs';
import { normalizeQuestion } from '../learning/questions.mjs';
import { resolveAnswer, buildSourceRegistry, SOURCE_FILE_KEYS } from '../learning/answers.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const fixturesPath = fileURLToPath(new URL('./fixtures/learning/observations.json', import.meta.url));
const F = JSON.parse(readFileSync(fixturesPath, 'utf-8'));
const { noticeQuestion, currentAuthorization, baseSalaryUSD, totalCompensationCAD, employerSpecificMaple } = F;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_P = 'c'.repeat(64);

function snapshot(sources) {
  return { sources, capturedAt: '2026-10-11T00:00:00.000Z' };
}

const standingSource = (sha, values) => ({
  fileKey: 'standing', sha256: sha, valuesBySelector: values,
  publicUse: 'applications_only', confirmedAt: '2026-10-01T00:00:00.000Z',
});

let fixture;
let ctx;
before(() => {
  fixture = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
});
after(() => fixture.cleanup());

test('fixture isolation: everything happens under the scratch root, never the live checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
});

test('source registry: only known read-only adapters, exact selectors, confirmed notes', () => {
  assert.deepEqual([...SOURCE_FILE_KEYS], ['profile', 'standing', 'cv', 'notes']);
  assert.throws(
    () => buildSourceRegistry(snapshot([{ fileKey: 'mystery', sha256: SHA_A, valuesBySelector: {} }])),
    (err) => err.code === 'FORBIDDEN_SOURCE',
  );
  assert.throws(
    () => buildSourceRegistry(snapshot([{ fileKey: 'notes', sha256: SHA_A, valuesBySelector: { 'note.x': 'y' } }])),
    (err) => err.code === 'FORBIDDEN_SOURCE',
    'unconfirmed notes are not an approved fact source',
  );
  const registry = buildSourceRegistry(snapshot([standingSource(SHA_A, { 'custom.notice_period': '4 weeks' })]));
  assert.equal(registry.lookup('standing', 'custom.notice_period'), '4 weeks');
  // A prose line is not a selector: anything unregistered stays unresolved.
  assert.equal(registry.lookup('standing', 'some prose line about eligibility'), undefined);
});

test('plan-required resolution: ready from approved mapping, zero model calls, stale on change', () => {
  let modelCalls = 0;
  const policy = {
    mappings: [{
      normalizedText: 'what is your notice period',
      fileKey: 'standing', selector: 'custom.notice_period', sha256: SHA_A,
    }],
    modelClient: { draft: () => { modelCalls += 1; } },
  };
  const approvedSources = snapshot([standingSource(SHA_A, { 'custom.notice_period': '4 weeks' })]);
  const changedSources = snapshot([standingSource(SHA_B, { 'custom.notice_period': '2 weeks' })]);
  const result = resolveAnswer(ctx,{observation:noticeQuestion,sourceSnapshot:approvedSources,policy});
  assert.equal(result.status,'ready');
  assert.equal(result.value,'4 weeks');
  assert.equal(modelCalls,0);
  const changed = resolveAnswer(ctx,{observation:noticeQuestion,sourceSnapshot:changedSources,policy});
  assert.notEqual(changed.status,'ready');
  assert.equal(changed.status, 'stale');
  assert.equal(changed.value, null, 'only ready carries a fillable value');
});

test('never copy an option label the current menu does not offer', () => {
  const policy = {
    mappings: [{
      normalizedText: 'what is your notice period',
      fileKey: 'standing', selector: 'custom.notice_period', sha256: SHA_A,
    }],
  };
  // '6 weeks' is a valid stored value but the select menu lacks it.
  const sources = snapshot([standingSource(SHA_A, { 'custom.notice_period': '6 weeks' })]);
  const result = resolveAnswer(ctx, { observation: noticeQuestion, sourceSnapshot: sources, policy });
  assert.equal(result.status, 'blocked');
  assert.equal(result.value, null);
  assert.match(result.reason, /not an option offered/);
});

// Helper: approved family + answer for a definition.
async function seedAnswer({ famId, ansId, definitionId, answerData, answerStatus = 'approved' }) {
  await commitRecord(ctx, 'families', famId, {
    label: `synthetic ${famId}`, questionIds: [definitionId], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'answers', ansId, {
    questionFamilyId: famId,
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.synthetic', sha256: SHA_A }],
    scope: { employerId: null, country: null, roleFamily: null, locale: null },
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
    dependencies: [], approvalRef: 'appr-synth', publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z', template: null,
    ...answerData,
  }, { expectedRevision: 0, status: answerStatus, sourceIds: [] });
}

test('expired preference: an answer outside its validity window is stale, not ready', async () => {
  const def = normalizeQuestion(baseSalaryUSD);
  await seedAnswer({
    famId: 'fam-salary', ansId: 'ans-salary-expired', definitionId: def.id,
    answerData: { validUntil: '2026-02-01T00:00:00.000Z' },
  });
  const sources = snapshot([standingSource(SHA_A, { 'custom.synthetic': '123000' })]);
  const result = resolveAnswer(ctx, { observation: baseSalaryUSD, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'stale');
  assert.equal(result.value, null);
  assert.match(result.reason, /validity window/);
});

test('modified source: hash mismatch makes a bound answer stale', async () => {
  const def = normalizeQuestion(currentAuthorization);
  await seedAnswer({ famId: 'fam-auth', ansId: 'ans-auth', definitionId: def.id, answerData: {} });
  // Snapshot carries a NEW standing hash: the answer is bound to SHA_A.
  const sources = snapshot([standingSource(SHA_B, { 'custom.synthetic': 'Yes' })]);
  const result = resolveAnswer(ctx, { observation: currentAuthorization, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'stale');
  assert.match(result.reason, /modified source|hash mismatch/);
});

test('salary basis and currency never cross: a base-USD answer does not reach total-CAD', () => {
  // fam-salary exists for baseSalaryUSD only; the total-comp question misses.
  const sources = snapshot([standingSource(SHA_A, { 'custom.synthetic': '123000' })]);
  const result = resolveAnswer(ctx, { observation: totalCompensationCAD, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /missing_information/);
});

test('unknown source fileKey is refused outright', () => {
  assert.throws(
    () => resolveAnswer(ctx, {
      observation: noticeQuestion,
      sourceSnapshot: snapshot([{ fileKey: 'scraped_site', sha256: SHA_A, valuesBySelector: {} }]),
      policy: {},
    }),
    (err) => err.code === 'FORBIDDEN_SOURCE',
  );
});

test('an accepted-but-generated old answer never becomes ready', async () => {
  const def = normalizeQuestion(F.optionalLanguage);
  await seedAnswer({
    famId: 'fam-lang', ansId: 'ans-lang-generated', definitionId: def.id,
    answerData: { kind: 'draft', authority: 'generated' },
  });
  const sources = snapshot([standingSource(SHA_A, { 'custom.synthetic': 'Deutsch' })]);
  const result = resolveAnswer(ctx, { observation: F.optionalLanguage, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.value, null);
  assert.match(result.reason, /generated/);
});

test('a new employer invalidates employer-scoped reuse', async () => {
  const def = normalizeQuestion(employerSpecificMaple);
  await seedAnswer({
    famId: 'fam-prior', ansId: 'ans-prior-acme', definitionId: def.id,
    answerData: { scope: { employerId: 'co-synthetic-acme', country: null, roleFamily: null, locale: null } },
  });
  const sources = snapshot([standingSource(SHA_A, { 'custom.synthetic': 'No' })]);
  // The observation is at Maple; the answer is scoped to Acme.
  const result = resolveAnswer(ctx, { observation: employerSpecificMaple, sourceSnapshot: sources, policy: {} });
  assert.notEqual(result.status, 'ready');
  assert.equal(result.value, null);
});

test('two plausible conflicting memories block with the conflicting reference IDs', async () => {
  const def = normalizeQuestion(F.conditionalRelocation);
  await commitRecord(ctx, 'families', 'fam-reloc', {
    label: 'synthetic relocation', questionIds: [def.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  for (const [ansId, selector] of [['ans-reloc-1', 'custom.city_a'], ['ans-reloc-2', 'custom.city_b']]) {
    await commitRecord(ctx, 'answers', ansId, {
      questionFamilyId: 'fam-reloc', kind: 'source_reference', authority: 'user_confirmed',
      sourceRefs: [{ fileKey: 'standing', selector, sha256: SHA_A }],
      scope: { employerId: null, country: null, roleFamily: null, locale: null },
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
      dependencies: [], approvalRef: 'appr-synth', publicUse: 'applications_only',
      lastValidatedAt: '2026-10-01T00:00:00.000Z', template: null,
    }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  }
  const sources = snapshot([standingSource(SHA_A, { 'custom.city_a': 'Springfield', 'custom.city_b': 'Shelbyville' })]);
  const result = resolveAnswer(ctx, { observation: F.conditionalRelocation, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.conflictingRefs.sort(), ['ans-reloc-1', 'ans-reloc-2']);
});

test('dynamic facts resolve as rules at use time, never as cached strings', async () => {
  const availabilityQuestion = {
    ...noticeQuestion, questionId: 'q-availability', fieldId: 'field-availability',
    fieldType: 'date', originalText: 'What is your earliest availability date?',
    options: [], unit: null,
  };
  const def = normalizeQuestion(availabilityQuestion);
  await commitRecord(ctx, 'families', 'fam-avail', {
    label: 'synthetic availability', questionIds: [def.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'answers', 'ans-avail-rule', {
    questionFamilyId: 'fam-avail', kind: 'derived_rule', authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.notice_weeks', sha256: SHA_A }],
    scope: { employerId: null, country: null, roleFamily: null, locale: null },
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
    dependencies: [{ fileKey: 'standing', selector: 'custom.notice_weeks' }],
    approvalRef: 'appr-synth', publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z', template: 'availability_date_from_notice',
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  const sources = snapshot([standingSource(SHA_A, { 'custom.notice_weeks': 4 })]);
  const result = resolveAnswer(ctx, { observation: availabilityQuestion, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'ready');
  // fixedClock 2026-10-11 + 4 synthetic weeks = 2026-11-08, computed at use time.
  assert.equal(result.value, '2026-11-08');
});

test('no nationality or eligibility is ever inferred from location', () => {
  // Sources know only a location; the work-authorization question stays blocked.
  const sources = snapshot([{
    fileKey: 'profile', sha256: SHA_P,
    valuesBySelector: { 'location.city': 'Synthville' },
    publicUse: 'applications_only', confirmedAt: null,
  }]);
  const result = resolveAnswer(ctx, {
    observation: { ...currentAuthorization, companyId: 'co-synthetic-berg', applicationId: 'app-fixture-090' },
    sourceSnapshot: snapshot([{ ...sources.sources[0] }]),
    policy: {},
  });
  // fam-auth's answer is bound to standing SHA_A, absent here -> never ready.
  assert.notEqual(result.status, 'ready');
  assert.equal(result.value, null);
});

test('sensitive optional questions follow the explicit disclosure policy', () => {
  const sensitiveQuestion = {
    ...F.optionalLanguage, questionId: 'q-sensitive', fieldId: 'field-sensitive',
    locale: 'en-US', country: 'US',
    originalText: 'What is your gender identity? (optional)',
    options: [
      { value: 'a', label: 'Option A' },
      { value: 'decline', label: 'Prefer not to say' },
    ],
  };
  const def = normalizeQuestion(sensitiveQuestion);
  const policy = {
    disclosure: {
      sensitiveNormalizedTexts: [def.normalizedText],
      action: 'decline',
      declineLabel: 'Prefer not to say',
    },
  };
  const sources = snapshot([standingSource(SHA_A, {})]);
  const result = resolveAnswer(ctx, { observation: sensitiveQuestion, sourceSnapshot: sources, policy });
  assert.equal(result.status, 'ready');
  assert.equal(result.value, 'Prefer not to say');
  // If the menu lacks the approved decline label, nothing is invented.
  const noDecline = { ...sensitiveQuestion, options: [{ value: 'a', label: 'Option A' }] };
  const blocked = resolveAnswer(ctx, { observation: noDecline, sourceSnapshot: sources, policy });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.value, null);
});

test('grounded drafts require review and are the only path that may consult a model', () => {
  let modelCalls = 0;
  const policy = { allowDraft: true, modelClient: { draft: () => { modelCalls += 1; } } };
  const freeText = {
    ...noticeQuestion, questionId: 'q-motivation', fieldId: 'field-motivation',
    fieldType: 'textarea', originalText: 'Why do you want to join our synthetic team?',
    options: [], unit: null,
  };
  const sources = snapshot([standingSource(SHA_A, {})]);
  const result = resolveAnswer(ctx, { observation: freeText, sourceSnapshot: sources, policy });
  assert.equal(result.status, 'draft');
  assert.equal(result.value, null, 'a draft is not a fillable value');
  assert.equal(modelCalls, 1);
});

test('restricted assessments resolve to blocked, never to an answer', () => {
  const sources = snapshot([standingSource(SHA_A, {})]);
  const result = resolveAnswer(ctx, { observation: F.restrictedAssessment, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /restricted_assessment/);
});
