// auto/learning/answers.mjs — answer resolution by authority, context and
// freshness (CONTRACTS D3/E, T07). Synchronous read-only resolution; nothing
// executes at import time. Never imports core/db.mjs.
//
// resolveAnswer(ctx,{observation,sourceSnapshot,policy})
//   -> { status, value, answerId, sourceRefs, reason }
// status: ready|needs_confirmation|draft|stale|blocked
// Only `ready` contains a fillable value. Every other status identifies the
// reason without inventing an answer. Conflicting sources return `blocked`
// with the conflicting reference IDs.

import { LearningError } from './contracts.mjs';
import { getRecord, listRecords } from './store.mjs';
import { normalizeQuestion } from './questions.mjs';

// Read-only source adapters. Only these file keys may ever back an answer;
// `notes` entries additionally require an explicit user confirmation stamp.
// A prose line in a memory file is NOT an approved eligibility fact: only
// exact selectors registered in valuesBySelector resolve.
export const SOURCE_FILE_KEYS = Object.freeze(['profile', 'standing', 'cv', 'notes']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * buildSourceRegistry(sourceSnapshot) -> registry
 * Validates the private in-process snapshot {sources:[{fileKey,sha256,
 * valuesBySelector,publicUse,confirmedAt}],capturedAt} and exposes exact
 * selector lookup only. Unknown file keys are refused, never guessed at.
 */
export function buildSourceRegistry(sourceSnapshot) {
  if (!isPlainObject(sourceSnapshot) || !Array.isArray(sourceSnapshot.sources)) {
    throw new LearningError('SCHEMA_VALIDATION', 'sourceSnapshot must be {sources:[],capturedAt}');
  }
  const byFileKey = new Map();
  for (const source of sourceSnapshot.sources) {
    if (!SOURCE_FILE_KEYS.includes(source?.fileKey)) {
      throw new LearningError('FORBIDDEN_SOURCE', `unknown source fileKey: ${String(source?.fileKey)}`);
    }
    if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) {
      throw new LearningError('SCHEMA_VALIDATION', `source ${source.fileKey} needs a sha256 hash`);
    }
    if (!isPlainObject(source.valuesBySelector)) {
      throw new LearningError('SCHEMA_VALIDATION', `source ${source.fileKey} needs valuesBySelector`);
    }
    if (source.fileKey === 'notes' && !source.confirmedAt) {
      throw new LearningError('FORBIDDEN_SOURCE', 'notes sources require explicit user confirmation (confirmedAt)');
    }
    byFileKey.set(source.fileKey, source);
  }
  return Object.freeze({
    hashOf: (fileKey) => byFileKey.get(fileKey)?.sha256 ?? null,
    lookup: (fileKey, selector) => {
      const source = byFileKey.get(fileKey);
      if (!source) return undefined;
      return Object.prototype.hasOwnProperty.call(source.valuesBySelector, selector)
        ? source.valuesBySelector[selector]
        : undefined;
    },
    publicUseOf: (fileKey) => byFileKey.get(fileKey)?.publicUse ?? null,
  });
}

// --- Deterministic derivation rules (dynamic facts are rules, not strings) ---
// Each rule names its inputs; inputs resolve from current approved sources at
// use time. Location NEVER derives nationality or work eligibility.
const DERIVATION_RULES = Object.freeze({
  availability_date_from_notice: {
    inputs: ['noticePeriodWeeks'],
    compute: ({ noticePeriodWeeks }, ctx) => {
      const weeks = Number(noticePeriodWeeks);
      if (!Number.isFinite(weeks) || weeks < 0) return null;
      const date = new Date(ctx.now().getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
      return date.toISOString().slice(0, 10);
    },
  },
});

function result(status, { value = null, answerId = null, sourceRefs = [], reason, conflictingRefs } = {}) {
  const out = { status, value, answerId, sourceRefs, reason };
  if (conflictingRefs) out.conflictingRefs = conflictingRefs;
  if (status !== 'ready') out.value = null; // only ready carries a fillable value
  return out;
}

// Never copy an option label the current menu does not offer.
function valueOfferedByMenu(observation, value) {
  if (!['select', 'radio', 'checkbox'].includes(observation.fieldType ?? '')) return true;
  const options = Array.isArray(observation.options) ? observation.options : [];
  return options.some((o) => o?.label === value || o?.value === value);
}

function scopeCompatible(scope, observation) {
  if (!isPlainObject(scope)) return true;
  if (scope.employerId != null && scope.employerId !== (observation.companyId ?? null)) return false;
  if (scope.country != null && scope.country !== (observation.country ?? null)) return false;
  if (scope.roleFamily != null && scope.roleFamily !== (observation.roleFamily ?? null)) return false;
  if (scope.locale != null && scope.locale !== (observation.locale ?? null)) return false;
  return true;
}

function withinValidity(record, nowIso) {
  const { validFrom, validUntil } = record.data;
  if (validFrom && nowIso < validFrom) return false;
  if (validUntil && nowIso > validUntil) return false;
  return true;
}

function sourceRefsCurrent(registry, sourceRefs) {
  for (const ref of sourceRefs ?? []) {
    if (registry.hashOf(ref.fileKey) !== ref.sha256) return false;
  }
  return true;
}

function familiesContaining(ctx, definitionId) {
  const { items: records } = listRecords(ctx, 'families', { limit: 500 });
  return records.filter((f) => f.status === 'approved'
    && Array.isArray(f.data.questionIds) && f.data.questionIds.includes(definitionId));
}

function approvedAnswersForFamilies(ctx, familyIds) {
  const { items: records } = listRecords(ctx, 'answers', { limit: 500 });
  return records.filter((a) => familyIds.includes(a.data.questionFamilyId));
}

function matchMapping(mapping, definition, observation) {
  if (mapping.definitionId && mapping.definitionId !== definition.id) return false;
  if (mapping.normalizedText && mapping.normalizedText !== definition.normalizedText) return false;
  if (!mapping.definitionId && !mapping.normalizedText) return false;
  if (mapping.scope && !scopeCompatible(mapping.scope, observation)) return false;
  if (mapping.unit !== undefined && mapping.unit !== (observation.unit ?? null)) return false;
  if (mapping.currency !== undefined && mapping.currency !== (observation.currency ?? null)) return false;
  return true;
}

/**
 * resolveAnswer(ctx,{observation,sourceSnapshot,policy}) (CONTRACTS E, T07).
 * Resolution order: current authoritative source mapping -> current approved
 * source-bound answer -> approved derivation from valid inputs -> grounded
 * draft requiring review -> missing-information blocker. Synchronous and
 * read-only; it never commits records and never calls a model for a
 * deterministic resolution.
 */
export function resolveAnswer(ctx, { observation, sourceSnapshot, policy = {} } = {}) {
  if (!isPlainObject(observation)) {
    throw new LearningError('SCHEMA_VALIDATION', 'resolveAnswer requires an observation');
  }
  const registry = buildSourceRegistry(sourceSnapshot);
  const definition = normalizeQuestion(observation);
  const nowIso = ctx.now().toISOString();

  if (definition.constraints.restricted) {
    return result('blocked', { reason: 'restricted_assessment: policy/human action required, not a reusable form answer' });
  }

  // Sensitive optional questions obey the user's explicit disclosure policy.
  const disclosure = policy.disclosure;
  if (disclosure && Array.isArray(disclosure.sensitiveNormalizedTexts)
      && disclosure.sensitiveNormalizedTexts.includes(definition.normalizedText)) {
    if (disclosure.action === 'decline' && typeof disclosure.declineLabel === 'string') {
      if (!valueOfferedByMenu(observation, disclosure.declineLabel)) {
        return result('blocked', { reason: 'approved decline option is not offered by the current menu' });
      }
      return result('ready', {
        value: disclosure.declineLabel,
        sourceRefs: [{ fileKey: 'policy', selector: 'disclosure.decline' }],
        reason: 'user-approved decline choice for sensitive optional question',
      });
    }
    return result('needs_confirmation', { reason: 'sensitive question without an approved disclosure action' });
  }

  // 1. Current authoritative source mapping.
  const mappings = (policy.mappings ?? []).filter((m) => matchMapping(m, definition, observation));
  if (mappings.length > 1) {
    const values = new Set(mappings.map((m) => registry.lookup(m.fileKey, m.selector)));
    if (values.size > 1) {
      return result('blocked', {
        reason: `conflicting source mappings: ${mappings.map((m) => `${m.fileKey}:${m.selector}`).join(' vs ')}`,
        conflictingRefs: mappings.map((m) => `${m.fileKey}:${m.selector}`),
      });
    }
  }
  if (mappings.length >= 1) {
    const mapping = mappings[0];
    const currentHash = registry.hashOf(mapping.fileKey);
    if (currentHash === null) {
      return result('blocked', { reason: `mapped source ${mapping.fileKey} absent from snapshot` });
    }
    if (mapping.sha256 && mapping.sha256 !== currentHash) {
      return result('stale', {
        reason: `source ${mapping.fileKey} changed since the mapping was approved (hash mismatch)`,
        sourceRefs: [{ fileKey: mapping.fileKey, selector: mapping.selector, sha256: mapping.sha256 }],
      });
    }
    const value = registry.lookup(mapping.fileKey, mapping.selector);
    if (value === undefined) {
      return result('blocked', { reason: `selector ${mapping.selector} not present in ${mapping.fileKey}` });
    }
    if (!valueOfferedByMenu(observation, value)) {
      return result('blocked', { reason: 'mapped value is not an option offered by the current menu' });
    }
    return result('ready', {
      value,
      sourceRefs: [{ fileKey: mapping.fileKey, selector: mapping.selector, sha256: currentHash }],
      reason: 'current authoritative source mapping',
    });
  }

  // 2/3. Current approved source-bound answer or approved derivation.
  const families = familiesContaining(ctx, definition.id);
  const familyIds = families.map((f) => f.id);
  if (familyIds.length > 0) {
    const answers = approvedAnswersForFamilies(ctx, familyIds);
    const approved = answers.filter((a) => a.status === 'approved');
    const conflicted = answers.filter((a) => a.status === 'conflicted');
    if (conflicted.length > 0) {
      return result('blocked', {
        reason: `conflicting answer records: ${conflicted.map((a) => a.id).join(', ')}`,
        conflictingRefs: conflicted.map((a) => a.id),
      });
    }
    const usable = approved.filter((a) => scopeCompatible(a.data.scope, observation));
    const distinctRefs = new Set(usable.map((a) => JSON.stringify(a.data.sourceRefs)));
    if (usable.length > 1 && distinctRefs.size > 1) {
      return result('blocked', {
        reason: `two plausible conflicting memories: ${usable.map((a) => a.id).join(', ')}`,
        conflictingRefs: usable.map((a) => a.id),
      });
    }
    for (const answer of usable) {
      const { kind, authority, sourceRefs, template, dependencies } = answer.data;
      if (['generated', 'inferred'].includes(authority)) {
        // A form accepting a generated answer never made it a personal fact.
        return result('needs_confirmation', {
          answerId: answer.id,
          reason: `answer ${answer.id} has authority "${authority}" and needs user confirmation before reuse`,
        });
      }
      if (!withinValidity(answer, nowIso)) {
        return result('stale', { answerId: answer.id, reason: `answer ${answer.id} is outside its validity window` });
      }
      if (!sourceRefsCurrent(registry, sourceRefs)) {
        return result('stale', { answerId: answer.id, reason: `answer ${answer.id} is bound to a modified source (hash mismatch)` });
      }
      if (kind === 'source_reference') {
        const ref = sourceRefs[0];
        const value = registry.lookup(ref.fileKey, ref.selector);
        if (value === undefined) {
          return result('blocked', { answerId: answer.id, reason: `selector ${ref.selector} vanished from ${ref.fileKey}` });
        }
        if (!valueOfferedByMenu(observation, value)) {
          return result('blocked', { answerId: answer.id, reason: 'stored value is not an option offered by the current menu' });
        }
        return result('ready', {
          value, answerId: answer.id, sourceRefs,
          reason: 'current approved source-bound answer',
        });
      }
      if (kind === 'derived_rule') {
        const rule = DERIVATION_RULES[template];
        if (!rule) {
          return result('blocked', { answerId: answer.id, reason: `unknown derivation rule ${String(template)}` });
        }
        const inputs = {};
        for (const [i, name] of rule.inputs.entries()) {
          const dep = (dependencies ?? [])[i];
          const value = dep ? registry.lookup(dep.fileKey, dep.selector) : undefined;
          if (value === undefined) {
            return result('blocked', { answerId: answer.id, reason: `derivation input ${name} unavailable from approved sources` });
          }
          inputs[name] = value;
        }
        const computed = rule.compute(inputs, ctx);
        if (computed === null) {
          return result('blocked', { answerId: answer.id, reason: 'derivation inputs were invalid' });
        }
        if (!valueOfferedByMenu(observation, computed)) {
          return result('blocked', { answerId: answer.id, reason: 'derived value is not an option offered by the current menu' });
        }
        return result('ready', {
          value: computed, answerId: answer.id, sourceRefs,
          reason: `approved derivation (${template}) from valid inputs`,
        });
      }
    }
  }

  // 4. Grounded draft requiring review (free text only; drafts are never facts).
  if (['text', 'textarea'].includes(observation.fieldType ?? '') && policy.allowDraft) {
    if (policy.modelClient && typeof policy.modelClient.draft === 'function') {
      policy.modelClient.draft({ normalizedText: definition.normalizedText });
    }
    return result('draft', { reason: 'grounded draft requires user review before any use' });
  }

  // 5. Missing-information blocker. No inference (and never nationality or
  // eligibility from location).
  return result('blocked', { reason: `missing_information: no approved source answers "${definition.normalizedText}"` });
}

/** Convenience read used by tests and callers: latest answer record. */
export function getAnswerRecord(ctx, answerId) {
  return getRecord(ctx, 'answers', answerId);
}
