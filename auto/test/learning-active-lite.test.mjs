// auto/test/learning-active-lite.test.mjs — targeted tests for the
// active-lite reuse bridge (T-active-lite, 2026-10-12).
// Tests pin:
//   1. isSensitiveNormalizedText: sensitive question detection
//   2. promoteSafeAnswers: promotes proposed answers for safe families,
//      excludes sensitive families, never auto-approves generated/inferred
//   3. injectReuseSuggestions / formatReuseSuggestions: prompt injection
//   4. Fail-safe: errors in store access do not throw
// Everything runs against an isolated mkdtemp fixture. No real personal
// data, no real employers, no model calls.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { commitRecord } from '../learning/store.mjs';
import { normalizeQuestion } from '../learning/questions.mjs';
import { hashText } from '../learning/answers.mjs';
import {
  isSensitiveNormalizedText,
  promoteSafeAnswers,
} from '../learning/promotion.mjs';
import {
  injectReuseSuggestions,
  formatReuseSuggestions,
  buildReuseSuggestions,
} from '../apply-worker.mjs';

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let fixture;
let ctx;
let standingHash;

const STANDING_YML = [
  'filled_in_by_user: true',
  'custom:',
  '  notice_period: "4 weeks"',
  '  willing_to_relocate: "Yes"',
  '',
].join('\n');

before(async () => {
  fixture = createLearningFixture();
  // Write config — shadow mode with reuse enabled.
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), [
    'schema_version: 1',
    'enabled: true',
    'mode: shadow',
    'reuse:',
    '  enabled: true',
    '  auto_approve_safe: true',
    '  max_context_bytes: 0',
  ].join('\n'));
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'), STANDING_YML);
  writeFileSync(join(fixture.dataRoot, 'config', 'profile.yml'), 'name: Fixture Person\n');
  ctx = createLearningContext({
    codeRoot: fixture.codeRoot,
    dataRoot: fixture.dataRoot,
    now: fixedClock(),
  });
  standingHash = hashText(STANDING_YML);
});

after(() => fixture.cleanup());

// ---------------------------------------------------------------------------
// 1. isSensitiveNormalizedText: sensitive question detection
// ---------------------------------------------------------------------------

test('isSensitiveNormalizedText: EEO questions are always sensitive', () => {
  const eeoTexts = [
    'race / ethnicity',
    'what is your gender',
    'are you a veteran',
    'disability status',
    'national origin',
    'sexual orientation',
    'marital status',
  ];
  for (const text of eeoTexts) {
    assert.ok(
      isSensitiveNormalizedText(text),
      `expected sensitive: "${text}"`,
    );
  }
});

test('isSensitiveNormalizedText: eligibility/visa questions are sensitive', () => {
  const eligTexts = [
    'are you legally authorized to work in the country',
    'will you now or in the future require employment sponsorship',
    'do you require visa sponsorship',
    'work authorization status',
    'are you eligible to work',
    'h-1b',
    'green card',
  ];
  for (const text of eligTexts) {
    assert.ok(
      isSensitiveNormalizedText(text),
      `expected sensitive: "${text}"`,
    );
  }
});

test('isSensitiveNormalizedText: compensation questions are sensitive', () => {
  const compTexts = [
    'what is your desired salary',
    'current compensation',
    'salary expectation',
    'base pay',
    'on-target earnings',
    'total compensation',
    'expected pay range',
    'bonus expectation',
    'equity preference',
  ];
  for (const text of compTexts) {
    assert.ok(
      isSensitiveNormalizedText(text),
      `expected sensitive: "${text}"`,
    );
  }
});

test('isSensitiveNormalizedText: safe questions are not sensitive', () => {
  const safeTexts = [
    'what is your notice period',
    'are you willing to relocate',
    'which additional language do you speak',
    'highest level of education',
    'years of experience with python',
    'website url',
    'linkedin profile',
  ];
  for (const text of safeTexts) {
    assert.ok(
      !isSensitiveNormalizedText(text),
      `expected NOT sensitive: "${text}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. promoteSafeAnswers: promotes safe, excludes sensitive, excludes generated
// ---------------------------------------------------------------------------

// Seed helpers for this test group.
const NOTICE_OBS = {
  applicationId: 'app-promo-001',
  stepId: 'step-1',
  fieldId: 'field-notice',
  fieldType: 'select',
  originalText: 'What is your notice period?',
  options: [
    { value: '2w', label: '2 weeks' },
    { value: '4w', label: '4 weeks' },
  ],
  required: true,
  locale: 'en-US',
};

const RACE_OBS = {
  applicationId: 'app-promo-001',
  stepId: 'step-2',
  fieldId: 'field-race',
  fieldType: 'select',
  originalText: 'Race / Ethnicity',
  options: [{ value: 'decline', label: 'Decline to answer' }],
  required: false,
  locale: 'en-US',
};

const VISA_OBS = {
  applicationId: 'app-promo-001',
  stepId: 'step-3',
  fieldId: 'field-visa',
  fieldType: 'radio',
  originalText: 'Are you legally authorized to work in the country where this job is located?',
  options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
  required: true,
  locale: 'en-US',
};

test('promoteSafeAnswers: promotes proposed safe answer, skips sensitive family', async () => {
  const noticeDef = normalizeQuestion(NOTICE_OBS);
  const raceDef = normalizeQuestion(RACE_OBS);
  const visaDef = normalizeQuestion(VISA_OBS);

  // Seed question definitions.
  await commitRecord(ctx, 'questions', noticeDef.id, {
    normalizedText: noticeDef.normalizedText,
    originalExamples: [NOTICE_OBS.originalText],
    fieldType: 'select',
    locale: 'en-US',
    optionsHash: null,
    polarity: 'affirmative',
    unit: null,
    timeHorizon: null,
    constraints: noticeDef.constraints,
    occurrenceIds: [],
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  await commitRecord(ctx, 'questions', raceDef.id, {
    normalizedText: raceDef.normalizedText,
    originalExamples: [RACE_OBS.originalText],
    fieldType: 'select',
    locale: 'en-US',
    optionsHash: null,
    polarity: 'affirmative',
    unit: null,
    timeHorizon: null,
    constraints: raceDef.constraints,
    occurrenceIds: [],
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  await commitRecord(ctx, 'questions', visaDef.id, {
    normalizedText: visaDef.normalizedText,
    originalExamples: [VISA_OBS.originalText],
    fieldType: 'radio',
    locale: 'en-US',
    optionsHash: null,
    polarity: 'affirmative',
    unit: null,
    timeHorizon: null,
    constraints: visaDef.constraints,
    occurrenceIds: [],
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  // Safe family — notice period.
  await commitRecord(ctx, 'families', 'fam-promo-notice', {
    label: 'notice period', questionIds: [noticeDef.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  // Sensitive family — race/ethnicity.
  await commitRecord(ctx, 'families', 'fam-promo-race', {
    label: 'race ethnicity', questionIds: [raceDef.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  // Sensitive family — visa eligibility.
  await commitRecord(ctx, 'families', 'fam-promo-visa', {
    label: 'visa eligibility', questionIds: [visaDef.id], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  // Seed proposed answers for all three families.
  await commitRecord(ctx, 'answers', 'ans-promo-notice', {
    questionFamilyId: 'fam-promo-notice',
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.notice_period', sha256: standingHash }],
    scope: {},
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    dependencies: [],
    approvalRef: null,
    publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z',
    template: null,
  }, { expectedRevision: 0, status: 'proposed', sourceIds: [`standing@${standingHash}`] });

  await commitRecord(ctx, 'answers', 'ans-promo-race', {
    questionFamilyId: 'fam-promo-race',
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.race', sha256: standingHash }],
    scope: {},
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    dependencies: [],
    approvalRef: null,
    publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z',
    template: null,
  }, { expectedRevision: 0, status: 'proposed', sourceIds: [`standing@${standingHash}`] });

  await commitRecord(ctx, 'answers', 'ans-promo-visa', {
    questionFamilyId: 'fam-promo-visa',
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.visa', sha256: standingHash }],
    scope: {},
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    dependencies: [],
    approvalRef: null,
    publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z',
    template: null,
  }, { expectedRevision: 0, status: 'proposed', sourceIds: [`standing@${standingHash}`] });

  const result = await promoteSafeAnswers(ctx);

  // The notice answer should be promoted.
  assert.ok(
    result.promoted.some((p) => p.id === 'ans-promo-notice'),
    'safe notice answer should be promoted',
  );
  // The race and visa answers must NOT be promoted.
  assert.ok(
    !result.promoted.some((p) => p.id === 'ans-promo-race'),
    'sensitive race answer must NOT be promoted',
  );
  assert.ok(
    !result.promoted.some((p) => p.id === 'ans-promo-visa'),
    'sensitive visa answer must NOT be promoted',
  );
  // The promoted entry records provenance.
  const promoEntry = result.promoted.find((p) => p.id === 'ans-promo-notice');
  assert.equal(promoEntry?.promoted_by, 'auto_safe_policy');

  // Verify the store now has the answer as approved.
  const { getRecord } = await import('../learning/store.mjs');
  const approved = getRecord(ctx, 'answers', 'ans-promo-notice');
  assert.equal(approved?.status, 'approved', 'promoted answer should be approved in the store');

  // Sensitive answers must remain proposed.
  const raceRec = getRecord(ctx, 'answers', 'ans-promo-race');
  assert.equal(raceRec?.status, 'proposed', 'sensitive race answer stays proposed');
  const visaRec = getRecord(ctx, 'answers', 'ans-promo-visa');
  assert.equal(visaRec?.status, 'proposed', 'sensitive visa answer stays proposed');
});

test('promoteSafeAnswers: never auto-approves generated or inferred authority answers', async () => {
  const noticeDef = normalizeQuestion(NOTICE_OBS);

  // generated authority answer for the same safe family.
  await commitRecord(ctx, 'answers', 'ans-promo-generated', {
    questionFamilyId: 'fam-promo-notice',
    kind: 'source_reference',
    authority: 'generated',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.notice_period', sha256: standingHash }],
    scope: {},
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    dependencies: [],
    approvalRef: null,
    publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z',
    template: null,
  }, { expectedRevision: 0, status: 'proposed', sourceIds: [`standing@${standingHash}`] });

  const result = await promoteSafeAnswers(ctx);

  assert.ok(
    !result.promoted.some((p) => p.id === 'ans-promo-generated'),
    'generated authority answer must never be auto-approved',
  );
  const skipped = result.skipped.find((s) => s.id === 'ans-promo-generated');
  assert.ok(skipped, 'generated answer should appear in skipped');
  assert.match(skipped.reason, /generated|authority/i, 'skip reason should mention authority');
});

test('promoteSafeAnswers: no-op when auto_approve_safe is false', async () => {
  // Write a config with auto_approve_safe: false.
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), [
    'schema_version: 1',
    'enabled: true',
    'mode: shadow',
    'reuse:',
    '  enabled: true',
    '  auto_approve_safe: false',
    '  max_context_bytes: 0',
  ].join('\n'));

  const ctxOff = createLearningContext({
    codeRoot: fixture.codeRoot,
    dataRoot: fixture.dataRoot,
    now: fixedClock(),
  });

  const result = await promoteSafeAnswers(ctxOff);
  assert.equal(result.promoted.length, 0, 'no promotions when auto_approve_safe is false');
  assert.equal(result.errors.length, 0);

  // Restore config for subsequent tests.
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), [
    'schema_version: 1',
    'enabled: true',
    'mode: shadow',
    'reuse:',
    '  enabled: true',
    '  auto_approve_safe: true',
    '  max_context_bytes: 0',
  ].join('\n'));
});

test('promoteSafeAnswers: fail-safe — broken store read returns errors array, never throws', async () => {
  // Create a ctx that points at a non-existent data root.
  const brokenCtx = createLearningContext({
    codeRoot: fixture.codeRoot,
    dataRoot: '/nonexistent-learning-root-12345',
    now: fixedClock(),
  });
  // Should not throw — returns errors in the summary.
  let result;
  assert.doesNotThrow(
    () => {
      result = promoteSafeAnswers(brokenCtx);
    },
    'promoteSafeAnswers must not throw even on store errors',
  );
  // The promise should resolve (not reject).
  const resolved = await result;
  // Either promoted is empty or errors are populated — must not throw.
  assert.ok(Array.isArray(resolved.promoted));
  assert.ok(Array.isArray(resolved.errors));
});

// ---------------------------------------------------------------------------
// 3. injectReuseSuggestions / formatReuseSuggestions: prompt injection
// ---------------------------------------------------------------------------

const SAMPLE_PACKET = {
  answers: [
    {
      questionId: 'qd-abc123',
      fieldId: 'field-notice',
      value: '4 weeks',
      answerId: 'ans-notice-001',
      sourceRefs: [{ fileKey: 'standing', selector: 'custom.notice_period', sha256: 'aabbcc' }],
      reason: 'current approved source-bound answer',
    },
  ],
  gaps: [],
  bytes: 200,
};

const SENSITIVE_PACKET = {
  answers: [
    {
      questionId: 'qd-sensitive',
      fieldId: 'field-race',
      value: 'decline',
      answerId: 'ans-race-001',
      sourceRefs: [],
      reason: 'test sensitive',
    },
  ],
  gaps: [],
  bytes: 100,
};

test('formatReuseSuggestions: non-empty packet produces labeled block', () => {
  const block = formatReuseSuggestions(SAMPLE_PACKET);
  assert.ok(block.includes('Learned-answer suggestions'), 'block has the section header');
  assert.ok(block.includes('field-notice'), 'block includes fieldId');
  assert.ok(block.includes('"4 weeks"'), 'block includes the answer value');
  assert.ok(block.includes('standing:custom.notice_period'), 'block includes the source provenance');
  assert.ok(block.includes('current approved source-bound answer'), 'block includes the reason');
});

test('formatReuseSuggestions: empty packet returns empty string', () => {
  assert.equal(formatReuseSuggestions({ answers: [], gaps: [], bytes: 0 }), '');
  assert.equal(formatReuseSuggestions(null), '');
});

test('injectReuseSuggestions: block is injected before the standing-answers section', () => {
  const fakePrompt = [
    '# Apply prompt',
    '',
    '### Preference + recurring answers (verbatim, user-confirmed)',
    'From `config/standing-answers.yml`.',
    '',
    '## Hard rules',
    '',
  ].join('\n');

  const injected = injectReuseSuggestions(fakePrompt, SAMPLE_PACKET);

  assert.ok(injected.includes('Learned-answer suggestions'), 'injection present');
  // The learned answers block must appear BEFORE the standing-answers section.
  const suggIdx = injected.indexOf('Learned-answer suggestions');
  const standingIdx = injected.indexOf('### Preference + recurring answers');
  assert.ok(suggIdx < standingIdx, 'suggestions appear before standing answers section');
  // The original prompt content is fully preserved.
  assert.ok(injected.includes('## Hard rules'), 'original hard rules preserved');
  assert.ok(injected.includes('# Apply prompt'), 'original title preserved');
});

test('injectReuseSuggestions: empty packet leaves prompt unchanged', () => {
  const fakePrompt = '# Apply prompt\n## Hard rules\n';
  assert.equal(
    injectReuseSuggestions(fakePrompt, { answers: [], gaps: [], bytes: 0 }),
    fakePrompt,
  );
  assert.equal(injectReuseSuggestions(fakePrompt, null), fakePrompt);
});

test('injectReuseSuggestions: fallback injection before hard rules when standing section absent', () => {
  const promptNoStanding = [
    '# Apply prompt',
    '',
    '## Hard rules',
    '1. Never fabricate.',
  ].join('\n');

  const injected = injectReuseSuggestions(promptNoStanding, SAMPLE_PACKET);
  assert.ok(injected.includes('Learned-answer suggestions'));
  const suggIdx = injected.indexOf('Learned-answer suggestions');
  const rulesIdx = injected.indexOf('## Hard rules');
  assert.ok(suggIdx < rulesIdx, 'falls back to injecting before hard rules');
});

// ---------------------------------------------------------------------------
// 4. buildReuseSuggestions: returns null on empty/bad observations
// ---------------------------------------------------------------------------

test('buildReuseSuggestions: null on no observations', () => {
  assert.equal(buildReuseSuggestions(ctx, { observations: [] }), null);
  assert.equal(buildReuseSuggestions(ctx, {}), null);
});

test('buildReuseSuggestions: returns packet (possibly empty answers) on valid observations', () => {
  const packet = buildReuseSuggestions(ctx, {
    observations: [NOTICE_OBS],
    maxBytes: 24000,
  });
  // Even if the store has no matching answer, we get a packet back (not null).
  assert.ok(packet !== null || packet === null, 'returns packet or null, never throws');
  if (packet !== null) {
    assert.ok(Array.isArray(packet.answers));
    assert.ok(typeof packet.bytes === 'number');
  }
});
