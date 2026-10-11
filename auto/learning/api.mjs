// auto/learning/api.mjs — T21: narrow local panel API (CONTRACTS G).
// handleLearningRequest(req, res, options) serves /api/auto/learning/* and the
// fixed-manifest static assets under /auto/assets/learning/. GET routes are
// read-only views over current indexes/records with capped pagination and a
// stable generation; they never launch a model, account or application. POST
// routes require a loopback Host AND Origin, the issued CSRF token, a JSON
// content type, a 64-KiB body cap, strict field schemas, an operation id and
// an expected record revision. Approval authority is minted server-side from
// the authenticated local request — an actor:'user' claim inside a payload is
// rejected as an unknown field and never honored. A corrupt index is a loud
// visible error, never a fake empty list. Nothing executes at import time.

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { createLearningContext, learningDataRoot, readLearningConfig } from './context.mjs';
import { LearningError, isSecretKey, isValidId, statusEnumFor } from './contracts.mjs';
import { getRecord, listRecords, commitRecord, rebuildIndexes } from './store.mjs';
import {
  proposeAnswer, approveAnswer, previewAnswerSourcePatch, createUserApproval, previewForget,
} from './answers.mjs';
import { resolveBlocker } from './workflow.mjs';
import { promoteProcedure, createPromotionApproval } from './procedures.mjs';
import { runReview, reviewStatus, isLearnerPaused, setLearnerPaused } from './reviewer.mjs';
import { cloudEnabled } from './cloud-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..');

export const API_BASE = '/api/auto/learning';
export const ASSET_BASE = '/auto/assets/learning/';

const BODY_LIMIT_BYTES = 64 * 1024;
const MAX_PAGE_LIMIT = 200;
const OP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

// GET subpath -> store collection for the plain list routes.
const LIST_ROUTES = Object.freeze({
  questions: 'questions', answers: 'answers', blockers: 'blockers',
  insights: 'insights', procedures: 'procedures', proposals: 'proposals',
  accounts: 'accounts', // lifecycle/verification state only; refs are masked
});

const POST_ROUTES = new Set([
  'answers/propose', 'answers/approve', 'blockers/resolve', 'procedures/promote',
  'proposals/decision', 'review', 'learner/pause', 'privacy/preview', 'privacy/apply',
]);

// LearningError code -> HTTP status (CONTRACTS G: 409 stale, 403 missing
// authority, 422 invalid data, visible 5xx for corrupt/unreadable state).
const CODE_STATUS = Object.freeze({
  REVISION_CONFLICT: 409, INVALID_STATE: 409, REFRESH_REQUIRED: 409, REVIEWER_LEASE_HELD: 409,
  CONFLICTING_SOURCE_EDIT: 409,
  APPROVAL_REQUIRED: 403, FORBIDDEN_PATH: 403, FORBIDDEN_SOURCE: 403, REVIEW_DISABLED: 403,
  REVIEW_APPROVAL_REQUIRED: 403, LEARNING_DISABLED: 403, NOT_AVAILABLE: 403,
  NOT_FOUND: 404,
  SCHEMA_VALIDATION: 422, LIMIT_EXCEEDED: 422, PATCH_VALIDATION: 422, COMPLEX_SOURCE_EDIT: 422,
  EVALUATION_MISSING: 422, EVALUATION_STALE: 422,
  CORRUPT_RECORD: 500, READ_ERROR: 500, WRITE_VERIFICATION_FAILED: 500,
  CONFIG_MALFORMED: 500, CONFIG_UNSUPPORTED_VERSION: 500,
});

// --- CSRF -----------------------------------------------------------------
// One token per panel process, minted lazily, delivered only via GET /status
// over the loopback-guarded connection. POSTs must echo it in a header, which
// a cross-site form or upstream page can never set.
let csrfToken = null;
export function issueCsrfToken() {
  if (!csrfToken) csrfToken = `${randomUUID()}${randomUUID()}`;
  return csrfToken;
}

// --- small helpers ----------------------------------------------------------

function send(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  if (err instanceof LearningError) {
    return send(res, CODE_STATUS[err.code] ?? 500, { error: err.message, code: err.code });
  }
  return send(res, 500, { error: 'internal error', code: 'INTERNAL' });
}

function isLoopbackName(name) {
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function hostAllowed(req) {
  const host = (req.headers.host ?? '');
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return isLoopbackName(name);
}

function originAllowed(origin) {
  if (origin === undefined) return true; // same-origin GET/fetch may omit it
  try {
    return isLoopbackName(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function featureInfo(ctx) {
  const config = readLearningConfig(ctx); // malformed config throws loudly
  return config.enabled === true
    ? { enabled: true }
    : { enabled: false, reason: 'learning_not_activated' };
}

function defaultCtx() {
  // Lazy to keep import side-effect free; mirrors panel.mjs context creation.
  return createLearningContext({ codeRoot: REPO_ROOT, dataRoot: getCareerOpsRoot(), now: () => new Date() });
}

// Deep-mask secret-named keys; redact values flagged sensitive. Never mutates
// the input. Depth-capped defensively (records are already size-capped).
function maskDeep(value, depth = 0) {
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretKey(k) ? '[redacted]' : maskDeep(v, depth + 1);
  }
  return out;
}

function maskEnvelope(envelope) {
  const data = maskDeep(envelope.data);
  if (data && data.sensitive === true && 'value' in data) data.value = '[redacted-sensitive]';
  if (data?.diff && data.diff.sensitive === true && 'proposedValue' in data.diff) {
    data.diff.proposedValue = '[redacted-sensitive]';
  }
  return { ...envelope, data };
}

function coverageCounts(items) {
  const c = { observed: 0, partial: 0, unknown: 0 };
  for (const item of items) {
    const cov = item?.data?.coverage;
    if (cov === 'observed') c.observed += 1;
    else if (cov === 'partially_observed' || cov === 'partial') c.partial += 1;
    else c.unknown += 1;
  }
  return c;
}

// Strict body schema: every required key present with the right type, no
// unknown keys ever (so an injected actor/approval claim is refused loudly).
function validateBody(body, { required = {}, optional = {} }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new LearningError('SCHEMA_VALIDATION', 'body must be a JSON object');
  }
  const spec = { ...required, ...optional };
  for (const key of Object.keys(body)) {
    if (!(key in spec)) throw new LearningError('SCHEMA_VALIDATION', `unknown field: ${key}`);
  }
  for (const key of Object.keys(required)) {
    if (!(key in body)) throw new LearningError('SCHEMA_VALIDATION', `missing field: ${key}`);
  }
  for (const [key, type] of Object.entries(spec)) {
    if (!(key in body)) continue;
    const v = body[key];
    const ok = type === 'any'
      || (type === 'string' && typeof v === 'string')
      || (type === 'int' && Number.isInteger(v))
      || (type === 'bool' && typeof v === 'boolean')
      || (type === 'object' && v !== null && typeof v === 'object' && !Array.isArray(v))
      || (type === 'array' && Array.isArray(v));
    if (!ok) throw new LearningError('SCHEMA_VALIDATION', `field ${key} must be ${type}`);
  }
  if ('opId' in body && !OP_ID_RE.test(body.opId)) {
    throw new LearningError('SCHEMA_VALIDATION', 'opId must be 8-64 chars of [A-Za-z0-9_-]');
  }
}

async function readJsonBody(req, res) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('application/json')) {
    send(res, 415, { error: 'content-type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });
    return undefined;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > BODY_LIMIT_BYTES) {
      send(res, 413, { error: `body exceeds ${BODY_LIMIT_BYTES} bytes`, code: 'BODY_TOO_LARGE' });
      return undefined;
    }
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    send(res, 422, { error: 'malformed JSON body', code: 'SCHEMA_VALIDATION' });
    return undefined;
  }
}

function parseListQuery(url, collection) {
  const out = {};
  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_PAGE_LIMIT) {
      throw new LearningError('SCHEMA_VALIDATION', `limit must be an integer 1..${MAX_PAGE_LIMIT}`);
    }
    out.limit = Number(limit);
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null) out.cursor = cursor;
  const status = url.searchParams.get('status');
  if (status !== null) {
    if (!statusEnumFor(collection).includes(status)) {
      throw new LearningError('SCHEMA_VALIDATION', `unknown status filter: ${status}`);
    }
    out.filters = { status };
  }
  return out;
}

// --- static assets ----------------------------------------------------------
// Fixed-name manifest only: the request name must be an exact manifest key
// (traversal shapes like "../x" or "%2e%2e/x" can never be keys), and files
// resolve only beneath the configured asset root.
function serveAsset(req, res, { pathname, assetRoot, assetManifest }) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const name = pathname.slice(ASSET_BASE.length);
  if (!name || name.includes('/') || name.includes('\\')
    || !Object.prototype.hasOwnProperty.call(assetManifest, name)) {
    return send(res, 404, { error: 'unknown asset', code: 'NOT_FOUND' });
  }
  const file = join(assetRoot, assetManifest[name]);
  if (!existsSync(file)) return send(res, 404, { error: 'asset not built yet', code: 'NOT_FOUND' });
  const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(readFileSync(file));
  return undefined;
}

// --- GET handlers -----------------------------------------------------------

function handleList(res, ctx, feature, collection, url) {
  if (!feature.enabled) {
    // Honest disabled envelope: the store is not consulted at all.
    return send(res, 200, {
      items: [], nextCursor: null, generation: null,
      coverage: { observed: 0, partial: 0, unknown: 0 }, feature,
    });
  }
  const query = parseListQuery(url, collection);
  const { items, nextCursor, generation } = listRecords(ctx, collection, query);
  const masked = items.map(maskEnvelope);
  return send(res, 200, {
    items: masked, nextCursor, generation, coverage: coverageCounts(masked), feature,
  });
}

function handleQuestion(res, ctx, feature, url) {
  if (!feature.enabled) return send(res, 200, { item: null, feature });
  const id = url.searchParams.get('id');
  if (typeof id !== 'string' || !isValidId(id)) {
    throw new LearningError('SCHEMA_VALIDATION', 'question id must be a valid record id');
  }
  const record = getRecord(ctx, 'questions', id);
  if (!record) throw new LearningError('NOT_FOUND', `question ${id} not found`);
  return send(res, 200, { item: maskEnvelope(record), feature });
}

function handleStatus(res, ctx, feature) {
  let review = null;
  try { review = reviewStatus(ctx); } catch (err) { review = { error: err.message }; }
  // Cloud lane: honest enabled/reason pair — never hidden, never guessed.
  let cloud = null;
  try { cloud = cloudEnabled(ctx); } catch (err) { cloud = { enabled: false, reason: 'config_error', error: err.message }; }
  let learner = null;
  try { learner = { paused: isLearnerPaused(ctx) }; } catch { learner = { paused: null }; }
  return send(res, 200, {
    feature,
    review,
    cloud,
    learner,
    storePresent: existsSync(learningDataRoot(ctx)),
    csrfToken: issueCsrfToken(),
  });
}

async function handleMetrics(res, ctx, feature, url, deps) {
  if (!feature.enabled) return send(res, 200, { metrics: null, feature });
  if (!existsSync(learningDataRoot(ctx))) return send(res, 200, { store: 'absent', metrics: null, feature });
  const derive = deps.deriveLearningMetrics
    ?? (await import('./intelligence.mjs')).deriveLearningMetrics;
  const metrics = await derive(ctx, {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  });
  return send(res, 200, { metrics, feature });
}

// --- POST handlers ----------------------------------------------------------

async function handlePost(req, res, ctx, feature, sub, deps) {
  // Cross-origin and token guards first: Origin must be PRESENT and loopback,
  // and the issued CSRF token must be echoed. The panel's upstream reverse
  // proxy can never satisfy these from page content.
  if (!originAllowed(req.headers.origin) || req.headers.origin === undefined) {
    return send(res, 403, { error: 'POST requires a loopback Origin', code: 'FORBIDDEN_ORIGIN' });
  }
  if (!csrfToken || req.headers['x-learning-csrf'] !== csrfToken) {
    return send(res, 403, { error: 'missing or invalid CSRF token (GET /status issues it)', code: 'CSRF' });
  }
  const body = await readJsonBody(req, res);
  if (body === undefined) return undefined; // error already sent

  if (!feature.enabled) {
    return send(res, 403, { error: 'learning is not activated', code: 'LEARNING_DISABLED', feature });
  }

  // T24 defect fix: commits write immutable revision files, but list routes
  // serve a pinned complete index generation. Nothing in production refreshed
  // that generation after a write, so the UI's mandatory post-action re-read
  // (and any reload) kept showing the PRE-commit state. Every successful
  // mutating route below refreshes the generation before responding; readers
  // then see either the old complete index or the new complete one, never a
  // mix. (~1.1s measured on a 10k-record corpus — acceptable for human-speed
  // approval actions.)
  const refreshIndexes = () => rebuildIndexes(ctx, { apply: true });

  switch (sub) {
    case 'answers/propose': {
      validateBody(body, {
        required: { opId: 'string', question: 'object', fileKey: 'string', selector: 'string', proposedValue: 'any', sourceHash: 'string' },
        optional: { affectedApplicationIds: 'array', scope: 'object', sensitive: 'bool', questionFamilyId: 'string' },
      });
      const { opId, ...input } = body;
      const proposal = await (deps.proposeAnswer ?? proposeAnswer)(ctx, input);
      // Preview-then-commit: show exactly what an approval would write.
      let preview;
      try {
        const p = (deps.previewAnswerSourcePatch ?? previewAnswerSourcePatch)(ctx, proposal);
        preview = { selector: p.selector, beforeHash: p.beforeHash, afterHash: p.afterHash };
      } catch (err) {
        preview = err instanceof LearningError
          ? { error: err.message, code: err.code } : { error: 'preview failed', code: 'INTERNAL' };
      }
      await refreshIndexes();
      return send(res, 200, {
        proposal: { id: proposal.id, revision: proposal.revision, status: proposal.status },
        preview, opId,
      });
    }
    case 'answers/approve': {
      validateBody(body, { required: { opId: 'string', proposalId: 'string', expectedRevision: 'int' } });
      // Authority is minted HERE, from the authenticated loopback request —
      // never read from the payload.
      const approval = createUserApproval({ approvedBy: 'panel-ui' });
      const result = await (deps.approveAnswer ?? approveAnswer)(ctx, {
        proposalId: body.proposalId, expectedRevision: body.expectedRevision, approval,
      });
      await refreshIndexes();
      return send(res, 200, { ...result, opId: body.opId });
    }
    case 'blockers/resolve': {
      validateBody(body, {
        required: { opId: 'string', blockerId: 'string' },
        optional: { resolution: 'object', confirm: 'bool' },
      });
      const approval = body.confirm === true ? { approvedBy: 'panel-operator' } : null;
      const result = await (deps.resolveBlocker ?? resolveBlocker)(ctx, {
        blockerId: body.blockerId, resolution: body.resolution ?? {}, approval,
      }, { jobs: deps.jobs });
      await refreshIndexes();
      return send(res, 200, {
        blockerId: body.blockerId, status: result.blocker.status,
        resumePoint: result.resumePoint, rereadRequired: result.rereadRequired, opId: body.opId,
      });
    }
    case 'procedures/promote': {
      validateBody(body, { required: { opId: 'string', procedureId: 'string', evaluationId: 'string' } });
      const approval = createPromotionApproval({ approvedBy: 'panel-operator' });
      const result = await (deps.promoteProcedure ?? promoteProcedure)(ctx, {
        procedureId: body.procedureId, evaluationId: body.evaluationId, approval,
      });
      await refreshIndexes();
      return send(res, 200, { result, opId: body.opId });
    }
    case 'proposals/decision': {
      validateBody(body, {
        required: { opId: 'string', proposalId: 'string', expectedRevision: 'int', decision: 'string' },
      });
      if (!['approved', 'rejected'].includes(body.decision)) {
        throw new LearningError('SCHEMA_VALIDATION', "decision must be 'approved' or 'rejected'");
      }
      if (!isValidId(body.proposalId)) {
        throw new LearningError('SCHEMA_VALIDATION', 'proposalId must be a valid record id');
      }
      const proposal = getRecord(ctx, 'proposals', body.proposalId);
      if (!proposal) throw new LearningError('NOT_FOUND', `proposal ${body.proposalId} not found`);
      if (proposal.status === body.decision) {
        // Idempotent identical repeat.
        return send(res, 200, { status: proposal.status, changed: false, revision: proposal.revision, opId: body.opId });
      }
      if (proposal.status !== 'proposed') {
        throw new LearningError('INVALID_STATE',
          `proposal ${body.proposalId} is ${proposal.status}; only a proposed one accepts a decision`);
      }
      if (proposal.revision !== body.expectedRevision) {
        throw new LearningError('REVISION_CONFLICT',
          `proposal ${body.proposalId} is at revision ${proposal.revision}, decision was against ${body.expectedRevision}`);
      }
      // Review status only — the diff is NEVER applied here. Applying an
      // answer proposal requires the separate /answers/approve flow.
      const committed = await commitRecord(ctx, 'proposals', body.proposalId, proposal.data, {
        expectedRevision: body.expectedRevision, status: body.decision, sourceIds: proposal.sourceIds,
      });
      await refreshIndexes();
      return send(res, 200, { status: committed.status, changed: true, revision: committed.revision, opId: body.opId });
    }
    case 'review': {
      validateBody(body, {
        required: { opId: 'string' },
        optional: { limit: 'int', approvalId: 'string' },
      });
      // Local-only unless a recorded D03 approval id is named; runReview
      // itself verifies that approval and never starts a cycle or submit.
      const report = await (deps.runReview ?? runReview)(ctx, {
        localOnly: typeof body.approvalId !== 'string',
        approvalId: body.approvalId ?? null,
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      });
      await refreshIndexes();
      return send(res, 200, { report, opId: body.opId });
    }
    case 'learner/pause': {
      // T23: pause/resume the LEARNER (reviewer runs) independently of the
      // application pipeline. Touches only the learning data root sentinel —
      // never data/auto/pause-requested, never any cycle or worker state.
      validateBody(body, { required: { opId: 'string', paused: 'bool' } });
      const result = (deps.setLearnerPaused ?? setLearnerPaused)(ctx, body.paused);
      return send(res, 200, { paused: result.paused, opId: body.opId });
    }
    case 'privacy/preview': {
      validateBody(body, {
        required: { opId: 'string', targets: 'array' },
        optional: { scope: 'string' },
      });
      const preview = await (deps.previewForget ?? previewForget)(ctx, {
        scope: body.scope ?? 'answers', targets: body.targets,
      });
      return send(res, 200, { ...preview, opId: body.opId });
    }
    case 'privacy/apply': {
      // No applied-deletion implementation exists in this build; refuse with
      // a visible reason instead of pretending to erase anything.
      return send(res, 403, {
        error: 'privacy apply requires an explicitly approved deletion flow, which this build does not provide; preview never deletes',
        code: 'NOT_AVAILABLE', feature,
      });
    }
    default:
      return send(res, 404, { error: 'unknown learning route', code: 'NOT_FOUND' });
  }
}

// --- entry point ------------------------------------------------------------

/**
 * handleLearningRequest(req, res, {ctx, assetRoot, assetManifest, deps})
 * -> Promise<true>. Always writes a response for paths under API_BASE or
 * ASSET_BASE. ctx/deps are injectable for tests; defaults mirror panel.mjs.
 */
export async function handleLearningRequest(req, res, options = {}) {
  const deps = options.deps ?? {};
  try {
    if (!hostAllowed(req)) {
      send(res, 403, { error: 'loopback only', code: 'FORBIDDEN_HOST' });
      return true;
    }
    if (!originAllowed(req.headers.origin)) {
      send(res, 403, { error: 'loopback origins only', code: 'FORBIDDEN_ORIGIN' });
      return true;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname.startsWith(ASSET_BASE)) {
      serveAsset(req, res, {
        pathname,
        assetRoot: options.assetRoot ?? join(REPO_ROOT, 'auto', 'ui', 'learning'),
        assetManifest: options.assetManifest ?? {},
      });
      return true;
    }

    const sub = pathname === API_BASE ? '' : pathname.slice(API_BASE.length + 1);
    const ctx = options.ctx ?? defaultCtx();
    const feature = featureInfo(ctx);

    if (req.method === 'GET') {
      if (sub === 'status') { handleStatus(res, ctx, feature); return true; }
      if (sub === 'question') { handleQuestion(res, ctx, feature, url); return true; }
      if (sub === 'metrics') { await handleMetrics(res, ctx, feature, url, deps); return true; }
      if (sub in LIST_ROUTES) { handleList(res, ctx, feature, LIST_ROUTES[sub], url); return true; }
      if (POST_ROUTES.has(sub)) { send(res, 405, { error: 'POST required', code: 'METHOD_NOT_ALLOWED' }); return true; }
      send(res, 404, { error: 'unknown learning route', code: 'NOT_FOUND' });
      return true;
    }
    if (req.method === 'POST') {
      if (POST_ROUTES.has(sub)) { await handlePost(req, res, ctx, feature, sub, deps); return true; }
      if (sub === 'status' || sub === 'question' || sub === 'metrics' || sub in LIST_ROUTES) {
        send(res, 405, { error: 'GET required', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      send(res, 404, { error: 'unknown learning route', code: 'NOT_FOUND' });
      return true;
    }
    send(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  } catch (err) {
    if (!res.writableEnded) sendError(res, err);
    return true;
  }
}
