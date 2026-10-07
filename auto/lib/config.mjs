/**
 * auto/lib/config.mjs — loader for config/auto.yml (+ standing-answers gate).
 *
 * Fails loudly on a missing/garbled auto.yml: every auto/ script depends on
 * these values and a silent default would make a misconfiguration look like
 * normal operation.
 */

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
