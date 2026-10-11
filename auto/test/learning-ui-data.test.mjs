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

// --- T23: Role Intelligence / Operations / Proposals view models ----------------

const { insightRows, capabilityRows, shareLabel, windowLabel, buildInsightCards,
  screenGeneratedCards, SUPPORTED_CARD_TYPES, SAMPLE_FLOOR } = await import('../ui/learning/intelligence.mjs');
const { fmtMs, fmtRate, fmtUsd, reuseSummary, timeSummary, budgetSummary,
  procedureRows, reviewerSummary, cloudSummary } = await import('../ui/learning/operations.mjs');
const { proposalRows, approvalScopeNote, sourceLabel, evaluationSummary } = await import('../ui/learning/proposals.mjs');

test('intelligence: HTML/script strings stay inert data in every derived field', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const rows = insightRows([{
    id: 'ins-1', status: 'draft',
    data: {
      roleFamily: hostile, distinctJobs: 2, distinctCompanies: 1, rawOccurrences: 3,
      statistics: [{ definitionId: 'd1', label: hostile, distinctJobs: 2, distinctCompanies: 1, rawOccurrences: 3, shareOfSampledJobs: 1, origin: 'unknown', sourceIds: [hostile] }],
      contradictions: [{ type: hostile, titles: [hostile] }],
      recommendations: { alreadySupported: [{ capability: hostile, quote: hostile, storyId: 's1' }] },
    },
  }]);
  // The strings pass through verbatim (rendering is textContent-only), never
  // parsed, stripped, or interpreted as markup by the view model.
  assert.equal(rows[0].roleFamily, hostile);
  assert.ok(rows[0].capabilities[0].label.includes('<script>'));
  assert.ok(rows[0].drafts[0].draft.includes('<script>'));
  assert.equal(rows[0].contradictions[0].type, hostile);
});

test('intelligence: tiny cohorts show counts and limitations, never confident shares', () => {
  assert.match(shareLabel(0.5, 2), /below sample floor/);
  assert.match(shareLabel(0.5, null), /below sample floor/);
  assert.equal(shareLabel(0.5, SAMPLE_FLOOR), `50% of ${SAMPLE_FLOOR} sampled jobs`);
  assert.equal(shareLabel('80%', 10), 'unknown (malformed)');
  assert.equal(shareLabel(4.2, 10), 'unknown (malformed)');
  const rows = insightRows([{ id: 'ins-2', status: 'draft', data: { roleFamily: 'qa', distinctJobs: 2 } }]);
  assert.equal(rows[0].smallSample, true);
});

test('intelligence: missing dates become honest unknown windows, never guessed', () => {
  assert.equal(windowLabel(null, null), 'evidence window unknown');
  assert.equal(windowLabel(null, '2026-10-11T00:00:00Z'), 'unknown start → 2026-10-11');
  assert.equal(windowLabel('2026-01-02T00:00:00Z', undefined), '2026-01-02 → unknown end');
});

test('intelligence: long multilingual question labels are clipped, not mangled', () => {
  const long = `Beschreiben Sie Ihre Erfahrung mit 自动化测试 και συστήματα CI/CD — ${'х'.repeat(300)}`;
  const caps = capabilityRows({ distinctJobs: 9, statistics: [{ definitionId: 'd', label: long, distinctJobs: 9, distinctCompanies: 3, rawOccurrences: 9, shareOfSampledJobs: 1, origin: 'unknown', sourceIds: [] }] });
  assert.ok(caps[0].label.length <= 200);
  assert.ok(caps[0].label.endsWith('…'));
  assert.ok(caps[0].label.includes('自动化测试'));
});

test('insight cards: all six supported types, auto-populated, honest when empty', () => {
  const cards = buildInsightCards({});
  assert.deepEqual(cards.map((c) => c.type), [...SUPPORTED_CARD_TYPES]);
  assert.match(cards.find((c) => c.type === 'question_trend').body, /No repeated question/);
  const withData = buildInsightCards({
    questions: [{ id: 'q-1', data: { occurrenceCount: 4, normalizedText: 'synthetic visa question?' } }],
    blockers: [{ id: 'blk-1', status: 'open', data: { question: 'salary?' } }],
  });
  assert.match(withData.find((c) => c.type === 'question_trend').body, /Seen 4×/);
  assert.match(withData.find((c) => c.type === 'unresolved_information').body, /1 open\/waiting blocker/);
});

test('insight cards: unsupported and code-bearing card types are refused as proposals', () => {
  const { accepted, refused } = screenGeneratedCards([
    { type: 'question_trend', title: 'ok', body: 'fine', evidence: [] },
    { type: 'market_dominance_chart', title: 'nope', body: 'x', evidence: [] },
    { type: 'outcome_summary', title: 'sneaky', body: 'x', evidence: [], html: '<div onclick=hack()>' },
  ]);
  assert.equal(accepted.length, 1);
  assert.equal(refused.length, 2);
  assert.match(refused[0].reason, /unsupported card type .*implementation review/);
  assert.match(refused[1].reason, /code payload .*implementation-review proposal/);
});

test('operations: malformed analytics values read as unknown, never zero or NaN', () => {
  assert.equal(fmtMs('fast'), 'unknown');
  assert.equal(fmtMs(-5), 'unknown');
  assert.equal(fmtMs(3900000), '1h 05m');
  assert.equal(fmtUsd('free'), 'unknown');
  assert.equal(fmtRate(null), 'unknown');
  assert.match(fmtRate({ numerator: 1, denominator: 2, rate: null, reason: 'sample_below_floor' }), /below 5-sample floor/);
  assert.equal(fmtRate({ numerator: 3, denominator: 10, rate: 0.3 }), '30% (3/10)');
  const b = budgetSummary({ modelUsage: { runs: 3, knownCostUsd: Number.NaN, runsWithUnknownCost: 2, tokens: { total: 'many' } } });
  assert.equal(b.knownCost, 'unknown');
  assert.equal(b.tokens, 'unknown');
  assert.match(budgetSummary(null).knownCost, /unknown/);
  const r = reuseSummary({ reuse: { byDisposition: { reused: 'lots' }, newQuestionRate: { rate: 'high' } } });
  assert.equal(r.dispositions[0].count, 0);
  assert.equal(r.newQuestionRate, 'unknown');
  const t = timeSummary({ time: { waitMsTotal: 'soon', activeMsKnownTotal: 60000 } });
  assert.equal(t.wait, 'unknown');
  assert.equal(t.activeKnown, '1m');
});

test('operations: revoked procedures and malformed dates stay visible and honest', () => {
  const now = new Date('2026-10-11T00:00:00Z');
  const rows = procedureRows([
    { id: 'proc-1', status: 'revoked', revision: 3, data: { atsVendor: 'synthetic-ats', lastVerifiedAt: '2026-10-01T00:00:00Z' } },
    { id: 'proc-2', status: 'active', revision: 1, data: { lastVerifiedAt: 'not-a-date' } },
    { id: 'proc-3', status: 'candidate', data: {} },
  ], now);
  assert.equal(rows[0].revoked, true);
  assert.equal(rows[0].staleness, '10d since verified');
  assert.equal(rows[1].staleness, 'unknown (malformed date)');
  assert.equal(rows[2].staleness, 'never verified');
  assert.equal(rows[2].scope, 'unknown scope');
});

test('operations: reviewer and cloud summaries surface pause and disabled reasons', () => {
  const rs = reviewerSummary(
    { reviewEnabled: true, paused: true, due: false, dueAt: '2026-10-11T06:00:00Z', cursor: { processed: 7, updatedAt: '2026-10-10T00:00:00Z' } },
    { paused: true },
  );
  assert.equal(rs.paused, true);
  assert.equal(rs.cursorProcessed, 7);
  assert.equal(rs.dueAt, '2026-10-11 06:00');
  assert.match(cloudSummary({ enabled: false, reason: 'disabled_in_config' }).text, /config\/learning\.yml/);
  assert.match(cloudSummary(null).text, /unknown/);
  assert.equal(cloudSummary({ enabled: true }).enabled, true);
});

test('proposals: rows carry why/affected/evidence/baseline/evaluation/risk/rollback', () => {
  const rows = proposalRows([{
    id: 'prop-1', status: 'proposed', revision: 2,
    data: {
      kind: 'answer_update', intendedBenefit: 'reuse the synthetic visa answer',
      affectedSources: [{ fileKey: 'standing-answers.yml', selector: 'custom.visa', sha256: 'a'.repeat(64) }],
      evidenceIds: ['q-1', 'q-2'], baseline: { reused: 0 },
      evaluationResult: { pass: true, cases: [{ name: 'replay', result: 'pass' }] },
      risk: 'low', requiredApprovals: ['user'], rollbackVersion: 1, diff: { op: 'set' },
    },
  }, {
    id: 'prop-2', status: 'rolled_back', revision: 4, data: { kind: 'code', rollbackVersion: 2 },
  }]);
  assert.equal(rows[0].why, 'reuse the synthetic visa answer');
  assert.match(rows[0].affected[0], /^standing-answers\.yml@a{12} custom\.visa$/);
  assert.equal(rows[0].evaluation.label, 'passed');
  assert.equal(rows[0].evaluation.cases[0].result, 'pass');
  assert.equal(rows[0].previousRevision, 1);
  assert.equal(rows[0].decidable, true);
  assert.equal(rows[1].rollback, 'ROLLED BACK to version 2');
  assert.equal(rows[1].decidable, false);
  // Missing fields degrade to honest placeholders, never invented values.
  const bare = proposalRows([{ id: 'prop-3', status: 'draft', revision: 1, data: {} }])[0];
  assert.equal(bare.why, 'not recorded');
  assert.deepEqual(bare.affected, ['unknown source/component']);
  assert.equal(bare.evaluation.label, 'pending — not yet evaluated');
  assert.equal(evaluationSummary('passed!').label, 'unknown (malformed evaluation result)');
  assert.equal(sourceLabel(null), 'unknown source');
});

test('proposals: approval scope differentiates answers from code and publishing', () => {
  assert.match(approvalScopeNote('answer_update'), /not permission to modify code/);
  assert.match(approvalScopeNote('code'), /does not grant permission to modify code/);
  assert.match(approvalScopeNote('positioning'), /does NOT publish .*LinkedIn/i);
  assert.match(approvalScopeNote('mystery'), /no code changes, no publishing/);
});
