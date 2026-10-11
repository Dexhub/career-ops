// auto/learning/cloud-client.mjs — local side of the optional Lambda/Bedrock
// analysis backend (T17, CONTRACTS H). Builds and redacts strict requests,
// takes a pricing-versioned local reservation BEFORE any transport call,
// enforces one in-flight request, validates replies (unknown source IDs and
// unsupported quoted claims rejected locally) and settles or keeps
// reservations for unknown outcomes without ever auto-reissuing.
// Nothing executes at import time. All transports are injected; the default
// CLI transport uses spawn with an ARGUMENT ARRAY (never shell concatenation)
// and private temp payload/response files, and is never exercised by tests.

import { randomUUID } from 'node:crypto';
import { LearningError } from './contracts.mjs';
import { readLearningConfig } from './context.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';
import {
  ALLOWED_TASKS, CLOUD_SCHEMA_VERSION, REQUEST_LIMITS,
  validateCloudRequest, validateCloudResponse,
} from './cloud/index.mjs';

export { ALLOWED_TASKS, CLOUD_SCHEMA_VERSION, REQUEST_LIMITS };

// ---------------------------------------------------------------------------
// Pricing. Versioned: a model with no entry here has UNKNOWN pricing and the
// cloud path is disabled for it — cost is never guessed. The dollar amounts
// below are the planning-time Anthropic/Bedrock list prices and are UNVERIFIED
// against the Bedrock pricing page (registry/webfetch verified SDK + runtime
// docs only); D03/T27 must confirm them before any deployment. The MECHANISM
// (version pin + refuse-on-unknown) is what T17 guarantees.
export const PRICING_VERSION = '2026-10-11';
export const MODEL_PRICING = Object.freeze({
  'anthropic.claude-3-5-haiku-20241022-v1:0': Object.freeze({
    inputUsdPerMTok: 0.8, outputUsdPerMTok: 4.0,
  }),
});

const RESERVATION_KIND = 'cloud_reservation';

function cloudSettings(ctx) {
  const config = readLearningConfig(ctx);
  return { config, cloud: config.cloud };
}

/**
 * Deterministic enablement check. Cloud analysis requires the learning layer
 * enabled, cloud.enabled, a function ARN, an approved model AND known pricing.
 * Returns {enabled, reason}.
 */
export function cloudEnabled(ctx) {
  const { config, cloud } = cloudSettings(ctx);
  if (!config.enabled) return { enabled: false, reason: 'learning_disabled' };
  if (!cloud.enabled) return { enabled: false, reason: 'cloud_disabled' };
  if (typeof cloud.function_arn !== 'string' || cloud.function_arn.length === 0) {
    return { enabled: false, reason: 'no_function_arn' };
  }
  if (typeof cloud.model_id !== 'string' || cloud.model_id.length === 0) {
    return { enabled: false, reason: 'no_model' };
  }
  if (!Object.hasOwn(MODEL_PRICING, cloud.model_id)) {
    return { enabled: false, reason: 'unknown_pricing' };
  }
  if (!(cloud.daily_usd_cap > 0) || !(cloud.max_calls_per_day > 0)) {
    return { enabled: false, reason: 'zero_budget' };
  }
  return { enabled: true, reason: null };
}

/**
 * buildCloudRequest -> validated, redaction-checked request envelope.
 * Throws LearningError before anything can reach a transport.
 */
export function buildCloudRequest(ctx, { task, policyVersion, sourceExcerpts } = {}) {
  const { cloud } = cloudSettings(ctx);
  const request = {
    schemaVersion: CLOUD_SCHEMA_VERSION,
    requestId: `req-${randomUUID()}`,
    task,
    policyVersion,
    payload: { sourceExcerpts },
  };
  try {
    validateCloudRequest(request, { maxPayloadBytes: cloud.max_payload_bytes });
  } catch (err) {
    throw new LearningError(err.code ?? 'CLOUD_REQUEST_INVALID', err.message);
  }
  return request;
}

// --------------------------------------------------------------------------
// Reservations: stored as reviewRuns records (reusing the existing budget-
// bearing collection, like T09 reused proposals) with
// data.budget.kind === 'cloud_reservation'. Status: running = in flight or
// outcome unknown; completed/failed/aborted = settled.

function reservationId(requestId) {
  return `cloudres-${requestId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function listCloudReservations(ctx) {
  const { items } = listRecords(ctx, 'reviewRuns', { limit: 500 });
  return items.filter((r) => r.data?.budget?.kind === RESERVATION_KIND);
}

function utcDay(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

// The ledger's shared secret-key regex rejects any key containing "token"
// (safe over-rejection, same tradeoff T05 recorded). Persisted token counts
// therefore use neutral key names; in-process APIs keep the SDK names.
function ledgerUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  if (Number.isFinite(usage.inputTokens)) out.input = usage.inputTokens;
  if (Number.isFinite(usage.outputTokens)) out.output = usage.outputTokens;
  if (Number.isFinite(usage.totalTokens)) out.total = usage.totalTokens;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Estimate input tokens. Prefer an injected CountTokens transport (free per
 * verified docs); otherwise a conservative ceiling of one token per character
 * of the serialized payload; refuse when no defensible bound exists.
 */
export async function estimateInputTokens(request, { countTokens } = {}) {
  if (typeof countTokens === 'function') {
    const n = await countTokens(request);
    if (!Number.isInteger(n) || n <= 0) {
      throw new LearningError('CLOUD_BOUND_UNAVAILABLE', 'countTokens returned no usable token count');
    }
    return { tokens: n, method: 'count_tokens' };
  }
  const chars = JSON.stringify({ task: request.task, payload: request.payload }).length;
  if (!Number.isInteger(chars) || chars <= 0) {
    throw new LearningError('CLOUD_BOUND_UNAVAILABLE', 'cannot establish a defensible input bound');
  }
  return { tokens: chars, method: 'char_ceiling' }; // >= real tokens for any tokenizer
}

/**
 * reserveCloudBudget(ctx,{request,estInputTokens}) -> reservation envelope.
 * Requires an approved model with known pricing, enforces daily dollar cap,
 * calls/day cap and ONE in-flight request. Persisted via commitRecord BEFORE
 * any transport call; unknown-outcome reservations keep counting against the
 * budget.
 */
export async function reserveCloudBudget(ctx, { request, estInputTokens, estimateMethod = 'char_ceiling' }) {
  const { enabled, reason } = cloudEnabled(ctx);
  if (!enabled) {
    throw new LearningError('CLOUD_DISABLED', `cloud analysis unavailable: ${reason}`);
  }
  const { cloud } = cloudSettings(ctx);
  const pricing = MODEL_PRICING[cloud.model_id];
  const maxOutputTokens = cloud.max_output_tokens;
  const estUsd = (estInputTokens * pricing.inputUsdPerMTok + maxOutputTokens * pricing.outputUsdPerMTok) / 1_000_000;

  const existing = listCloudReservations(ctx);
  const inFlight = existing.find((r) => r.status === 'running');
  if (inFlight) {
    throw new LearningError('CLOUD_IN_FLIGHT',
      `a cloud request is already in flight or unresolved (${inFlight.id}); reconcile it first — never auto-reissue`,
      { reservationId: inFlight.id });
  }
  const today = utcDay(ctx.now().toISOString());
  const todays = existing.filter((r) => utcDay(r.data.startedAt) === today);
  if (todays.length >= cloud.max_calls_per_day) {
    throw new LearningError('CLOUD_BUDGET_EXCEEDED', 'max_calls_per_day reached');
  }
  // failed = invoke errored before any model charge; everything else counts.
  const spentUsd = todays.filter((r) => r.status !== 'failed')
    .reduce((sum, r) => sum + (r.data.outcomes?.actualUsd ?? r.data.budget.estUsd ?? 0), 0);
  if (spentUsd + estUsd > cloud.daily_usd_cap) {
    throw new LearningError('CLOUD_BUDGET_EXCEEDED',
      `estimated $${estUsd.toFixed(6)} would exceed daily cap $${cloud.daily_usd_cap} (reserved $${spentUsd.toFixed(6)})`);
  }
  return commitRecord(ctx, 'reviewRuns', reservationId(request.requestId), {
    startedAt: ctx.now().toISOString(),
    budget: {
      kind: RESERVATION_KIND,
      requestId: request.requestId,
      task: request.task,
      modelId: cloud.model_id,
      pricingVersion: PRICING_VERSION,
      estInput: estInputTokens,
      estimateMethod,
      maxOutput: maxOutputTokens,
      estUsd,
      dailyUsdCap: cloud.daily_usd_cap,
    },
    outcomes: { result: 'pending' },
  }, { expectedRevision: 0, status: 'running', sourceIds: [] });
}

async function settleReservation(ctx, reservation, status, outcomes) {
  const latest = getRecord(ctx, 'reviewRuns', reservation.id);
  const data = { ...latest.data, outcomes };
  if (status !== 'running') data.finishedAt = ctx.now().toISOString();
  return commitRecord(ctx, 'reviewRuns', reservation.id, data,
    { expectedRevision: latest.revision, status, sourceIds: [] });
}

/**
 * Local reply validation beyond structure: requestId must match, the model
 * must be the approved one, every candidate sourceId must name a SENT source
 * and every quoted claim must appear verbatim in the sent excerpt for that
 * source. Unknown IDs / unsupported claims are rejected (CONTRACTS H).
 */
export function validateCloudReply(reply, { request }) {
  try {
    validateCloudResponse(reply);
  } catch (err) {
    throw new LearningError('CLOUD_REPLY_INVALID', err.message);
  }
  if (reply.requestId !== request.requestId) {
    throw new LearningError('CLOUD_REPLY_INVALID', 'reply requestId does not match the request');
  }
  if (reply.status !== 'ok') return reply; // non-ok carries no candidates to trust
  const sentById = new Map(request.payload.sourceExcerpts.map((e) => [e.sourceId, e.excerpt]));
  for (const [i, c] of reply.candidates.entries()) {
    for (const sid of c.sourceIds) {
      if (!sentById.has(sid)) {
        throw new LearningError('CLOUD_REPLY_REJECTED', `candidates[${i}] cites unknown source id`, { sourceId: sid });
      }
    }
    for (const q of c.quotes ?? []) {
      const excerpt = sentById.get(q.sourceId);
      if (excerpt === undefined || !excerpt.includes(q.quote)) {
        throw new LearningError('CLOUD_REPLY_REJECTED', `candidates[${i}] carries an unsupported quoted claim`);
      }
    }
  }
  return reply;
}

function actualUsdFrom(usage, modelId) {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing || !usage || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
    return null; // unknown stays unknown, never zero
  }
  return (usage.inputTokens * pricing.inputUsdPerMTok + usage.outputTokens * pricing.outputUsdPerMTok) / 1_000_000;
}

/**
 * invokeCloudAnalysis(ctx,{task,policyVersion,sourceExcerpts,transport,countTokens})
 * -> {requestId,reservationId,status,candidates,usage,actualUsd}.
 *
 * Order of operations (each gate throws before the next runs, and ALWAYS
 * before the transport): enablement -> request build/redaction -> token bound
 * -> persisted reservation (one in flight) -> single synchronous transport
 * call -> local reply validation -> reservation settlement. A transport
 * timeout leaves the reservation 'running' with an unknown outcome: the same
 * batch is never reissued automatically; reconcileCloudRequest settles it.
 */
export async function invokeCloudAnalysis(ctx, { task, policyVersion, sourceExcerpts, transport, countTokens } = {}) {
  if (typeof transport !== 'function') {
    throw new LearningError('CLOUD_TRANSPORT_REQUIRED', 'an injected transport function is required');
  }
  const { enabled, reason } = cloudEnabled(ctx);
  if (!enabled) {
    throw new LearningError('CLOUD_DISABLED', `cloud analysis unavailable: ${reason}`);
  }
  const request = buildCloudRequest(ctx, { task, policyVersion, sourceExcerpts });
  const { tokens, method } = await estimateInputTokens(request, { countTokens });
  const reservation = await reserveCloudBudget(ctx, {
    request, estInputTokens: tokens, estimateMethod: method,
  });

  let reply;
  try {
    reply = await transport(request);
  } catch (err) {
    if (err?.code === 'TIMEOUT') {
      // Unknown outcome: the paid call may or may not have run. Keep the
      // reservation (status stays running, cost stays reserved) and refuse
      // any automatic second invocation.
      await settleReservation(ctx, reservation, 'running', { result: 'unknown' });
      throw new LearningError('CLOUD_OUTCOME_UNKNOWN',
        `transport timed out; outcome unknown for ${request.requestId} — reconcile, never auto-retry`,
        { requestId: request.requestId, reservationId: reservation.id });
    }
    // A transport error without a reply is also an unknown outcome.
    await settleReservation(ctx, reservation, 'running', { result: 'unknown', errorCode: err?.code ?? 'TRANSPORT_ERROR' });
    throw new LearningError('CLOUD_OUTCOME_UNKNOWN',
      `transport failed without a reply for ${request.requestId}`,
      { requestId: request.requestId, reservationId: reservation.id });
  }

  let validated;
  try {
    validated = validateCloudReply(reply, { request });
  } catch (err) {
    // A reply arrived, so the invoke completed; the model may have been paid.
    await settleReservation(ctx, reservation, 'completed', {
      result: 'rejected_reply', errorCode: err.code,
      usage: ledgerUsage(reply?.usage), actualUsd: actualUsdFrom(reply?.usage, reply?.modelId),
    });
    throw err;
  }
  if (validated.status === 'provider_error') {
    await settleReservation(ctx, reservation, 'failed', { result: 'provider_error' });
    throw new LearningError('CLOUD_PROVIDER_ERROR',
      `backend reported a provider error for ${request.requestId}; not retried automatically`,
      { requestId: request.requestId, reservationId: reservation.id });
  }
  const actualUsd = actualUsdFrom(validated.usage, validated.modelId);
  await settleReservation(ctx, reservation, 'completed', {
    result: validated.status, usage: ledgerUsage(validated.usage), actualUsd,
  });
  return {
    requestId: request.requestId,
    reservationId: reservation.id,
    status: validated.status,
    candidates: validated.status === 'ok' ? validated.candidates : [],
    usage: validated.usage,
    actualUsd,
  };
}

/**
 * reconcileCloudRequest(ctx,{requestId,outcome,usage}) — settle a named
 * unresolved reservation with evidence, or mark it explicitly unknown
 * (status 'aborted', cost stays reserved). NEVER reissues the request.
 * outcome: 'ok' | 'failed' | 'unknown'.
 */
export async function reconcileCloudRequest(ctx, { requestId, outcome, usage = null } = {}) {
  if (!['ok', 'failed', 'unknown'].includes(outcome)) {
    throw new LearningError('SCHEMA_VALIDATION', 'outcome must be ok|failed|unknown');
  }
  const reservation = listCloudReservations(ctx)
    .find((r) => r.data.budget.requestId === requestId);
  if (!reservation) {
    throw new LearningError('CLOUD_RESERVATION_NOT_FOUND', `no reservation for ${String(requestId)}`);
  }
  if (reservation.status !== 'running') {
    throw new LearningError('CLOUD_ALREADY_SETTLED', `reservation ${reservation.id} is already ${reservation.status}`);
  }
  const status = outcome === 'ok' ? 'completed' : outcome === 'failed' ? 'failed' : 'aborted';
  return settleReservation(ctx, reservation, status, {
    result: outcome,
    usage: ledgerUsage(usage),
    actualUsd: actualUsdFrom(usage, reservation.data.budget.modelId),
    reconciled: true,
  });
}

// ---------------------------------------------------------------------------
// Local CLI transport. Deployment and real use are T27-gated; this exists so
// the authorized invocation shape is pinned down and testable WITHOUT AWS.

/**
 * Pure builder for the authorized aws CLI invocation: an ARGUMENT ARRAY
 * (element 0 is the executable), never a shell-concatenated string.
 */
export function buildAwsCliInvokeArgs({ functionArn, profile = 'hk_dev', region = 'us-east-1', payloadPath, responsePath }) {
  for (const [name, v] of [['functionArn', functionArn], ['payloadPath', payloadPath], ['responsePath', responsePath]]) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new LearningError('SCHEMA_VALIDATION', `${name} is required`);
    }
  }
  return [
    'aws',
    '--profile', profile,
    '--region', region,
    'lambda', 'invoke',
    '--function-name', functionArn,
    '--invocation-type', 'RequestResponse',
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `fileb://${payloadPath}`,
    responsePath,
  ];
}

/**
 * createCliTransport({functionArn,profile,region,timeoutMs,spawnFn,fsImpl,
 * osImpl}) -> async transport(request). Writes the payload to a private
 * (0600) temp file in a private (0700) temp dir, invokes the AWS CLI via
 * spawn with the argument array and AWS_MAX_ATTEMPTS=1, reads the private
 * response file and cleans up. On timeout the child is killed and the error
 * carries code 'TIMEOUT' so the caller keeps the reservation unknown.
 * Everything is injectable; tests never spawn a real process.
 */
export function createCliTransport({
  functionArn, profile = 'hk_dev', region = 'us-east-1', timeoutMs = 90_000,
  spawnFn, fsImpl, osImpl,
} = {}) {
  return async function cliTransport(request) {
    const [{ spawn }, fs, os, path] = await Promise.all([
      spawnFn ? Promise.resolve({ spawn: spawnFn }) : import('node:child_process'),
      fsImpl ? Promise.resolve(fsImpl) : import('node:fs'),
      osImpl ? Promise.resolve(osImpl) : import('node:os'),
      import('node:path'),
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-cloud-'), { mode: 0o700 });
    const payloadPath = path.join(dir, 'payload.json');
    const responsePath = path.join(dir, 'response.json');
    try {
      fs.writeFileSync(payloadPath, JSON.stringify(request), { mode: 0o600 });
      const args = buildAwsCliInvokeArgs({ functionArn, profile, region, payloadPath, responsePath });
      await new Promise((resolve, reject) => {
        const child = spawn(args[0], args.slice(1), {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, AWS_MAX_ATTEMPTS: '1' },
          shell: false,
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          const err = new Error('aws lambda invoke timed out');
          err.code = 'TIMEOUT';
          reject(err);
        }, timeoutMs);
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else {
            const err = new Error(`aws lambda invoke exited with code ${code}`);
            err.code = 'INVOKE_FAILED';
            reject(err);
          }
        });
      });
      return JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}
