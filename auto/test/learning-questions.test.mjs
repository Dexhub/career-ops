// auto/test/learning-questions.test.mjs — T06: question definitions,
// occurrences, candidate retrieval and family corrections. All fixtures are
// synthetic D1 observations from auto/test/fixtures/learning/observations.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { getRecord, listRecords, commitRecord } from '../learning/store.mjs';
import {
  normalizeQuestion, findQuestionCandidates, recordOccurrence, correctFamily,
  isRestrictedQuestion, NORMALIZATION_VERSION,
} from '../learning/questions.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const fixturesPath = fileURLToPath(new URL('./fixtures/learning/observations.json', import.meta.url));
const F = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

const {
  originalQuestion, spacedDuplicate, currentAuthorization, futureSponsorship,
  baseSalaryUSD, totalCompensationCAD, negatedConviction, affirmativeConviction,
  employerSpecificAcme, employerSpecificMaple, optionalLanguage, fileUploadCv,
  conditionalRelocation, repeatedControlChangedOptions, restrictedAssessment,
} = F;

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

test('plan-required id and normalization assertions', () => {
  assert.notEqual(normalizeQuestion(currentAuthorization).id, normalizeQuestion(futureSponsorship).id);
  assert.notEqual(normalizeQuestion(baseSalaryUSD).id, normalizeQuestion(totalCompensationCAD).id);
  assert.equal(normalizeQuestion(spacedDuplicate).normalizedText, normalizeQuestion(originalQuestion).normalizedText);
});

test('harmless punctuation/case/whitespace variants share one stable definition id', () => {
  const a = normalizeQuestion(originalQuestion);
  const b = normalizeQuestion(spacedDuplicate);
  assert.equal(a.id, b.id);
  assert.equal(a.constraints.normalizationVersion, NORMALIZATION_VERSION);
  // The original text is retained, not erased by normalization.
  assert.equal(a.originalText, originalQuestion.originalText);
  assert.equal(b.originalText, spacedDuplicate.originalText);
});

test('semantic constraints survive: negation, time horizon, salary basis, currency, employer scope', () => {
  assert.equal(normalizeQuestion(negatedConviction).polarity, 'negated');
  assert.equal(normalizeQuestion(affirmativeConviction).polarity, 'affirmative');
  assert.notEqual(normalizeQuestion(negatedConviction).id, normalizeQuestion(affirmativeConviction).id);
  assert.equal(normalizeQuestion(currentAuthorization).timeHorizon, 'current');
  assert.equal(normalizeQuestion(futureSponsorship).timeHorizon, 'future');
  assert.equal(normalizeQuestion(baseSalaryUSD).constraints.salaryBasis, 'base');
  assert.equal(normalizeQuestion(totalCompensationCAD).constraints.salaryBasis, 'total');
  assert.equal(normalizeQuestion(baseSalaryUSD).constraints.currency, 'USD');
  // Identical employment text at two employers never shares an id.
  assert.notEqual(normalizeQuestion(employerSpecificAcme).id, normalizeQuestion(employerSpecificMaple).id);
  assert.equal(normalizeQuestion(employerSpecificAcme).constraints.employerScope, 'co-synthetic-acme');
  // Optional/required state and locale are part of the identity surface.
  assert.equal(normalizeQuestion(optionalLanguage).constraints.required, false);
  assert.equal(normalizeQuestion(optionalLanguage).locale, 'de-DE');
  assert.equal(normalizeQuestion(fileUploadCv).fieldType, 'file');
  assert.equal(normalizeQuestion(conditionalRelocation).constraints.parentCondition, 'field-reloc=yes');
});

test('occurrences store independently, dedupe unchanged snapshots, revise changed fields', async () => {
  const first = await recordOccurrence(ctx, currentAuthorization);
  assert.equal(first.deduplicated, false);
  assert.equal(first.fieldRevision, 1);
  // Same unchanged field from another attempt: evidence, not a new occurrence.
  const again = await recordOccurrence(ctx, { ...currentAuthorization, attemptId: 'att-fixture-099' });
  assert.equal(again.occurrenceId, first.occurrenceId);
  assert.equal(again.deduplicated, true);
  assert.equal(again.fieldRevision, 1);
  // Changed options on the same page control become a new field revision.
  const changed = await recordOccurrence(ctx, repeatedControlChangedOptions);
  assert.equal(changed.occurrenceId, first.occurrenceId);
  assert.equal(changed.deduplicated, false);
  assert.equal(changed.fieldRevision, 2);
  // Changed options also mean a different definition (option semantics kept).
  assert.notEqual(changed.definitionId, first.definitionId);
  const stored = getRecord(ctx, 'observations', first.occurrenceId);
  assert.equal(stored.revision, 2);
  assert.equal(stored.data.options.length, 3);
});

test('restricted assessments record metadata only and open a policy blocker', async () => {
  assert.equal(isRestrictedQuestion(restrictedAssessment), true);
  const res = await recordOccurrence(ctx, restrictedAssessment);
  assert.equal(res.restricted, true);
  assert.equal(res.definitionId, null, 'no reusable definition for a restricted assessment');
  const blocker = getRecord(ctx, 'blockers', res.blockerId);
  assert.equal(blocker.status, 'open');
  assert.equal(blocker.data.type, 'policy');
  const observation = getRecord(ctx, 'observations', res.occurrenceId);
  assert.equal(observation.data.answerDisposition, 'blocked');
  // Restricted questions never surface as reuse candidates either.
  assert.deepEqual(findQuestionCandidates(ctx, restrictedAssessment), []);
});

test('candidate retrieval: exact and lexical matches, hard filters, cap, no reuse authority', async () => {
  await recordOccurrence(ctx, originalQuestion);
  await recordOccurrence(ctx, futureSponsorship);
  await recordOccurrence(ctx, employerSpecificAcme);
  await recordOccurrence(ctx, employerSpecificMaple);
  await recordOccurrence(ctx, negatedConviction);
  await recordOccurrence(ctx, affirmativeConviction);

  // Exact: a harmless variant finds the shared definition.
  const exact = findQuestionCandidates(ctx, spacedDuplicate);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].match, 'exact');
  assert.equal(exact[0].questionId, normalizeQuestion(originalQuestion).id);
  assert.equal(exact[0].authorizesReuse, false);

  // Dangerous pairs never become interchangeable despite similar text.
  const auth = findQuestionCandidates(ctx, currentAuthorization);
  assert.ok(!auth.some((c) => c.questionId === normalizeQuestion(futureSponsorship).id),
    'current authorization must not surface future sponsorship');
  const acme = findQuestionCandidates(ctx, employerSpecificAcme);
  assert.ok(!acme.some((c) => c.questionId === normalizeQuestion(employerSpecificMaple).id),
    'employer-specific employment never crosses companies');
  const negated = findQuestionCandidates(ctx, negatedConviction);
  assert.ok(!negated.some((c) => c.questionId === normalizeQuestion(affirmativeConviction).id),
    'negation flips are filtered out');

  // The cap is honored.
  const capped = findQuestionCandidates(ctx, originalQuestion, { limit: 1 });
  assert.ok(capped.length <= 1);
});

test('unknown questions stay queryable rather than disappearing', async () => {
  const res = await recordOccurrence(ctx, optionalLanguage);
  // No neighbors: zero candidates besides itself, but the record exists.
  const { items: records } = listRecords(ctx, 'questions', { limit: 500 });
  assert.ok(records.some((r) => r.id === res.definitionId));
  const stored = getRecord(ctx, 'questions', res.definitionId);
  assert.equal(stored.data.normalizedText, normalizeQuestion(optionalLanguage).normalizedText);
  assert.ok(stored.data.occurrenceIds.includes(res.occurrenceId));
});

test('family split invalidates bound answers without rewriting raw observations', async () => {
  const defA = normalizeQuestion(originalQuestion);
  const defB = normalizeQuestion(baseSalaryUSD);
  await commitRecord(ctx, 'families', 'fam-mistaken-1', {
    label: 'synthetic mistaken family',
    questionIds: [defA.id, defB.id],
    scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'answers', 'ans-split-victim', {
    questionFamilyId: 'fam-mistaken-1',
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.synthetic', sha256: '0'.repeat(64) }],
    scope: { employerId: null, country: null, roleFamily: null, locale: 'en' },
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
    dependencies: [], approvalRef: 'appr-synth-1', publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z', template: null,
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  const obsBefore = getRecord(ctx, 'observations', (await recordOccurrence(ctx, originalQuestion)).occurrenceId);

  const correction = await correctFamily(ctx, {
    kind: 'split',
    familyIds: ['fam-mistaken-1'],
    replacements: [
      { label: 'notice period', questionIds: [defA.id], scope: {} },
      { label: 'base salary', questionIds: [defB.id], scope: {} },
    ],
    reason: 'notice period and salary were wrongly grouped',
  });
  assert.equal(correction.newFamilyIds.length, 2);
  assert.deepEqual(correction.invalidatedAnswerIds, ['ans-split-victim']);

  const revoked = getRecord(ctx, 'families', 'fam-mistaken-1');
  assert.equal(revoked.status, 'revoked');
  const staleAnswer = getRecord(ctx, 'answers', 'ans-split-victim');
  assert.equal(staleAnswer.status, 'stale');
  for (const famId of correction.newFamilyIds) {
    const fam = getRecord(ctx, 'families', famId);
    assert.equal(fam.status, 'proposed');
    assert.deepEqual(fam.sourceIds, ['fam-mistaken-1'], 'provenance points at the corrected family');
  }
  // Raw observations are untouched by the correction.
  const obsAfter = getRecord(ctx, 'observations', obsBefore.id);
  assert.equal(obsAfter.revision, obsBefore.revision);
  assert.deepEqual(obsAfter.data, obsBefore.data);
});

test('merge corrections revoke the sources and create a combined family', async () => {
  const defA = normalizeQuestion(employerSpecificAcme);
  await commitRecord(ctx, 'families', 'fam-dup-a', {
    label: 'dup a', questionIds: [defA.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'families', 'fam-dup-b', {
    label: 'dup b', questionIds: [defA.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  const correction = await correctFamily(ctx, {
    kind: 'merge',
    familyIds: ['fam-dup-a', 'fam-dup-b'],
    replacements: [{ label: 'merged', questionIds: [defA.id], scope: {} }],
    reason: 'duplicate families for one definition',
  });
  assert.equal(correction.newFamilyIds.length, 1);
  assert.equal(getRecord(ctx, 'families', 'fam-dup-a').status, 'revoked');
  assert.equal(getRecord(ctx, 'families', 'fam-dup-b').status, 'revoked');
  assert.equal(correction.invalidatedAnswerIds.length, 0, 'merge does not stale answers');
});
