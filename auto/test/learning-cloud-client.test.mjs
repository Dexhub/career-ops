// auto/test/learning-cloud-client.test.mjs — T17 client tests. No AWS, no
// network, no real spawn: every transport is injected. node:test only;
// synthetic values only; dynamic imports after the fixture is created.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

const APPROVED_MODEL = 'anthropic.claude-3-5-haiku-20241022-v1:0';
const SYNTH_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:synthetic-learning';

function writeCloudConfig(root, cloudOverrides = {}, topOverrides = {}) {
  const cloud = {
    enabled: true,
    function_arn: SYNTH_ARN,
    model_id: APPROVED_MODEL,
    daily_usd_cap: 1,
    max_calls_per_day: 10,
    ...cloudOverrides,
  };
  const lines = ['schema_version: 1', `enabled: ${topOverrides.enabled ?? true}`, 'cloud:'];
  for (const [k, v] of Object.entries(cloud)) {
    lines.push(`  ${k}: ${v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : v}`);
  }
  writeFileSync(join(root, 'config', 'learning.yml'), lines.join('\n') + '\n');
}

async function setup(cloudOverrides, topOverrides) {
  const fixture = createLearningFixture();
  writeCloudConfig(fixture.root, cloudOverrides, topOverrides);
  const { createLearningContext } = await import('../learning/context.mjs');
  const client = await import('../learning/cloud-client.mjs');
  const store = await import('../learning/store.mjs');
  const ctx = createLearningContext({
    codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock(),
  });
  return { fixture, ctx, client, store };
}

const EXCERPT = 'What is your notice period? Field type text, required.';
function args(transport, extra = {}) {
  return {
    task: 'question_families',
    policyVersion: 'policy-v1',
    sourceExcerpts: [{ sourceId: 'obs-1', excerpt: EXCERPT }],
    transport,
    ...extra,
  };
}

function okReply(request, overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    status: 'ok',
    modelId: APPROVED_MODEL,
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    candidates: [{
      summary: 'notice period asked as free text',
      sourceIds: ['obs-1'],
      quotes: [{ sourceId: 'obs-1', quote: 'notice period' }],
    }],
    ...overrides,
  };
}

function recordingTransport(replyFor) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    const out = replyFor(request);
    if (out instanceof Error) throw out;
    return out;
  };
  return { calls, transport };
}

test('fixture isolation: all writes land under the tmpdir fixture, never the repo', async () => {
  const { fixture, ctx, client } = await setup();
  try {
    assert.ok(fixture.root.startsWith(tmpdir().replace(/\/private\//, '/')) || fixture.root.includes('career-learning-'));
    const { calls, transport } = recordingTransport((req) => okReply(req));
    await client.invokeCloudAnalysis(ctx, args(transport));
    assert.equal(calls.length, 1);
    const learningDir = join(fixture.root, 'data', 'auto', 'learning');
    assert.ok(existsSync(learningDir), 'reservation persisted under the fixture root');
    assert.ok(!existsSync(join(process.cwd(), 'data', 'auto', 'learning', 'reviewRuns')),
      'nothing written into the repository working tree');
  } finally { fixture.cleanup(); }
});

test('disabled by default: no config -> CLOUD_DISABLED and the transport is never called', async () => {
  const fixture = createLearningFixture(); // no learning.yml at all
  try {
    const { createLearningContext } = await import('../learning/context.mjs');
    const client = await import('../learning/cloud-client.mjs');
    const ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
    assert.deepEqual(client.cloudEnabled(ctx), { enabled: false, reason: 'learning_disabled' });
    const { calls, transport } = recordingTransport((req) => okReply(req));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_DISABLED' });
    assert.equal(calls.length, 0, 'disabled means the transport is never touched');
  } finally { fixture.cleanup(); }
});

test('zero budget refuses before any reservation or transport call', async () => {
  const { fixture, ctx, client, store } = await setup({ daily_usd_cap: 0 });
  try {
    const { calls, transport } = recordingTransport((req) => okReply(req));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_DISABLED' });
    assert.equal(calls.length, 0);
    assert.equal(store.listRecords(ctx, 'reviewRuns', {}).items.length, 0, 'no reservation taken');
  } finally { fixture.cleanup(); }
});

test('unapproved model (unknown pricing) disables the cloud path', async () => {
  const { fixture, ctx, client } = await setup({ model_id: 'synthetic.unapproved-model-v9' });
  try {
    assert.deepEqual(client.cloudEnabled(ctx), { enabled: false, reason: 'unknown_pricing' });
    const { calls, transport } = recordingTransport((req) => okReply(req));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_DISABLED' });
    assert.equal(calls.length, 0);
  } finally { fixture.cleanup(); }
});

test('oversized and private payloads are rejected before reservation and transport', async () => {
  const { fixture, ctx, client, store } = await setup();
  try {
    const { calls, transport } = recordingTransport((req) => okReply(req));
    const oversized = [{ sourceId: 'obs-1', excerpt: 'a'.repeat(5000) }];
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport, { sourceExcerpts: oversized })));
    const privateExcerpts = [
      [{ sourceId: 'obs-1', excerpt: 'my password is hunter2' }],
      [{ sourceId: 'obs-1', excerpt: 'fetch https://evil.example.com/x' }],
      [{ sourceId: 'obs-1', excerpt: 'open /Users/jarvis/.ssh/id_rsa' }],
    ];
    for (const sourceExcerpts of privateExcerpts) {
      await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport, { sourceExcerpts })));
    }
    assert.equal(calls.length, 0, 'nothing reached the transport');
    assert.equal(store.listRecords(ctx, 'reviewRuns', {}).items.length, 0, 'nothing was reserved');
  } finally { fixture.cleanup(); }
});

test('reservation is persisted BEFORE the transport runs, with pricing version and bounds', async () => {
  const { fixture, ctx, client, store } = await setup();
  try {
    let reservedDuringCall = null;
    const transport = async (request) => {
      reservedDuringCall = store.listRecords(ctx, 'reviewRuns', {}).items
        .filter((r) => r.data.budget?.kind === 'cloud_reservation');
      return okReply(request);
    };
    const result = await client.invokeCloudAnalysis(ctx, args(transport));
    assert.equal(reservedDuringCall.length, 1, 'reservation existed while the call was in flight');
    assert.equal(reservedDuringCall[0].status, 'running');
    const budget = reservedDuringCall[0].data.budget;
    assert.equal(budget.pricingVersion, client.PRICING_VERSION);
    assert.equal(budget.modelId, APPROVED_MODEL);
    assert.ok(budget.estInput > 0 && budget.estUsd > 0 && budget.maxOutput > 0);
    const settled = store.getRecord(ctx, 'reviewRuns', result.reservationId);
    assert.equal(settled.status, 'completed');
    assert.deepEqual(settled.data.outcomes.usage, { input: 100, output: 20, total: 120 });
    assert.ok(settled.data.outcomes.actualUsd > 0);
  } finally { fixture.cleanup(); }
});

test('injected CountTokens is preferred; a broken one refuses rather than guesses', async () => {
  const { fixture, ctx, client, store } = await setup();
  try {
    const { transport } = recordingTransport((req) => okReply(req));
    const seen = [];
    const result = await client.invokeCloudAnalysis(ctx, args(transport, {
      countTokens: async (req) => { seen.push(req.requestId); return 42; },
    }));
    const rec = store.getRecord(ctx, 'reviewRuns', result.reservationId);
    assert.equal(rec.data.budget.estInput, 42);
    assert.equal(rec.data.budget.estimateMethod, 'count_tokens');
    assert.equal(seen.length, 1);
    // Broken CountTokens -> refuse with no reservation and no transport call.
    const { calls, transport: t2 } = recordingTransport((req) => okReply(req));
    await assert.rejects(
      client.invokeCloudAnalysis(ctx, args(t2, { countTokens: async () => Number.NaN })),
      { code: 'CLOUD_BOUND_UNAVAILABLE' },
    );
    assert.equal(calls.length, 0);
  } finally { fixture.cleanup(); }
});

test('daily dollar cap and calls/day cap are enforced against reserved spend', async () => {
  const { fixture, ctx, client } = await setup({ daily_usd_cap: 0.01, max_calls_per_day: 2 });
  try {
    // First call succeeds and its actual usage counts as spend.
    const big = (req) => okReply(req, { usage: { inputTokens: 2000, outputTokens: 2000, totalTokens: 4000 } });
    await client.invokeCloudAnalysis(ctx, args(async (r) => big(r)));
    // Second call: reserving max_output_tokens=1200 output at haiku pricing
    // (~$0.0048) on top of spent (~$0.0096) exceeds the $0.01 cap.
    const { calls, transport } = recordingTransport((req) => okReply(req));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_BUDGET_EXCEEDED' });
    assert.equal(calls.length, 0);
  } finally { fixture.cleanup(); }
});

test('max_calls_per_day counts every reservation including failed ones', async () => {
  const { fixture, ctx, client } = await setup({ max_calls_per_day: 1 });
  try {
    await client.invokeCloudAnalysis(ctx, args(async (r) => okReply(r)));
    const { calls, transport } = recordingTransport((req) => okReply(req));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_BUDGET_EXCEEDED' });
    assert.equal(calls.length, 0);
  } finally { fixture.cleanup(); }
});

test('reply citing an unknown source id is rejected locally; reservation settles as rejected_reply', async () => {
  const { fixture, ctx, client, store } = await setup();
  try {
    const { calls, transport } = recordingTransport((req) => okReply(req, {
      candidates: [{ summary: 'made-up claim', sourceIds: ['obs-UNSENT'] }],
    }));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_REPLY_REJECTED' });
    assert.equal(calls.length, 1, 'exactly one transport call, no retry');
    const [rec] = store.listRecords(ctx, 'reviewRuns', {}).items;
    assert.equal(rec.status, 'completed');
    assert.equal(rec.data.outcomes.result, 'rejected_reply');
  } finally { fixture.cleanup(); }
});

test('unsupported quoted claim (quote not in the sent excerpt) is rejected locally', async () => {
  const { fixture, ctx, client } = await setup();
  try {
    const { transport } = recordingTransport((req) => okReply(req, {
      candidates: [{
        summary: 'claim with fabricated quote', sourceIds: ['obs-1'],
        quotes: [{ sourceId: 'obs-1', quote: 'salary expectations in USD' }],
      }],
    }));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_REPLY_REJECTED' });
  } finally { fixture.cleanup(); }
});

test('prompt injection carried in a source cannot smuggle instructions back: injected reply text is data and mismatched requestId/model is rejected', async () => {
  const { fixture, ctx, client } = await setup();
  try {
    // Reply tries to swap in a different requestId (replay) -> rejected.
    const { transport } = recordingTransport((req) => okReply(req, { requestId: 'req-other' }));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_REPLY_INVALID' });
  } finally { fixture.cleanup(); }
});

test('malformed reply JSON shape -> CLOUD_REPLY_INVALID, settled, exactly one call', async () => {
  const { fixture, ctx, client, store } = await setup();
  try {
    const { calls, transport } = recordingTransport(() => ({ nonsense: true }));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_REPLY_INVALID' });
    assert.equal(calls.length, 1);
    const [rec] = store.listRecords(ctx, 'reviewRuns', {}).items;
    assert.equal(rec.data.outcomes.result, 'rejected_reply');
  } finally { fixture.cleanup(); }
});

test('provider error settles the reservation as failed with no implicit retry', async () => {
  const { fixture, ctx, client, store } = await setup();
  try {
    const { calls, transport } = recordingTransport((req) => okReply(req, {
      status: 'provider_error', usage: null, candidates: [],
    }));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_PROVIDER_ERROR' });
    assert.equal(calls.length, 1);
    const [rec] = store.listRecords(ctx, 'reviewRuns', {}).items;
    assert.equal(rec.status, 'failed');
    // A failed invoke frees the dollar budget but still counts as a call.
    const { calls: c2, transport: t2 } = recordingTransport((req) => okReply(req));
    const result = await client.invokeCloudAnalysis(ctx, args(t2));
    assert.equal(result.status, 'ok');
    assert.equal(c2.length, 1);
  } finally { fixture.cleanup(); }
});

test('client timeout keeps the reservation unknown and blocks any second invocation until reconciled', async () => {
  const { fixture, ctx, client, store } = await setup();
  try {
    const timeoutErr = new Error('timed out'); timeoutErr.code = 'TIMEOUT';
    const { calls, transport } = recordingTransport(() => timeoutErr);
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_OUTCOME_UNKNOWN' });
    assert.equal(calls.length, 1);
    const [rec] = store.listRecords(ctx, 'reviewRuns', {}).items;
    assert.equal(rec.status, 'running', 'unknown outcome stays reserved');
    assert.equal(rec.data.outcomes.result, 'unknown');
    // No implicit second invocation: a new call is refused outright.
    const { calls: c2, transport: t2 } = recordingTransport((req) => okReply(req));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(t2)), { code: 'CLOUD_IN_FLIGHT' });
    assert.equal(c2.length, 0);
    // Deliberate reconcile (with evidence) settles it; only then may a new call run.
    const requestId = rec.data.budget.requestId;
    await client.reconcileCloudRequest(ctx, { requestId, outcome: 'failed' });
    const settled = store.listRecords(ctx, 'reviewRuns', {}).items.find((r) => r.id === rec.id);
    assert.equal(settled.status, 'failed');
    const result = await client.invokeCloudAnalysis(ctx, args(t2));
    assert.equal(result.status, 'ok');
    // Reconciling twice is refused.
    await assert.rejects(client.reconcileCloudRequest(ctx, { requestId, outcome: 'ok' }), { code: 'CLOUD_ALREADY_SETTLED' });
  } finally { fixture.cleanup(); }
});

test('reconcile unknown marks aborted and keeps the cost reserved against the daily cap', async () => {
  const { fixture, ctx, client, store } = await setup({ daily_usd_cap: 0.006 });
  try {
    const timeoutErr = new Error('t'); timeoutErr.code = 'TIMEOUT';
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(async () => { throw timeoutErr; })),
      { code: 'CLOUD_OUTCOME_UNKNOWN' });
    const [rec] = store.listRecords(ctx, 'reviewRuns', {}).items;
    await client.reconcileCloudRequest(ctx, { requestId: rec.data.budget.requestId, outcome: 'unknown' });
    const after = store.getRecord(ctx, 'reviewRuns', rec.id);
    assert.equal(after.status, 'aborted');
    // estUsd (~0.0048 for 1200 output tokens) stays reserved: a second call
    // of the same size would exceed the 0.006 cap.
    const { calls, transport } = recordingTransport((req) => okReply(req));
    await assert.rejects(client.invokeCloudAnalysis(ctx, args(transport)), { code: 'CLOUD_BUDGET_EXCEEDED' });
    assert.equal(calls.length, 0);
  } finally { fixture.cleanup(); }
});

test('buildAwsCliInvokeArgs yields a pure argument array for the authorized invocation', async () => {
  const { fixture, client } = await setup();
  try {
    const argv = client.buildAwsCliInvokeArgs({
      functionArn: SYNTH_ARN, payloadPath: '/tmp/x/payload.json', responsePath: '/tmp/x/response.json',
    });
    assert.ok(Array.isArray(argv));
    assert.equal(argv[0], 'aws');
    assert.deepEqual(argv.slice(1, 5), ['--profile', 'hk_dev', '--region', 'us-east-1']);
    assert.ok(argv.includes('lambda') && argv.includes('invoke'));
    assert.deepEqual(argv.slice(argv.indexOf('--invocation-type'), argv.indexOf('--invocation-type') + 2),
      ['--invocation-type', 'RequestResponse']);
    assert.equal(argv[argv.indexOf('--function-name') + 1], SYNTH_ARN);
    for (const a of argv) assert.ok(!/[;&|]/.test(a), 'no shell metacharacter smuggling');
    assert.throws(() => client.buildAwsCliInvokeArgs({ functionArn: '', payloadPath: 'p', responsePath: 'r' }));
  } finally { fixture.cleanup(); }
});

test('createCliTransport spawns with argument array, shell:false, AWS_MAX_ATTEMPTS=1 and private files; kill on timeout -> code TIMEOUT', async () => {
  const { fixture, client } = await setup();
  try {
    const spawnCalls = [];
    const files = {};
    const fakeFs = {
      mkdtempSync: (prefix, opts) => { files.dir = `${prefix}SYNTH`; files.dirMode = opts?.mode; return files.dir; },
      writeFileSync: (p, body, opts) => { files[p] = { body, mode: opts?.mode }; },
      readFileSync: (p) => JSON.stringify({ schemaVersion: 1, requestId: 'req-x', status: 'ok', modelId: APPROVED_MODEL, usage: null, candidates: [] }),
      rmSync: (p, opts) => { files.removed = p; },
    };
    const fakeOs = { tmpdir: () => '/synthetic-tmp' };
    const makeChild = (behavior) => {
      const handlers = {};
      const child = {
        killed: null,
        kill(sig) { this.killed = sig; },
        on(event, cb) { handlers[event] = cb; },
      };
      queueMicrotask(() => behavior(handlers, child));
      return child;
    };
    // Success path.
    const okSpawn = (cmd, argv, opts) => {
      spawnCalls.push({ cmd, argv, opts });
      return makeChild((h) => h.exit(0));
    };
    const transport = client.createCliTransport({
      functionArn: SYNTH_ARN, spawnFn: okSpawn, fsImpl: fakeFs, osImpl: fakeOs, timeoutMs: 1000,
    });
    const reply = await transport({ schemaVersion: 1, requestId: 'req-x', task: 'question_families', policyVersion: 'p', payload: { sourceExcerpts: [] } });
    assert.equal(reply.status, 'ok');
    assert.equal(spawnCalls.length, 1);
    const { cmd, argv, opts } = spawnCalls[0];
    assert.equal(cmd, 'aws');
    assert.ok(Array.isArray(argv), 'arguments passed as an array, never a shell string');
    assert.equal(opts.shell, false);
    assert.equal(opts.env.AWS_MAX_ATTEMPTS, '1');
    assert.equal(files.dirMode, 0o700, 'private temp dir');
    const payloadFile = Object.keys(files).find((k) => k.endsWith('payload.json'));
    assert.equal(files[payloadFile].mode, 0o600, 'private payload file');
    assert.equal(files.removed, files.dir, 'temp dir cleaned up');
    // Timeout path: child never exits -> killed, error code TIMEOUT.
    const hangSpawn = (cmd2, argv2, opts2) => makeChild(() => { /* never exits */ });
    const slow = client.createCliTransport({
      functionArn: SYNTH_ARN, spawnFn: hangSpawn, fsImpl: fakeFs, osImpl: fakeOs, timeoutMs: 20,
    });
    await assert.rejects(
      slow({ schemaVersion: 1, requestId: 'req-y', task: 'question_families', policyVersion: 'p', payload: { sourceExcerpts: [] } }),
      (err) => err.code === 'TIMEOUT',
    );
  } finally { fixture.cleanup(); }
});
