// auto/learning/questions.mjs — question definitions, occurrences and safe
// families (CONTRACTS D1/D2/E, T06). Pure normalization plus explicit store
// commits; nothing executes at import time. Never imports core/db.mjs.
//
// Exports:
//   normalizeQuestion(observation) -> definition           (pure)
//   findQuestionCandidates(ctx, observation, {limit}) -> candidates[]
//   recordOccurrence(ctx, observation) -> occurrence result
//   correctFamily(ctx, {kind, familyIds, replacements, reason})
//
// A candidate link NEVER authorizes answer reuse; restricted assessments and
// attestations become policy blockers with metadata only.

import { createHash } from 'node:crypto';
import { LearningError } from './contracts.mjs';
import { readLearningConfig } from './context.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';

// Bump whenever normalization semantics change: it is embedded in every
// definition id so old ids never silently alias new semantics.
export const NORMALIZATION_VERSION = 1;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// --- Normalization -----------------------------------------------------------

/**
 * Unicode NFC, collapse whitespace runs, trim, lowercase, strip harmless
 * leading/trailing punctuation. Negation words, units, countries etc. stay in
 * the text; semantics are additionally captured as explicit constraints.
 */
function normalizeText(text) {
  return String(text)
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[\s"'“”‘’*:;,.!?-]+/, '')
    .replace(/[\s"'“”‘’*:;,.!?-]+$/, '');
}

const NEGATION_RE = /(^|[^a-z])(not|no longer|never|without|aren't|don't|do not|won't|cannot|can't)([^a-z]|$)/i;
const CURRENT_RE = /(^|[^a-z])(currently|now|at present|today|presently)([^a-z]|$)/i;
const FUTURE_RE = /(^|[^a-z])(future|will you|in the future|sponsorship|at any point going forward)([^a-z]|$)/i;
const BASE_SALARY_RE = /base (salary|pay|compensation)/i;
const TOTAL_COMP_RE = /(total (compensation|comp|pay)|on[- ]target earnings|ote)/i;
const EMPLOYER_SPECIFIC_RE = /(ever (worked|been employed)|previously (worked|employed)|former employee|currently employed (at|by|with)|employed (at|by|with) (this|our))/i;
const RESTRICTED_RE = /(timed assessment|proctored|complete (this|the) assessment|without (any )?(assistance|help|aid)|unaided|do not use (ai|artificial intelligence|external (help|resources))|confidential (test|assessment)|no outside (help|resources))/i;

function detectPolarity(normalizedText) {
  return NEGATION_RE.test(normalizedText) ? 'negated' : 'affirmative';
}

function detectTimeHorizon(observation, normalizedText) {
  if (observation.timeHorizon !== undefined && observation.timeHorizon !== null) {
    return observation.timeHorizon;
  }
  if (CURRENT_RE.test(normalizedText)) return 'current';
  if (FUTURE_RE.test(normalizedText)) return 'future';
  return null;
}

function detectSalaryBasis(normalizedText) {
  if (TOTAL_COMP_RE.test(normalizedText)) return 'total';
  if (BASE_SALARY_RE.test(normalizedText)) return 'base';
  return null;
}

function detectEmployerScope(observation, normalizedText) {
  if (!EMPLOYER_SPECIFIC_RE.test(normalizedText)) return null;
  return observation.companyId ?? observation.employerName ?? null;
}

/** Restricted assessments/attestations are not ordinary reusable answers. */
export function isRestrictedQuestion(observation) {
  const text = String(observation?.originalText ?? '');
  return RESTRICTED_RE.test(text);
}

function optionsHashOf(options) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const canonical = options
    .map((o) => `${normalizeText(o?.value ?? '')}=${normalizeText(o?.label ?? '')}`)
    .sort()
    .join('|');
  return sha256(canonical);
}

/**
 * normalizeQuestion(observation) -> definition (CONTRACTS E, T06).
 * Pure. The stable id embeds the normalization version and every semantic
 * constraint: negation, time horizon, country, salary basis, units, currency,
 * required state and option semantics are never erased by normalization.
 */
export function normalizeQuestion(observation) {
  if (!isPlainObject(observation) || typeof observation.originalText !== 'string'
      || observation.originalText.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'normalizeQuestion requires an observation with originalText');
  }
  const normalizedText = normalizeText(observation.originalText);
  const polarity = detectPolarity(normalizedText);
  const timeHorizon = detectTimeHorizon(observation, normalizedText);
  const unit = observation.unit ?? null;
  const currency = observation.currency ?? null;
  const optionsHash = optionsHashOf(observation.options);
  const constraints = {
    normalizationVersion: NORMALIZATION_VERSION,
    country: observation.country ?? null,
    currency,
    required: observation.required ?? null,
    salaryBasis: detectSalaryBasis(normalizedText),
    employerScope: detectEmployerScope(observation, normalizedText),
    restricted: isRestrictedQuestion(observation),
    parentCondition: observation.parentCondition ?? null,
  };
  const fieldType = observation.fieldType ?? 'unknown';
  const locale = observation.locale ?? null;
  const id = `qd-${sha256(JSON.stringify({
    v: NORMALIZATION_VERSION,
    normalizedText,
    fieldType,
    locale,
    optionsHash,
    polarity,
    unit,
    timeHorizon,
    constraints,
  })).slice(0, 48)}`;
  return Object.freeze({
    id,
    normalizedText,
    originalText: observation.originalText,
    fieldType,
    locale,
    optionsHash,
    polarity,
    unit,
    timeHorizon,
    constraints: Object.freeze(constraints),
  });
}

// --- Occurrences -------------------------------------------------------------

// Occurrence identity is per form field of one requisition: a different
// application attempt is evidence on the same occurrence, not a new
// requisition in aggregate counts.
function occurrenceIdFor(observation) {
  const key = [observation.applicationId, observation.stepId, observation.fieldId]
    .map((v) => String(v ?? '')).join('\u0000');
  return `occ-${sha256(key).slice(0, 40)}`;
}

function snapshotHashOf(observation) {
  return sha256(JSON.stringify({
    originalText: observation.originalText,
    options: observation.options ?? null,
    required: observation.required ?? null,
    parentCondition: observation.parentCondition ?? null,
  }));
}

function pickD1(observation) {
  const keys = [
    'applicationId', 'attemptId', 'questionId', 'companyId', 'employerName',
    'atsVendor', 'atsTenant', 'roleTitle', 'roleFamily', 'country', 'locale',
    'stepId', 'fieldId', 'fieldType', 'originalText', 'options', 'required',
    'parentCondition', 'unit', 'currency', 'timeHorizon', 'observedAt',
    'sourceArtifact', 'captureMethod', 'coverage', 'answerDisposition', 'answerRef',
  ];
  const out = {};
  for (const key of keys) {
    if (observation[key] !== undefined) out[key] = observation[key];
  }
  return out;
}

/**
 * recordOccurrence(ctx, observation) ->
 *   { occurrenceId, definitionId|null, deduplicated, fieldRevision, restricted, blockerId|null }
 *
 * Stores the raw observation independently of any family. Repeated unchanged
 * snapshots deduplicate; changed text/options become a new field revision.
 * Restricted assessments store permitted metadata only and open a policy
 * blocker instead of a reusable definition.
 */
export async function recordOccurrence(ctx, observation) {
  const occurrenceId = occurrenceIdFor(observation);
  const snapshotHash = snapshotHashOf(observation);
  const existing = getRecord(ctx, 'observations', occurrenceId);

  if (isRestrictedQuestion(observation)) {
    const blockerId = `blk-${sha256(`restricted:${occurrenceId}`).slice(0, 40)}`;
    if (!getRecord(ctx, 'blockers', blockerId)) {
      await commitRecord(ctx, 'blockers', blockerId, {
        applicationId: observation.applicationId ?? null,
        attemptId: observation.attemptId ?? null,
        type: 'policy',
        question: normalizeText(observation.originalText),
        requiredResolution: 'human_action_restricted_assessment',
      }, { expectedRevision: 0, status: 'open', sourceIds: [occurrenceId] });
    }
    if (!existing) {
      await commitRecord(ctx, 'observations', occurrenceId, {
        ...pickD1(observation),
        answerDisposition: 'blocked',
      }, { expectedRevision: 0, status: 'recorded', sourceIds: [] });
    }
    return {
      occurrenceId, definitionId: null, deduplicated: Boolean(existing),
      fieldRevision: existing ? existing.revision : 1, restricted: true, blockerId,
    };
  }

  let envelope;
  let deduplicated = false;
  if (existing && snapshotHashOf(existing.data) === snapshotHash) {
    // Same unchanged field/step snapshot (possibly another attempt): evidence,
    // not a new occurrence and not a new requisition.
    envelope = existing;
    deduplicated = true;
  } else {
    envelope = await commitRecord(ctx, 'observations', occurrenceId, pickD1(observation), {
      expectedRevision: existing ? existing.revision : 0,
      status: 'recorded',
      sourceIds: [],
    });
  }

  const definition = normalizeQuestion(observation);
  const defRecord = getRecord(ctx, 'questions', definition.id);
  const occurrenceIds = new Set(defRecord?.data.occurrenceIds ?? []);
  const originalExamples = new Set(defRecord?.data.originalExamples ?? []);
  const hadOccurrence = occurrenceIds.has(occurrenceId);
  occurrenceIds.add(occurrenceId);
  if (originalExamples.size < 10) originalExamples.add(observation.originalText);
  if (!defRecord || !hadOccurrence || !deduplicated) {
    await commitRecord(ctx, 'questions', definition.id, {
      normalizedText: definition.normalizedText,
      originalExamples: [...originalExamples],
      fieldType: definition.fieldType,
      locale: definition.locale,
      optionsHash: definition.optionsHash,
      polarity: definition.polarity,
      unit: definition.unit,
      timeHorizon: definition.timeHorizon,
      constraints: definition.constraints,
      occurrenceIds: [...occurrenceIds],
    }, {
      expectedRevision: defRecord ? defRecord.revision : 0,
      status: defRecord ? defRecord.status : 'proposed',
      sourceIds: [...occurrenceIds],
    });
  }

  return {
    occurrenceId,
    definitionId: definition.id,
    deduplicated,
    fieldRevision: envelope.revision,
    restricted: false,
    blockerId: null,
  };
}

// --- Candidate retrieval -----------------------------------------------------

function tokensOf(normalizedText) {
  return new Set(normalizedText.split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// Hard filters: deliberately dangerous pairs never become interchangeable.
function hardFiltersPass(definition, stored) {
  const c1 = definition.constraints;
  const c2 = stored.constraints ?? {};
  return definition.polarity === stored.polarity
    && definition.timeHorizon === stored.timeHorizon
    && definition.unit === stored.unit
    && c1.currency === (c2.currency ?? null)
    && c1.salaryBasis === (c2.salaryBasis ?? null)
    && c1.employerScope === (c2.employerScope ?? null)
    && !(c2.restricted ?? false);
}

const LEXICAL_THRESHOLD = 0.6;

/**
 * findQuestionCandidates(ctx, observation, {limit}) -> candidates[]
 * Exact and lexical retrieval over stored definitions with hard semantic
 * filters and a configurable cap (config retrieval.max_candidates). Every
 * candidate carries authorizesReuse:false; near matches stay candidates and
 * unknowns simply return [] while remaining queryable in the store.
 */
export function findQuestionCandidates(ctx, observation, { limit } = {}) {
  const config = readLearningConfig(ctx);
  const cap = Number.isInteger(limit) && limit > 0
    ? limit
    : config.retrieval.max_candidates;
  const definition = normalizeQuestion(observation);
  if (definition.constraints.restricted) return [];
  const { items: records } = listRecords(ctx, 'questions', { limit: 500 });
  const queryTokens = tokensOf(definition.normalizedText);
  const candidates = [];
  for (const record of records) {
    if (!['proposed', 'approved'].includes(record.status)) continue;
    if (record.id === definition.id) {
      candidates.push({
        questionId: record.id, match: 'exact', score: 1, authorizesReuse: false,
      });
      continue;
    }
    if (!hardFiltersPass(definition, record.data)) continue;
    const score = jaccard(queryTokens, tokensOf(record.data.normalizedText));
    if (score >= LEXICAL_THRESHOLD) {
      candidates.push({
        questionId: record.id, match: 'lexical', score, authorizesReuse: false,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || (a.questionId < b.questionId ? -1 : 1));
  return candidates.slice(0, cap);
}

// --- Family corrections ------------------------------------------------------

/**
 * correctFamily(ctx, {kind:'merge'|'split', familyIds, replacements, reason})
 *   -> { revokedFamilyIds, newFamilyIds, invalidatedAnswerIds }
 *
 * Corrections are new immutable revisions: source families get a revoking
 * revision, replacements are created with provenance in sourceIds, and raw
 * observations are never rewritten. A split invalidates (stales) every answer
 * bound to the mistaken family.
 */
export async function correctFamily(ctx, { kind, familyIds, replacements, reason } = {}) {
  if (!['merge', 'split'].includes(kind)) {
    throw new LearningError('SCHEMA_VALIDATION', `correction kind must be merge|split, got ${String(kind)}`);
  }
  if (!Array.isArray(familyIds) || familyIds.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'familyIds must be a nonempty array');
  }
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'replacements must be a nonempty array of {label,questionIds,scope}');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'a correction requires a reason');
  }

  const sources = familyIds.map((id) => {
    const record = getRecord(ctx, 'families', id);
    if (!record) throw new LearningError('READ_ERROR', `unknown family ${id}`);
    return record;
  });

  const newFamilyIds = [];
  for (const [i, repl] of replacements.entries()) {
    const newId = `fam-${sha256(JSON.stringify({ kind, familyIds, i, label: repl.label })).slice(0, 40)}`;
    await commitRecord(ctx, 'families', newId, {
      label: repl.label,
      questionIds: repl.questionIds,
      scope: repl.scope ?? {},
    }, { expectedRevision: 0, status: 'proposed', sourceIds: [...familyIds] });
    newFamilyIds.push(newId);
  }

  for (const record of sources) {
    await commitRecord(ctx, 'families', record.id, record.data, {
      expectedRevision: record.revision,
      status: 'revoked',
      sourceIds: newFamilyIds,
    });
  }

  const invalidatedAnswerIds = [];
  if (kind === 'split') {
    const { items: answers } = listRecords(ctx, 'answers', { limit: 500 });
    for (const answer of answers) {
      if (!familyIds.includes(answer.data.questionFamilyId)) continue;
      if (['revoked', 'stale'].includes(answer.status)) continue;
      await commitRecord(ctx, 'answers', answer.id, answer.data, {
        expectedRevision: answer.revision,
        status: 'stale',
        sourceIds: newFamilyIds,
      });
      invalidatedAnswerIds.push(answer.id);
    }
  }

  return { revokedFamilyIds: familyIds, newFamilyIds, invalidatedAnswerIds };
}
