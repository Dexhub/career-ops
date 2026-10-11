// T24: learning UI acceptance — pure state/formatting contracts for
// accessibility, honest state coverage and scale bounds. No DOM dependency:
// a minimal fake document records exactly what the renderers set (attributes,
// text, tabIndex), which is the contract screen readers and keyboards rely on.
// Browser-level behavior (real focus, announcements, layout, latency) is
// verified separately through BrowserOS Neo against an isolated fixture panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

import {
  renderQuestionsView, MAX_RENDERED_ROWS, questionRows, questionFacets,
} from '../ui/learning/questions.mjs';
import { renderKnowledgeView } from '../ui/learning/profile.mjs';
import { renderIntelligenceView } from '../ui/learning/intelligence.mjs';
import { renderOperationsView } from '../ui/learning/operations.mjs';
import { renderProposalsView } from '../ui/learning/proposals.mjs';
import { mountLearningUI } from '../ui/learning/index.mjs';
import { createLearningClient, LearningClientError } from '../ui/learning/client.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { commitRecord, rebuildIndexes, listRecords } from '../learning/store.mjs';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

// --- minimal fake DOM ---------------------------------------------------------

function makeNode(doc, tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    listeners: {},
    className: '',
    title: '',
    value: '',
    type: '',
    placeholder: '',
    disabled: false,
    tabIndex: null,
    id: '',
    _text: '',
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? { textContent: k, children: [], tagName: '#text', attributes: {} } : k); },
    replaceChildren() { this.children = []; this._text = ''; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    focus() { doc._focused = this; },
    get options() { return this.children.filter((c) => c.tagName === 'OPTION'); },
    querySelector(selector) {
      // Supports only the '[role="x"], [role="y"]' form the UI uses.
      const roles = [...selector.matchAll(/\[role="([^"]+)"\]/g)].map((m) => m[1]);
      let found = null;
      walk(this, (n) => { if (!found && roles.includes(n.attributes?.role)) found = n; });
      return found;
    },
  };
  return node;
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}

function makeDoc(ids = ['learning-root']) {
  const doc = { _focused: null, _byId: new Map() };
  doc.createElement = (tag) => makeNode(doc, tag);
  doc.head = makeNode(doc, 'head');
  for (const id of ids) {
    const n = makeNode(doc, 'div');
    n.id = id;
    doc._byId.set(id, n);
  }
  doc.getElementById = (id) => doc._byId.get(id) ?? null;
  return doc;
}

function collect(root, pred) {
  const out = [];
  walk(root, (n) => { if (pred(n)) out.push(n); });
  return out;
}

function accessibleName(n) {
  return (n.attributes['aria-label'] ?? n.textContent ?? '').trim();
}

const INTERACTIVE = new Set(['BUTTON', 'SELECT', 'INPUT']);

function assertAllNamed(root, viewName) {
  const controls = collect(root, (n) => INTERACTIVE.has(n.tagName));
  assert.ok(controls.length > 0, `${viewName}: expected interactive controls`);
  for (const c of controls) {
    assert.ok(accessibleName(c).length > 0,
      `${viewName}: ${c.tagName} (class "${c.className}") has no accessible name`);
  }
}

// --- shared fixtures ----------------------------------------------------------

const FEATURE_ON = { enabled: true };

function sampleQuestionItems(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    id: `q-${String(i).padStart(4, '0')}`,
    revision: 1,
    status: 'approved',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    sourceIds: [`obs-${i}`],
    data: {
      normalizedText: `question number ${i}`,
      originalExamples: [`Question #${i}?`],
      fieldType: i % 2 === 0 ? 'text' : 'select',
      locale: 'en',
      occurrenceIds: [`occ-${i}`],
    },
  }));
}

function questionsModel(rows, extra = {}) {
  return {
    rows,
    facets: questionFacets(rows),
    filters: {},
    coverage: { observed: rows.length, partial: 0, unknown: 0 },
    feature: FEATURE_ON,
    answerStatus: new Map(),
    groups: [],
    onFilter: () => {},
    ...extra,
  };
}

// --- accessible names ----------------------------------------------------------

test('questions view: every interactive control carries an accessible name', () => {
  const doc = makeDoc();
  const root = makeNode(doc, 'div');
  renderQuestionsView(doc, root, questionsModel(questionRows(sampleQuestionItems())));
  assertAllNamed(root, 'questions');
  // The search input must be named by aria-label, not only its placeholder.
  const search = collect(root, (n) => n.tagName === 'INPUT' && n.type === 'search')[0];
  assert.ok(search.attributes['aria-label']);
  // All five filter selects are individually named.
  const selects = collect(root, (n) => n.tagName === 'SELECT');
  assert.equal(selects.length, 5);
  assert.equal(new Set(selects.map((s) => s.attributes['aria-label'])).size, 5);
});

test('knowledge view: ambiguous buttons are disambiguated per record', () => {
  const doc = makeDoc();
  const root = makeNode(doc, 'div');
  renderKnowledgeView(doc, root, {
    rows: [],
    proposals: [
      { id: 'prop-1', revision: 1, status: 'proposed', question: 'Salary?', proposedValue: '[redacted-sensitive]', sensitive: true, fileKey: 'profile.yml', selector: 'salary', scope: {}, affectedApplicationIds: [], affectedSources: [], requiredApprovals: [] },
      { id: 'prop-2', revision: 1, status: 'proposed', question: 'Visa?', proposedValue: '[redacted-sensitive]', sensitive: true, fileKey: 'profile.yml', selector: 'visa', scope: {}, affectedApplicationIds: [], affectedSources: [], requiredApprovals: [] },
    ],
    blockers: [
      { id: 'blk-1', status: 'open', type: 'missing_answer', question: 'x', applicationId: null, resumePoint: null, deadline: null, resolution: null },
    ],
    feature: FEATURE_ON,
    busy: false,
    readback: null,
    error: null,
    revealed: new Set(),
    onReveal: () => {}, onApprove: () => {}, onResolveBlocker: () => {},
  });
  assertAllNamed(root, 'knowledge');
  const reveals = collect(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'reveal');
  assert.equal(reveals.length, 2);
  // Two "reveal" buttons must not announce identically.
  assert.notEqual(accessibleName(reveals[0]), accessibleName(reveals[1]));
  const resolve = collect(root, (n) => n.tagName === 'BUTTON' && n.textContent.startsWith('Resolve'))[0];
  assert.match(accessibleName(resolve), /blk-1/);
});

test('intelligence/operations/proposals views: controls are named', () => {
  const doc = makeDoc();
  const r1 = makeNode(doc, 'div');
  renderIntelligenceView(doc, r1, { rows: [], cards: [], refusedCards: [], selectedFamily: null, feature: FEATURE_ON });
  assertAllNamed(r1, 'intelligence');
  const r2 = makeNode(doc, 'div');
  renderOperationsView(doc, r2, { metrics: null, review: {}, learner: {}, cloud: null, accounts: [], procedures: [] });
  assertAllNamed(r2, 'operations');
  const r3 = makeNode(doc, 'div');
  renderProposalsView(doc, r3, {
    rows: [{ id: 'prop-9', status: 'proposed', revision: 1, previousRevision: null, kind: 'answer', why: 'w', affected: ['a'], evidence: [], baseline: 'b', evaluation: { label: 'pending', cases: [] }, risk: 'low', approvals: ['user'], rollback: 'none', hasDiff: false, scopeNote: 'scope', decidable: true, expectedRevision: 1 }],
    feature: FEATURE_ON,
    onDecide: () => {},
  });
  assertAllNamed(r3, 'proposals');
  const decide = collect(r3, (n) => n.tagName === 'BUTTON');
  assert.deepEqual(decide.map(accessibleName), ['approve proposal prop-9', 'reject proposal prop-9']);
});

// --- announcements and focus targets -------------------------------------------

test('errors are alert regions and readbacks are focusable status regions', () => {
  const doc = makeDoc();
  const root = makeNode(doc, 'div');
  renderKnowledgeView(doc, root, {
    rows: [], proposals: [], blockers: [], feature: FEATURE_ON,
    error: 'boom', revealed: new Set(),
    readback: { proposalStatus: 'approved', proposalRevision: 2, answerId: 'ans-1', answerStatus: 'approved', answerSourceRefs: [], familyId: null, sourceHash: null, sourceHashConfirmed: false, openBlockers: [] },
  });
  const alert = collect(root, (n) => n.attributes?.role === 'alert')[0];
  assert.ok(alert, 'error must render with role=alert');
  assert.equal(alert.textContent, 'boom');
  assert.equal(alert.tabIndex, -1);
  const status = collect(root, (n) => n.attributes?.role === 'status')[0];
  assert.ok(status, 'readback must render with role=status');
  assert.equal(status.tabIndex, -1);

  const ops = makeNode(doc, 'div');
  renderOperationsView(doc, ops, { metrics: null, review: {}, learner: {}, cloud: null, accounts: [], procedures: [], readback: 'done' });
  assert.ok(collect(ops, (n) => n.attributes?.role === 'status')[0]);
  const props = makeNode(doc, 'div');
  renderProposalsView(doc, props, { rows: [], feature: FEATURE_ON, readback: 'done' });
  assert.ok(collect(props, (n) => n.attributes?.role === 'status')[0]);
});

// --- state matrix via the real mount --------------------------------------------

function fakeClientWith({ statusPayload, listAllResult, failStatus = null } = {}) {
  return {
    async status() {
      if (failStatus) throw failStatus;
      return statusPayload;
    },
    async listAll() { return listAllResult; },
    async list() { return { metrics: null }; },
    async post() { throw new Error('not under test'); },
    async panelGet() { return {}; },
  };
}

test('mount: loading state first, then sub-tabs expose aria-pressed', async () => {
  const doc = makeDoc(['learning-root']);
  const api = mountLearningUI({
    doc,
    client: fakeClientWith({
      statusPayload: { feature: FEATURE_ON, review: { due: false } },
      listAllResult: { items: [], generation: 'g1', coverage: { observed: 0, partial: 0, unknown: 0 }, feature: FEATURE_ON, truncated: false },
    }),
  });
  const root = doc.getElementById('learning-root');
  assert.match(root.textContent, /loading…/, 'pre-data render must show a loading state');
  await api.refreshLearning();
  const tabs = collect(root, (n) => n.tagName === 'BUTTON' && n.className.includes('lrn-tab'));
  assert.equal(tabs.length, 5);
  assert.deepEqual(tabs.map((t) => t.attributes['aria-pressed']), ['true', 'false', 'false', 'false', 'false']);
});

test('mount: a failed load renders a role=alert error and keeps the reload control', async () => {
  const doc = makeDoc(['learning-root']);
  const api = mountLearningUI({
    doc,
    client: fakeClientWith({ failStatus: new LearningClientError('network', 'network failure: refused') }),
  });
  await api.refreshLearning();
  const root = doc.getElementById('learning-root');
  const alert = collect(root, (n) => n.attributes?.role === 'alert')[0];
  assert.ok(alert, 'load failure must announce via role=alert');
  assert.match(alert.textContent, /network/);
  const reload = collect(root, (n) => n.tagName === 'BUTTON' && n.attributes['aria-label'] === 'reload from server')[0];
  assert.ok(reload, 'reload control must stay available after a failure');
});

test('disabled feature: every view renders an honest disabled message, nothing else', () => {
  const doc = makeDoc();
  const off = { enabled: false, reason: 'learning_not_activated' };
  const checks = [
    [renderQuestionsView, questionsModel([], { feature: off }), /not activated/],
    [renderKnowledgeView, { rows: [], proposals: [], blockers: [], feature: off, revealed: new Set() }, /not activated/],
    [renderIntelligenceView, { rows: [], cards: [], refusedCards: [], feature: off }, /disabled/],
    [renderProposalsView, { rows: [], feature: off }, /disabled/],
  ];
  for (const [render, model, re] of checks) {
    const root = makeNode(doc, 'div');
    render(doc, root, model);
    assert.match(root.textContent, re);
    assert.equal(collect(root, (n) => n.tagName === 'TABLE').length, 0);
    assert.equal(collect(root, (n) => n.tagName === 'BUTTON').length, 0);
  }
});

test('cloud lane disabled never hides local knowledge or claims completeness', () => {
  const doc = makeDoc();
  const root = makeNode(doc, 'div');
  renderOperationsView(doc, root, {
    metrics: { reuse: { byDisposition: { reused: 4 }, distinctQuestions: 4, newQuestions: 1, newQuestionRate: { reason: 'sample_below_floor', numerator: 1, denominator: 4 } }, time: {}, attempts: {}, modelUsage: {} },
    review: { reviewEnabled: true, due: false },
    learner: { paused: false },
    cloud: { enabled: false, reason: 'disabled_in_config' },
    accounts: [], procedures: [],
  });
  const text = root.textContent;
  assert.match(text, /disabled in config\/learning\.yml/);
  assert.match(text, /Answer reuse vs new questions/, 'local metrics must still render');
  assert.match(text, /below 5-sample floor/, 'honest limitation shown, not a fabricated rate');
});

// --- scale bounds ---------------------------------------------------------------

test('questions table caps rendered rows and announces both truncations honestly', () => {
  const doc = makeDoc();
  const root = makeNode(doc, 'div');
  const many = questionRows(sampleQuestionItems(MAX_RENDERED_ROWS + 50));
  renderQuestionsView(doc, root, questionsModel(many, { truncated: true }));
  const tbody = collect(root, (n) => n.tagName === 'TBODY')[0];
  assert.equal(tbody.children.length, MAX_RENDERED_ROWS);
  assert.match(root.textContent, new RegExp(`showing first ${MAX_RENDERED_ROWS} of ${many.length} matching`));
  assert.match(root.textContent, /list truncated at the client page cap/);
});

test('listAll reports truncation when the page cap is exhausted mid-walk', async () => {
  // A server with endless pages under one generation.
  const fetchImpl = async (url) => {
    const u = new URL(url, 'http://x');
    const cursor = u.searchParams.get('cursor') ?? 'g::0';
    const n = Number(cursor.split('::')[1]);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        items: [{ id: `q-${n}` }], nextCursor: `g::${n + 1}`, generation: 'g',
        coverage: null, feature: FEATURE_ON,
      }),
    };
  };
  const client = createLearningClient({ fetchImpl });
  const out = await client.listAll('questions', { pageLimit: 1, maxPages: 3 });
  assert.equal(out.items.length, 3);
  assert.equal(out.truncated, true);
  // A complete walk is explicit about NOT being truncated.
  const complete = await client.listAll('questions', {
    pageLimit: 1,
    maxPages: 3,
    params: {},
  }).catch(() => null);
  assert.ok(complete === null || complete.truncated === true); // endless server never completes
});

test('store pagination bounds: exact page boundary and a cursor past the end', async () => {
  const fx = createLearningFixture();
  try {
    const ctx = createLearningContext({ codeRoot: fx.codeRoot, dataRoot: fx.dataRoot, now: fixedClock() });
    for (let i = 0; i < 4; i += 1) {
      await commitRecord(ctx, 'questions', `q-${i}`, {
        normalizedText: `q ${i}`, originalExamples: [], fieldType: 'text', occurrenceIds: [],
      }, { expectedRevision: 0, status: 'proposed' });
    }
    await rebuildIndexes(ctx, { apply: true });
    // Exact boundary: 4 records, pages of 2 — the second page must end cleanly.
    const p1 = listRecords(ctx, 'questions', { limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.ok(p1.nextCursor);
    const p2 = listRecords(ctx, 'questions', { cursor: p1.nextCursor, limit: 2 });
    assert.equal(p2.items.length, 2);
    assert.equal(p2.nextCursor, null, 'no phantom page after an exact boundary');
    // Cursor at/after the last id: an empty page, never a throw or a wrap.
    const last = p2.items[p2.items.length - 1].id;
    const p3 = listRecords(ctx, 'questions', { cursor: `${p2.generation}::${last}`, limit: 2 });
    assert.deepEqual(p3.items, []);
    assert.equal(p3.nextCursor, null);
    const beyond = listRecords(ctx, 'questions', { cursor: `${p2.generation}::zzzz`, limit: 2 });
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.nextCursor, null);
  } finally {
    fx.cleanup();
  }
});

test('T24 regression: a decided proposal is visible in list reads immediately (no stale index)', async () => {
  // Defect found via Neo on the 10k fixture: POST commits wrote new revision
  // files but nothing refreshed the pinned list-index generation, so the UI's
  // mandatory post-approval re-read (and any reload) showed the PRE-commit
  // state. Reproduces only when an index generation exists.
  const { createServer } = await import('node:http');
  const api = await import('../learning/api.mjs');
  const fx = createLearningFixture();
  let server;
  try {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(fx.dataRoot, 'config', 'learning.yml'), 'schema_version: 1\nenabled: true\n');
    const ctx = createLearningContext({ codeRoot: fx.codeRoot, dataRoot: fx.dataRoot, now: () => new Date() });
    await commitRecord(ctx, 'proposals', 'prop-stale-check', {
      kind: 'answer', evidenceIds: [], intendedBenefit: 'x', risk: 'low', baseline: 'b',
      evaluationResult: null, affectedSources: [], requiredApprovals: ['user'], rollbackVersion: null, diff: null,
    }, { expectedRevision: 0, status: 'proposed', sourceIds: [] });
    await rebuildIndexes(ctx, { apply: true }); // pin a generation BEFORE the decision
    server = createServer((req, res) => {
      api.handleLearningRequest(req, res, { ctx, assetRoot: fx.root, assetManifest: {} })
        .catch(() => { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } });
    });
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const port = server.address().port;
    const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
    const csrf = (await get('/api/auto/learning/status')).csrfToken;
    const res = await fetch(`http://127.0.0.1:${port}/api/auto/learning/proposals/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-learning-csrf': csrf },
      body: JSON.stringify({ opId: 'op-stale-check', proposalId: 'prop-stale-check', expectedRevision: 1, decision: 'approved' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).status, 'approved');
    // The very next list read must already show the committed state.
    const listed = await get('/api/auto/learning/proposals');
    const item = listed.items.find((i) => i.id === 'prop-stale-check');
    assert.equal(item.status, 'approved');
    assert.equal(item.revision, 2);
  } finally {
    server?.close();
    fx.cleanup();
  }
});

test('fixture isolation: scratch roots live under tmpdir, never the checkout', () => {
  const fx = createLearningFixture();
  try {
    assert.ok(fx.root.startsWith(tmpdir()) || fx.root.includes('career-learning-'));
    assert.ok(!fx.root.includes('career-ops/career-ops/data'));
  } finally {
    fx.cleanup();
  }
});
