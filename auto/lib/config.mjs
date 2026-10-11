/**
 * auto/lib/config.mjs — loader for config/auto.yml (+ standing-answers gate).
 *
 * Fails loudly on a missing/garbled auto.yml: every auto/ script depends on
 * these values and a silent default would make a misconfiguration look like
 * normal operation.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

const ROOT = getCareerOpsRoot();

export const AUTO_CONFIG_PATH = join(ROOT, 'config/auto.yml');
export const STANDING_ANSWERS_PATH = join(ROOT, 'config/standing-answers.yml');

const DEFAULTS = Object.freeze({
  score_threshold: 4.0,
  daily_soft_limit: 100,
  jitter_min_minutes: 2,
  jitter_max_minutes: 10,
  max_attempts: 2,
  cycle_interval_hours: 6,
  eval: { model: 'qwen2.5:32b', limit_per_cycle: 20 },
  ats_allowlist: ['greenhouse', 'greenhouse-embedded', 'lever', 'ashby', 'workable'],
  agent: { primary: 'claude', fallback: 'codex', timeout_minutes: 25 },
  resume_variants: [],
});

let cache = null;

/** @returns {object} merged config (file over defaults). Throws when unreadable. */
export function loadAutoConfig({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  if (!existsSync(AUTO_CONFIG_PATH)) {
    throw new Error(`config/auto.yml not found at ${AUTO_CONFIG_PATH} — the auto layer is not set up`);
  }
  const raw = yaml.load(readFileSync(AUTO_CONFIG_PATH, 'utf-8'));
  if (!raw || typeof raw !== 'object') {
    throw new Error('config/auto.yml did not parse to a mapping');
  }
  cache = {
    ...DEFAULTS,
    ...raw,
    eval: { ...DEFAULTS.eval, ...(raw.eval || {}) },
    agent: { ...DEFAULTS.agent, ...(raw.agent || {}) },
  };
  return cache;
}

// ---------------------------------------------------------------------------
// Execution policy (T12): the ONE validated, versioned view of the limits the
// dispatcher and worker enforce. The panel's editable ranges derive from the
// same table, so the UI can never accept a value the dispatcher refuses.

export const POLICY_RANGES = Object.freeze({
  score_threshold:         Object.freeze({ kind: 'number', min: 0, max: 5 }),
  daily_soft_limit:        Object.freeze({ kind: 'int', min: 1, max: 1000 }),
  jitter_min_minutes:      Object.freeze({ kind: 'int', min: 0, max: 120 }),
  jitter_max_minutes:      Object.freeze({ kind: 'int', min: 0, max: 240 }),
  max_attempts:            Object.freeze({ kind: 'int', min: 1, max: 5 }),
  'agent.timeout_minutes': Object.freeze({ kind: 'int', min: 5, max: 120 }),
});

function policyError(msg) {
  const err = new Error(`execution policy invalid — refusing to run (fix config/auto.yml): ${msg}`);
  err.code = 'POLICY_INVALID';
  return err;
}

/**
 * Resolve config/auto.yml into one frozen execution policy. Garbled or
 * out-of-range values are an explicit refusal (POLICY_INVALID), never a
 * silent fallback: a saved operator choice must not be quietly replaced.
 * `policyVersion` is a digest of the enforced values, pinned onto every
 * attempt so later limit changes surface instead of rewriting history.
 * @returns {Readonly<{scoreThreshold:number, dailySoftLimit:number,
 *   jitterMinMinutes:number, jitterMaxMinutes:number, maxAttempts:number,
 *   timeoutMinutes:number, atsAllowlist:readonly string[], policyVersion:string}>}
 */
export function resolveExecutionPolicy({ cfg = null } = {}) {
  const c = cfg ?? loadAutoConfig({ fresh: true });
  const num = (key, raw) => {
    const spec = POLICY_RANGES[key];
    const bad = typeof raw !== 'number' || !Number.isFinite(raw)
      || raw < spec.min || raw > spec.max
      || (spec.kind === 'int' && !Number.isInteger(raw));
    if (bad) throw policyError(`${key} must be a${spec.kind === 'int' ? 'n integer' : ' number'} ${spec.min}–${spec.max}, got ${JSON.stringify(raw)}`);
    return raw;
  };
  const scoreThreshold = num('score_threshold', c.score_threshold);
  const dailySoftLimit = num('daily_soft_limit', c.daily_soft_limit);
  const jitterMinMinutes = num('jitter_min_minutes', c.jitter_min_minutes);
  const jitterMaxMinutes = num('jitter_max_minutes', c.jitter_max_minutes);
  const maxAttempts = num('max_attempts', c.max_attempts);
  const timeoutMinutes = num('agent.timeout_minutes', c.agent?.timeout_minutes);
  if (jitterMinMinutes > jitterMaxMinutes) {
    throw policyError(`jitter_min_minutes (${jitterMinMinutes}) exceeds jitter_max_minutes (${jitterMaxMinutes})`);
  }
  const allow = c.ats_allowlist;
  if (!Array.isArray(allow) || allow.length === 0 || allow.some((a) => typeof a !== 'string' || !a.trim())) {
    throw policyError('ats_allowlist must be a non-empty list of ATS family names');
  }
  const atsAllowlist = Object.freeze(allow.map((a) => a.trim()));
  const values = {
    scoreThreshold, dailySoftLimit, jitterMinMinutes, jitterMaxMinutes,
    maxAttempts, timeoutMinutes, atsAllowlist: [...atsAllowlist],
  };
  const policyVersion = `p1-${createHash('sha256').update(JSON.stringify({ schema: 1, ...values })).digest('hex').slice(0, 16)}`;
  return Object.freeze({ ...values, atsAllowlist, policyVersion });
}

const WORKDAY_RE = /workday|myworkdayjobs/i;
const ACTIONABLE_STAGES = ['queued', 'resume_ready', 'applying'];

/**
 * Pure preview of what enforcing `policy` means for an existing backlog.
 * Submitted applications whose ATS now sits outside the allowlist are
 * surfaced for operator reconciliation — they may reflect historical
 * authorization and are never retro-labeled or mutated by this function.
 * @param {object[]} jobs @param {object} policy
 */
export function previewPolicyEnforcement(jobs, policy) {
  const out = {
    policyVersion: policy.policyVersion,
    blockedAts: [], belowThreshold: [], held: [], overAttempts: [],
    historicalOutsideAllowlist: [], notes: [],
  };
  for (const j of jobs || []) {
    const ats = (j.ats || '').trim();
    const entry = {
      urlKey: j.urlKey, company: j.company, stage: j.stage,
      ats: ats || 'unknown', score: j.score ?? null,
      workday: WORKDAY_RE.test(ats) || WORKDAY_RE.test(j.url || ''),
    };
    if (j.stage === 'submitted') {
      if (!policy.atsAllowlist.includes(ats)) out.historicalOutsideAllowlist.push(entry);
      continue;
    }
    if (!ACTIONABLE_STAGES.includes(j.stage)) continue;
    if (j.held) out.held.push(entry);
    if (!policy.atsAllowlist.includes(ats)) out.blockedAts.push(entry);
    if (j.score != null && Number(j.score) < policy.scoreThreshold) out.belowThreshold.push(entry);
    if ((j.attempts || 0) >= policy.maxAttempts) out.overAttempts.push(entry);
  }
  if (out.historicalOutsideAllowlist.length) {
    out.notes.push(`${out.historicalOutsideAllowlist.length} submitted application(s) used an ATS outside the current allowlist`
      + ' (e.g. Workday). These may reflect historical authorization: reconcile operator intent with config/auto.yml.'
      + ' They are NOT retroactively unauthorized, and the allowlist is unchanged.');
  }
  if (out.blockedAts.length) {
    out.notes.push(`${out.blockedAts.length} actionable job(s) would be refused dispatch by the ATS allowlist.`);
  }
  return out;
}

/**
 * Standing answers, or null when absent/unconfirmed. The apply worker treats
 * null as a hard refusal to start — preferences must be user-authored, never
 * defaulted by the system.
 * @returns {object|null}
 */
export function loadStandingAnswers() {
  if (!existsSync(STANDING_ANSWERS_PATH)) return null;
  const raw = yaml.load(readFileSync(STANDING_ANSWERS_PATH, 'utf-8'));
  if (!raw || typeof raw !== 'object') return null;
  if (raw.filled_in_by_user !== true) return null;
  return raw;
}
