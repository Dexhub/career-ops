// auto/test/learning-audit-contract.test.mjs — T04: one normalization path
// for every historical answers.json representation, consumed by apply-worker
// verifyAudit and diagnose buildReport. Runs entirely against the T01 fixture
// root; never reads or writes live audit directories or live controls.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLearningFixture } from './helpers/learning.mjs';
import { normalizeAuditAnswers } from '../learning/evidence.mjs';
import { buildReport, collectAttempts } from '../diagnose.mjs';

let fx; // T01 fixture: { root, cleanup }
let verifyAudit; // ../apply-worker.mjs, imported only after the fixture env is set

before(async () => {
  fx = createLearningFixture();
  // apply-worker imports state.mjs -> core/db.mjs; import it only after
  // CAREER_OPS_ROOT / CAREER_OPS_DB point at the fixture, never live data.
  ({ verifyAudit } = await import('../apply-worker.mjs'));
});

after(() => fx.cleanup());

// ---------- test-local helpers (fixture paths only) ----------

/** Fresh audit dir inside the fixture root with a passing artifact set. */
let auditSeq = 0;
function makeAuditDir({ answers, answersRaw } = {}) {
  const dir = join(fx.root, 'output', 'fixture-app', 'audit', `attempt-${auditSeq += 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'filled_no_submit' }));
  writeFileSync(join(dir, '01-form-filled.png'), 'png');
  if (answersRaw !== undefined) writeFileSync(join(dir, 'answers.json'), answersRaw);
  else if (answers !== undefined) writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
  return dir;
}

/**
 * fixtureAttempt(normalized) — an attempt record per the updated diagnostics
 * contract: buildReport consumes {app,attempt,dir,result,verdict,answers,
 * answersGap,error} where `answers` flows through normalizeAuditAnswers.
 */
function fixtureAttempt(normalized) {
  return {
    app: 'fixture-app',
    attempt: 'attempt-fixture',
    dir: join(fx.root, 'output', 'fixture-app', 'audit', 'attempt-fixture'),
    result: { status: 'filled_no_submit' },
    verdict: { status: 'filled_no_submit', ok: true, reason: '' },
    answers: normalized.entries,
    answersGap: null,
    error: null,
  };
}

/** Classification used by the fixtures below — three DISTINCT statuses. */
function classify(normalized) {
  if (normalized.entries.length === 0 && normalized.rejected.length > 0) return 'rejected_import';
  const [entry] = normalized.entries;
  if (entry.value === null || entry.value === '') return 'observed_question';
  return 'reusable_answer';
}

// ---------- isolation ----------

test('fixture isolation: env names the helper-created temp root, never the real checkout', () => {
  assert.equal(process.env.CAREER_OPS_ROOT, fx.root);
  assert.match(fx.root, /career-learning-/);
  assert.equal(process.env.CAREER_OPS_DB, join(fx.root, 'career-ops-test.db'));
});

// ---------- paired representations: identical logical fields ----------

const EXPECTED_ENTRY = {
  fieldId: 'contact.email',
  label: 'Email',
  value: 'sample@example.invalid',
  source: 'profile',
  section: 'Contact',
};

test('array, section-object and keyed representations normalize identically', () => {
  const repArray = [{ section: 'Contact', label: 'Email', value: 'sample@example.invalid', source: 'profile' }];
  const repStepArray = [{ step: 'Contact', label: 'Email', value: 'sample@example.invalid', source: 'profile' }];
  const repSectionRows = { Contact: [{ label: 'Email', value: 'sample@example.invalid', source: 'profile' }] };
  const repKeyed = { Contact: { Email: { value: 'sample@example.invalid', source: 'profile' } } };
  for (const rep of [repArray, repStepArray, repSectionRows, repKeyed]) {
    const out = normalizeAuditAnswers(rep);
    assert.deepEqual(out, { entries: [EXPECTED_ENTRY], rejected: [] });
    assert.equal(classify(out), 'reusable_answer');
  }
});

// ---------- plan-required assertion snippet ----------

test('plan-required assertion: keyed form normalizes and renders in diagnostics', () => {
  const normalized = normalizeAuditAnswers({ Contact: { Email: { value: 'sample@example.invalid', source: 'profile' } } });
  assert.equal(normalized.entries.length, 1);
  assert.equal(normalized.entries[0].label, 'Email');
  assert.doesNotThrow(() => buildReport([fixtureAttempt(normalized)]));
});

// ---------- value edge cases (paired array/keyed forms) ----------

test('false is a preserved reusable value, not emptiness', () => {
  for (const rep of [
    [{ section: 'Eligibility', label: 'Previously employed here', value: false, source: 'standing' }],
    { Eligibility: { 'Previously employed here': { value: false, source: 'standing' } } },
  ]) {
    const out = normalizeAuditAnswers(rep);
    assert.equal(out.entries[0].value, false);
    assert.equal(out.rejected.length, 0);
    assert.equal(classify(out), 'reusable_answer');
  }
});

test('zero is a preserved reusable value', () => {
  for (const rep of [
    [{ section: 'Experience', label: 'Years with tool X', value: 0, source: 'cv' }],
    { Experience: { 'Years with tool X': { value: 0, source: 'cv' } } },
  ]) {
    const out = normalizeAuditAnswers(rep);
    assert.equal(out.entries[0].value, 0);
    assert.equal(classify(out), 'reusable_answer');
  }
});

test('empty optional answer is an observed question, not a reusable answer', () => {
  for (const rep of [
    [{ section: 'Extras', label: 'Anything to add', value: '', source: 'profile' }],
    { Extras: { 'Anything to add': { value: '', source: 'profile' } } },
  ]) {
    const out = normalizeAuditAnswers(rep);
    assert.equal(out.entries.length, 1);
    assert.equal(classify(out), 'observed_question');
  }
  // Missing value key entirely -> null value, same observed-question status.
  const noValue = normalizeAuditAnswers([{ label: 'Anything to add', source: 'profile' }]);
  assert.equal(noValue.entries[0].value, null);
  assert.equal(classify(noValue), 'observed_question');
});

test('multiline response survives normalization byte-for-byte', () => {
  const text = 'Line one.\nLine two,\n  indented third line.';
  for (const rep of [
    [{ section: 'Questions', label: 'Why us', value: text, source: 'generated' }],
    { Questions: { 'Why us': { value: text, source: 'generated' } } },
  ]) {
    const out = normalizeAuditAnswers(rep);
    assert.equal(out.entries[0].value, text);
    assert.equal(out.entries[0].source, 'generated');
  }
});

test('missing source becomes unverified — never user_confirmed', () => {
  for (const rep of [
    [{ section: 'Contact', label: 'Phone', value: '000' }],
    { Contact: { Phone: { value: '000' } } },
    { Contact: { Phone: '000' } }, // observed flat keyed variant
  ]) {
    const out = normalizeAuditAnswers(rep);
    assert.equal(out.entries[0].source, 'unverified');
    assert.notEqual(out.entries[0].source, 'user_confirmed');
  }
  // Non-string source is unknown too.
  assert.equal(normalizeAuditAnswers([{ label: 'Phone', value: '000', source: 42 }]).entries[0].source, 'unverified');
});

// ---------- rejections ----------

test('empty object/array carry no entries and no rejections (empty audit)', () => {
  assert.deepEqual(normalizeAuditAnswers({}), { entries: [], rejected: [] });
  assert.deepEqual(normalizeAuditAnswers([]), { entries: [], rejected: [] });
});

test('ambiguous nested object is rejected with reason + source pointer, not guessed', () => {
  const out = normalizeAuditAnswers({ Contact: { Email: { nested: { deeper: 'x' } } } });
  assert.equal(out.entries.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].pointer, '$.Contact.Email');
  assert.match(out.rejected[0].reason, /ambiguous/);
  assert.equal(classify(out), 'rejected_import');
});

test('secret field is a rejected import and its value never leaks', () => {
  const secretValue = 'hunter2-SUPER-SECRET-0191';
  const reps = [
    [{ section: 'Account', label: 'Password', value: secretValue, source: 'generated' }],
    { Account: { Password: { value: secretValue, source: 'generated' } } },
    { Account: { Login: { value: 'user@example.invalid', password: secretValue } } },
  ];
  for (const rep of reps) {
    const out = normalizeAuditAnswers(rep);
    assert.equal(out.entries.length, 0, 'secret entries must not normalize');
    assert.ok(out.rejected.length >= 1);
    const dump = JSON.stringify(out.rejected);
    assert.ok(!dump.includes(secretValue), 'rejection messages must not leak the secret value');
    assert.equal(classify(out), 'rejected_import');
  }
});

test('a generic string object is never parsed as a credential or approved fact', () => {
  // Looks like an account block (observed keyed form) — normalizes to plain
  // unverified observations, never an approved/user_confirmed fact.
  const out = normalizeAuditAnswers({ account: { method: 'created_new', email: 'sample@example.invalid' } });
  assert.equal(out.rejected.length, 0);
  for (const entry of out.entries) {
    assert.equal(entry.source, 'unverified');
  }
});

test('unsupported top-level shapes reject with pointer $', () => {
  for (const input of ['a string', 42, null, true]) {
    const out = normalizeAuditAnswers(input);
    assert.equal(out.entries.length, 0);
    assert.equal(out.rejected[0].pointer, '$');
  }
});

// ---------- consumer: verifyAudit (audit shape, not reuse authorization) ----------

test('verifyAudit accepts every supported representation and rejects empty ones', () => {
  const row = [{ label: 'Name', value: 'X', source: 'profile' }];
  const keyed = { my_information: { name: 'X' }, application_questions: [] };
  assert.equal(verifyAudit(makeAuditDir({ answers: row }), { submit: false }).ok, true);
  assert.equal(verifyAudit(makeAuditDir({ answers: keyed }), { submit: false }).ok, true, 'object-form regression must not fail');
  assert.equal(verifyAudit(makeAuditDir({ answers: [] }), { submit: false }).ok, false);
  assert.equal(verifyAudit(makeAuditDir({ answers: {} }), { submit: false }).ok, false);
  assert.equal(verifyAudit(makeAuditDir({ answers: 'not-answers' }), { submit: false }).ok, false);
});

test('malformed answers.json file fails shape validation as unparseable, not external failure', () => {
  const dir = makeAuditDir({ answersRaw: '{"Contact": {"Email": ' }); // truncated JSON
  const verdict = verifyAudit(dir, { submit: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /unparseable/);
});

// ---------- consumer: diagnose buildReport ----------

test('object-form answers no longer crash buildReport and generated answers aggregate', () => {
  const attempts = [
    {
      app: 'a1', attempt: 'attempt-1', dir: '/x',
      result: { status: 'filled_no_submit' }, verdict: { status: 'filled_no_submit', ok: true, reason: '' },
      answers: { Questions: { 'Why us': { value: 'because', source: 'generated' } } },
      answersGap: null, error: null,
    },
    {
      app: 'a2', attempt: 'attempt-1', dir: '/y',
      result: { status: 'filled_no_submit' }, verdict: { status: 'filled_no_submit', ok: true, reason: '' },
      answers: [{ label: 'Why us', value: 'reasons', source: 'generated' }],
      answersGap: null, error: null,
    },
  ];
  let report;
  assert.doesNotThrow(() => { report = buildReport(attempts); });
  assert.ok(report.includes('**Why us** ×2'), 'generated answers from both shapes aggregate together');
});

test('missing and malformed answers.json surface as evidence gaps, not failures', () => {
  // Real files via collectAttempts on a fixture output tree.
  makeAuditDir({}); // no answers.json at all
  makeAuditDir({ answersRaw: '{broken' }); // malformed
  const attempts = collectAttempts(join(fx.root, 'output'));
  const states = attempts.map((a) => a.answersGap).sort();
  assert.ok(states.includes('missing'));
  assert.ok(states.includes('malformed'));
  const report = buildReport(attempts);
  assert.ok(report.includes('Evidence gaps'));
  assert.ok(report.includes('answers.json missing (evidence gap, not an external failure)'));
  assert.ok(report.includes('answers.json malformed (evidence gap, not an external failure)'));
});

// ---------- fixture classification matrix (distinct statuses) ----------

test('every fixture class maps to one of three distinct statuses', () => {
  const matrix = [
    ['reusable_answer', { Contact: { Email: { value: 'sample@example.invalid', source: 'profile' } } }],
    ['observed_question', [{ label: 'Anything to add', value: '', source: 'profile' }]],
    ['rejected_import', [{ label: 'Password', value: 'x', source: 'generated' }]],
  ];
  const seen = new Set();
  for (const [expected, input] of matrix) {
    assert.equal(classify(normalizeAuditAnswers(input)), expected);
    seen.add(expected);
  }
  assert.equal(seen.size, 3, 'observed question, reusable answer and rejected import are distinct statuses');
});
