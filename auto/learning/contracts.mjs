// auto/learning/contracts.mjs — schema validation, enums and public record
// limits for the learning ledger (CONTRACTS C/D). Pure functions only; nothing
// executes at import time. Never imports core/db.mjs.

export class LearningError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LearningError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const SCHEMA_VERSION = 1;

// Allowed collections (CONTRACTS C). Credentials are deliberately NOT one.
export const COLLECTIONS = Object.freeze([
  'observations', 'questions', 'families', 'answers', 'sourceChanges',
  'blockers', 'accounts', 'procedures', 'insights', 'proposals',
  'syncTasks', 'reviewRuns', 'forgetRequests',
]);

// Public record limits.
export const LIMITS = Object.freeze({
  maxTextLength: 20_000,
  maxArrayLength: 500,
  maxDepth: 8,
  maxRecordBytes: 262_144, // 256 KiB serialized envelope
  maxSourceIds: 200,
  maxIdLength: 128,
});

// Collection-specific envelope status enums. The ones named in CONTRACTS D are
// verbatim; the rest are deterministic local enums (strict, not permissive).
const STATUS_ENUMS = Object.freeze({
  observations: ['recorded', 'superseded', 'invalidated'],
  questions: ['proposed', 'approved', 'stale', 'revoked'],
  families: ['proposed', 'approved', 'stale', 'conflicted', 'revoked'],
  answers: ['proposed', 'approved', 'stale', 'conflicted', 'revoked'], // D3
  sourceChanges: ['recorded', 'processed'],
  blockers: ['open', 'waiting', 'resolved', 'expired'],
  accounts: ['active', 'pending', 'disabled', 'revoked'],
  procedures: ['candidate', 'tested', 'active', 'stale', 'revoked'], // D5
  insights: ['draft', 'published', 'stale', 'revoked'],
  proposals: ['draft', 'proposed', 'approved', 'rejected', 'applied', 'rolled_back'],
  syncTasks: ['pending', 'in_progress', 'done', 'failed'],
  reviewRuns: ['running', 'completed', 'failed', 'aborted'],
  forgetRequests: ['requested', 'previewed', 'applied', 'rejected'],
});

// Allowed top-level `data` keys per collection (CONTRACTS D). Unknown keys are
// rejected, never recursively indexed.
const DATA_KEYS = Object.freeze({
  observations: [
    'applicationId', 'attemptId', 'questionId', 'companyId', 'employerName',
    'atsVendor', 'atsTenant', 'roleTitle', 'roleFamily', 'country', 'locale',
    'stepId', 'fieldId', 'fieldType', 'originalText', 'options', 'required',
    'parentCondition', 'unit', 'currency', 'timeHorizon', 'observedAt',
    'sourceArtifact', 'captureMethod', 'coverage', 'answerDisposition', 'answerRef',
  ],
  questions: [
    'normalizedText', 'originalExamples', 'fieldType', 'locale', 'optionsHash',
    'polarity', 'unit', 'timeHorizon', 'constraints', 'occurrenceIds',
  ],
  families: ['label', 'questionIds', 'scope'],
  answers: [
    'questionFamilyId', 'kind', 'authority', 'sourceRefs', 'scope', 'validFrom',
    'validUntil', 'dependencies', 'approvalRef', 'publicUse', 'lastValidatedAt', 'template',
  ],
  sourceChanges: ['fileKey', 'oldHash', 'newHash', 'changedAt', 'impact'],
  blockers: [
    'applicationId', 'attemptId', 'type', 'question', 'requiredResolution',
    'sourceVersions', 'nextCheckAt', 'deadline', 'resolution',
  ],
  accounts: [
    'tenant', 'employerId', 'loginIdentityRef', 'credentialRef', 'lifecycle',
    'createdAtSource', 'lastUsedAt',
  ],
  procedures: [
    'scope', 'preconditions', 'steps', 'expectedObservations', 'maxRetries',
    'maxWaitMs', 'lastVerifiedAt', 'supportingAttemptIds', 'contradictingAttemptIds',
    'evaluationVersion', 'evaluationResult',
  ],
  insights: [
    'roleFamily', 'filters', 'from', 'to', 'distinctJobs', 'distinctCompanies',
    'rawOccurrences', 'coverage', 'statistics', 'sourceIds', 'contradictions',
    'recommendations',
  ],
  proposals: [
    'kind', 'evidenceIds', 'intendedBenefit', 'risk', 'baseline',
    'evaluationResult', 'affectedSources', 'requiredApprovals', 'rollbackVersion', 'diff',
  ],
  syncTasks: [
    'taskType', 'applicationId', 'attemptId', 'payloadRef', 'attempts',
    'lastError', 'nextAttemptAt',
  ],
  reviewRuns: [
    'startedAt', 'finishedAt', 'cursor', 'budget', 'processed', 'outcomes', 'errors',
  ],
  forgetRequests: [
    'scope', 'requestedAt', 'targets', 'previewRef', 'appliedAt', 'accounting',
  ],
});

// Value enums enforced when the field is present (CONTRACTS D1/D3/D5/D6).
const FIELD_ENUMS = Object.freeze({
  observations: {
    captureMethod: ['live_structured', 'legacy_array', 'legacy_object', 'report_section', 'manual_review'],
    coverage: ['observed', 'partially_observed', 'not_reached', 'unknown'],
    answerDisposition: ['unanswered', 'reused', 'drafted', 'confirmed', 'declined', 'blocked'],
    fieldType: ['text', 'textarea', 'select', 'radio', 'checkbox', 'date', 'number', 'file', 'custom', 'unknown'],
  },
  answers: {
    kind: ['source_reference', 'derived_rule', 'grounded_template', 'draft'],
    authority: ['canonical_source', 'user_confirmed', 'inferred', 'generated'],
  },
  blockers: {
    type: ['missing_answer', 'verification_pending', 'captcha', 'account_conflict',
      'submission_unknown', 'source_conflict', 'policy', 'tool_unavailable'],
  },
  proposals: {
    kind: ['answer', 'procedure', 'config', 'code', 'ui', 'positioning'],
  },
});

// Keys that may never carry secret material into the ledger. Matched
// case-insensitively against every nested key. Error details carry the key
// name only, never the value.
const FORBIDDEN_KEY_RE = /(password|passwd|secret|token|api[_-]?key|otp|one[_-]?time[_-]?code|credential|cookie|authorization|private[_-]?key|verification[_-]?(url|link))/i;
const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Shared secret/forbidden-key test (T04 evidence reuses the same pattern as
 * record validation). Matches the key/label NAME only; callers must never put
 * the value in an error or rejection message.
 */
export function isSecretKey(key) {
  return typeof key === 'string' && FORBIDDEN_KEY_RE.test(key);
}

export function isValidCollection(collection) {
  return COLLECTIONS.includes(collection);
}

export function assertCollection(collection) {
  if (!isValidCollection(collection)) {
    throw new LearningError('INVALID_COLLECTION', `unknown collection: ${String(collection)}`);
  }
}

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !id.includes('..');
}

export function assertId(id) {
  if (!isValidId(id)) {
    throw new LearningError('INVALID_ID', `invalid record id (opaque hash/uuid-like, no path fragments): ${String(id)}`);
  }
}

export function statusEnumFor(collection) {
  assertCollection(collection);
  return STATUS_ENUMS[collection];
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Deep structural validation shared by every collection: prototype keys,
// forbidden secret-bearing keys, non-finite numbers, depth/size caps.
function validateValue(value, path, depth) {
  if (depth > LIMITS.maxDepth) {
    throw new LearningError('LIMIT_EXCEEDED', `nesting deeper than ${LIMITS.maxDepth} at ${path}`);
  }
  if (value === null) return;
  const type = typeof value;
  if (type === 'string') {
    if (value.length > LIMITS.maxTextLength) {
      throw new LearningError('LIMIT_EXCEEDED', `string longer than ${LIMITS.maxTextLength} chars at ${path}`);
    }
    return;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new LearningError('SCHEMA_VALIDATION', `non-finite number at ${path}`);
    }
    return;
  }
  if (type === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxArrayLength) {
      throw new LearningError('LIMIT_EXCEEDED', `array longer than ${LIMITS.maxArrayLength} at ${path}`);
    }
    value.forEach((item, i) => validateValue(item, `${path}[${i}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new LearningError('SCHEMA_VALIDATION', `non-string key at ${path}`);
      }
      if (PROTO_KEYS.has(key)) {
        throw new LearningError('FORBIDDEN_KEY', `prototype-related key "${key}" at ${path}`);
      }
      if (FORBIDDEN_KEY_RE.test(key)) {
        throw new LearningError('FORBIDDEN_KEY', `secret-bearing key "${key}" is not allowed at ${path}`);
      }
      validateValue(value[key], `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new LearningError('SCHEMA_VALIDATION', `unsupported value type ${type} at ${path}`);
}

/**
 * Strict deterministic validation of a record's `data` payload for one
 * collection. Unknown top-level keys are rejected, never guessed at.
 */
export function validateRecordData(collection, data) {
  assertCollection(collection);
  if (!isPlainObject(data)) {
    throw new LearningError('SCHEMA_VALIDATION', `data must be a plain object for ${collection}`);
  }
  const allowed = DATA_KEYS[collection];
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== 'string' || PROTO_KEYS.has(key)) {
      throw new LearningError('FORBIDDEN_KEY', `prototype-related key in ${collection} data`);
    }
    if (FORBIDDEN_KEY_RE.test(key)) {
      throw new LearningError('FORBIDDEN_KEY', `secret-bearing key "${key}" is not allowed in ${collection} data`);
    }
    if (!allowed.includes(key)) {
      throw new LearningError('SCHEMA_VALIDATION', `unknown key "${key}" in ${collection} data`);
    }
  }
  validateValue(data, `${collection}.data`, 0);
  const enums = FIELD_ENUMS[collection];
  if (enums) {
    for (const [field, values] of Object.entries(enums)) {
      const v = data[field];
      if (v !== undefined && v !== null && !values.includes(v)) {
        throw new LearningError('SCHEMA_VALIDATION', `invalid ${collection}.${field}: ${String(v)}`);
      }
    }
  }
  // Collection-specific required shapes used by phase-1 consumers.
  if (collection === 'families') {
    if (typeof data.label !== 'string' || data.label.length === 0) {
      throw new LearningError('SCHEMA_VALIDATION', 'families.label must be a nonempty string');
    }
    if (!Array.isArray(data.questionIds)) {
      throw new LearningError('SCHEMA_VALIDATION', 'families.questionIds must be an array');
    }
    if (!isPlainObject(data.scope)) {
      throw new LearningError('SCHEMA_VALIDATION', 'families.scope must be an object');
    }
  }
  return true;
}

/**
 * Validate a full stored envelope (CONTRACTS C common envelope). Future schema
 * versions are refused, not parsed permissively.
 */
export function validateEnvelope(envelope, { collection } = {}) {
  if (!isPlainObject(envelope)) {
    throw new LearningError('SCHEMA_VALIDATION', 'envelope must be a plain object');
  }
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new LearningError('UNSUPPORTED_SCHEMA_VERSION',
      `unsupported schemaVersion ${String(envelope.schemaVersion)} (supported: ${SCHEMA_VERSION}); migration required`);
  }
  assertId(envelope.id);
  if (!Number.isInteger(envelope.revision) || envelope.revision < 1) {
    throw new LearningError('SCHEMA_VALIDATION', 'revision must be an integer >= 1');
  }
  for (const field of ['createdAt', 'updatedAt']) {
    const v = envelope[field];
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      throw new LearningError('SCHEMA_VALIDATION', `${field} must be an ISO date string`);
    }
  }
  if (!Array.isArray(envelope.sourceIds) || envelope.sourceIds.length > LIMITS.maxSourceIds) {
    throw new LearningError('SCHEMA_VALIDATION', `sourceIds must be an array of at most ${LIMITS.maxSourceIds}`);
  }
  for (const sid of envelope.sourceIds) {
    if (typeof sid !== 'string' || sid.length === 0 || sid.length > LIMITS.maxIdLength) {
      throw new LearningError('SCHEMA_VALIDATION', 'sourceIds entries must be nonempty short strings');
    }
  }
  if (collection !== undefined) {
    assertCollection(collection);
    if (!STATUS_ENUMS[collection].includes(envelope.status)) {
      throw new LearningError('SCHEMA_VALIDATION',
        `invalid status "${String(envelope.status)}" for ${collection} (allowed: ${STATUS_ENUMS[collection].join('|')})`);
    }
    validateRecordData(collection, envelope.data);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ingestion allowlist (T02): what source paths may ever be read into learning.
// Question text/options, source references and workflow measurements come from
// these roots; credentials, prompts, MCP configs, mailboxes, env files, tokens
// and verification links are excluded by name wherever they appear.

const INGEST_ALLOWED_PREFIXES = ['output/', 'reports/', 'jds/', 'data/auto/'];
const INGEST_FORBIDDEN_RE = /(^|\/)(credentials?\.json|prompt\.md|\.env[^/]*|.*\.mcp\.json|mcp[^/]*\.json|\.mcp(\/|$)|mail(box)?(\/|$)|.*\.eml)$|(^|\/)mail(box)?\//i;

export function isIngestiblePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
  if (relativePath.includes('\0')) return false;
  if (relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath)) return false; // absolute
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..' || part === '')) return false;
  if (INGEST_FORBIDDEN_RE.test(normalized)) return false;
  return INGEST_ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function assertIngestiblePath(relativePath) {
  if (!isIngestiblePath(relativePath)) {
    throw new LearningError('FORBIDDEN_SOURCE', `source path is not ingestible: ${String(relativePath)}`);
  }
  return true;
}
