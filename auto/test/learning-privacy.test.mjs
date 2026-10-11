// auto/test/learning-privacy.test.mjs — secret-bearing keys never land in the
// ledger, error reports never carry the secret value, and ingestion is
// restricted to the allowlisted source roots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext, learningDataRoot } from '../learning/context.mjs';
import { commitRecord } from '../learning/store.mjs';
import {
  isIngestiblePath, assertIngestiblePath, validateRecordData, LearningError,
} from '../learning/contracts.mjs';

let fixture;
let ctx;
before(() => {
  fixture = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
});
after(() => fixture.cleanup());

const SECRET_VALUE = 'hunter2-super-secret-value';

function allStoredBytes() {
  const root = learningDataRoot(ctx);
  if (!existsSync(root)) return '';
  const chunks = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) chunks.push(readFileSync(p, 'utf-8'));
    }
  };
  walk(root);
  return chunks.join('\n');
}

test('secret-bearing keys are rejected at every nesting level with FORBIDDEN_KEY', async () => {
  const cases = [
    { password: SECRET_VALUE },
    { api_key: SECRET_VALUE },
    { apiKey: SECRET_VALUE },
    { 'session-token': SECRET_VALUE },
    { otp: SECRET_VALUE },
    { one_time_code: SECRET_VALUE },
    { Authorization: SECRET_VALUE },
    { cookie: SECRET_VALUE },
    { verification_url: SECRET_VALUE },
    { verification_link: SECRET_VALUE },
    { private_key: SECRET_VALUE },
    { credentials: SECRET_VALUE },
  ];
  for (const extra of cases) {
    const data = { label: 'x', questionIds: [], scope: { nested: { deeper: extra } } };
    await assert.rejects(
      commitRecord(ctx, 'families', 'family-privacy', data, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
      (err) => {
        assert.equal(err.code, 'FORBIDDEN_KEY');
        assert.ok(!err.message.includes(SECRET_VALUE), 'error message must not leak the secret value');
        assert.ok(!JSON.stringify({ ...err }).includes(SECRET_VALUE), 'error details must not leak the secret value');
        return true;
      });
  }
  // Rejected commits leave no trace of the secret anywhere on disk.
  assert.ok(!allStoredBytes().includes(SECRET_VALUE), 'secret value must never reach the ledger');
});

test('top-level secret keys are rejected before any schema guessing', () => {
  assert.throws(
    () => validateRecordData('answers', { questionFamilyId: 'f1', kind: 'draft', authority: 'generated', passwd: SECRET_VALUE }),
    (err) => err instanceof LearningError && err.code === 'FORBIDDEN_KEY');
});

test('question text with the WORD password is data, not a secret key', async () => {
  // Privacy filtering is key-based: observed question text may legitimately
  // mention passwords; the value is text, the key is originalText.
  const envelope = await commitRecord(ctx, 'observations', 'obs-pwd-question', {
    questionId: 'q-pwd-1',
    originalText: 'Create a password for your candidate account',
    fieldType: 'text',
    coverage: 'observed',
    answerDisposition: 'blocked',
  }, { expectedRevision: 0, status: 'recorded', sourceIds: [] });
  assert.equal(envelope.revision, 1);
});

test('ingestion allowlist: only output/, reports/, jds/, data/auto/ are readable', () => {
  for (const ok of [
    'output/apply/app-1/page1.json',
    'reports/2026-10-10/summary.md',
    'jds/company/role.txt',
    'data/auto/jobs/queue.json',
  ]) {
    assert.equal(isIngestiblePath(ok), true, `${ok} should be ingestible`);
  }
  for (const bad of [
    'config/auto.yml',
    'config/credentials.json',
    'auto/prompts/prompt.md',
    '.env',
    '.env.local',
    'data/auto/../../config/credentials.json',
    '/etc/passwd',
    'output/../config/credentials.json',
    'data/auto/mail/inbox.eml',
    'mailbox/message.eml',
    'home/.mcp.json',
    'output/servers.mcp.json',
    '',
    'output',
  ]) {
    assert.equal(isIngestiblePath(bad), false, `${bad || '(empty)'} must NOT be ingestible`);
    assert.throws(() => assertIngestiblePath(bad), (err) => err.code === 'FORBIDDEN_SOURCE');
  }
});

test('forbidden source paths inside allowed roots stay forbidden', () => {
  assert.equal(isIngestiblePath('output/credentials.json'), false);
  assert.equal(isIngestiblePath('reports/prompt.md'), false);
  assert.equal(isIngestiblePath('data/auto/.env.production'), false);
});

test('sourceIds carry references, never free text or secrets', async () => {
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-src', { label: 'x', questionIds: [], scope: {} },
      { expectedRevision: 0, status: 'proposed', sourceIds: ['x'.repeat(129)] }),
    (err) => err.code === 'SCHEMA_VALIDATION');
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-src', { label: 'x', questionIds: [], scope: {} },
      { expectedRevision: 0, status: 'proposed', sourceIds: [''] }),
    (err) => err.code === 'SCHEMA_VALIDATION');
});
