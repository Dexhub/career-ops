// auto/test/learning-api.test.mjs — T21: narrow local panel API (CONTRACTS G).
// Exercises handleLearningRequest through a real loopback HTTP server against
// an isolated mkdtemp fixture: wrong Host/Origin, absent CSRF, invalid content
// type, oversized bodies, traversal, unknown ids, malformed queries, stale
// revisions, disabled features, masking, approval provenance, decision-only
// proposal routes and fixed-manifest asset serving. node:test only; synthetic
// values only; never starts a cycle, browser, model or application.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture } from './helpers/learning.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(here, '..', '..'));

const ENABLED = 'schema_version: 1\nenabled: true\nmode: shadow\n';
const DISABLED = 'schema_version: 1\nenabled: false\n';

const BASE_STANDING = `# synthetic standing fixture (T21) — comment must survive
custom:
  "do you require synthetic sponsorship?": "no"
`;

let fixture; let ctx; let api;
let commitRecord; let getRecord; let proposeAnswer;
let server; let port; let csrf;
let standingPath; let assetRoot;

const MANIFEST = Object.freeze({ 'index.mjs': 'index.mjs', 'learning.css': 'learning.css' });

function setConfig(yaml) {
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), yaml);
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

// Raw HTTP client so Host/Origin/CSRF headers are fully controllable.
function call(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON body (assets) */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.end(body); else req.end();
  });
}

function post(path, payload, { headers = {}, csrfToken = csrf } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return call('POST', path, {
    body,
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'x-learning-csrf': csrfToken,
      ...headers,
    },
  });
}

let qSeq = 0;
async function seedQuestion() {
  qSeq += 1;
  const id = `q-api-${String(qSeq).padStart(3, '0')}`;
  await commitRecord(ctx, 'questions', id, {
    normalizedText: `synthetic question ${qSeq}?`, fieldType: 'text',
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  return id;
}

before(async () => {
  fixture = createLearningFixture();
  setConfig(ENABLED);
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'), BASE_STANDING);
  assetRoot = join(fixture.root, 'assets');
  mkdirSync(assetRoot, { recursive: true });
  writeFileSync(join(assetRoot, 'index.mjs'), '// placeholder module\n');
  writeFileSync(join(assetRoot, 'learning.css'), '/* placeholder */\n');

  api = await import('../learning/api.mjs');
  ({ commitRecord, getRecord } = await import('../learning/store.mjs'));
  const answers = await import('../learning/answers.mjs');
  proposeAnswer = answers.proposeAnswer;
  const { createLearningContext } = await import('../learning/context.mjs');
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: () => new Date('2026-10-11T00:00:00Z') });
  standingPath = answers.standingSourcePath(ctx);

  server = createServer((req, res) => {
    api.handleLearningRequest(req, res, {
      ctx,
      assetRoot,
      assetManifest: MANIFEST,
      // GET routes must never reach consequential operations: these throw.
      deps: {
        runReviewCanary: () => { throw new Error('GET must never run a review'); },
      },
    }).catch(() => { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const status = await call('GET', '/api/auto/learning/status');
  csrf = status.json.csrfToken;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fixture.cleanup();
});

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.ok(standingPath.startsWith(fixture.dataRoot + sep));
});

test('status: reports feature enabled, review info and a csrf token', async () => {
  const r = await call('GET', '/api/auto/learning/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.feature, { enabled: true });
  assert.equal(typeof r.json.csrfToken, 'string');
  assert.ok(r.json.review && typeof r.json.review === 'object');
});

test('loopback only: a non-loopback Host is refused', async () => {
  const r = await call('GET', '/api/auto/learning/status', { headers: { host: 'evil.example' } });
  assert.equal(r.status, 403);
});

test('a non-loopback Origin is refused even on GET', async () => {
  const r = await call('GET', '/api/auto/learning/questions', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('GET lists: seeded synthetic questions page with generation and coverage', async () => {
  await seedQuestion(); await seedQuestion(); await seedQuestion();
  const r = await call('GET', '/api/auto/learning/questions?limit=2');
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 2);
  assert.equal(typeof r.json.generation, 'string');
  assert.equal(typeof r.json.nextCursor, 'string');
  assert.deepEqual(r.json.feature, { enabled: true });
  const c = r.json.coverage;
  assert.equal(c.observed + c.partial + c.unknown, 2);
  // Next page via cursor pages the same generation.
  const r2 = await call('GET', `/api/auto/learning/questions?limit=2&cursor=${encodeURIComponent(r.json.nextCursor)}`);
  assert.equal(r2.status, 200);
  assert.ok(r2.json.items.length >= 1);
});

test('malformed queries: non-integer limit and garbage cursor are 422; stale cursor is 409', async () => {
  const bad = await call('GET', '/api/auto/learning/questions?limit=abc');
  assert.equal(bad.status, 422);
  const cur = await call('GET', '/api/auto/learning/questions?cursor=nonsense');
  assert.equal(cur.status, 422);
  const stale = await call('GET', '/api/auto/learning/questions?cursor=gen-obsolete%3A%3Aq-api-001');
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'REFRESH_REQUIRED');
});

test('GET question by id: unknown id 404, traversal-shaped id 422', async () => {
  const id = await seedQuestion();
  const ok = await call('GET', `/api/auto/learning/question?id=${id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.item.id, id);
  const missing = await call('GET', '/api/auto/learning/question?id=q-does-not-exist');
  assert.equal(missing.status, 404);
  const traversal = await call('GET', `/api/auto/learning/question?id=${encodeURIComponent('../../secrets')}`);
  assert.equal(traversal.status, 422);
});

test('masking: secret-named keys and sensitive proposed values never leave the API', async () => {
  // The store itself refuses secret-bearing keys, so none can exist to leak;
  // the API's maskDeep is defense-in-depth on top of that.
  await assert.rejects(
    commitRecord(ctx, 'answers', 'ans-api-mask', {
      questionFamilyId: 'fam-1', kind: 'derived_rule', authority: 'inferred',
      sourceRefs: [], scope: { password: 'super-secret' },
    }, { expectedRevision: 0, status: 'approved', sourceIds: [] }),
    (err) => /secret-bearing/.test(err.message),
  );
  await commitRecord(ctx, 'answers', 'ans-api-mask', {
    questionFamilyId: 'fam-1', kind: 'derived_rule', authority: 'inferred', sourceRefs: [],
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });

  // A sensitive proposed value is redacted in the proposals list.
  const sourceHash = sha256(readFileSync(standingPath, 'utf-8'));
  const p = await proposeAnswer(ctx, {
    question: { normalizedText: 'synthetic sensitive question?' },
    fileKey: 'standing', selector: 'custom.synthetic sensitive question?',
    proposedValue: 'synthetic-secret-value', sourceHash, sensitive: true,
  });
  const proposals = await call('GET', '/api/auto/learning/proposals');
  assert.equal(proposals.status, 200);
  const prop = proposals.json.items.find((i) => i.id === p.id);
  assert.equal(prop.data.diff.proposedValue, '[redacted-sensitive]');
  assert.ok(!proposals.raw.includes('synthetic-secret-value'));
});

test('POST guards: absent CSRF, wrong CSRF, missing Origin, wrong content type, oversized body', async () => {
  const payload = { opId: 'op-guard-0001', targets: [{ collection: 'answers', id: 'x' }] };
  const noCsrf = await post('/api/auto/learning/privacy/preview', payload, { csrfToken: '' });
  assert.equal(noCsrf.status, 403);
  const wrongCsrf = await post('/api/auto/learning/privacy/preview', payload, { csrfToken: 'forged' });
  assert.equal(wrongCsrf.status, 403);
  const noOrigin = await call('POST', '/api/auto/learning/privacy/preview', {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', 'x-learning-csrf': csrf },
  });
  assert.equal(noOrigin.status, 403);
  const badType = await post('/api/auto/learning/privacy/preview', payload, { headers: { 'content-type': 'text/plain' } });
  assert.equal(badType.status, 415);
  const huge = await post('/api/auto/learning/privacy/preview', `{"pad":"${'x'.repeat(70_000)}"}`);
  assert.equal(huge.status, 413);
  const badJson = await post('/api/auto/learning/privacy/preview', '{not json');
  assert.equal(badJson.status, 422);
});

test('strict schemas: unknown fields (including actor claims) are rejected', async () => {
  const r = await post('/api/auto/learning/answers/approve', {
    proposalId: 'prop-x', expectedRevision: 1, opId: 'op-actor-0001', actor: 'user',
  });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /unknown field/);
});

test('answers propose/approve: preview-then-commit with server-minted approval; idempotent and stale repeats', async () => {
  const sourceHash = sha256(readFileSync(standingPath, 'utf-8'));
  const proposed = await post('/api/auto/learning/answers/propose', {
    opId: 'op-prop-0001',
    question: { normalizedText: 'synthetic approve question?' },
    fileKey: 'standing',
    selector: 'custom.synthetic approve question?',
    proposedValue: 'yes',
    sourceHash,
  });
  assert.equal(proposed.status, 200);
  const { proposal, preview } = proposed.json;
  assert.equal(proposal.status, 'proposed');
  assert.equal(preview.beforeHash, sourceHash);
  assert.equal(typeof preview.afterHash, 'string');
  // Propose never touched the source.
  assert.equal(sha256(readFileSync(standingPath, 'utf-8')), sourceHash);

  const approved = await post('/api/auto/learning/answers/approve', {
    proposalId: proposal.id, expectedRevision: proposal.revision, opId: 'op-appr-0001',
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.status, 'applied');
  assert.equal(approved.json.sourceHash, preview.afterHash);
  assert.equal(sha256(readFileSync(standingPath, 'utf-8')), preview.afterHash);

  // Identical repeat: idempotent, never re-applied.
  const again = await post('/api/auto/learning/answers/approve', {
    proposalId: proposal.id, expectedRevision: proposal.revision, opId: 'op-appr-0001',
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'already_applied');

  // Unknown proposal id.
  const unknown = await post('/api/auto/learning/answers/approve', {
    proposalId: 'prop-unknown', expectedRevision: 1, opId: 'op-appr-0002',
  });
  assert.equal(unknown.status, 404);
});

test('stale revision: approving a proposal against the wrong revision is a 409 and leaves the source untouched', async () => {
  const sourceHash = sha256(readFileSync(standingPath, 'utf-8'));
  const p = await proposeAnswer(ctx, {
    question: { normalizedText: 'synthetic stale question?' },
    fileKey: 'standing', selector: 'custom.do you require synthetic sponsorship?',
    proposedValue: 'maybe', sourceHash,
  });
  const r = await post('/api/auto/learning/answers/approve', {
    proposalId: p.id, expectedRevision: p.revision + 5, opId: 'op-stale-0001',
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'REVISION_CONFLICT');
  assert.equal(sha256(readFileSync(standingPath, 'utf-8')), sourceHash);
});

test('proposals/decision changes review status only and never applies a diff', async () => {
  const sourceHash = sha256(readFileSync(standingPath, 'utf-8'));
  const p = await proposeAnswer(ctx, {
    question: { normalizedText: 'synthetic decision question?' },
    fileKey: 'standing', selector: 'custom.do you require synthetic sponsorship?',
    proposedValue: 'decided', sourceHash,
  });
  const r = await post('/api/auto/learning/proposals/decision', {
    proposalId: p.id, expectedRevision: p.revision, decision: 'rejected', opId: 'op-dec-0001',
  });
  assert.equal(r.status, 200);
  assert.deepEqual({ status: r.json.status, changed: r.json.changed }, { status: 'rejected', changed: true });
  assert.equal(getRecord(ctx, 'proposals', p.id).status, 'rejected');
  // The diff was never applied.
  assert.equal(sha256(readFileSync(standingPath, 'utf-8')), sourceHash);
  // Identical repeat: idempotent no-op.
  const again = await post('/api/auto/learning/proposals/decision', {
    proposalId: p.id, expectedRevision: p.revision, decision: 'rejected', opId: 'op-dec-0001',
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.changed, false);
  // Conflicting repeat: refused.
  const conflict = await post('/api/auto/learning/proposals/decision', {
    proposalId: p.id, expectedRevision: p.revision + 1, decision: 'approved', opId: 'op-dec-0002',
  });
  assert.equal(conflict.status, 409);
  const invalid = await post('/api/auto/learning/proposals/decision', {
    proposalId: p.id, expectedRevision: p.revision, decision: 'sideways', opId: 'op-dec-0003',
  });
  assert.equal(invalid.status, 422);
});

test('privacy: preview works, apply is visibly unavailable', async () => {
  const prev = await post('/api/auto/learning/privacy/preview', {
    opId: 'op-priv-0001', targets: [{ collection: 'answers', id: 'ans-api-mask' }],
  });
  assert.equal(prev.status, 200);
  assert.equal(prev.json.claimsCompleteErasure, false);
  const apply = await post('/api/auto/learning/privacy/apply', { opId: 'op-priv-0002', requestId: 'forget-x' });
  assert.equal(apply.status, 403);
  assert.equal(apply.json.code, 'NOT_AVAILABLE');
  assert.match(apply.json.error, /approved deletion/);
});

test('unknown routes and wrong methods', async () => {
  const unknown = await call('GET', '/api/auto/learning/nonexistent');
  assert.equal(unknown.status, 404);
  const wrongMethod = await post('/api/auto/learning/questions', { opId: 'op-mm-0001' });
  assert.equal(wrongMethod.status, 405);
  const getOnPost = await call('GET', '/api/auto/learning/answers/approve');
  assert.equal(getOnPost.status, 405);
});

test('assets: fixed manifest names only, correct content types, nosniff, traversal refused', async () => {
  const js = await call('GET', '/auto/assets/learning/index.mjs');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal(js.headers['x-content-type-options'], 'nosniff');
  const css = await call('GET', '/auto/assets/learning/learning.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  for (const path of [
    '/auto/assets/learning/panel.mjs',
    '/auto/assets/learning/../../../panel.mjs',
    '/auto/assets/learning/%2e%2e/panel.mjs',
    '/auto/assets/learning/',
  ]) {
    const r = await call('GET', path);
    assert.equal(r.status, 404, `${path} must be refused`);
  }
  const postAsset = await post('/auto/assets/learning/index.mjs', { opId: 'op-asset-01' });
  assert.equal(postAsset.status, 405);
});

test('corrupt index: a visible 500, never a fake empty list', async () => {
  const { rebuildIndexes } = await import('../learning/store.mjs');
  await rebuildIndexes(ctx, { apply: true });
  const pointerPath = join(fixture.dataRoot, 'data', 'auto', 'learning', 'indexes', 'current.json');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
  const idxPath = join(fixture.dataRoot, 'data', 'auto', 'learning', 'indexes', pointer.generation, 'questions.json');
  const good = readFileSync(idxPath, 'utf-8');
  writeFileSync(idxPath, '{corrupt');
  try {
    const r = await call('GET', '/api/auto/learning/questions');
    assert.equal(r.status, 500);
    assert.equal(r.json.code, 'CORRUPT_RECORD');
    assert.ok(!Array.isArray(r.json.items), 'a corrupt index must not read as an empty list');
  } finally {
    writeFileSync(idxPath, good);
  }
});

test('disabled feature: GETs report learning_not_activated without reading records; POSTs are refused', async () => {
  setConfig(DISABLED);
  try {
    const list = await call('GET', '/api/auto/learning/questions');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items, []);
    assert.deepEqual(list.json.feature, { enabled: false, reason: 'learning_not_activated' });
    const metrics = await call('GET', '/api/auto/learning/metrics');
    assert.equal(metrics.status, 200);
    assert.deepEqual(metrics.json.feature, { enabled: false, reason: 'learning_not_activated' });
    const review = await post('/api/auto/learning/review', { opId: 'op-rev-0001' });
    assert.equal(review.status, 403);
    assert.equal(review.json.code, 'LEARNING_DISABLED');
    const status = await call('GET', '/api/auto/learning/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.json.feature, { enabled: false, reason: 'learning_not_activated' });
  } finally {
    setConfig(ENABLED);
  }
});

test('panel dispatch: panel.mjs routes learning paths to the handler', async () => {
  // Surgical integration check: the panel server forwards /api/auto/learning.
  const { createPanelServer } = await import('../panel.mjs');
  const panel = createPanelServer();
  await new Promise((r) => panel.listen(0, '127.0.0.1', r));
  const panelPort = panel.address().port;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: panelPort, path: '/api/auto/learning/status' }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(r.status, 200);
    assert.ok('feature' in r.json);
  } finally {
    await new Promise((r) => panel.close(r));
  }
});

// --- T23: learner pause — independent of the application pipeline -------------

test('learner/pause: pauses ONLY the learner, blocks review, and is reversible', async () => {
  // Status reflects the running learner plus the cloud lane reason.
  let status = await call('GET', '/api/auto/learning/status');
  assert.equal(status.json.learner.paused, false);
  assert.equal(status.json.cloud.enabled, false); // no cloud config -> honest reason
  assert.equal(typeof status.json.cloud.reason, 'string');

  // Strict schema: unknown fields and non-bool paused are rejected.
  const bad = await post('/api/auto/learning/learner/pause', { opId: 'op-pause-001', paused: 'yes' });
  assert.equal(bad.status, 422);
  const extra = await post('/api/auto/learning/learner/pause', { opId: 'op-pause-002', paused: true, cycle: 'start' });
  assert.equal(extra.status, 422);

  const pause = await post('/api/auto/learning/learner/pause', { opId: 'op-pause-003', paused: true });
  assert.equal(pause.status, 200);
  assert.equal(pause.json.paused, true);

  status = await call('GET', '/api/auto/learning/status');
  assert.equal(status.json.learner.paused, true);
  assert.equal(status.json.review.paused, true);
  assert.equal(status.json.review.due, false); // paused is never silently "due"

  // A paused learner refuses review runs with a visible 403, not a silent skip.
  // (review.enabled is false in this fixture config anyway; the pause check must
  // not mask that order — enable review for this call via config.)
  setConfig('schema_version: 1\nenabled: true\nmode: shadow\nreview:\n  enabled: true\n');
  const refused = await post('/api/auto/learning/review', { opId: 'op-pause-004' });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /paused/);
  setConfig(ENABLED);

  // The sentinel lives under the LEARNING data root — the pipeline pause file
  // (data/auto/pause-requested) is untouched.
  const { existsSync: ex } = await import('node:fs');
  const { learnerPausePath } = await import('../learning/reviewer.mjs');
  assert.ok(learnerPausePath(ctx).includes('learning'));
  assert.equal(ex(join(fixture.dataRoot, 'data', 'auto', 'pause-requested')), false);

  const resume = await post('/api/auto/learning/learner/pause', { opId: 'op-pause-005', paused: false });
  assert.equal(resume.status, 200);
  assert.equal(resume.json.paused, false);
  status = await call('GET', '/api/auto/learning/status');
  assert.equal(status.json.learner.paused, false);
});
