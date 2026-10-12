// auto/test/mail-sync.test.mjs
// Lean tests for auto/mail-sync.mjs (BrowserOS Neo mechanism).
// Uses node:test. All tests use synthetic fixtures; no live browser or mailbox is touched.
// Covers:
//   1. HWM load/save round-trip (first run + subsequent run)
//   2. SeenIds load/save round-trip (dedup persistence + rolling trim)
//   3. isPotentialJobReply: ATS sender domain → true
//   4. isPotentialJobReply: job keyword in subject → true
//   5. isPotentialJobReply: company name match → true
//   6. isPotentialJobReply: short company name (≤4 chars) needs word boundary → no false positive
//   7. isPotentialJobReply: unrelated personal email → false
//   8. buildExtractionPrompt: contains outputPath, sinceDate, userEmail, and read-only instruction
//   9. parseAgentOutput: valid JSON array → messages
//  10. parseAgentOutput: missing file → error
//  11. parseAgentOutput: agent error object → error
//  12. parseAgentOutput: non-array JSON → error
//  13. Message dedup by ID in seen-set
//  14. HWM creates parent directory if missing
//  15. SeenIds rolling trim to SEEN_IDS_MAX

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── env-isolation helper ──────────────────────────────────────────────────────

function makeFixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'career-ops-mail-sync-test-'));
}

// ── Test 1: HWM round-trip ────────────────────────────────────────────────────

test('mail-sync: loadHwm returns null when file is missing', async () => {
  const root = makeFixtureRoot();
  process.env.CAREER_OPS_ROOT = root;

  const { loadHwm } = await import('../mail-sync.mjs');
  assert.equal(loadHwm(), null, 'should return null for missing HWM file');

  delete process.env.CAREER_OPS_ROOT;
});

test('mail-sync: saveHwm and loadHwm round-trip correctly', async () => {
  const root = makeFixtureRoot();
  process.env.CAREER_OPS_ROOT = root;

  const { saveHwm, loadHwm } = await import('../mail-sync.mjs');

  assert.equal(loadHwm(), null);

  saveHwm('2026-08-22');
  assert.equal(loadHwm()?.lastSyncDate, '2026-08-22');

  saveHwm('2026-10-12');
  assert.equal(loadHwm()?.lastSyncDate, '2026-10-12', 'should update to newer date');

  delete process.env.CAREER_OPS_ROOT;
});

// ── Test 2: SeenIds round-trip ────────────────────────────────────────────────

test('mail-sync: loadSeenIds returns empty Set when file is missing', async () => {
  const root = makeFixtureRoot();
  process.env.CAREER_OPS_ROOT = root;

  const { loadSeenIds } = await import('../mail-sync.mjs');
  const ids = loadSeenIds();
  assert.ok(ids instanceof Set);
  assert.equal(ids.size, 0);

  delete process.env.CAREER_OPS_ROOT;
});

test('mail-sync: saveSeenIds and loadSeenIds round-trip with dedup', async () => {
  const root = makeFixtureRoot();
  process.env.CAREER_OPS_ROOT = root;

  const { loadSeenIds, saveSeenIds } = await import('../mail-sync.mjs');

  saveSeenIds(new Set(), ['id-1', 'id-2', 'id-3']);
  const loaded = loadSeenIds();
  assert.ok(loaded.has('id-1'));
  assert.ok(loaded.has('id-2'));
  assert.equal(loaded.size, 3);

  saveSeenIds(loaded, ['id-4', 'id-5']);
  const loaded2 = loadSeenIds();
  assert.equal(loaded2.size, 5);
  assert.ok(loaded2.has('id-4'));

  delete process.env.CAREER_OPS_ROOT;
});

// ── Test 3-7: isPotentialJobReply ─────────────────────────────────────────────

test('mail-sync: isPotentialJobReply true for known ATS sender domain (greenhouse.io)', async () => {
  const { isPotentialJobReply } = await import('../mail-sync.mjs');
  assert.ok(isPotentialJobReply(
    { from: 'noreply@greenhouse.io', subject: 'Update', snippet: '' }, []
  ));
});

test('mail-sync: isPotentialJobReply true for LinkedIn sender', async () => {
  const { isPotentialJobReply } = await import('../mail-sync.mjs');
  assert.ok(isPotentialJobReply(
    { from: 'jobs-noreply@linkedin.com', subject: 'Your application', snippet: '' }, []
  ));
});

test('mail-sync: isPotentialJobReply true for rejection keyword in subject', async () => {
  const { isPotentialJobReply } = await import('../mail-sync.mjs');
  assert.ok(isPotentialJobReply(
    { from: 'hr@somecompany.com', subject: 'Unfortunately we will not be moving forward', snippet: '' }, []
  ));
});

test('mail-sync: isPotentialJobReply true for interview keyword in subject', async () => {
  const { isPotentialJobReply } = await import('../mail-sync.mjs');
  assert.ok(isPotentialJobReply(
    { from: 'recruiter@techcorp.com', subject: 'Interview invitation', snippet: '' }, []
  ));
});

test('mail-sync: isPotentialJobReply true when tracked company name appears in subject', async () => {
  const { isPotentialJobReply } = await import('../mail-sync.mjs');
  assert.ok(isPotentialJobReply(
    { from: 'team@news.example.com', subject: 'OpenAI latest update', snippet: '' },
    ['openai', 'stripe']
  ));
});

test('mail-sync: isPotentialJobReply does NOT false-positive on short company name inside longer word', async () => {
  // "here" (HERE Technologies) must not match inside "there" or "where"
  const { isPotentialJobReply } = await import('../mail-sync.mjs');
  const result = isPotentialJobReply(
    { from: 'friend@gmail.com', subject: 'Dinner Saturday?', snippet: 'Are you free? There is a new restaurant.' },
    ['here']
  );
  assert.ok(!result, '"here" inside "There" should NOT trigger the job filter');
});

test('mail-sync: isPotentialJobReply false for unrelated personal email', async () => {
  const { isPotentialJobReply } = await import('../mail-sync.mjs');
  assert.ok(!isPotentialJobReply(
    { from: 'friend@gmail.com', subject: 'Dinner Saturday?', snippet: 'Hey! Are you free?' },
    ['openai', 'stripe']
  ));
});

// ── Test 8: buildExtractionPrompt ─────────────────────────────────────────────

test('mail-sync: buildExtractionPrompt contains required fields', async () => {
  const { buildExtractionPrompt } = await import('../mail-sync.mjs');
  const outputPath = '/tmp/test-output.json';
  const prompt = buildExtractionPrompt({
    sinceDate: '2026-08-22',
    outputPath,
    cap: 150,
    userEmail: '0xhshah@gmail.com',
  });

  assert.ok(typeof prompt === 'string' && prompt.length > 100, 'prompt should be a non-trivial string');
  assert.ok(prompt.includes(outputPath), 'prompt must include the output file path');
  assert.ok(prompt.includes('2026-08-22'), 'prompt must include the since-date');
  assert.ok(prompt.includes('0xhshah@gmail.com'), 'prompt must include the user email');
  assert.ok(prompt.includes('https://mail.google.com'), 'prompt must reference Gmail URL');
});

test('mail-sync: buildExtractionPrompt contains read-only constraint language', async () => {
  const { buildExtractionPrompt } = await import('../mail-sync.mjs');
  const prompt = buildExtractionPrompt({
    sinceDate: '2026-08-22',
    outputPath: '/tmp/out.json',
    cap: 100,
    userEmail: 'test@example.com',
  });

  // Must include explicit read-only instructions
  assert.ok(
    prompt.toLowerCase().includes('read-only') || prompt.toLowerCase().includes('must not'),
    'prompt must contain read-only constraint language'
  );
  assert.ok(
    prompt.toLowerCase().includes('archive') && prompt.toLowerCase().includes('delete'),
    'prompt must explicitly forbid archive and delete'
  );
  assert.ok(
    prompt.toLowerCase().includes('mark') && (prompt.toLowerCase().includes('read') || prompt.toLowerCase().includes('unread')),
    'prompt must forbid marking messages as read/unread'
  );
});

test('mail-sync: buildExtractionPrompt specifies JSON array output contract', async () => {
  const { buildExtractionPrompt } = await import('../mail-sync.mjs');
  const prompt = buildExtractionPrompt({
    sinceDate: '2026-09-01',
    outputPath: '/tmp/messages.json',
    cap: 50,
    userEmail: 'user@example.com',
  });

  assert.ok(prompt.includes('"id"'), 'prompt must specify id field in output contract');
  assert.ok(prompt.includes('"from"'), 'prompt must specify from field');
  assert.ok(prompt.includes('"subject"'), 'prompt must specify subject field');
  assert.ok(prompt.includes('"date"'), 'prompt must specify date field');
  assert.ok(prompt.includes('"snippet"'), 'prompt must specify snippet field');
});

// ── Test 9-12: parseAgentOutput ───────────────────────────────────────────────

test('mail-sync: parseAgentOutput returns messages for valid JSON array', async () => {
  const { parseAgentOutput } = await import('../mail-sync.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'mail-sync-parse-'));
  const outputPath = join(tmpDir, 'out.json');

  const messages = [
    { id: 'abc123', from: 'noreply@greenhouse.io', subject: 'Update', date: '2026-10-01', snippet: 'We regret...' },
    { id: 'def456', from: 'hr@stripe.com', subject: 'Interview', date: '2026-10-02', snippet: 'We would like...' },
  ];
  writeFileSync(outputPath, JSON.stringify(messages), 'utf-8');

  const { messages: parsed, error } = parseAgentOutput(outputPath);
  assert.equal(error, null, 'should have no error');
  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0].id, 'abc123');
  assert.equal(parsed?.[1].from, 'hr@stripe.com');
});

test('mail-sync: parseAgentOutput returns error when file is missing', async () => {
  const { parseAgentOutput } = await import('../mail-sync.mjs');
  const { messages, error } = parseAgentOutput('/nonexistent/path/out.json');
  assert.equal(messages, null);
  assert.ok(typeof error === 'string' && error.length > 0, 'should return an error string');
  assert.ok(error.includes('did not write') || error.includes('output'), 'error should mention missing file');
});

test('mail-sync: parseAgentOutput returns error for agent error object', async () => {
  const { parseAgentOutput } = await import('../mail-sync.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'mail-sync-parse-err-'));
  const outputPath = join(tmpDir, 'out.json');

  writeFileSync(outputPath, JSON.stringify({ error: 'wrong_account' }), 'utf-8');
  const { messages, error } = parseAgentOutput(outputPath);
  assert.equal(messages, null);
  assert.ok(error?.includes('wrong_account'), 'error should include agent error reason');
});

test('mail-sync: parseAgentOutput returns error for non-array JSON', async () => {
  const { parseAgentOutput } = await import('../mail-sync.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'mail-sync-parse-nonarr-'));
  const outputPath = join(tmpDir, 'out.json');

  writeFileSync(outputPath, JSON.stringify({ messages: [] }), 'utf-8');
  const { messages, error } = parseAgentOutput(outputPath);
  assert.equal(messages, null);
  assert.ok(error?.includes('not a JSON array'), 'should mention non-array');
});

// ── Test 13: Message dedup by ID ──────────────────────────────────────────────

test('mail-sync: message with same ID is not double-processed (seen-set dedup)', async () => {
  const root = makeFixtureRoot();
  process.env.CAREER_OPS_ROOT = root;

  const { loadSeenIds, saveSeenIds } = await import('../mail-sync.mjs');

  // First run: record two message IDs
  const initial = loadSeenIds();
  saveSeenIds(initial, ['thread-abc-123', 'thread-def-456']);

  // Second run: load and verify those IDs are seen
  const loaded = loadSeenIds();
  assert.ok(loaded.has('thread-abc-123'), 'processed ID should be in seen set');
  assert.ok(loaded.has('thread-def-456'), 'processed ID should be in seen set');
  assert.ok(!loaded.has('thread-new-789'), 'new message ID should not be seen yet');

  delete process.env.CAREER_OPS_ROOT;
});

// ── Test 14: HWM creates parent directory ─────────────────────────────────────

test('mail-sync: saveHwm creates parent directory if missing', async () => {
  const root = makeFixtureRoot();
  process.env.CAREER_OPS_ROOT = root;

  const { saveHwm, loadHwm } = await import('../mail-sync.mjs');
  // data/auto/ does not exist yet — saveHwm should create it
  saveHwm('2026-10-12');
  assert.equal(loadHwm()?.lastSyncDate, '2026-10-12');

  delete process.env.CAREER_OPS_ROOT;
});

// ── Test 15: SeenIds rolling trim ─────────────────────────────────────────────

test('mail-sync: saveSeenIds trims to SEEN_IDS_MAX (10000)', async () => {
  const root = makeFixtureRoot();
  process.env.CAREER_OPS_ROOT = root;

  const { loadSeenIds, saveSeenIds } = await import('../mail-sync.mjs');

  const bigArr = [];
  for (let i = 0; i < 10001; i++) bigArr.push(`id-${i}`);
  saveSeenIds(new Set(), bigArr);

  const loaded = loadSeenIds();
  assert.ok(loaded.size <= 10000, `should be trimmed to ≤10000 (got ${loaded.size})`);

  delete process.env.CAREER_OPS_ROOT;
});
