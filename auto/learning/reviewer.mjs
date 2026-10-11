// auto/learning/reviewer.mjs — bounded incremental reviewer (T19, CONTRACTS
// D7/F). Persists a high-water mark over settled attempt IDs/revisions, a
// reviewer lease, a due time and one active run ID; processes deterministic
// source batches; computes deterministic failure/reuse/cost summaries FIRST
// and invokes optional cloud analysis only when needed, budget-permitted and
// covered by a recorded D03 approval. Creates evidence-linked proposals that
// are always inert: code/UI proposals are suggested diffs or notes, never
// executed. The reviewer can NEVER start a cycle, submit an application,
// change desired application-running state, or enable a launchd schedule —
// no such capability is imported or reachable from this module.
// Nothing executes at import time. Never imports core/db.mjs.

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readdirSync, readFileSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { LearningError, LIMITS, isValidId } from './contracts.mjs';
import { learningDataRoot, readLearningConfig } from './context.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';
import { cloudEnabled, invokeCloudAnalysis, REQUEST_LIMITS } from './cloud-client.mjs';

export const REVIEWER_STATE_VERSION = 1;
const LEASE_TTL_MS = 30 * 60_000;
const DEFAULT_TIME_LIMIT_MS = 60_000;
const REV_FILE_RE = /^(\d{1,9})\.json$/;
// Attempt statuses that are settled facts; everything else stays explicitly
// pending (reported each run, never silently skipped past).
const SETTLED_ATTEMPT_STATUSES = new Set(['confirmed', 'definitely_not_submitted']);
const PROPOSAL_KINDS = ['answer', 'procedure', 'config', 'code', 'ui', 'positioning'];
// Keys through which a candidate could try to smuggle authority or execution.
const SELF_AUTHORITY_KEYS = ['approved', 'approvedBy', 'approvalRef', 'autoApply', 'apply', 'execute', 'run'];

// ---------------------------------------------------------------------------
// Reviewer state: data/auto/learning/reviewer/state.json, mutated only under
// a pipeline lock with atomic temp+fsync+rename writes.

function statePath(ctx) {
  return join(learningDataRoot(ctx), 'reviewer', 'state.json');
}

function stateLockPath(ctx) {
  return join(learningDataRoot(ctx), 'locks', 'reviewer-state');
}

function writeFileAtomic(targetPath, content) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

function defaultState() {
  return {
    schemaVersion: REVIEWER_STATE_VERSION,
    enabledAt: null,       // interval cadence applies only after enabling
    intervalMinutes: 360,
    dueAt: null,
    lastRunAt: null,
    lease: null,           // {owner, acquiredAt, expiresAt}
    activeRunId: null,     // at most ONE active run
    cursor: { processed: {}, updatedAt: null }, // high-water: sourceId -> revision
  };
}

/** readReviewerState(ctx) -> state. Missing file yields disabled defaults;
 *  a malformed or future-versioned file throws, never guessed at. */
export function readReviewerState(ctx) {
  const path = statePath(ctx);
  if (!existsSync(path)) return defaultState();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new LearningError('CORRUPT_RECORD', `malformed reviewer state: ${path}`);
  }
  if (parsed?.schemaVersion !== REVIEWER_STATE_VERSION) {
    throw new LearningError('UNSUPPORTED_SCHEMA_VERSION',
      `unsupported reviewer state version ${String(parsed?.schemaVersion)} (supported: ${REVIEWER_STATE_VERSION})`);
  }
  const base = defaultState();
  return {
    ...base,
    ...parsed,
    cursor: { ...base.cursor, ...(parsed.cursor && typeof parsed.cursor === 'object' ? parsed.cursor : {}) },
  };
}

async function mutateState(ctx, fn) {
  return withPipelineLock(stateLockPath(ctx), async () => {
    const state = readReviewerState(ctx);
    fn(state);
    writeFileAtomic(statePath(ctx), JSON.stringify(state, null, 2));
    return state;
  });
}

// ---------------------------------------------------------------------------
// Learner pause (T23): one sentinel under the LEARNING data root. Pausing the
// learner blocks review runs (local and cloud) independently of the
// application pipeline — this module never touches the pipeline's own
// data/auto/pause-requested sentinel. Live capture during applications still
// follows config/learning.yml `enabled`.

export function learnerPausePath(ctx) {
  return join(learningDataRoot(ctx), 'pause-requested');
}

export function isLearnerPaused(ctx) {
  return existsSync(learnerPausePath(ctx));
}

/** setLearnerPaused(ctx, paused) -> {paused}. Atomic write / idempotent rm. */
export function setLearnerPaused(ctx, paused) {
  const path = learnerPausePath(ctx);
  if (paused === true) {
    writeFileAtomic(path, `${JSON.stringify({ pausedAt: ctx.now().toISOString() })}\n`);
  } else {
    rmSync(path, { force: true });
  }
  return { paused: existsSync(path) };
}

// ---------------------------------------------------------------------------
// Due-time logic (pure).

/**
 * reviewDue(state, now) -> boolean (CONTRACTS D7). Pure over the persisted
 * state. The default interval applies only after review was enabled
 * (state.enabledAt set by the first run). Missed intervals coalesce: however
 * long the machine slept, "due" is a single boolean and one catch-up run
 * resets dueAt — intervals are never replayed one-for-one. A backward clock
 * shift that leaves dueAt more than one interval in the future triggers one
 * resynchronizing run rather than freezing reviews until the wall clock
 * catches back up.
 */
export function reviewDue(state, now) {
  if (!state || typeof state !== 'object' || !state.enabledAt) return false;
  if (!state.dueAt) return true;
  const due = Date.parse(state.dueAt);
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(due) || !Number.isFinite(t)) return false;
  const intervalMs = (Number.isFinite(state.intervalMinutes) ? state.intervalMinutes : 360) * 60_000;
  if (due - t > intervalMs) return true; // backward clock shift: resync once
  return t >= due;
}

/**
 * reviewStatus(ctx) -> informational snapshot for the panel. Strictly
 * read-only: never acquires the lease, never writes state, never starts
 * anything. Config/state errors degrade to "not due" rather than throwing
 * into the panel.
 */
export function reviewStatus(ctx) {
  const paused = isLearnerPaused(ctx);
  let config;
  try {
    config = readLearningConfig(ctx);
  } catch {
    return { enabled: false, reviewEnabled: false, paused, due: false };
  }
  if (!config.enabled || !config.review.enabled) {
    return { enabled: config.enabled, reviewEnabled: false, paused, due: false };
  }
  let state;
  try {
    state = readReviewerState(ctx);
  } catch {
    return { enabled: true, reviewEnabled: true, paused, due: false };
  }
  // Enabled in config but never run: the first run is due immediately. A
  // paused learner is never "due" — the pause is visible, not silently late.
  const due = !paused && (state.enabledAt ? reviewDue(state, ctx.now()) : true);
  return {
    enabled: true,
    reviewEnabled: true,
    paused,
    due,
    dueAt: state.dueAt,
    lastRunAt: state.lastRunAt,
    activeRunId: state.activeRunId,
    cursor: {
      processed: Object.keys(state.cursor?.processed ?? {}).length,
      updatedAt: state.cursor?.updatedAt ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Cloud approval gate (D03): a RECORDED approval, not a credential profile.

/**
 * verifyCloudApproval(ctx, approvalId) -> approval record. The cloud-enabled
 * variant requires a recorded D03 approval: a `proposals` record, committed by
 * the operator surface, with status 'approved' and 'D03' in its
 * requiredApprovals. The presence of an AWS credential profile (or any cloud
 * config) is never sufficient, and a model/agent-supplied claim cannot mint
 * such a record through this module.
 */
export function verifyCloudApproval(ctx, approvalId) {
  const refused = () => new LearningError('REVIEW_APPROVAL_REQUIRED',
    'cloud review requires a recorded D03 approval record; an AWS credential profile is never sufficient');
  if (typeof approvalId !== 'string' || !isValidId(approvalId)) throw refused();
  let record = null;
  try {
    record = getRecord(ctx, 'proposals', approvalId);
  } catch {
    throw refused();
  }
  const approvals = record?.data?.requiredApprovals;
  if (!record || record.status !== 'approved' || !Array.isArray(approvals) || !approvals.includes('D03')) {
    throw refused();
  }
  return record;
}

// ---------------------------------------------------------------------------
// Proposal screening and persistence. Proposals are always inert records.

/**
 * screenProposalCandidate(spec) -> {ok, code?, reason?}. Rejects any candidate
 * that attempts to grant itself authority: a pre-approved status, a waived or
 * emptied approval gate, or execution/approval flags. Candidates can only ever
 * become status 'proposed' records whose approval gate includes the user.
 */
export function screenProposalCandidate(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, code: 'SCHEMA_VALIDATION', reason: 'candidate must be a plain object' };
  }
  if (!PROPOSAL_KINDS.includes(spec.kind)) {
    return { ok: false, code: 'SCHEMA_VALIDATION', reason: `unknown proposal kind: ${String(spec.kind)}` };
  }
  if (spec.status !== undefined && spec.status !== 'proposed' && spec.status !== 'draft') {
    return { ok: false, code: 'PROPOSAL_SELF_AUTHORITY', reason: 'a candidate may not arrive pre-approved or applied' };
  }
  if (spec.requiredApprovals !== undefined
    && (!Array.isArray(spec.requiredApprovals) || spec.requiredApprovals.length === 0)) {
    return { ok: false, code: 'PROPOSAL_SELF_AUTHORITY', reason: 'a candidate may not waive its approval gate' };
  }
  for (const key of SELF_AUTHORITY_KEYS) {
    if (key in spec) {
      return { ok: false, code: 'PROPOSAL_SELF_AUTHORITY', reason: `forbidden authority/execution key: ${key}` };
    }
  }
  return { ok: true };
}

/** Deterministic proposal id by affected component/source/version: the
 *  duplicate-suppression key. */
export function proposalIdFor({ kind, component, source, version }) {
  const digest = createHash('sha256')
    .update(`${kind}|${component}|${source}|${version}`)
    .digest('hex').slice(0, 24);
  return `prop-review-${digest}`;
}

/**
 * persistProposal(ctx, spec) -> {action:'created'|'updated', envelope}.
 * Screens the candidate, then either creates a 'proposed' record or — for a
 * duplicate component/source/version — commits a new revision of the existing
 * record retaining its status while merging the additional supporting
 * evidence. Code/UI proposals carry an inert suggested diff/note in `diff`;
 * nothing in this module (or the review loop) ever executes it.
 */
export async function persistProposal(ctx, spec) {
  const screened = screenProposalCandidate(spec);
  if (!screened.ok) {
    throw new LearningError(screened.code, screened.reason);
  }
  const id = proposalIdFor(spec);
  const evidenceIds = [...new Set(spec.evidenceIds ?? [])].slice(0, LIMITS.maxArrayLength);
  const existing = getRecord(ctx, 'proposals', id);
  if (existing) {
    const merged = [...new Set([...(existing.data.evidenceIds ?? []), ...evidenceIds])]
      .slice(0, LIMITS.maxArrayLength);
    if (merged.length === (existing.data.evidenceIds ?? []).length) {
      return { action: 'unchanged', envelope: existing };
    }
    const envelope = await commitRecord(ctx, 'proposals', id,
      { ...existing.data, evidenceIds: merged },
      { expectedRevision: existing.revision, status: existing.status, sourceIds: merged.slice(0, LIMITS.maxSourceIds) });
    return { action: 'updated', envelope };
  }
  const requiredApprovals = [...new Set(['user', ...(spec.requiredApprovals ?? [])])];
  const envelope = await commitRecord(ctx, 'proposals', id, {
    kind: spec.kind,
    evidenceIds,
    intendedBenefit: spec.intendedBenefit ?? null, // why this is useful
    risk: spec.risk ?? 'low',
    baseline: spec.baseline ?? null,               // measured starting point
    evaluationResult: null,                        // actual evaluation, pending
    affectedSources: spec.affectedSources ?? [],   // expected scope
    requiredApprovals,                             // approval gate
    rollbackVersion: null,
    diff: typeof spec.diff === 'string' ? spec.diff : null, // inert note/diff
  }, { expectedRevision: 0, status: 'proposed', sourceIds: evidenceIds.slice(0, LIMITS.maxSourceIds) });
  return { action: 'created', envelope };
}

// ---------------------------------------------------------------------------
// Deterministic source gathering. Revision heads are read from directory
// names only (no JSON parse), so one malformed record can never block the
// scan; its JSON is parsed per-record inside the batch loop under try/catch.

function attemptHeads(ctx) {
  const root = join(learningDataRoot(ctx), 'records', 'attempts');
  let ids = [];
  try {
    ids = readdirSync(root);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const heads = [];
  for (const id of ids.filter(isValidId).sort()) {
    let names = [];
    try {
      names = readdirSync(join(root, id));
    } catch { continue; }
    let latest = 0;
    for (const name of names) {
      const m = REV_FILE_RE.exec(name);
      if (m) latest = Math.max(latest, Number(m[1]));
    }
    if (latest > 0) heads.push({ id, revision: latest });
  }
  return heads;
}

// ---------------------------------------------------------------------------
// Deterministic local summaries (always computed FIRST, before any model).

function summarizeBatch(batch) {
  const outcomes = {};
  const failuresByTenant = {};
  let failures = 0;
  for (const r of batch) {
    outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
    if (r.status === 'definitely_not_submitted') {
      failures += 1;
      const tenant = r.data?.tenant ?? 'unknown';
      failuresByTenant[tenant] = (failuresByTenant[tenant] ?? 0) + 1;
    }
  }
  return { attempts: batch.length, outcomes, failures, failuresByTenant };
}

function summarizeReuse(ctx, batchAttemptIds) {
  const dispositions = {};
  if (batchAttemptIds.size === 0) return { dispositions };
  try {
    let cursor;
    let pages = 0;
    do {
      const page = listRecords(ctx, 'observations', { cursor, limit: 500 });
      for (const o of page.items) {
        if (!batchAttemptIds.has(o.data?.attemptId)) continue;
        const d = o.data?.answerDisposition ?? 'unanswered';
        dispositions[d] = (dispositions[d] ?? 0) + 1;
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 4);
    return { dispositions, truncated: Boolean(cursor) };
  } catch (err) {
    return { dispositions, unavailable: err?.code ?? 'READ_ERROR' };
  }
}

function summarizeCost(ctx, nowIso) {
  try {
    const { items } = listRecords(ctx, 'reviewRuns', { limit: 500 });
    const reservations = items.filter((r) => r.data?.budget?.kind === 'cloud_reservation');
    const today = nowIso.slice(0, 10);
    const todays = reservations.filter((r) => (r.data.startedAt ?? '').slice(0, 10) === today);
    const reservedUsdToday = todays.filter((r) => r.status !== 'failed')
      .reduce((sum, r) => sum + (r.data.outcomes?.actualUsd ?? r.data.budget?.estUsd ?? 0), 0);
    return {
      reservations: reservations.length,
      todayCalls: todays.length,
      reservedUsdToday,
      unresolved: reservations.filter((r) => r.status === 'running').length,
    };
  } catch (err) {
    return { unavailable: err?.code ?? 'READ_ERROR' };
  }
}

function localProposalSpecs(summary, batch) {
  const specs = [];
  for (const [tenant, count] of Object.entries(summary.failuresByTenant)) {
    if (count < 2) continue; // one-off failures are evidence, not yet a pattern
    const evidenceIds = batch
      .filter((r) => r.status === 'definitely_not_submitted' && (r.data?.tenant ?? 'unknown') === tenant)
      .map((r) => r.id);
    specs.push({
      kind: 'procedure',
      component: 'procedure',
      source: `tenant:${tenant}`,
      version: 'v1',
      evidenceIds,
      intendedBenefit: `Repeated submission failures (${count}) at tenant ${tenant}; derive or revise a scoped procedure before further attempts.`,
      risk: 'low',
      baseline: { failures: count, tenant },
      affectedSources: [`tenant:${tenant}`],
    });
  }
  return specs;
}

function cloudExcerptsFrom(batch) {
  return batch
    .filter((r) => r.status === 'definitely_not_submitted')
    .slice(0, REQUEST_LIMITS.maxExcerpts)
    .map((r) => ({
      sourceId: r.id,
      excerpt: JSON.stringify({
        status: r.status,
        tenant: r.data?.tenant ?? null,
        employerId: r.data?.employerId ?? null,
        verdicts: (r.data?.verdicts ?? []).slice(-3),
      }).slice(0, REQUEST_LIMITS.maxExcerptChars),
    }));
}

// ---------------------------------------------------------------------------
// The bounded run.

/**
 * runReview(ctx, {localOnly, limit, approvalId}) -> runReport (CONTRACTS D7).
 * One bounded incremental pass: refuse while disabled; take the reviewer
 * lease; abort any stale active run record; process a deterministic batch of
 * newly settled attempts (stopping on batch/time limits while preserving the
 * cursor); compute deterministic failure/reuse/cost summaries first; then —
 * only when !localOnly, needed, budget-permitted AND covered by a recorded
 * D03 approval — invoke cloud analysis through the injected transport. An
 * unknown cloud outcome is recorded and NEVER auto-retried. The reviewer has
 * no path to startCycle, submission, desired-state files or launchd.
 */
export async function runReview(ctx, options = {}) {
  const {
    localOnly = true,
    limit,
    approvalId = null,
    owner = `pid-${process.pid}`,
    timeLimitMs = DEFAULT_TIME_LIMIT_MS,
  } = options;
  const transports = options.transports ?? ctx.reviewTransports ?? {};

  const config = readLearningConfig(ctx);
  if (!config.enabled) {
    throw new LearningError('REVIEW_DISABLED', 'learning is disabled (config/learning.yml enabled: false) — review refused');
  }
  if (!config.review.enabled) {
    throw new LearningError('REVIEW_DISABLED', 'review is disabled (config/learning.yml review.enabled: false) — review refused');
  }
  if (isLearnerPaused(ctx)) {
    throw new LearningError('REVIEW_DISABLED',
      'the learner is paused (learning pause-requested sentinel) — review refused; unpause it from the panel first');
  }
  if (!localOnly) verifyCloudApproval(ctx, approvalId);
  const batchLimit = Number.isInteger(limit) && limit > 0 ? limit : config.review.max_new_attempts;

  const startedAt = ctx.now();
  const startedIso = startedAt.toISOString();
  const runId = `review-${startedAt.getTime()}-${randomUUID().slice(0, 8)}`;

  // Lease + single active run id, under the state lock. A live lease held by
  // another owner refuses; an expired lease (crash/restart) is taken over and
  // its still-"running" run record is marked aborted.
  let abortedRunId = null;
  let priorProcessed = {};
  await mutateState(ctx, (state) => {
    if (state.lease && state.lease.owner !== owner
      && Date.parse(state.lease.expiresAt) > startedAt.getTime()) {
      throw new LearningError('REVIEWER_LEASE_HELD',
        `reviewer lease is held by ${state.lease.owner} until ${state.lease.expiresAt}`,
        { owner: state.lease.owner, expiresAt: state.lease.expiresAt });
    }
    abortedRunId = state.activeRunId ?? null;
    if (!state.enabledAt) state.enabledAt = startedIso;
    state.intervalMinutes = config.review.interval_minutes;
    state.lease = {
      owner,
      acquiredAt: startedIso,
      expiresAt: new Date(startedAt.getTime() + LEASE_TTL_MS).toISOString(),
    };
    state.activeRunId = runId;
    priorProcessed = { ...state.cursor.processed };
  });
  if (abortedRunId && abortedRunId !== runId) {
    try {
      const stale = getRecord(ctx, 'reviewRuns', abortedRunId);
      if (stale && stale.status === 'running') {
        await commitRecord(ctx, 'reviewRuns', abortedRunId,
          { ...stale.data, finishedAt: startedIso },
          { expectedRevision: stale.revision, status: 'aborted', sourceIds: [] });
      }
    } catch { /* a stale run record must not block the new run */ }
  }

  await commitRecord(ctx, 'reviewRuns', runId, {
    startedAt: startedIso,
    cursor: { resumedFrom: Object.keys(priorProcessed).length },
    budget: { kind: 'review_run', limit: batchLimit, timeLimitMs, localOnly },
    processed: {},
    outcomes: { result: 'pending' },
    errors: [],
  }, { expectedRevision: 0, status: 'running', sourceIds: [] });

  const releaseAndFail = async (err) => {
    try {
      const latest = getRecord(ctx, 'reviewRuns', runId);
      if (latest?.status === 'running') {
        await commitRecord(ctx, 'reviewRuns', runId,
          { ...latest.data, finishedAt: ctx.now().toISOString(), errors: [{ code: err?.code ?? 'REVIEW_ERROR' }] },
          { expectedRevision: latest.revision, status: 'failed', sourceIds: [] });
      }
    } catch { /* best-effort */ }
    try {
      await mutateState(ctx, (state) => {
        if (state.activeRunId === runId) state.activeRunId = null;
        if (state.lease?.owner === owner) state.lease = null;
      });
    } catch { /* best-effort */ }
    throw err;
  };

  try {
    // ---- deterministic batch over newly settled attempts ----
    const processedMap = { ...priorProcessed };
    const deadline = startedAt.getTime() + timeLimitMs;
    const batch = [];
    const pending = [];
    const errors = [];
    let stoppedEarly = false;
    for (const head of attemptHeads(ctx)) {
      if ((processedMap[head.id] ?? 0) >= head.revision) continue; // high-water mark
      if (batch.length >= batchLimit || ctx.now().getTime() > deadline) {
        stoppedEarly = true;
        break;
      }
      let record = null;
      try {
        record = getRecord(ctx, 'attempts', head.id);
      } catch (err) {
        // Malformed source: reported, left pending, never blocks the rest.
        errors.push({ sourceId: head.id, code: err?.code ?? 'READ_ERROR' });
        continue;
      }
      if (!record) continue;
      if (!SETTLED_ATTEMPT_STATUSES.has(record.status)) {
        pending.push(head.id); // failed/unsettled artifacts stay explicitly pending
        continue;
      }
      batch.push(record);
      processedMap[head.id] = record.revision;
    }

    // ---- deterministic summaries FIRST ----
    const summary = summarizeBatch(batch);
    const summaries = {
      failures: { total: summary.failures, byTenant: summary.failuresByTenant, outcomes: summary.outcomes },
      reuse: summarizeReuse(ctx, new Set(batch.map((r) => r.data?.attemptId ?? r.id))),
      cost: summarizeCost(ctx, startedIso),
    };

    // ---- optional cloud analysis: needed + enabled + budget + D03 only ----
    const specs = localProposalSpecs(summary, batch);
    let cloudOutcome = null;
    if (!localOnly) {
      const excerpts = cloudExcerptsFrom(batch);
      const gate = cloudEnabled(ctx);
      if (summary.failures === 0 || excerpts.length === 0) {
        cloudOutcome = { skipped: 'not_needed' }; // summaries answered it locally
      } else if (!gate.enabled) {
        cloudOutcome = { skipped: gate.reason };
      } else {
        try {
          const res = await invokeCloudAnalysis(ctx, {
            task: 'improvement_review',
            policyVersion: 'review-v1',
            sourceExcerpts: excerpts,
            transport: transports.cloud,
          });
          cloudOutcome = {
            result: res.status, requestId: res.requestId,
            actualUsd: res.actualUsd ?? null, candidates: res.candidates.length,
          };
          for (const c of res.candidates) {
            // Model output becomes an inert note; authority fields are never
            // derived from it (screened again in persistProposal).
            specs.push({
              kind: 'positioning',
              component: 'review-analysis',
              source: [...c.sourceIds].sort().join(','),
              version: 'v1',
              evidenceIds: c.sourceIds,
              intendedBenefit: c.summary,
              risk: 'low',
              baseline: { failures: summary.failures },
              affectedSources: c.sourceIds,
            });
          }
        } catch (err) {
          if (['CLOUD_BUDGET_EXCEEDED', 'CLOUD_DISABLED', 'CLOUD_IN_FLIGHT'].includes(err?.code)) {
            cloudOutcome = { skipped: err.code }; // local summaries remain the result
          } else if (err?.code === 'CLOUD_OUTCOME_UNKNOWN') {
            // The reservation stays open; reconcile settles it. NEVER retried here.
            cloudOutcome = { result: 'unknown', requestId: err.requestId ?? null, reservationId: err.reservationId ?? null };
          } else {
            cloudOutcome = { failed: err?.code ?? 'CLOUD_ERROR' };
          }
        }
      }
    }

    // ---- persist proposals (deduplicated, evidence retained) ----
    const proposals = { created: 0, updated: 0, unchanged: 0, rejected: 0 };
    for (const spec of specs) {
      try {
        const { action } = await persistProposal(ctx, spec);
        proposals[action] += 1;
      } catch (err) {
        proposals.rejected += 1;
        errors.push({ sourceId: proposalIdFor(spec), code: err?.code ?? 'PROPOSAL_ERROR' });
      }
    }

    // ---- settle the run record and advance the cursor ----
    const finishedAt = ctx.now();
    const cursor = {
      processedTotal: Object.keys(processedMap).length,
      batchCount: batch.length,
      lastSourceId: batch.length > 0 ? batch[batch.length - 1].id : null,
      pendingCount: pending.length,
      updatedAt: finishedAt.toISOString(),
    };
    const running = getRecord(ctx, 'reviewRuns', runId);
    await commitRecord(ctx, 'reviewRuns', runId, {
      ...running.data,
      finishedAt: finishedAt.toISOString(),
      cursor,
      processed: { attempts: batch.length, proposals },
      outcomes: { result: 'ok', summaries, cloud: cloudOutcome, stoppedEarly },
      errors,
    }, {
      expectedRevision: running.revision,
      status: 'completed',
      sourceIds: batch.map((r) => r.id).slice(0, LIMITS.maxSourceIds),
    });

    await mutateState(ctx, (state) => {
      state.cursor = { processed: processedMap, updatedAt: finishedAt.toISOString() };
      state.lastRunAt = finishedAt.toISOString();
      // Coalesced catch-up: one run, then the next due time from NOW — missed
      // intervals during sleep are never replayed individually.
      state.dueAt = new Date(finishedAt.getTime() + state.intervalMinutes * 60_000).toISOString();
      if (state.activeRunId === runId) state.activeRunId = null;
      if (state.lease?.owner === owner) state.lease = null;
    });

    return {
      runId,
      status: 'completed',
      processed: batch.length,
      pending,
      errors,
      proposals,
      summaries,
      cloud: cloudOutcome,
      stoppedEarly,
      cursor,
    };
  } catch (err) {
    return releaseAndFail(err);
  }
}
