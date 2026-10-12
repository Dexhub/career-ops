// auto/learning/context.mjs — explicit code/data roots, injected clock, and
// validated feature configuration for the learning layer (CONTRACTS E, T01).
// Nothing executes at import time; every function takes an explicit ctx.
// Never imports core/db.mjs.

import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import * as yaml from 'js-yaml';
import { LearningError } from './contracts.mjs';

export const CONFIG_SCHEMA_VERSION = 1;

// CONTRACTS F defaults, verbatim. Everything consequential starts disabled.
export const LEARNING_CONFIG_DEFAULTS = Object.freeze({
  schema_version: 1,
  enabled: false,
  mode: 'shadow',
  capture: Object.freeze({
    max_artifact_bytes: 2097152,
    max_fields_per_page: 100,
  }),
  retrieval: Object.freeze({
    max_candidates: 12,
    max_context_bytes: 24000,
  }),
  // reuse defaults: off when the block is absent (backward-compatible).
  // reuse.enabled: false means NO context injection and NO auto-promotion.
  // reuse.auto_approve_safe: false means captured answers stay as-is.
  // reuse.max_context_bytes: 0 means use retrieval.max_context_bytes.
  reuse: Object.freeze({
    enabled: false,
    auto_approve_safe: false,
    max_context_bytes: 0,
  }),
  review: Object.freeze({
    enabled: false,
    interval_minutes: 360,
    max_new_attempts: 25,
    concurrency: 1,
    auto_promote_procedures: false,
  }),
  queue: Object.freeze({ mode: 'existing' }),
  cloud: Object.freeze({
    enabled: false,
    region: 'us-east-1',
    profile: 'hk_dev',
    function_arn: null,
    model_id: null,
    daily_usd_cap: 0,
    max_calls_per_day: 0,
    max_output_tokens: 1200,
    max_payload_bytes: 65536,
  }),
});

const QUEUE_MODES = ['existing', 'fit_then_freshness', 'freshness_then_fit'];
const MODES = ['shadow', 'active', 'off'];

/**
 * createLearningContext({codeRoot,dataRoot,now}) -> ctx (CONTRACTS E).
 * Roots are explicit absolute paths; `now` is an injected clock returning a
 * Date (defaults to the system clock). The ctx is frozen.
 */
export function createLearningContext({ codeRoot, dataRoot, now } = {}) {
  for (const [name, value] of [['codeRoot', codeRoot], ['dataRoot', dataRoot]]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new LearningError('INVALID_CONTEXT', `${name} must be a nonempty string path`);
    }
    if (!isAbsolute(value)) {
      throw new LearningError('INVALID_CONTEXT', `${name} must be an absolute path, got: ${value}`);
    }
  }
  const clock = now ?? (() => new Date());
  if (typeof clock !== 'function') {
    throw new LearningError('INVALID_CONTEXT', 'now must be a function returning a Date');
  }
  return Object.freeze({ codeRoot, dataRoot, now: clock });
}

/** Private learning state lives under the DATA root, never the code checkout. */
export function learningDataRoot(ctx) {
  return join(ctx.dataRoot, 'data', 'auto', 'learning');
}

/** Source files/prompts resolve from the CODE root. */
export function learningCodePath(ctx, ...parts) {
  return join(ctx.codeRoot, ...parts);
}

export function learningConfigPath(ctx) {
  return join(ctx.dataRoot, 'config', 'learning.yml');
}

function expectPlainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LearningError('CONFIG_MALFORMED', `config ${path} must be a mapping`);
  }
}

function expectBoolean(value, path) {
  if (typeof value !== 'boolean') {
    throw new LearningError('CONFIG_MALFORMED', `config ${path} must be a boolean`);
  }
  return value;
}

function expectNonNegativeNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LearningError('CONFIG_MALFORMED', `config ${path} must be a finite number >= 0`);
  }
  return value;
}

function expectStringOrNull(value, path) {
  if (value !== null && typeof value !== 'string') {
    throw new LearningError('CONFIG_MALFORMED', `config ${path} must be a string or null`);
  }
  return value;
}

function mergeSection(defaults, raw, path, validators) {
  if (raw === undefined) return { ...defaults };
  expectPlainObject(raw, path);
  const out = { ...defaults };
  for (const key of Object.keys(raw)) {
    if (!(key in defaults)) {
      throw new LearningError('CONFIG_MALFORMED', `unknown config key ${path}.${key}`);
    }
    out[key] = validators[key](raw[key], `${path}.${key}`);
  }
  return out;
}

/**
 * readLearningConfig(ctx) -> validatedConfig (CONTRACTS E). A missing file
 * yields the disabled defaults; a malformed or future-versioned file throws
 * and is never overwritten or repaired. Read-only.
 */
export function readLearningConfig(ctx) {
  const path = learningConfigPath(ctx);
  if (!existsSync(path)) {
    return structuredClone(LEARNING_CONFIG_DEFAULTS);
  }
  let raw;
  try {
    raw = yaml.load(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new LearningError('CONFIG_MALFORMED', `config/learning.yml failed to parse: ${err.message}`);
  }
  expectPlainObject(raw, '(root)');
  if (raw.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new LearningError('CONFIG_UNSUPPORTED_VERSION',
      `config/learning.yml schema_version ${String(raw.schema_version)} is not supported (expected ${CONFIG_SCHEMA_VERSION}); refusing to guess`);
  }
  const known = new Set(['schema_version', 'enabled', 'mode', 'capture', 'retrieval', 'reuse', 'review', 'queue', 'cloud']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new LearningError('CONFIG_MALFORMED', `unknown top-level config key: ${key}`);
    }
  }
  const config = {
    schema_version: CONFIG_SCHEMA_VERSION,
    enabled: raw.enabled === undefined ? false : expectBoolean(raw.enabled, 'enabled'),
    mode: LEARNING_CONFIG_DEFAULTS.mode,
    capture: mergeSection(LEARNING_CONFIG_DEFAULTS.capture, raw.capture, 'capture', {
      max_artifact_bytes: expectNonNegativeNumber,
      max_fields_per_page: expectNonNegativeNumber,
    }),
    retrieval: mergeSection(LEARNING_CONFIG_DEFAULTS.retrieval, raw.retrieval, 'retrieval', {
      max_candidates: expectNonNegativeNumber,
      max_context_bytes: expectNonNegativeNumber,
    }),
    // reuse block: defaults to off when the key is absent (backward-compat).
    // Invalid keys are still rejected (fail-closed for malformed config).
    reuse: mergeSection(LEARNING_CONFIG_DEFAULTS.reuse, raw.reuse, 'reuse', {
      enabled: expectBoolean,
      auto_approve_safe: expectBoolean,
      max_context_bytes: expectNonNegativeNumber,
    }),
    review: mergeSection(LEARNING_CONFIG_DEFAULTS.review, raw.review, 'review', {
      enabled: expectBoolean,
      interval_minutes: expectNonNegativeNumber,
      max_new_attempts: expectNonNegativeNumber,
      concurrency: expectNonNegativeNumber,
      auto_promote_procedures: expectBoolean,
    }),
    queue: mergeSection(LEARNING_CONFIG_DEFAULTS.queue, raw.queue, 'queue', {
      mode: (value, path2) => {
        if (!QUEUE_MODES.includes(value)) {
          throw new LearningError('CONFIG_MALFORMED', `config ${path2} must be one of ${QUEUE_MODES.join('|')}`);
        }
        return value;
      },
    }),
    cloud: mergeSection(LEARNING_CONFIG_DEFAULTS.cloud, raw.cloud, 'cloud', {
      enabled: expectBoolean,
      region: (v, p) => { expectStringOrNull(v, p); if (v === null) throw new LearningError('CONFIG_MALFORMED', `config ${p} must be a string`); return v; },
      profile: (v, p) => { expectStringOrNull(v, p); if (v === null) throw new LearningError('CONFIG_MALFORMED', `config ${p} must be a string`); return v; },
      function_arn: expectStringOrNull,
      model_id: expectStringOrNull,
      daily_usd_cap: expectNonNegativeNumber,
      max_calls_per_day: expectNonNegativeNumber,
      max_output_tokens: expectNonNegativeNumber,
      max_payload_bytes: expectNonNegativeNumber,
    }),
  };
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode)) {
      throw new LearningError('CONFIG_MALFORMED', `config mode must be one of ${MODES.join('|')}`);
    }
    config.mode = raw.mode;
  }
  return Object.freeze(config);
}
