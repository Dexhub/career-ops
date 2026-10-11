// auto/learning/workflow.mjs — T13: persisted answer blockers and
// account-verification waits (CONTRACTS E, D5). Blocked work survives a
// restart as structured records: an account record keyed by employer/ATS
// tenant/login identity (holding a credential REFERENCE only, never
// material), and a blocker record carrying the expected recipient/account
// reference, employer/tenant, request time, bounded check deadline and the
// safe resume point. Resolution routes the SAME application identity back to
// execution — never a new one. Nothing executes at import time, and this
// module never imports core/db.mjs statically: job access goes through an
// injectable `jobs` adapter that defaults to a lazy import of auto/state.mjs.

import { createHash } from 'node:crypto';
import { existsSync as fsExists, readFileSync as fsRead } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { LearningError } from './contracts.mjs';
import { readLearningConfig } from './context.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';

// Job execution phases this layer may set (extends state.mjs's D4 execution
// object; 'preparing' is the safe resume point after a resolved wait).
export const EXECUTION_PHASES = Object.freeze([
  'preparing', 'in_progress', 'waiting_verification', 'blocked', 'finished',
]);

// The existing ~10-minute policy acts as a configurable CEILING on
// verification waits, never an indefinite one; checks happen at bounded
// intervals beneath it.
export const VERIFICATION_CEILING_MINUTES = 10;
export const DEFAULT_CHECK_INTERVAL_MINUTES = 2;

const MINUTE_MS = 60_000;

function sha40(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 40);
}

function assertEnabled(ctx) {
  const config = readLearningConfig(ctx);
  if (!config.enabled) {
    throw new LearningError('SCHEMA_VALIDATION',
      'learning is disabled (config/learning.yml enabled: false) — workflow refused');
  }
  return config;
}

function nonempty(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', `${name} must be a nonempty string`);
  }
  return value;
}

async function jobsApi(jobs) {
  // Injectable in tests; the lazy default keeps core/db.mjs out of this
  // module's import graph until a caller actually touches job state.
  return jobs ?? await import('../state.mjs');
}

async function findJobByApplicationId(state, applicationId) {
  // Legacy rows may predate the applicationId column; derive it the same way
  // migrateJobRecord does instead of silently missing the job.
  const row = state.listJobs().find((j) => (
    j.applicationId ?? (typeof state.applicationIdFor === 'function' ? state.applicationIdFor(j.urlKey) : null)
  ) === applicationId);
  if (!row) {
    throw new LearningError('SCHEMA_VALIDATION', `no job for applicationId ${applicationId}`);
  }
  return typeof state.loadJob === 'function' ? state.loadJob(row.urlKey) : row;
}

// ---------------------------------------------------------------------------
// Account memory (D5): keyed by employer / ATS tenant / login identity — NOT
// by a shared vendor hostname. Two tenants on the same vendor host are two
// accounts; the same tenant for the same login identity is always ONE.

/** Deterministic account id for one employer+tenant+login identity. */
export function accountIdFor({ tenant, employerId, loginIdentityRef } = {}) {
  nonempty('tenant', tenant);
  nonempty('employerId', employerId);
  nonempty('loginIdentityRef', loginIdentityRef);
  return `acct-${sha40(`account:${employerId}:${tenant}:${loginIdentityRef}`)}`;
}

const CREDENTIAL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

/**
 * ensureAccount(ctx,{tenant,employerId,loginIdentityRef,credentialRef,
 * lifecycle,createdAtSource}) -> {account, created}. Idempotent on the
 * account key: an existing record is returned untouched — a pending
 * verification or an unknown password NEVER causes another account to be
 * created. credentialRef is an opaque pointer into the private credential
 * store; anything shaped like credential material is refused here and again
 * by the contracts layer.
 */
export async function ensureAccount(ctx, {
  tenant, employerId, loginIdentityRef, credentialRef = null,
  lifecycle = 'existing', createdAtSource = null,
} = {}) {
  assertEnabled(ctx);
  const id = accountIdFor({ tenant, employerId, loginIdentityRef });
  if (credentialRef !== null
      && (typeof credentialRef !== 'string' || !CREDENTIAL_REF_RE.test(credentialRef))) {
    throw new LearningError('FORBIDDEN_KEY',
      'credentialRef must be a short opaque reference, never credential material');
  }
  const existing = getRecord(ctx, 'accounts', id);
  if (existing) return { account: existing, created: false };
  const status = ['created', 'verification_pending'].includes(lifecycle) ? 'pending' : 'active';
  const account = await commitRecord(ctx, 'accounts', id, {
    tenant, employerId, loginIdentityRef, credentialRef, lifecycle,
    createdAtSource: createdAtSource ?? ctx.now().toISOString(),
    lastUsedAt: null,
  }, { expectedRevision: 0, status, sourceIds: [] });
  return { account, created: true };
}

// ---------------------------------------------------------------------------
// Blocker records (D5): persisted waits with everything needed to resume.

/**
 * openBlocker — idempotent creation keyed on application+type+question(+account).
 * A repeated attempt to open the same wait returns the live record unchanged.
 */
export async function openBlocker(ctx, {
  applicationId, attemptId = null, type, question,
  requiredResolution = null, accountId = null, recipientRef = null,
  employerId = null, tenant = null, requestedAt = null,
  deadline = null, nextCheckAt = null, resumePoint = 'preparing',
  sourceVersions = null, status = 'open',
} = {}) {
  assertEnabled(ctx);
  nonempty('applicationId', applicationId);
  nonempty('type', type);
  nonempty('question', question);
  if (!EXECUTION_PHASES.includes(resumePoint)) {
    throw new LearningError('SCHEMA_VALIDATION', `invalid resumePoint "${String(resumePoint)}"`);
  }
  const id = `blk-${sha40(`blocker:${applicationId}:${type}:${question}:${accountId ?? ''}`)}`;
  const existing = getRecord(ctx, 'blockers', id);
  if (existing && ['open', 'waiting'].includes(existing.status)) {
    return { blocker: existing, created: false };
  }
  if (existing) {
    throw new LearningError('SCHEMA_VALIDATION',
      `blocker ${id} already ${existing.status} — a settled wait is never silently reopened`);
  }
  const blocker = await commitRecord(ctx, 'blockers', id, {
    applicationId, attemptId, type, question, requiredResolution,
    accountId, recipientRef, employerId, tenant,
    requestedAt: requestedAt ?? ctx.now().toISOString(),
    deadline, nextCheckAt, resumePoint,
    ...(sourceVersions ? { sourceVersions } : {}),
  }, { expectedRevision: 0, status, sourceIds: [] });
  return { blocker, created: true };
}

/** First live blocker bound to an attempt, or null. Used by completion routing. */
export function findOpenAttemptBlocker(ctx, attemptId) {
  if (typeof attemptId !== 'string' || attemptId === '') return null;
  const { items } = listRecords(ctx, 'blockers', { limit: 500 });
  return items.find((b) => ['open', 'waiting'].includes(b.status) && b.data.attemptId === attemptId) ?? null;
}

// ---------------------------------------------------------------------------
// CONTRACTS E: checkpointAttempt / resolveBlocker

/**
 * checkpointAttempt(ctx,{applicationId,attemptId,expectedVersion,phase,
 * evidenceRefs}) -> job. Persists executor progress as the job's execution
 * phase under the CAS guard. The attempt must be the one the job's execution
 * record owns — a stale or foreign attempt can never move the job.
 */
export async function checkpointAttempt(ctx, {
  applicationId, attemptId, expectedVersion, phase, evidenceRefs = [],
} = {}, { jobs } = {}) {
  assertEnabled(ctx);
  nonempty('applicationId', applicationId);
  nonempty('attemptId', attemptId);
  if (!EXECUTION_PHASES.includes(phase)) {
    throw new LearningError('SCHEMA_VALIDATION',
      `invalid phase "${String(phase)}" (allowed: ${EXECUTION_PHASES.join(', ')})`);
  }
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some((r) => typeof r !== 'string' || r === '')) {
    throw new LearningError('SCHEMA_VALIDATION', 'evidenceRefs must be an array of nonempty strings');
  }
  const state = await jobsApi(jobs);
  const job = await findJobByApplicationId(state, applicationId);
  if (job.execution?.attemptId !== attemptId) {
    throw new LearningError('SCHEMA_VALIDATION',
      `attempt ${attemptId} does not own application ${applicationId}`);
  }
  return state.updateJob(job.urlKey, {
    expectedVersion,
    patch: { execution: { phase } },
  });
}

/**
 * resolveBlocker(ctx,{blockerId,resolution,approval}) -> result (CONTRACTS E).
 * Resolution rules by type:
 *  - missing_answer: resolution.answerId must name an APPROVED answer record;
 *    the result carries that answer's source version so the resumed operation
 *    loads the approved source and rereads the live field/options.
 *  - verification_pending: normally resolved by checkVerification; a manual
 *    resolution requires an explicit approval.
 *  - captcha / account_conflict: never auto-resolved — require approval
 *    ({approvedBy}). No CAPTCHA is ever bypassed by this layer.
 * The bound job keeps its applicationId; execution returns to the blocker's
 * safe resume point with the blocker cleared. A parked job is NOT force-moved:
 * resuming the same application happens through the ordinary queue.
 */
export async function resolveBlocker(ctx, { blockerId, resolution = {}, approval = null } = {}, { jobs } = {}) {
  assertEnabled(ctx);
  nonempty('blockerId', blockerId);
  const blocker = getRecord(ctx, 'blockers', blockerId);
  if (!blocker) throw new LearningError('SCHEMA_VALIDATION', `unknown blocker ${blockerId}`);
  if (!['open', 'waiting'].includes(blocker.status)) {
    throw new LearningError('SCHEMA_VALIDATION',
      `blocker ${blockerId} is ${blocker.status} — only open/waiting blockers can resolve`);
  }
  const type = blocker.data.type;
  let sourceVersion = null;
  let resolvedResolution;
  if (type === 'missing_answer') {
    nonempty('resolution.answerId', resolution.answerId);
    const answer = getRecord(ctx, 'answers', resolution.answerId);
    if (!answer || answer.status !== 'approved') {
      throw new LearningError('SCHEMA_VALIDATION',
        `blocker ${blockerId} requires an APPROVED answer; ${String(resolution.answerId)} is ${answer?.status ?? 'missing'}`);
    }
    sourceVersion = answer.data.sourceRefs ?? [];
    resolvedResolution = {
      answerId: answer.id, answerRevision: answer.revision,
      resolvedAt: ctx.now().toISOString(),
    };
  } else if (['captcha', 'account_conflict'].includes(type)) {
    if (!approval || typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') {
      throw new LearningError('SCHEMA_VALIDATION',
        `blocker type ${type} requires human approval ({approvedBy}) — never auto-resolved or bypassed`);
    }
    resolvedResolution = { by: approval.approvedBy, resolvedAt: ctx.now().toISOString() };
  } else if (type === 'verification_pending') {
    if (resolution.verifiedAt) {
      resolvedResolution = { verifiedAt: resolution.verifiedAt, resolvedAt: ctx.now().toISOString() };
    } else if (approval && typeof approval.approvedBy === 'string' && approval.approvedBy.trim() !== '') {
      resolvedResolution = { by: approval.approvedBy, resolvedAt: ctx.now().toISOString() };
    } else {
      throw new LearningError('SCHEMA_VALIDATION',
        'verification_pending resolves via checkVerification or explicit approval');
    }
  } else {
    throw new LearningError('SCHEMA_VALIDATION',
      `blocker type ${type} is not resolvable here (submission reconciliation is T14)`);
  }

  const resolved = await commitRecord(ctx, 'blockers', blocker.id,
    { ...blocker.data, resolution: resolvedResolution },
    { expectedRevision: blocker.revision, status: 'resolved', sourceIds: blocker.sourceIds });

  // Route the SAME application back to its safe resume point. The resumed
  // operation must reread the current field/options rather than trusting
  // anything captured before the wait.
  const state = await jobsApi(jobs);
  const job = await findJobByApplicationId(state, blocker.data.applicationId);
  const resumePoint = blocker.data.resumePoint ?? 'preparing';
  const updated = await state.updateJob(job.urlKey, {
    patch: { execution: { phase: resumePoint, blockerId: null } },
  });
  return {
    blocker: resolved,
    job: updated,
    resumePoint,
    sourceVersion,
    rereadRequired: true, // resume rereads the live field/options
  };
}

// ---------------------------------------------------------------------------
// Account-verification waits

function clampCeiling(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return VERIFICATION_CEILING_MINUTES;
  return Math.min(n, VERIFICATION_CEILING_MINUTES);
}

/**
 * beginVerificationWait(ctx,{applicationId,attemptId,account,recipientRef,
 * ceilingMinutes,checkMinutes}) -> {status, account, created, blocker?, job?}.
 * Idempotent end to end: repeated resumes of the same delayed verification
 * reuse the SAME account record and the SAME blocker — waiting can never
 * imply creating another account. An existing account with an unknown
 * password becomes an account_conflict blocker for a human, never a second
 * account. Status: 'ready' | 'waiting' | 'conflict'.
 */
export async function beginVerificationWait(ctx, {
  applicationId, attemptId = null, account: accountInput, recipientRef,
  ceilingMinutes = VERIFICATION_CEILING_MINUTES,
  checkMinutes = DEFAULT_CHECK_INTERVAL_MINUTES,
} = {}, { jobs } = {}) {
  assertEnabled(ctx);
  nonempty('applicationId', applicationId);
  nonempty('recipientRef', recipientRef);
  const { account, created } = await ensureAccount(ctx, {
    ...accountInput,
    lifecycle: accountInput?.lifecycle ?? 'verification_pending',
  });
  const state = await jobsApi(jobs);

  if (!created && account.data.lifecycle === 'password_unknown') {
    // Known account, unknown password: a human decision, never a new account.
    const { blocker } = await openBlocker(ctx, {
      applicationId, attemptId, type: 'account_conflict',
      question: `existing account for ${account.data.employerId}/${account.data.tenant} has an unknown password`,
      accountId: account.id, employerId: account.data.employerId, tenant: account.data.tenant,
      resumePoint: 'preparing',
    });
    const job = await findJobByApplicationId(state, applicationId);
    const updated = await state.updateJob(job.urlKey, {
      patch: { execution: { phase: 'blocked', blockerId: blocker.id } },
    });
    return { status: 'conflict', account, created, blocker, job: updated };
  }

  if (!created && account.status === 'active' && account.data.lifecycle !== 'verification_pending') {
    // Existing authorized account: nothing to wait for.
    return { status: 'ready', account, created };
  }

  const requestedAt = account.data.createdAtSource ?? ctx.now().toISOString();
  const ceiling = clampCeiling(ceilingMinutes);
  const interval = Math.min(Math.max(Number(checkMinutes) || DEFAULT_CHECK_INTERVAL_MINUTES, 1), ceiling);
  const deadline = new Date(Date.parse(requestedAt) + ceiling * MINUTE_MS).toISOString();
  const nextCheckAt = new Date(Math.min(
    Date.parse(requestedAt) + interval * MINUTE_MS, Date.parse(deadline))).toISOString();
  const { blocker } = await openBlocker(ctx, {
    applicationId, attemptId, type: 'verification_pending',
    question: `account verification pending for ${account.data.employerId}/${account.data.tenant}`,
    accountId: account.id, recipientRef,
    employerId: account.data.employerId, tenant: account.data.tenant,
    requestedAt, deadline, nextCheckAt, resumePoint: 'preparing', status: 'waiting',
  });
  const job = await findJobByApplicationId(state, applicationId);
  const updated = await state.updateJob(job.urlKey, {
    patch: { execution: { phase: 'waiting_verification', blockerId: blocker.id } },
  });
  return { status: 'waiting', account, created, blocker, job: updated };
}

/**
 * checkVerification(ctx,{blockerId,mailbox,now}) -> {status,...}. Retrieval
 * happens ONLY through the injected, already-authorized transport, with a
 * narrowly scoped query (expected recipient + tenant + request time). Every
 * candidate message is validated — sender tenant, recipient, timing after the
 * request, expected destination host — before it counts; stale or
 * other-employer messages are rejected. Nothing from the message (link, code)
 * is ever stored; only the verification FACT is. Checks are bounded by the
 * blocker's deadline: past it the wait expires instead of running forever.
 * Status: 'verified' | 'waiting' | 'expired'.
 */
export async function checkVerification(ctx, { blockerId, mailbox, now } = {}, { jobs } = {}) {
  assertEnabled(ctx);
  nonempty('blockerId', blockerId);
  if (!mailbox || typeof mailbox.search !== 'function') {
    throw new LearningError('SCHEMA_VALIDATION', 'checkVerification requires an authorized mailbox transport');
  }
  const blocker = getRecord(ctx, 'blockers', blockerId);
  if (!blocker || blocker.data.type !== 'verification_pending') {
    throw new LearningError('SCHEMA_VALIDATION', `blocker ${blockerId} is not a verification wait`);
  }
  if (!['open', 'waiting'].includes(blocker.status)) {
    throw new LearningError('SCHEMA_VALIDATION', `blocker ${blockerId} is ${blocker.status}`);
  }
  const at = now instanceof Date ? now : ctx.now();
  const { recipientRef, tenant, requestedAt, deadline, accountId } = blocker.data;

  // Narrowly scoped search: recipient, sender tenant, and request time are
  // ALWAYS part of the query — never a broad mailbox read.
  const messages = await mailbox.search({ recipientRef, tenant, since: requestedAt });
  const requestedMs = Date.parse(requestedAt);
  const match = (Array.isArray(messages) ? messages : []).find((m) => m
    && m.recipientRef === recipientRef
    && m.tenant === tenant
    && m.kind === 'verification'
    && Number.isFinite(Date.parse(m.sentAt)) && Date.parse(m.sentAt) >= requestedMs
    && m.destinationHost === tenant);

  const state = await jobsApi(jobs);
  if (match) {
    // Mark the account verified/active. No link, code, or message body is
    // persisted — the verification fact and timing only.
    const account = getRecord(ctx, 'accounts', accountId);
    if (account) {
      await commitRecord(ctx, 'accounts', account.id,
        { ...account.data, lifecycle: 'verified', lastUsedAt: at.toISOString() },
        { expectedRevision: account.revision, status: 'active', sourceIds: account.sourceIds });
    }
    const result = await resolveBlocker(ctx, {
      blockerId, resolution: { verifiedAt: at.toISOString() },
    }, { jobs: state });
    return { status: 'verified', account: getRecord(ctx, 'accounts', accountId), ...result };
  }

  if (deadline && at.getTime() >= Date.parse(deadline)) {
    const expired = await commitRecord(ctx, 'blockers', blocker.id, blocker.data,
      { expectedRevision: blocker.revision, status: 'expired', sourceIds: blocker.sourceIds });
    const job = await findJobByApplicationId(state, blocker.data.applicationId);
    const updated = await state.updateJob(job.urlKey, {
      patch: { execution: { phase: 'blocked' }, lastError: 'account verification expired' },
    });
    return { status: 'expired', blocker: expired, job: updated };
  }

  // Still waiting: persist the bounded nextCheckAt and yield. Other safe form
  // sections may proceed in the meantime; that is the caller's loop.
  const nextCheckAt = new Date(Math.min(
    at.getTime() + DEFAULT_CHECK_INTERVAL_MINUTES * MINUTE_MS,
    deadline ? Date.parse(deadline) : Infinity)).toISOString();
  const updatedBlocker = await commitRecord(ctx, 'blockers', blocker.id,
    { ...blocker.data, nextCheckAt },
    { expectedRevision: blocker.revision, status: 'waiting', sourceIds: blocker.sourceIds });
  return { status: 'waiting', nextCheckAt, blocker: updatedBlocker };
}

// ---------------------------------------------------------------------------
// Orchestrator sweep: consume T08 notifications. invalidateSource bumps a
// bound blocker's nextCheckAt; approveAnswer creates the approved answer. The
// sweep resolves due missing_answer blockers whose required answer is now
// approved — e.g. an answer supplied while the browser was closed — so the
// SAME application resumes through the ordinary queue. CAPTCHA, verification
// and account conflicts are never auto-resolved here.
export async function sweepDueBlockers(ctx, { now, jobs } = {}) {
  assertEnabled(ctx);
  const at = now instanceof Date ? now : ctx.now();
  const state = await jobsApi(jobs);
  const summary = { checked: 0, resolved: [], skipped: [] };
  const { items } = listRecords(ctx, 'blockers', { limit: 500 });
  const { items: answers } = listRecords(ctx, 'answers', { limit: 500 });
  for (const b of items) {
    if (!['open', 'waiting'].includes(b.status)) continue;
    if (b.data.type !== 'missing_answer') { summary.skipped.push(b.id); continue; }
    const due = b.data.nextCheckAt == null || Date.parse(b.data.nextCheckAt) <= at.getTime();
    if (!due) { summary.skipped.push(b.id); continue; }
    summary.checked += 1;
    const answer = answers.find((a) => a.status === 'approved'
      && b.data.requiredResolution != null
      && a.data.questionFamilyId === b.data.requiredResolution);
    if (!answer) { summary.skipped.push(b.id); continue; }
    const result = await resolveBlocker(ctx, {
      blockerId: b.id, resolution: { answerId: answer.id },
    }, { jobs: state });
    summary.resolved.push({ blockerId: b.id, answerId: answer.id, urlKey: result.job.urlKey });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// T14 (CONTRACTS D4): submission-outcome recovery. The safety boundary is the
// persisted attempt intent, written BEFORE any submission-capable executor
// launches. After that point a crash, kill, or timeout can never be classified
// "didn't submit" from the worker's own narrative: only read-only
// reconciliation against bound evidence (or an explicit human/portal-review
// resolution) settles the outcome. Unknown stays unknown — parked with a
// structured submission_unknown blocker — and the shared requeue path refuses
// to retry it (state.mjs, code SUBMISSION_OUTCOME_UNKNOWN).

/**
 * recordAttemptIntent(ctx,{applicationId,attemptId,urlKey,...}) -> record.
 * Persists the exact job identity and policy intent for one immutable attempt
 * with submissionPossible: true, status 'intended'. Must be committed before
 * the executor launches; a persistence failure must abort the launch.
 */
export async function recordAttemptIntent(ctx, {
  applicationId, attemptId, urlKey, allowedAction = 'submit',
  policyVersion = null, sourceVersion = null, procedureVersion = null,
  employerId = null, tenant = null, requisitionId = null, accountId = null,
  allocatedAt = null,
} = {}) {
  assertEnabled(ctx);
  nonempty('applicationId', applicationId);
  nonempty('attemptId', attemptId);
  nonempty('urlKey', urlKey);
  const existing = getRecord(ctx, 'attempts', attemptId);
  if (existing) {
    throw new LearningError('SCHEMA_VALIDATION',
      `attempt intent ${attemptId} already exists — attempts are immutable, allocate a fresh one`);
  }
  return commitRecord(ctx, 'attempts', attemptId, {
    applicationId, attemptId, urlKey, allowedAction,
    submissionPossible: true,
    policyVersion, sourceVersion, procedureVersion,
    employerId, tenant, requisitionId, accountId,
    allocatedAt: allocatedAt ?? ctx.now().toISOString(),
    launchedAt: null,
    verdicts: [],
  }, { expectedRevision: 0, status: 'intended', sourceIds: [] });
}

/**
 * markAttemptLaunched — the trusted parent (never the executor) records that
 * the submission-capable executor is about to run. From here on, only
 * reconcileAttempt can settle the outcome. A failure to mark must abort the
 * launch: an unlaunched 'intended' record safely reconciles to
 * definitely_not_submitted.
 */
export async function markAttemptLaunched(ctx, { attemptId, launchedAt = null } = {}) {
  assertEnabled(ctx);
  nonempty('attemptId', attemptId);
  const intent = getRecord(ctx, 'attempts', attemptId);
  if (!intent) throw new LearningError('SCHEMA_VALIDATION', `unknown attempt intent ${attemptId}`);
  if (intent.status !== 'intended') {
    throw new LearningError('SCHEMA_VALIDATION',
      `attempt ${attemptId} is ${intent.status} — launch can only follow 'intended'`);
  }
  return commitRecord(ctx, 'attempts', attemptId,
    { ...intent.data, launchedAt: launchedAt ?? ctx.now().toISOString() },
    { expectedRevision: intent.revision, status: 'launched', sourceIds: intent.sourceIds });
}

// Identity fields a confirmation must bind when the intent knows them.
const BINDING_KEYS = Object.freeze(['employerId', 'tenant', 'requisitionId', 'accountId']);

/**
 * Structured confirmation validation. Only a capture that binds the attempt
 * AND the employer/requisition/account identity (as available on the intent)
 * AND retains its source artifact counts. File existence, an unrelated
 * thank-you page (identity mismatch), or an agent's success sentence can
 * never pass here — they are not structured, bound captures.
 */
function confirmationVerdict(intent, conf) {
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) {
    return { ok: false, reason: 'no structured confirmation capture' };
  }
  if (conf.attemptId !== intent.data.attemptId) {
    return { ok: false, reason: 'confirmation does not bind this attempt (stale or foreign capture)' };
  }
  if (typeof conf.sourceArtifact !== 'string' || conf.sourceArtifact.trim() === '') {
    return { ok: false, reason: 'confirmation retains no source artifact' };
  }
  const capturedMs = Date.parse(conf.capturedAt ?? '');
  if (!Number.isFinite(capturedMs)) {
    return { ok: false, reason: 'confirmation has no parseable capturedAt' };
  }
  const allocatedMs = Date.parse(intent.data.allocatedAt ?? '');
  if (Number.isFinite(allocatedMs) && capturedMs < allocatedMs) {
    return { ok: false, reason: 'confirmation predates this attempt (old capture reused)' };
  }
  let bound = 0;
  for (const key of BINDING_KEYS) {
    const expected = intent.data[key];
    if (expected == null) continue; // identity the intent never knew cannot bind
    if (conf[key] == null) {
      return { ok: false, reason: `confirmation missing ${key} binding` };
    }
    if (conf[key] !== expected) {
      return { ok: false, reason: `confirmation contradicts intent on ${key}` };
    }
    bound += 1;
  }
  if (bound === 0) {
    return { ok: false, reason: 'confirmation binds no employer/requisition/account identity' };
  }
  return { ok: true, ref: conf.sourceArtifact };
}

function readConfirmationCapture(auditDir) {
  const path = pathJoin(auditDir, 'learning', 'confirmation.json');
  if (!fsExists(path)) return null;
  try {
    const parsed = JSON.parse(fsRead(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? { conf: parsed, ref: 'learning/confirmation.json' } : null;
  } catch {
    return null; // unparseable capture is NOT evidence
  }
}

/**
 * reconcileAttempt(ctx,{applicationId,attemptId,evidence}) ->
 * {status,evidenceRefs,reason} with status
 * confirmed | definitely_not_submitted | unknown (CONTRACTS reconcileAttempt).
 *
 * Read-only with respect to the outside world; locally it appends a verdict
 * to the attempt's history (prior verdicts and evidence are retained, never
 * replaced), routes the job's execution record, and opens/resolves the
 * submission_unknown blocker.
 *
 * evidence: {
 *   auditDir?    — attempt audit dir; learning/confirmation.json is read as
 *                  the structured capture (result.json narratives never count),
 *   confirmation? — structured capture object (same validation),
 *   resolution?  — explicit read-only portal review or human resolution:
 *                  {outcome:'submitted'|'not_submitted', by, checkedAt?}.
 * }
 */
export async function reconcileAttempt(ctx, { applicationId, attemptId, evidence = {} } = {}, { jobs } = {}) {
  assertEnabled(ctx);
  nonempty('applicationId', applicationId);
  nonempty('attemptId', attemptId);

  const intent = getRecord(ctx, 'attempts', attemptId);
  if (!intent) {
    // No persisted intent: this layer cannot prove anything either way, and it
    // must not touch job records it never claimed. Conservative, side-effect
    // free unknown.
    return { status: 'unknown', evidenceRefs: [], reason: 'no persisted attempt intent' };
  }
  if (intent.data.applicationId !== applicationId) {
    throw new LearningError('SCHEMA_VALIDATION',
      `attempt ${attemptId} belongs to application ${intent.data.applicationId}, not ${applicationId}`);
  }

  // Gather structured evidence. The executor's result.json / success sentence
  // and bare file existence are deliberately never read here.
  const evidenceRefs = [];
  let conf = null;
  if (evidence.confirmation && typeof evidence.confirmation === 'object') {
    conf = evidence.confirmation;
  } else if (typeof evidence.auditDir === 'string' && evidence.auditDir !== '') {
    const read = readConfirmationCapture(evidence.auditDir);
    if (read) { conf = read.conf; }
  }
  const resolution = evidence.resolution && typeof evidence.resolution === 'object'
    ? evidence.resolution : null;

  let status; let reason; let confirmationRef = null;
  if (intent.status === 'intended') {
    // The trusted parent never marked a launch: the executor never ran.
    status = 'definitely_not_submitted';
    reason = 'executor never launched for this attempt';
  } else if (resolution !== null) {
    if (!['submitted', 'not_submitted'].includes(resolution.outcome)
        || typeof resolution.by !== 'string' || resolution.by.trim() === '') {
      throw new LearningError('SCHEMA_VALIDATION',
        'resolution evidence requires outcome submitted|not_submitted and a nonempty by');
    }
    if (resolution.outcome === 'submitted') {
      status = 'confirmed';
      confirmationRef = `resolution:${resolution.by}`;
      reason = `resolved as submitted by ${resolution.by}`;
    } else {
      status = 'definitely_not_submitted';
      reason = `resolved as not submitted by ${resolution.by}`;
    }
    evidenceRefs.push(confirmationRef ?? `resolution:${resolution.by}`);
  } else {
    const v = confirmationVerdict(intent, conf);
    if (v.ok) {
      status = 'confirmed';
      confirmationRef = v.ref;
      evidenceRefs.push(v.ref);
      reason = 'structured confirmation binds attempt and employer identity with retained source';
    } else {
      status = 'unknown';
      reason = v.reason;
    }
  }

  // A settled attempt is never un-settled by weaker evidence; the re-check is
  // still appended to the verdict history.
  if (['confirmed', 'definitely_not_submitted'].includes(intent.status) && status === 'unknown') {
    status = intent.status;
    reason = `already ${intent.status}; prior verdicts retained (${reason})`;
  }

  const verdict = {
    status, reason, evidenceRefs: [...evidenceRefs],
    reconciledAt: ctx.now().toISOString(),
  };
  const updatedIntent = await commitRecord(ctx, 'attempts', intent.id,
    { ...intent.data, verdicts: [...(intent.data.verdicts ?? []), verdict] },
    { expectedRevision: intent.revision, status, sourceIds: intent.sourceIds });

  // Route the job (same application identity) and the submission_unknown
  // blocker. Only the attempt that owns the job's execution record may move
  // it; a newer attempt's state is never clobbered by an old reconciliation.
  const state = await jobsApi(jobs);
  let job = null;
  try {
    job = typeof state.loadJob === 'function' ? state.loadJob(intent.data.urlKey) : null;
  } catch { job = null; }
  const owns = job?.execution?.attemptId === attemptId;
  let blockerId = job?.execution?.blockerId ?? null;

  if (status === 'unknown') {
    const { blocker } = await openBlocker(ctx, {
      applicationId, attemptId, type: 'submission_unknown',
      question: `submission outcome unknown for attempt ${attemptId}`,
      employerId: intent.data.employerId, tenant: intent.data.tenant,
      resumePoint: 'preparing',
    });
    blockerId = blocker.id;
    if (owns) {
      await state.updateJob(job.urlKey, {
        patch: { execution: { submissionOutcome: 'unknown', phase: 'blocked', blockerId: blocker.id } },
      });
    }
  } else {
    // Settled either way: resolve the live submission_unknown wait, if any.
    const open = findOpenAttemptBlocker(ctx, attemptId);
    if (open && open.data.type === 'submission_unknown') {
      await commitRecord(ctx, 'blockers', open.id,
        { ...open.data, resolution: { outcome: status, resolvedAt: ctx.now().toISOString() } },
        { expectedRevision: open.revision, status: 'resolved', sourceIds: open.sourceIds });
    }
    if (owns) {
      await state.updateJob(job.urlKey, {
        patch: {
          execution: {
            submissionOutcome: status,
            blockerId: null,
            ...(status === 'confirmed' ? { phase: 'finished', confirmationRef } : {}),
          },
        },
      });
    }
  }

  return {
    status, evidenceRefs: verdict.evidenceRefs, reason,
    ...(status === 'unknown' ? { blockerId } : {}),
    attempt: updatedIntent,
  };
}
