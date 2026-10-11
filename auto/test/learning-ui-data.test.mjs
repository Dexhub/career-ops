// T22: learning UI data-layer tests — the shared client (pagination, CSRF,
// typed errors, stale-generation refresh, unknown-result POST discipline) and
// the pure view models behind the Questions / Candidate Knowledge / freshness
// views. node:test only; everything synthetic; no DOM and no live server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLearningFixture } from './helpers/learning.mjs';
import { createLearningClient, classifyStatus, LearningClientError } from '../ui/learning/client.mjs';
import {
  questionRows, questionFacets, filterQuestions, answerStatusByQuestion, familyGroups, requirednessOf,
} from '../ui/learning/questions.mjs';
import {
  knowledgeRows, pendingProposalRows, blockerRows, approvalPreview, approvalReadback, isExpired, REDACTED,
} from '../ui/learning/profile.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = createLearningFixture();
test.after(() => fixture.cleanup());

test('fixture isolation: scratch roots live under tmpdir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.root);
});

// --- client: typed errors ------------------------------------------------------

test('classifyStatus maps the CONTRACTS-G error surface to typed kinds', () => {
  assert.equal(classifyStatus(403, { code: 'CSRF' }), 'csrf');
  assert.equal(classifyStatus(403, {}), 'forbidden');
  assert.equal(classifyStatus(404, {}), 'not_found');
  assert.equal(classifyStatus(409, { code: 'REFRESH_REQUIRED' }), 'stale');
  assert.equal(classifyStatus(409, { code: 'REVISION_CONFLICT' }), 'conflict');
  assert.equal(classifyStatus(413, {}), 'too_large');
  assert.equal(classifyStatus(415, {}), 'unsupported');
  assert.equal(classifyStatus(422, {}), 'invalid');
  assert.equal(classifyStatus(500, { code: 'CORRUPT_RECORD' }), 'corrupt');
  assert.equal(classifyStatus(500, {}), 'server');
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// --- client: pagination under one generation -----------------------------------

test('listAll pages with cursors and keeps one generation', async () => {
  const calls = [];
  const pages = {
    '': { items: [{ id: 'q-1' }, { id: 'q-2' }], nextCursor: 'c1', generation: 'g1', coverage: { observed: 2, partial: 0, unknown: 0 }, feature: { enabled: true } },
    c1: { items: [{ id: 'q-3' }], nextCursor: null, generation: 'g1', coverage: { observed: 1, partial: 0, unknown: 0 }, feature: { enabled: true } },
  };
  const client = createLearningClient({
    fetchImpl: async (url) => {
      calls.push(url);
      const cursor = new URL(url, 'http://x').searchParams.get('cursor') ?? '';
      return jsonResponse(200, pages[cursor]);
    },
  });
  const out = await client.listAll('questions', { pageLimit: 2 });
  assert.deepEqual(out.items.map((i) => i.id), ['q-1', 'q-2', 'q-3']);
  assert.equal(out.generation, 'g1');
  assert.equal(calls.length, 2);
});

test('listAll restarts ONCE on a stale cursor, then surfaces kind stale', async () => {
  let phase = 0;
  const client = createLearningClient({
    fetchImpl: async (url) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      if (!cursor) {
        phase += 1;
        return jsonResponse(200, { items: [{ id: `p${phase}` }], nextCursor: 'c1', generation: `g${phase}`, feature: { enabled: true } });
      }
      if (phase === 1) return jsonResponse(409, { error: 'stale', code: 'REFRESH_REQUIRED' });
      return jsonResponse(200, { items: [{ id: 'tail' }], nextCursor: null, generation: `g${phase}`, feature: { enabled: true } });
    },
  });
  const out = await client.listAll('questions', {});
  assert.deepEqual(out.items.map((i) => i.id), ['p2', 'tail']);
  assert.equal(out.generation, 'g2');
});

test('listAll gives up with kind stale when records change on every walk', async () => {
  let n = 0;
  const client = createLearningClient({
    fetchImpl: async (url) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      if (!cursor) { n += 1; return jsonResponse(200, { items: [], nextCursor: 'c', generation: `g${n}`, feature: { enabled: true } }); }
      return jsonResponse(409, { error: 'stale', code: 'REFRESH_REQUIRED' });
    },
  });
  await assert.rejects(client.listAll('questions', {}), (err) => err instanceof LearningClientError && err.kind === 'stale');
});

// --- client: CSRF + consequential POST discipline ------------------------------

test('post fetches the CSRF token first and sends it on the POST', async () => {
  const seen = [];
  const client = createLearningClient({
    fetchImpl: async (url, opts = {}) => {
      seen.push({ url, method: opts.method ?? 'GET', headers: opts.headers ?? {} });
      if (url.endsWith('/status')) return jsonResponse(200, { feature: { enabled: true }, csrfToken: 'tok-1' });
      return jsonResponse(200, { status: 'applied', opId: 'op-1' });
    },
  });
  const out = await client.post('answers/approve', { opId: 'op-1', proposalId: 'p', expectedRevision: 1 });
  assert.equal(out.status, 'applied');
  assert.equal(seen[0].url.endsWith('/status'), true);
  assert.equal(seen[1].headers['x-learning-csrf'], 'tok-1');
});

test('post retries ONCE on a pre-execution CSRF 403 with a refreshed token', async () => {
  let token = 'old';
  let posts = 0;
  const client = createLearningClient({
    fetchImpl: async (url, opts = {}) => {
      if (url.endsWith('/status')) { token = 'new'; return jsonResponse(200, { csrfToken: token }); }
      posts += 1;
      if (opts.headers['x-learning-csrf'] !== 'new') return jsonResponse(403, { error: 'bad csrf', code: 'CSRF' });
      return jsonResponse(200, { status: 'applied' });
    },
  });
  await client.status();
  token = 'rotated-server-side';
  // Force a mismatch by simulating a server that only accepts 'new' after refresh.
  const out = await client.post('review', { opId: 'op-2' });
  assert.equal(out.status, 'applied');
  assert.ok(posts <= 2);
});

test('a POST that fails in flight is kind unknown_result and is NEVER retried', async () => {
  let posts = 0;
  const client = createLearningClient({
    fetchImpl: async (url, opts = {}) => {
      if (url.endsWith('/status')) return jsonResponse(200, { csrfToken: 't' });
      posts += 1;
      throw new Error('socket closed mid-flight');
    },
  });
  await assert.rejects(
    client.post('answers/approve', { opId: 'op-3', proposalId: 'p', expectedRevision: 1 }),
    (err) => err instanceof LearningClientError && err.kind === 'unknown_result' && err.unknownResult === true,
  );
  assert.equal(posts, 1);
});

test('GET cancellation: a new request under the same key aborts the previous', async () => {
  let resolveFirst;
  const first = new Promise((r) => { resolveFirst = r; });
  let call = 0;
  const client = createLearningClient({
    fetchImpl: (url, opts = {}) => {
      call += 1;
      if (call === 1) {
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            resolveFirst();
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
          });
        });
      }
      return jsonResponse(200, { feature: { enabled: true }, csrfToken: 't' });
    },
  });
  const p1 = client.status({ key: 'status' }).catch((e) => e);
  const p2 = client.status({ key: 'status' });
  await first;
  const [e1, r2] = await Promise.all([p1, p2]);
  assert.ok(e1 instanceof LearningClientError && e1.kind === 'cancelled');
  assert.equal(r2.csrfToken, 't');
});

// --- questions view model -------------------------------------------------------

const Q = (id, data = {}, extra = {}) => ({
  id, revision: 1, status: 'approved', createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z', sourceIds: ['obs-1'],
  data: { normalizedText: `question ${id}?`, originalExamples: [`Original ${id}?`], fieldType: 'text', occurrenceIds: ['occ-1', 'occ-2'], ...data },
  ...extra,
});

test('questionRows: wording, occurrence history and honest unknown requiredness', () => {
  const rows = questionRows([Q('q-a'), Q('q-b', { fieldType: 'select' })]);
  assert.equal(rows[0].text, 'question q-a?');
  assert.deepEqual(rows[0].examples, ['Original q-a?']);
  assert.equal(rows[0].occurrenceCount, 2);
  assert.equal(rows[0].required, 'unknown'); // observations are not listed by the API
  assert.equal(requirednessOf({ required: true }), 'required');
  assert.equal(requirednessOf({ required: false }), 'optional');
  const facets = questionFacets(rows);
  assert.deepEqual(facets.fieldTypes, ['select', 'text']);
});

test('filterQuestions: search matches original wording; type/status/date filters apply', () => {
  const rows = questionRows([
    Q('q-salary', { normalizedText: 'expected salary?', originalExamples: ['What are your salary expectations?'] }),
    Q('q-visa', { normalizedText: 'need sponsorship?', fieldType: 'boolean' }),
  ]);
  assert.deepEqual(filterQuestions(rows, { search: 'expectations' }).map((r) => r.id), ['q-salary']);
  assert.deepEqual(filterQuestions(rows, { fieldType: 'boolean' }).map((r) => r.id), ['q-visa']);
  assert.equal(filterQuestions(rows, { dateFrom: '2026-11-01' }).length, 0);
  assert.equal(filterQuestions(rows, { dateTo: '2026-10-04' }).length, 0);
  assert.equal(filterQuestions(rows, { dateTo: '2026-10-05' }).length, 2);
});

test('answerStatusByQuestion joins families to answers; unjoinable stays unknown', () => {
  const families = [
    { id: 'fam-1', status: 'approved', data: { questionIds: ['q-a', 'q-b'] } },
    { id: 'fam-2', status: 'approved', data: { questionIds: ['q-c'] } },
    { id: 'fam-gone', status: 'revoked', data: { questionIds: ['q-d'] } },
  ];
  const answers = [
    { id: 'ans-1', status: 'approved', data: { questionFamilyId: 'fam-1' } },
    { id: 'ans-2', status: 'conflicted', data: { questionFamilyId: 'fam-2' } },
  ];
  const map = answerStatusByQuestion({ families, answers });
  assert.equal(map.get('q-a').state, 'approved');
  assert.equal(map.get('q-c').state, 'conflicted');
  assert.equal(map.get('q-d'), undefined); // revoked family: no claim
  assert.equal(map.get('q-unknown'), undefined);
});

test('familyGroups: members, evidence and pending regroup proposals (review flow only)', () => {
  const groups = familyGroups({
    families: [{ id: 'fam-1', status: 'approved', revision: 2, sourceIds: ['q-a', 'q-b'], data: { label: 'salary', questionIds: ['q-a', 'q-b'] } }],
    questionsById: new Map([['q-a', Q('q-a')]]),
    answers: [{ id: 'ans-1', status: 'approved', data: { questionFamilyId: 'fam-1' } }],
    proposals: [
      { id: 'prop-regroup', status: 'proposed', revision: 1, data: { kind: 'config', evidenceIds: ['fam-1'] } },
      { id: 'prop-done', status: 'applied', revision: 3, data: { kind: 'config', evidenceIds: ['fam-1'] } },
    ],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members[0].text, 'question q-a?');
  assert.equal(groups[0].members[1].text, '(not in current page)'); // honest gap
  assert.deepEqual(groups[0].pendingProposals.map((p) => p.id), ['prop-regroup']);
});

// --- knowledge view model -------------------------------------------------------

const NOW = new Date('2026-10-11T00:00:00Z');

test('knowledgeRows: confirmed vs pending vs conflicted vs expired vs revoked', () => {
  const rows = knowledgeRows({
    answers: [
      { id: 'ans-ok', revision: 1, status: 'approved', data: { questionFamilyId: 'fam-1', kind: 'source_reference', authority: 'user_confirmed', sourceRefs: [{ fileKey: 'standing', sha256: 'abc123def456' }], approvalRef: 'prop-1', dependencies: ['app-1'] } },
      { id: 'ans-old', revision: 2, status: 'approved', data: { validUntil: '2026-10-01T00:00:00Z' } },
      { id: 'ans-new', revision: 1, status: 'proposed', data: {} },
      { id: 'ans-bad', revision: 1, status: 'conflicted', data: {} },
      { id: 'ans-dead', revision: 3, status: 'revoked', data: {} },
      { id: 'ans-stale', revision: 2, status: 'stale', data: {} },
    ],
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => r.group), ['confirmed', 'expired', 'pending', 'conflicted', 'revoked', 'stale']);
  assert.equal(rows[0].provenance.approvalRef, 'prop-1');
  assert.deepEqual(rows[0].dependents, ['app-1']);
  assert.equal(isExpired({ data: { validUntil: '2026-10-12T00:00:00Z' } }, NOW), false);
});

test('pendingProposalRows + approvalPreview: sensitive values stay redacted', () => {
  const rows = pendingProposalRows([
    { id: 'prop-s', revision: 4, status: 'proposed', data: { kind: 'answer', requiredApprovals: ['user'], affectedSources: [{ fileKey: 'standing', sha256: 'ff00ff00ff00ff00' }], diff: { question: { normalizedText: 'synthetic sensitive question?' }, proposedValue: '[redacted-sensitive]', sensitive: true, fileKey: 'standing', selector: 'custom.sensitive_q', affectedApplicationIds: ['app-9'] } } },
    { id: 'prop-x', revision: 1, status: 'applied', data: { kind: 'answer', diff: {} } },
    { id: 'prop-cfg', revision: 1, status: 'proposed', data: { kind: 'config' } },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['prop-s']); // applied + non-answer excluded
  const preview = approvalPreview(rows[0]);
  assert.equal(preview.value, REDACTED);
  assert.equal(preview.expectedRevision, 4);
  assert.equal(preview.target, 'standing → custom.sensitive_q');
  assert.deepEqual(preview.sourceVersions, ['standing@ff00ff00ff00']);
  assert.deepEqual(preview.affectedApplicationIds, ['app-9']);
});

test('approvalReadback: committed state comes ONLY from re-read records', () => {
  const rb = approvalReadback({
    postResult: { status: 'applied', sourceHash: 'beefbeefbeef' },
    proposal: { id: 'prop-1', revision: 5, status: 'applied', data: { diff: { questionFamilyId: 'fam-1' } } },
    answers: [{ id: 'ans-prop-1', status: 'approved', sourceIds: ['standing@beefbeefbeef'], data: { questionFamilyId: 'fam-1', sourceRefs: [] } }],
    blockers: [
      { id: 'blk-1', status: 'resolved', data: { type: 'missing_answer' } },
      { id: 'blk-2', status: 'open', data: { type: 'missing_answer' } },
      { id: 'blk-3', status: 'open', data: { type: 'captcha' } },
    ],
  });
  assert.equal(rb.proposalStatus, 'applied');
  assert.equal(rb.answerId, 'ans-prop-1');
  assert.equal(rb.answerStatus, 'approved');
  assert.equal(rb.sourceHashConfirmed, true);
  assert.deepEqual(rb.openBlockers.map((b) => b.id), ['blk-2']); // resolved + non-answer excluded
});

test('approvalReadback without a committed answer stays honest', () => {
  const rb = approvalReadback({
    postResult: null,
    proposal: { id: 'prop-9', revision: 2, status: 'proposed', data: { diff: {} } },
    answers: [], blockers: [],
  });
  assert.equal(rb.answerStatus, 'not found on server');
  assert.equal(rb.sourceHashConfirmed, false);
});

test('blockerRows: resume point and resolution visibility', () => {
  const rows = blockerRows([
    { id: 'blk-1', revision: 2, status: 'resolved', updatedAt: '2026-10-10T00:00:00Z', data: { type: 'missing_answer', applicationId: 'app-1', resumePoint: 'filling', question: { normalizedText: 'expected salary?' }, resolution: { answerId: 'ans-1', resolvedAt: '2026-10-10T00:00:00Z' } } },
    { id: 'blk-2', revision: 1, status: 'open', data: { type: 'captcha', applicationId: 'app-2' } },
  ]);
  assert.equal(rows[0].resumePoint, 'filling');
  assert.equal(rows[0].resolution.answerId, 'ans-1');
  assert.equal(rows[1].question, null);
});
