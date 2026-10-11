// auto/learning/procedures.mjs — scoped procedure learning and gated promotion
// (CONTRACTS E, T18). Episodes are extracted deterministically from the
// learning ledger; candidate procedures are declarative step lists scoped to
// one employer/ATS tenant; evaluation runs a fixed trusted fixture driver
// (never model-generated test code) and promotion must reload the persisted
// reviewRuns evaluation record. Nothing executes at import time. Pure
// functions never mutate; only commit/persist/promote/rollback write.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LearningError, isSecretKey, validateEnvelope } from './contracts.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';
import { learningDataRoot, readLearningConfig } from './context.mjs';

// --- Declarative step vocabulary (T18) ----------------------------------------
// The ONLY actions a learned procedure may name. There is deliberately no
// submit/final-submit, shell, code, eval or permission-granting step.
export const ALLOWED_STEP_TYPES = Object.freeze([
  'open_existing_application', 'inspect_fields', 'wait_for_verification',
  'recheck_session', 'resolve_known_question', 'request_human_help',
]);

// Steps that only read, wait or re-establish an existing session. Only these
// are ever eligible for the (default-off) auto-promotion path; anything that
// fills a form answer, or any future permission/fact/submission/budget/code
// change, always needs an explicit harness approval.
export const DATA_ONLY_STEP_TYPES = Object.freeze([
  'inspect_fields', 'wait_for_verification', 'recheck_session',
]);

const FORBIDDEN_PARAM_KEY_RE = /^(command|cmd|script|code|shell|exec|eval|sql|js|javascript)$/i;
const MAX_STEPS = 20;
const MAX_RETRIES_LIMIT = 5;
const MAX_WAIT_MS_LIMIT = 10 * 60 * 1000; // existing T13 verification ceiling

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/**
 * validateProcedureSteps(steps) — rejects anything outside the declarative
 * vocabulary: unknown step types, generic final-submit, shell/code-shaped
 * params, secret-bearing param keys. Never evaluates any step content.
 */
export function validateProcedureSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
    throw new LearningError('INVALID_PROCEDURE', `steps must be a nonempty array of at most ${MAX_STEPS}`);
  }
  for (const [i, step] of steps.entries()) {
    if (!isPlainObject(step) || typeof step.type !== 'string') {
      throw new LearningError('INVALID_PROCEDURE', `step[${i}] must be an object with a string type`);
    }
    if (!ALLOWED_STEP_TYPES.includes(step.type)) {
      throw new LearningError('INVALID_PROCEDURE',
        `step[${i}] type "${step.type}" is not in the declarative allowlist`);
    }
    for (const key of Object.keys(step)) {
      if (key !== 'type' && key !== 'params') {
        throw new LearningError('INVALID_PROCEDURE', `step[${i}] has unknown key "${key}"`);
      }
    }
    if (step.params !== undefined) {
      if (!isPlainObject(step.params)) {
        throw new LearningError('INVALID_PROCEDURE', `step[${i}].params must be a plain object`);
      }
      for (const [key, value] of Object.entries(step.params)) {
        if (isSecretKey(key) || FORBIDDEN_PARAM_KEY_RE.test(key)) {
          throw new LearningError('INVALID_PROCEDURE',
            `step[${i}].params key "${key}" is forbidden (code/shell/secret-shaped)`);
        }
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) {
          throw new LearningError('INVALID_PROCEDURE', `step[${i}].params.${key} must be a scalar`);
        }
      }
    }
  }
  return true;
}

function validateLimits({ maxRetries, maxWaitMs }) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_LIMIT) {
    throw new LearningError('INVALID_PROCEDURE', `maxRetries must be an integer 0..${MAX_RETRIES_LIMIT}`);
  }
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > MAX_WAIT_MS_LIMIT) {
    throw new LearningError('INVALID_PROCEDURE', `maxWaitMs must be an integer 0..${MAX_WAIT_MS_LIMIT}`);
  }
}

// --- Episode extraction (T18 checkbox 1) ---------------------------------------

function msBetween(a, b) {
  const t0 = Date.parse(a ?? ''); const t1 = Date.parse(b ?? '');
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 < t0) return null;
  return t1 - t0;
}

/**
 * extractEpisodes(ctx) -> episodes[] — deterministic read of settled ledger
 * state (attempts + blockers). Each episode carries the starting condition,
 * allowed action, observed result, wait/active time, failures, pinned
 * source/policy/procedure versions and whether the outcome was VERIFIED
 * (settled through reconcileAttempt, never a worker narrative). Failed and
 * contradictory episodes are included, never filtered to successes.
 */
export function extractEpisodes(ctx) {
  const { items: attempts } = listRecords(ctx, 'attempts', { limit: 500 });
  const { items: blockers } = listRecords(ctx, 'blockers', { limit: 500 });
  const blockersByAttempt = new Map();
  for (const b of blockers) {
    const key = b.data.attemptId ?? null;
    if (!key) continue;
    if (!blockersByAttempt.has(key)) blockersByAttempt.set(key, []);
    blockersByAttempt.get(key).push(b);
  }
  const episodes = [];
  for (const a of attempts) {
    const d = a.data;
    const attached = blockersByAttempt.get(d.attemptId) ?? [];
    const failures = [];
    for (const b of attached) {
      if (['open', 'expired'].includes(b.status) || b.data.type === 'submission_unknown') {
        failures.push({ blockerType: b.data.type, blockerStatus: b.status });
      }
    }
    const verdicts = Array.isArray(d.verdicts) ? d.verdicts : [];
    if (['unknown', 'definitely_not_submitted'].includes(a.status)) {
      failures.push({ attemptStatus: a.status });
    }
    let waitMs = 0;
    for (const b of attached) {
      const w = msBetween(b.data.requestedAt, b.data.resolution?.resolvedAt ?? b.data.nextCheckAt);
      if (w !== null) waitMs += w;
    }
    const totalMs = msBetween(d.allocatedAt, a.updatedAt);
    episodes.push({
      sourceId: a.id,
      applicationId: d.applicationId ?? null,
      employerId: d.employerId ?? null,
      tenant: d.tenant ?? null,
      startingCondition: { urlKey: d.urlKey ?? null, accountId: d.accountId ?? null },
      allowedAction: d.allowedAction ?? null,
      observedResult: a.status,
      verifiedOutcome: ['confirmed', 'definitely_not_submitted'].includes(a.status),
      waitMs,
      activeMs: totalMs === null ? null : Math.max(0, totalMs - waitMs),
      failures,
      verdictCount: verdicts.length,
      policyVersion: d.policyVersion ?? null,
      sourceVersion: d.sourceVersion ?? null,
      procedureVersion: d.procedureVersion ?? null,
      contradiction: a.status === 'confirmed' && failures.length > 0,
    });
  }
  episodes.sort((x, y) => (x.sourceId < y.sourceId ? -1 : x.sourceId > y.sourceId ? 1 : 0));
  return episodes;
}

// --- Candidate derivation (T18 checkbox 2) -------------------------------------

/**
 * deriveCandidateProcedures(ctx,{episodes}) -> candidates[] (pure).
 * Groups episodes by exact employer/ATS tenant; a candidate is only produced
 * for a fully identified tenant and is scoped to it plus exact preconditions.
 * Steps come only from the declarative vocabulary and always keep the
 * request_human_help fallback; episodes with failures/contradictions feed the
 * contradicting list rather than being dropped.
 */
export function deriveCandidateProcedures(ctx, { episodes } = {}) {
  if (!Array.isArray(episodes)) {
    throw new LearningError('SCHEMA_VALIDATION', 'episodes must be an array');
  }
  const byTenant = new Map();
  for (const ep of episodes) {
    if (!ep.employerId || !ep.tenant) continue; // never a global candidate
    const key = `${ep.employerId}\u0000${ep.tenant}`;
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push(ep);
  }
  const candidates = [];
  for (const [key, group] of [...byTenant.entries()].sort()) {
    const [employerId, tenant] = key.split('\u0000');
    const supporting = group.filter((e) => e.verifiedOutcome && e.observedResult === 'confirmed' && !e.contradiction);
    const contradicting = group.filter((e) => e.failures.length > 0 || e.contradiction);
    if (supporting.length === 0) continue;
    const sawWaits = group.some((e) => (e.waitMs ?? 0) > 0);
    const steps = [
      { type: 'open_existing_application' },
      { type: 'recheck_session' },
      { type: 'inspect_fields' },
      ...(sawWaits ? [{ type: 'wait_for_verification' }] : []),
      { type: 'resolve_known_question' },
      { type: 'request_human_help' },
    ];
    validateProcedureSteps(steps);
    candidates.push({
      id: `proc-${sha256Hex(key).slice(0, 24)}`,
      scope: { employerId, atsTenant: tenant },
      preconditions: {
        startingCondition: 'existing_application_open',
        requiresApprovedAnswers: true,
        tenant,
      },
      steps,
      expectedObservations: ['fields_inspected', 'known_questions_resolved'],
      maxRetries: 2,
      maxWaitMs: MAX_WAIT_MS_LIMIT,
      derivationSourceIds: supporting.map((e) => e.sourceId),
      contradictingSourceIds: contradicting.map((e) => e.sourceId),
    });
  }
  return candidates;
}

/**
 * commitCandidateProcedure(ctx, candidate) -> envelope. Persists one derived
 * candidate (status 'candidate') after re-validating steps/limits/scope.
 */
export async function commitCandidateProcedure(ctx, candidate) {
  if (!isPlainObject(candidate)) {
    throw new LearningError('SCHEMA_VALIDATION', 'candidate must be an object');
  }
  validateProcedureSteps(candidate.steps);
  validateLimits(candidate);
  if (!isPlainObject(candidate.scope) || (!candidate.scope.employerId && !candidate.scope.atsTenant)) {
    throw new LearningError('SCOPE_TOO_BROAD', 'a candidate procedure must be scoped to an employer/ATS tenant');
  }
  return commitRecord(ctx, 'procedures', candidate.id, {
    scope: candidate.scope,
    preconditions: candidate.preconditions ?? {},
    steps: candidate.steps,
    expectedObservations: candidate.expectedObservations ?? [],
    maxRetries: candidate.maxRetries,
    maxWaitMs: candidate.maxWaitMs,
    lastVerifiedAt: null,
    supportingAttemptIds: candidate.derivationSourceIds ?? [],
    contradictingAttemptIds: candidate.contradictingSourceIds ?? [],
    evaluationVersion: null,
    evaluationResult: null,
  }, { expectedRevision: 0, status: 'candidate', sourceIds: candidate.derivationSourceIds ?? [] });
}

// --- Fixed trusted fixture driver (T18 checkboxes 3-4) --------------------------
// The driver below is the ONLY executor of evaluation cases. It interprets
// declarative fixture data; it never evaluates strings, never runs
// model-generated test code, never touches a browser or the network.

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Digest of the behavior-bearing fields of a procedure revision. */
export function procedureDigest(data) {
  return sha256Hex(canonicalJson({
    scope: data.scope ?? {}, preconditions: data.preconditions ?? {},
    steps: data.steps ?? [], expectedObservations: data.expectedObservations ?? [],
    maxRetries: data.maxRetries ?? null, maxWaitMs: data.maxWaitMs ?? null,
  }));
}

const OUTCOME_RANK = Object.freeze({ completed: 2, escalated: 1, aborted: 1, failed: 0 });
const CASE_FORBIDDEN_RE = /^(code|script|command|shell|eval|exec)$/i;

function validateFixtureCase(kase, i) {
  if (!isPlainObject(kase) || typeof kase.id !== 'string' || typeof kase.sourceId !== 'string') {
    throw new LearningError('INVALID_FIXTURE', `case[${i}] must have string id and sourceId`);
  }
  const stack = [kase];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) { stack.push(...node); continue; }
    if (!isPlainObject(node)) continue;
    for (const key of Object.keys(node)) {
      if (CASE_FORBIDDEN_RE.test(key) || isSecretKey(key)) {
        throw new LearningError('INVALID_FIXTURE',
          `case[${i}] contains forbidden key "${key}" — evaluation never runs generated test code`);
      }
      stack.push(node[key]);
    }
  }
  if (!isPlainObject(kase.baseline) || !Number.isInteger(kase.baseline.actions)
    || !(kase.baseline.outcome in OUTCOME_RANK)) {
    throw new LearningError('INVALID_FIXTURE', `case[${i}] baseline must carry integer actions and a known outcome`);
  }
}

function runFixtureCase(procedureData, kase) {
  const cond = {
    sessionValid: true, verificationFresh: true, optionsChanged: false,
    toolAvailable: true, knownAnswer: true, applicationExists: true,
    ...(isPlainObject(kase.conditions) ? kase.conditions : {}),
  };
  const scope = procedureData.scope ?? {};
  const violations = [];
  let actions = 0;
  let truthful = true;

  const tenantMatches = (scope.atsTenant == null || scope.atsTenant === kase.tenant)
    && (scope.employerId == null || scope.employerId === kase.employerId);
  if (!tenantMatches) {
    // Correct behavior: a tenant-scoped procedure refuses out-of-scope work
    // before taking any action.
    return { caseId: kase.id, outcome: 'aborted', actions: 0, violations, truthful };
  }
  if ((scope.atsTenant == null && scope.employerId == null) && kase.kind === 'tenant_mismatch') {
    violations.push('global_rule_executed_on_foreign_tenant');
    return { caseId: kase.id, outcome: 'failed', actions: 0, violations, truthful };
  }

  const types = procedureData.steps.map((s) => s.type);
  const hasEscalation = types.includes('request_human_help');
  if (!cond.toolAvailable) {
    if (hasEscalation) return { caseId: kase.id, outcome: 'escalated', actions: 1, violations, truthful };
    violations.push('tool_unavailable_unhandled');
    return { caseId: kase.id, outcome: 'failed', actions: 1, violations, truthful };
  }

  let verified = cond.verificationFresh;
  let sessionOk = cond.sessionValid;
  let sawInspect = false;
  let needHelp = false;
  let escalated = false;
  for (const type of types) {
    if (escalated) break;
    if (type === 'open_existing_application') {
      actions += 1;
      if (!cond.applicationExists) {
        if (hasEscalation) { needHelp = true; } else { violations.push('missing_application_unhandled'); }
      }
    } else if (type === 'recheck_session') {
      actions += 1; sessionOk = true;
    } else if (type === 'inspect_fields') {
      actions += 1; sawInspect = true;
    } else if (type === 'wait_for_verification') {
      verified = true; // waiting is not an action
    } else if (type === 'resolve_known_question') {
      if (needHelp) continue;
      if (!sessionOk) { violations.push('acted_on_expired_session'); continue; }
      if (!verified) { violations.push('resolved_before_verification'); continue; }
      if (cond.optionsChanged) {
        if (sawInspect && hasEscalation) { needHelp = true; } else {
          violations.push('answered_with_stale_options'); truthful = false;
        }
        continue;
      }
      if (!cond.knownAnswer) {
        if (hasEscalation) { needHelp = true; } else { truthful = false; }
        continue;
      }
      actions += 1;
    } else if (type === 'request_human_help') {
      if (needHelp) escalated = true; // conditional fallback, not a detour on the happy path
    }
  }
  const outcome = violations.length > 0 ? 'failed' : escalated ? 'escalated' : (needHelp ? 'failed' : 'completed');
  return { caseId: kase.id, outcome, actions, violations, truthful };
}

/**
 * evaluateProcedure(ctx,{procedureId,fixtureSet}) -> evaluation (CONTRACTS E).
 * READ-ONLY: nothing is persisted here. fixtureSet is the frozen evaluation
 * set ({derivationSourceIds, cases} or a bare case array); cases whose
 * sourceId appears in the derivation list are excluded from scoring so the
 * held-out set never overlaps the examples that produced the candidate.
 * Returns {id,procedureId,fixtureDigest,derivationSourceIds,heldOutSourceIds,
 * safetyViolations,regressions,actionDelta,results} plus sampleSize/failures.
 */
export function evaluateProcedure(ctx, { procedureId, fixtureSet } = {}) {
  const procedure = getRecord(ctx, 'procedures', procedureId);
  if (!procedure) throw new LearningError('NOT_FOUND', `procedure ${String(procedureId)} not found`);
  validateProcedureSteps(procedure.data.steps);
  const set = Array.isArray(fixtureSet) ? { cases: fixtureSet } : fixtureSet;
  if (!isPlainObject(set) || !Array.isArray(set.cases) || set.cases.length === 0) {
    throw new LearningError('INVALID_FIXTURE', 'fixtureSet must carry a nonempty cases array');
  }
  const derivationSourceIds = Array.isArray(set.derivationSourceIds)
    ? [...set.derivationSourceIds]
    : [...(procedure.data.supportingAttemptIds ?? [])];
  set.cases.forEach(validateFixtureCase);
  const derivation = new Set(derivationSourceIds);
  const heldOut = set.cases.filter((k) => !derivation.has(k.sourceId));
  if (heldOut.length === 0) {
    throw new LearningError('INVALID_FIXTURE', 'no held-out cases: every case overlaps the derivation set');
  }

  const results = [];
  const failures = [];
  let safetyViolations = 0;
  let regressions = 0;
  let totalActions = 0;
  let totalBaseline = 0;
  const tenants = new Set();
  for (const kase of heldOut) {
    if (kase.tenant) tenants.add(kase.tenant);
    const r = runFixtureCase(procedure.data, kase);
    const baseline = kase.baseline;
    const regressed = (OUTCOME_RANK[r.outcome] < OUTCOME_RANK[baseline.outcome])
      || (!r.truthful && baseline.truthful !== false);
    if (regressed) regressions += 1;
    safetyViolations += r.violations.length;
    totalActions += r.actions;
    totalBaseline += baseline.actions;
    if (r.violations.length > 0 || regressed) {
      failures.push({ caseId: kase.id, violations: r.violations, regressed });
    }
    results.push({ ...r, baselineActions: baseline.actions, baselineOutcome: baseline.outcome, regressed });
  }
  const fixtureDigest = sha256Hex(canonicalJson(set));
  const actionDelta = totalActions - totalBaseline;
  const passed = safetyViolations === 0 && regressions === 0 && actionDelta < 0;
  const id = `proceval-${sha256Hex(`${procedureId}|${procedure.revision}|${fixtureDigest}`).slice(0, 24)}`;
  return {
    id,
    procedureId,
    procedureRevision: procedure.revision,
    procedureDigest: procedureDigest(procedure.data),
    fixtureDigest,
    derivationSourceIds,
    heldOutSourceIds: heldOut.map((k) => k.sourceId),
    sampleSize: heldOut.length,
    safetyViolations,
    regressions,
    actionDelta,
    passed,
    failures,
    tenants: [...tenants].sort(),
    results,
    evaluatedAt: ctx.now().toISOString(),
  };
}

// --- Persisted evaluation + gated promotion (T18 checkboxes 5-6) ----------------

/**
 * persistEvaluation(ctx, evaluation) -> {reviewRun, procedure}. The
 * coordinator persists an evaluation through commitRecord in reviewRuns
 * (procedure version, fixture digest, held-out source IDs). A PASSED
 * evaluation moves a candidate to 'tested' — never further: activation always
 * waits for promotion (D04).
 */
export async function persistEvaluation(ctx, evaluation) {
  if (!isPlainObject(evaluation) || typeof evaluation.id !== 'string') {
    throw new LearningError('SCHEMA_VALIDATION', 'persistEvaluation requires an evaluateProcedure result');
  }
  const outcomes = {
    kind: 'procedure_evaluation',
    procedureId: evaluation.procedureId,
    procedureRevision: evaluation.procedureRevision,
    procedureDigest: evaluation.procedureDigest,
    fixtureDigest: evaluation.fixtureDigest,
    derivationSourceIds: evaluation.derivationSourceIds,
    heldOutSourceIds: evaluation.heldOutSourceIds,
    sampleSize: evaluation.sampleSize,
    safetyViolations: evaluation.safetyViolations,
    regressions: evaluation.regressions,
    actionDelta: evaluation.actionDelta,
    passed: evaluation.passed === true,
    tenants: evaluation.tenants ?? [],
  };
  // The id is deterministic over (procedure, revision, fixture digest), so an
  // already-persisted identical evaluation is reused rather than conflicting.
  const existing = getRecord(ctx, 'reviewRuns', evaluation.id);
  if (existing) {
    if (existing.data?.outcomes?.procedureDigest !== evaluation.procedureDigest
      || existing.data?.outcomes?.fixtureDigest !== evaluation.fixtureDigest) {
      throw new LearningError('EVALUATION_MISMATCH',
        `reviewRuns ${evaluation.id} exists with different outcomes`);
    }
    return { reviewRun: existing, procedure: getRecord(ctx, 'procedures', evaluation.procedureId) };
  }
  const reviewRun = await commitRecord(ctx, 'reviewRuns', evaluation.id, {
    startedAt: evaluation.evaluatedAt,
    finishedAt: evaluation.evaluatedAt,
    cursor: null,
    budget: null,
    processed: evaluation.sampleSize,
    outcomes,
    errors: evaluation.failures ?? [],
  }, { expectedRevision: 0, status: 'completed', sourceIds: evaluation.heldOutSourceIds });

  let procedure = getRecord(ctx, 'procedures', evaluation.procedureId);
  if (procedure && outcomes.passed && procedure.status === 'candidate'
    && procedureDigest(procedure.data) === evaluation.procedureDigest) {
    procedure = await commitRecord(ctx, 'procedures', evaluation.procedureId, {
      ...procedure.data,
      evaluationVersion: evaluation.id,
      evaluationResult: {
        passed: true, sampleSize: evaluation.sampleSize,
        safetyViolations: 0, regressions: 0, actionDelta: evaluation.actionDelta,
      },
    }, { expectedRevision: procedure.revision, status: 'tested', sourceIds: procedure.sourceIds });
  }
  return { reviewRun, procedure };
}

// Promotion authority is capability-based like T08: only a token minted by
// the owning harness/UI confers it. Data claiming approval (or passed:true)
// can never be in this private set.
const PROMOTION_APPROVALS = new WeakSet();

export function createPromotionApproval({ approvedBy } = {}) {
  if (typeof approvedBy !== 'string' || approvedBy.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'createPromotionApproval requires approvedBy');
  }
  const token = Object.freeze({ kind: 'procedure_promotion_approval', approvedBy });
  PROMOTION_APPROVALS.add(token);
  return token;
}

function autoPromotionAllowed(ctx, procedureData) {
  let config;
  try { config = readLearningConfig(ctx); } catch { return false; }
  if (config?.review?.auto_promote_procedures !== true) return false;
  // Only allowlisted data-only procedures within existing wait/retry limits.
  // Permissions, source facts, submission rules, model budgets and code are
  // not expressible as steps and are never auto-promoted.
  const actionTypes = procedureData.steps.map((s) => s.type).filter((t) => t !== 'request_human_help');
  if (!actionTypes.every((t) => DATA_ONLY_STEP_TYPES.includes(t))) return false;
  if ((procedureData.maxRetries ?? Infinity) > MAX_RETRIES_LIMIT) return false;
  if ((procedureData.maxWaitMs ?? Infinity) > MAX_WAIT_MS_LIMIT) return false;
  return true;
}

/**
 * promoteProcedure(ctx,{procedureId,evaluationId,approval}) -> record
 * (CONTRACTS E). Reloads the persisted reviewRuns evaluation and verifies the
 * procedure digest, pass result and tenant coverage from THAT record — a
 * missing/stale evaluation ID or a caller-supplied passed:true can never
 * authorize promotion. Requires a harness-minted approval token unless the
 * (default-off) auto-promotion path applies to a data-only procedure.
 */
export async function promoteProcedure(ctx, { procedureId, evaluationId, approval } = {}) {
  const procedure = getRecord(ctx, 'procedures', procedureId);
  if (!procedure) throw new LearningError('NOT_FOUND', `procedure ${String(procedureId)} not found`);
  if (typeof evaluationId !== 'string' || evaluationId.length === 0) {
    throw new LearningError('EVALUATION_MISSING', 'promotion requires the persisted evaluation id');
  }
  const run = getRecord(ctx, 'reviewRuns', evaluationId);
  if (!run || run.status !== 'completed' || run.data.outcomes?.kind !== 'procedure_evaluation') {
    throw new LearningError('EVALUATION_MISSING',
      `no persisted procedure evaluation ${evaluationId} — an unpersisted or caller-asserted result cannot authorize promotion`);
  }
  const o = run.data.outcomes;
  if (o.procedureId !== procedureId) {
    throw new LearningError('EVALUATION_MISMATCH', 'evaluation record is bound to a different procedure');
  }
  if (o.procedureDigest !== procedureDigest(procedure.data)) {
    throw new LearningError('EVALUATION_STALE',
      'the procedure changed since this evaluation — re-evaluate the current version');
  }
  if (o.passed !== true || o.safetyViolations !== 0 || o.regressions !== 0) {
    throw new LearningError('EVALUATION_FAILED',
      'persisted evaluation did not pass (zero safety violations, zero regressions, measured improvement required)');
  }
  if (!Array.isArray(o.heldOutSourceIds) || o.heldOutSourceIds.length === 0) {
    throw new LearningError('EVALUATION_FAILED', 'persisted evaluation has no held-out cases');
  }
  // One tenant's success can never promote a global rule.
  const scope = procedure.data.scope ?? {};
  const scoped = scope.employerId != null || scope.atsTenant != null;
  if (!scoped && (o.tenants ?? []).length < 2) {
    throw new LearningError('SCOPE_TOO_BROAD',
      'a globally scoped procedure cannot be promoted from a single tenant\u2019s evidence');
  }
  if (!['tested', 'active'].includes(procedure.status)) {
    throw new LearningError('INVALID_STATE', `procedure is ${procedure.status}, not tested`);
  }
  if (!PROMOTION_APPROVALS.has(approval)) {
    if (!autoPromotionAllowed(ctx, procedure.data)) {
      throw new LearningError('APPROVAL_REQUIRED',
        'promotion requires a harness-minted approval token (D04); auto-promotion applies only to allowlisted data-only procedures when explicitly enabled');
    }
  }
  return commitRecord(ctx, 'procedures', procedureId, {
    ...procedure.data,
    lastVerifiedAt: ctx.now().toISOString(),
    evaluationVersion: evaluationId,
    evaluationResult: {
      passed: true, sampleSize: o.sampleSize,
      safetyViolations: 0, regressions: 0, actionDelta: o.actionDelta,
    },
  }, { expectedRevision: procedure.revision, status: 'active', sourceIds: procedure.sourceIds });
}

// --- Versioning, staleness, contradictions, rollback (T18 checkboxes 7-8) -------

/**
 * selectProcedure(ctx,{employerId,tenant}) -> {procedureId,version,
 * procedureVersion,steps,scope} | null. New attempts pin this at the safe
 * boundary (recordAttemptIntent, before launch); in-flight attempts keep
 * their already-pinned version regardless of later promotions or rollbacks.
 */
export function selectProcedure(ctx, { employerId = null, tenant = null } = {}) {
  const { items } = listRecords(ctx, 'procedures', { limit: 500, filters: { status: 'active' } });
  const matches = items
    .filter((p) => {
      const s = p.data.scope ?? {};
      return (s.employerId == null || s.employerId === employerId)
        && (s.atsTenant == null || s.atsTenant === tenant);
    })
    .sort((a, b) => String(b.data.lastVerifiedAt ?? '').localeCompare(String(a.data.lastVerifiedAt ?? '')));
  if (matches.length === 0) return null;
  const p = matches[0];
  return {
    procedureId: p.id, version: p.revision,
    procedureVersion: `${p.id}@${p.revision}`,
    steps: p.data.steps, scope: p.data.scope ?? {},
  };
}

/**
 * markProcedureStale(ctx,{procedureId}) — a changed employer flow (or any
 * contradicting evidence) retires the procedure for NEW attempts; in-flight
 * attempts stay pinned to the version they recorded.
 */
export async function markProcedureStale(ctx, { procedureId } = {}) {
  const procedure = getRecord(ctx, 'procedures', procedureId);
  if (!procedure) throw new LearningError('NOT_FOUND', `procedure ${String(procedureId)} not found`);
  if (procedure.status === 'revoked') return procedure;
  return commitRecord(ctx, 'procedures', procedureId, procedure.data,
    { expectedRevision: procedure.revision, status: 'stale', sourceIds: procedure.sourceIds });
}

/** revokeProcedure(ctx,{procedureId}) — terminal removal for new attempts. */
export async function revokeProcedure(ctx, { procedureId } = {}) {
  const procedure = getRecord(ctx, 'procedures', procedureId);
  if (!procedure) throw new LearningError('NOT_FOUND', `procedure ${String(procedureId)} not found`);
  return commitRecord(ctx, 'procedures', procedureId, procedure.data,
    { expectedRevision: procedure.revision, status: 'revoked', sourceIds: procedure.sourceIds });
}

/**
 * recordContradiction(ctx,{procedureId,attemptId}) — tracks contradicting
 * evidence on the procedure record without changing its status.
 */
export async function recordContradiction(ctx, { procedureId, attemptId } = {}) {
  const procedure = getRecord(ctx, 'procedures', procedureId);
  if (!procedure) throw new LearningError('NOT_FOUND', `procedure ${String(procedureId)} not found`);
  if (typeof attemptId !== 'string' || attemptId.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'recordContradiction requires attemptId');
  }
  const existing = procedure.data.contradictingAttemptIds ?? [];
  if (existing.includes(attemptId)) return procedure;
  return commitRecord(ctx, 'procedures', procedureId,
    { ...procedure.data, contradictingAttemptIds: [...existing, attemptId] },
    { expectedRevision: procedure.revision, status: procedure.status, sourceIds: procedure.sourceIds });
}

function readProcedureRevision(ctx, procedureId, revision) {
  const path = join(learningDataRoot(ctx), 'records', 'procedures', procedureId, `${revision}.json`);
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  validateEnvelope(envelope, { collection: 'procedures' });
  return envelope;
}

/**
 * rollbackProcedure(ctx,{procedureId,approval}) -> record. Restores the most
 * recent prior revision whose behavior digest differs, as a NEW active
 * revision for NEW attempts. Nothing here touches attempts records: an active
 * attempt keeps the version it pinned. Requires harness approval.
 */
export async function rollbackProcedure(ctx, { procedureId, approval } = {}) {
  if (!PROMOTION_APPROVALS.has(approval)) {
    throw new LearningError('APPROVAL_REQUIRED', 'rollback requires a harness-minted approval token');
  }
  const current = getRecord(ctx, 'procedures', procedureId);
  if (!current) throw new LearningError('NOT_FOUND', `procedure ${String(procedureId)} not found`);
  const currentDigest = procedureDigest(current.data);
  const dir = join(learningDataRoot(ctx), 'records', 'procedures', procedureId);
  let revisions = [];
  try {
    revisions = readdirSync(dir)
      .map((n) => /^(\d{1,9})\.json$/.exec(n)?.[1])
      .filter(Boolean).map(Number).sort((a, b) => b - a);
  } catch {
    throw new LearningError('NOT_FOUND', `procedure ${String(procedureId)} has no revisions`);
  }
  for (const rev of revisions) {
    if (rev >= current.revision) continue;
    const prior = readProcedureRevision(ctx, procedureId, rev);
    if (!prior) continue;
    if (procedureDigest(prior.data) !== currentDigest) {
      return commitRecord(ctx, 'procedures', procedureId,
        { ...prior.data, lastVerifiedAt: ctx.now().toISOString() },
        { expectedRevision: current.revision, status: 'active', sourceIds: prior.sourceIds });
    }
  }
  throw new LearningError('ROLLBACK_UNAVAILABLE',
    `no prior distinct version of ${procedureId} exists to roll back to`);
}
