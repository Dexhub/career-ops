// auto/learning/answers.mjs — answer resolution by authority, context and
// freshness (CONTRACTS D3/E, T07). Synchronous read-only resolution; nothing
// executes at import time. Never imports core/db.mjs.
// T08 adds durable proposal/approval/invalidation at the end of this file;
// resolution itself stays read-only.
//
// resolveAnswer(ctx,{observation,sourceSnapshot,policy})
//   -> { status, value, answerId, sourceRefs, reason }
// status: ready|needs_confirmation|draft|stale|blocked
// Only `ready` contains a fillable value. Every other status identifies the
// reason without inventing an answer. Conflicting sources return `blocked`
// with the conflicting reference IDs.

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { LearningError } from './contracts.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';
import { normalizeQuestion } from './questions.mjs';
import { learningDataRoot } from './context.mjs';

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

// ---------------------------------------------------------------------------
// T08 — durable approval, corrections, withdrawal and resume (CONTRACTS E).
// proposeAnswer / approveAnswer / invalidateSource, plus the source-patch
// preview, crash reconciliation and forget preview they depend on.

const HASH_RE = /^[0-9a-f]{64}$/;
const CUSTOM_SELECTOR_RE = /^custom\.(.+)$/s;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function hashText(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** sha256 hex of a file's current content. */
export function hashFileHex(path) {
  return hashText(readFileSync(path, 'utf-8'));
}

/** The standing-answers source file under the DATA root (fixtures use copies). */
export function standingSourcePath(ctx) {
  return join(ctx.dataRoot, 'config', 'standing-answers.yml');
}

function intentsDir(ctx) {
  return join(learningDataRoot(ctx), 'intents');
}

/** Durable approval-intent path for one proposal (crash reconciliation). */
export function approvalIntentPath(ctx, proposalId) {
  return join(intentsDir(ctx), `${proposalId}.json`);
}

// Atomic write: exclusive owner-only temp in the target dir, write+fsync, rename.
function writeFileAtomicLocal(targetPath, content) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  const fd = openSync(tmpPath, 'wx', FILE_MODE);
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

// --- User-approval authority -------------------------------------------------
// Authority is capability-based: only a token minted via createUserApproval by
// the owning harness/UI confers it. A plain data object claiming actor:'user'
// (anything an agent or model can serialize) can never be in this private set.
const USER_APPROVALS = new WeakSet();

/**
 * createUserApproval({approvedBy}) -> token. To be called ONLY by the surface
 * that actually interacted with the user (UI/CLI/test harness fixture).
 */
export function createUserApproval({ approvedBy } = {}) {
  if (typeof approvedBy !== 'string' || approvedBy.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'createUserApproval requires approvedBy');
  }
  const token = Object.freeze({ kind: 'user_approval', approvedBy });
  USER_APPROVALS.add(token);
  return token;
}

function assertUserApproval(approval) {
  if (!USER_APPROVALS.has(approval)) {
    throw new LearningError('APPROVAL_REQUIRED',
      "user approval required: only a token minted by the owning harness confers authority; an agent/model-supplied actor:'user' claim never does");
  }
}

/**
 * proposeAnswer(ctx, input) -> proposal envelope (CONTRACTS E, T08).
 * Creates an immutable proposal record WITHOUT changing any candidate source.
 * Stores question/context, the proposed value, the exact source hash, the
 * intended selector, affected applications and use scope.
 */
export async function proposeAnswer(ctx, input = {}) {
  const {
    question, fileKey, selector, proposedValue, sourceHash,
    affectedApplicationIds = [], scope = {}, sensitive = false,
    questionFamilyId = null, evidenceIds = [], intendedBenefit = null, risk = 'low',
  } = input;
  if (!isPlainObject(question) || typeof question.normalizedText !== 'string' || question.normalizedText.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'proposeAnswer requires question.normalizedText');
  }
  if (!SOURCE_FILE_KEYS.includes(fileKey)) {
    throw new LearningError('FORBIDDEN_SOURCE', `unknown source fileKey: ${String(fileKey)}`);
  }
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'proposeAnswer requires a selector');
  }
  if (typeof sourceHash !== 'string' || !HASH_RE.test(sourceHash)) {
    throw new LearningError('SCHEMA_VALIDATION', 'proposeAnswer requires the exact current sourceHash (sha256 hex)');
  }
  const valueOk = typeof proposedValue === 'string'
    || (Array.isArray(proposedValue) && proposedValue.length > 0 && proposedValue.every((v) => typeof v === 'string'));
  if (!valueOk) {
    throw new LearningError('SCHEMA_VALIDATION', 'proposedValue must be a string or a nonempty array of strings');
  }
  if (!Array.isArray(affectedApplicationIds) || !affectedApplicationIds.every((a) => typeof a === 'string')) {
    throw new LearningError('SCHEMA_VALIDATION', 'affectedApplicationIds must be an array of strings');
  }
  const id = `prop-${randomUUID()}`;
  const data = {
    kind: 'answer',
    evidenceIds: [...evidenceIds],
    intendedBenefit,
    risk,
    baseline: null,
    evaluationResult: null,
    affectedSources: [{ fileKey, selector, sha256: sourceHash }],
    requiredApprovals: ['user'],
    rollbackVersion: null,
    diff: {
      question: {
        normalizedText: question.normalizedText,
        originalText: question.originalText ?? null,
        fieldType: question.fieldType ?? null,
      },
      fileKey,
      selector,
      proposedValue,
      scope: { ...scope },
      affectedApplicationIds: [...affectedApplicationIds],
      sensitive: sensitive === true,
      questionFamilyId,
    },
  };
  return commitRecord(ctx, 'proposals', id, data, {
    expectedRevision: 0, status: 'proposed', sourceIds: [`${fileKey}@${sourceHash}`],
  });
}

/**
 * listAnswerProposals(ctx,{includeSensitiveValues}) -> envelopes.
 * The DEFAULT list hides sensitive proposed values; only an explicit opt-in
 * (a reviewing UI acting for the user) sees them.
 */
export function listAnswerProposals(ctx, { includeSensitiveValues = false } = {}) {
  const { items } = listRecords(ctx, 'proposals', { limit: 500 });
  return items
    .filter((p) => p.data.kind === 'answer')
    .map((p) => {
      if (includeSensitiveValues || p.data.diff?.sensitive !== true) return p;
      return {
        ...p,
        data: { ...p.data, diff: { ...p.data.diff, proposedValue: '[redacted-sensitive]' } },
      };
    });
}

// Insert one quoted entry at the end of the top-level `custom:` block,
// preserving every other byte (comments, ordering, Markdown-ish prose).
function insertCustomEntry(beforeText, entryLine) {
  const lines = beforeText.split('\n');
  const start = lines.findIndex((l) => /^custom:\s*(#.*)?$/.test(l));
  if (start === -1) {
    throw new LearningError('PATCH_VALIDATION', 'standing source has no top-level custom: block');
  }
  let lastContent = start;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\s{2,}\S/.test(l)) { lastContent = i; continue; }
    if (l.trim() === '') continue;
    break; // next top-level key or column-0 comment: block ended
  }
  const out = lines.slice();
  out.splice(lastContent + 1, 0, entryLine);
  return out.join('\n');
}

/**
 * previewAnswerSourcePatch(ctx, proposalOrId) -> {beforeHash, afterHash,
 * afterText, key, selector}. Pure preview: nothing is written. Only an
 * explicitly quoted scalar/array under an approved standing `custom.*` key is
 * patchable here; profile/CV or conflicting edits require a separate reviewed
 * source patch and are refused, never hidden in the answer bank.
 */
export function previewAnswerSourcePatch(ctx, proposalOrId) {
  const proposal = typeof proposalOrId === 'string'
    ? getRecord(ctx, 'proposals', proposalOrId)
    : proposalOrId;
  if (!proposal || !isPlainObject(proposal.data)) {
    throw new LearningError('NOT_FOUND', 'proposal not found');
  }
  const source = proposal.data.affectedSources?.[0];
  if (!source) {
    throw new LearningError('SCHEMA_VALIDATION', 'proposal has no affected source');
  }
  if (source.fileKey !== 'standing') {
    throw new LearningError('COMPLEX_SOURCE_EDIT',
      `edits to ${source.fileKey} require a separate reviewed source patch, not an override hidden in the answer bank`);
  }
  const m = CUSTOM_SELECTOR_RE.exec(source.selector);
  if (!m) {
    throw new LearningError('COMPLEX_SOURCE_EDIT',
      'only approved standing custom.* keys may be patched automatically');
  }
  const key = m[1];
  const path = standingSourcePath(ctx);
  const beforeText = readFileSync(path, 'utf-8');
  const beforeHash = hashText(beforeText);
  if (beforeHash !== source.sha256) {
    throw new LearningError('REVISION_CONFLICT',
      'standing source changed since the proposal captured its hash',
      { expectedHash: source.sha256, actualHash: beforeHash });
  }
  const parsedBefore = yaml.load(beforeText);
  if (!isPlainObject(parsedBefore) || !isPlainObject(parsedBefore.custom)) {
    throw new LearningError('PATCH_VALIDATION', 'standing source must parse to a mapping with a custom block');
  }
  if (Object.prototype.hasOwnProperty.call(parsedBefore.custom, key)) {
    throw new LearningError('CONFLICTING_SOURCE_EDIT',
      'custom key already exists with a prior user-approved value; a conflicting change requires a separate reviewed source patch');
  }
  const value = proposal.data.diff.proposedValue;
  const rendered = Array.isArray(value)
    ? `[${value.map((v) => JSON.stringify(String(v))).join(', ')}]`
    : JSON.stringify(String(value));
  const entryLine = `  ${JSON.stringify(key)}: ${rendered}`;
  const afterText = insertCustomEntry(beforeText, entryLine);
  // Validate parsed before/after structures: only the approved path changed.
  const parsedAfter = yaml.load(afterText);
  if (!isPlainObject(parsedAfter) || !isPlainObject(parsedAfter.custom)
      || !Object.prototype.hasOwnProperty.call(parsedAfter.custom, key)) {
    throw new LearningError('PATCH_VALIDATION', 'patched standing source lost the approved key');
  }
  const expected = Array.isArray(value) ? value.map(String) : String(value);
  if (JSON.stringify(parsedAfter.custom[key]) !== JSON.stringify(expected)) {
    throw new LearningError('PATCH_VALIDATION', 'patched value does not round-trip through YAML');
  }
  const clone = structuredClone(parsedAfter);
  delete clone.custom[key];
  if (JSON.stringify(clone) !== JSON.stringify(parsedBefore)) {
    throw new LearningError('PATCH_VALIDATION', 'patch changed something besides the approved custom path');
  }
  return { beforeHash, afterHash: hashText(afterText), afterText, key, selector: source.selector };
}

// Idempotent finalization shared by approveAnswer and crash reconciliation:
// every step checks for prior completion so nothing is ever applied twice.
async function finalizeApproval(ctx, intent, committedHash) {
  const nowIso = ctx.now().toISOString();
  const proposal = getRecord(ctx, 'proposals', intent.proposalId);
  if (!proposal) {
    throw new LearningError('NOT_FOUND', `proposal ${intent.proposalId} vanished during finalization`);
  }
  const diff = proposal.data.diff;
  const answerId = `ans-${intent.proposalId}`;
  if (!getRecord(ctx, 'answers', answerId)) {
    await commitRecord(ctx, 'answers', answerId, {
      questionFamilyId: diff.questionFamilyId ?? null,
      kind: 'source_reference',
      authority: 'user_confirmed',
      sourceRefs: [{ fileKey: 'standing', selector: intent.selector, sha256: committedHash }],
      scope: {
        employerId: diff.scope?.employerId ?? null,
        country: diff.scope?.country ?? null,
        roleFamily: diff.scope?.roleFamily ?? null,
        locale: diff.scope?.locale ?? 'en',
      },
      validFrom: nowIso,
      validUntil: null,
      dependencies: [],
      approvalRef: intent.proposalId,
      publicUse: 'applications_only',
      lastValidatedAt: nowIso,
      template: null,
    }, { expectedRevision: 0, status: 'approved', sourceIds: [`standing@${committedHash}`] });
  }
  const changeId = `srcchg-${intent.proposalId}`;
  if (!getRecord(ctx, 'sourceChanges', changeId)) {
    await commitRecord(ctx, 'sourceChanges', changeId, {
      fileKey: 'standing',
      oldHash: intent.beforeHash,
      newHash: committedHash,
      changedAt: nowIso,
      impact: { proposalId: intent.proposalId, reason: 'approved_answer_patch' },
    }, { expectedRevision: 0, status: 'recorded', sourceIds: [intent.proposalId] });
  }
  if (proposal.status !== 'applied') {
    await commitRecord(ctx, 'proposals', proposal.id, {
      ...proposal.data,
      rollbackVersion: intent.beforeHash,
      evaluationResult: {
        committedHash, approvedBy: intent.approvedBy, approvedAt: intent.approvedAt,
      },
    }, { expectedRevision: proposal.revision, status: 'applied', sourceIds: proposal.sourceIds });
  }
  try {
    unlinkSync(approvalIntentPath(ctx, intent.proposalId));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return answerId;
}

/**
 * approveAnswer(ctx,{proposalId,expectedRevision,approval}) -> {status,
 * sourceHash} (CONTRACTS E, T08). Applies a user-approved proposal under the
 * source lock with an expected hash: persist the approval intent, atomically
 * write the approved source change, record the committed hash. The approval
 * binds to one proposal revision; a stale revision or an independently edited
 * source rejects with REVISION_CONFLICT and leaves the source untouched.
 */
export async function approveAnswer(ctx, { proposalId, expectedRevision, approval } = {}) {
  assertUserApproval(approval);
  const proposal = getRecord(ctx, 'proposals', proposalId);
  if (!proposal) {
    throw new LearningError('NOT_FOUND', `proposal ${String(proposalId)} not found`);
  }
  if (proposal.status === 'applied') {
    // Idempotent repeat: the applied change is terminal; never re-apply.
    return {
      status: 'already_applied',
      sourceHash: proposal.data.evaluationResult?.committedHash ?? null,
    };
  }
  if (proposal.status !== 'proposed') {
    throw new LearningError('INVALID_STATE', `proposal ${proposalId} is ${proposal.status}, not approvable`);
  }
  if (proposal.revision !== expectedRevision) {
    throw new LearningError('REVISION_CONFLICT',
      `stale approval: proposal ${proposalId} is at revision ${proposal.revision}, approval was granted against ${expectedRevision}`,
      { expectedRevision, actualRevision: proposal.revision });
  }
  const standingPath = standingSourcePath(ctx);
  return withPipelineLock(standingPath, async () => {
    // Re-checks the expected source hash under the lock; an independent edit
    // throws REVISION_CONFLICT here, before any intent or write exists.
    const preview = previewAnswerSourcePatch(ctx, proposal);
    const intent = {
      proposalId,
      proposalRevision: proposal.revision,
      fileKey: 'standing',
      selector: preview.selector,
      beforeHash: preview.beforeHash,
      afterHash: preview.afterHash,
      approvedBy: approval.approvedBy,
      approvedAt: ctx.now().toISOString(),
    };
    // 1. Durable intent BEFORE touching the source (crash reconciliation).
    writeFileAtomicLocal(approvalIntentPath(ctx, proposalId), JSON.stringify(intent, null, 2));
    // 2. Atomic source write, then verify the committed hash.
    writeFileAtomicLocal(standingPath, preview.afterText);
    const committedHash = hashFileHex(standingPath);
    if (committedHash !== preview.afterHash) {
      throw new LearningError('WRITE_VERIFICATION_FAILED',
        'committed standing hash does not match the intended after-hash');
    }
    // 3. Finalize records and clear the intent.
    await finalizeApproval(ctx, intent, committedHash);
    return { status: 'applied', sourceHash: committedHash };
  });
}

/**
 * reconcileApprovals(ctx) -> {finalized,rolledBack,diverged} (T08 crash
 * recovery). Compares each persisted intent's before/after hashes against the
 * current source. after-hash match: the write committed before the crash —
 * finalize records WITHOUT applying again. before-hash match: the write never
 * happened — drop the intent; the proposal stays 'proposed' and a pending
 * intent is never treated as an approved usable fact. Anything else diverged:
 * kept for human review.
 */
export async function reconcileApprovals(ctx) {
  const dir = intentsDir(ctx);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const summary = { finalized: [], rolledBack: [], diverged: [] };
  const standingPath = standingSourcePath(ctx);
  for (const name of names) {
    const intent = JSON.parse(readFileSync(join(dir, name), 'utf-8'));
    const currentHash = existsSync(standingPath) ? hashFileHex(standingPath) : null;
    if (currentHash === intent.afterHash) {
      await finalizeApproval(ctx, intent, currentHash);
      summary.finalized.push(intent.proposalId);
    } else if (currentHash === intent.beforeHash) {
      unlinkSync(join(dir, name));
      summary.rolledBack.push(intent.proposalId);
    } else {
      summary.diverged.push(intent.proposalId);
    }
  }
  return summary;
}

/**
 * invalidateSource(ctx,{fileKey,oldHash,newHash}) -> summary (CONTRACTS E,
 * T08). Correction/expiry/revocation: records the source change and
 * invalidates everything bound to the old hash — answer records (including
 * grounded-template stories), procedures dependent on the fact, and
 * positioning/answer proposal drafts. Notifies ONLY blockers that reference
 * the changed source; it never requeues an unknown submission or creates an
 * application. newHash null means the source was deleted: bound answers are
 * revoked, not merely stale.
 */
export async function invalidateSource(ctx, { fileKey, oldHash, newHash } = {}) {
  if (!SOURCE_FILE_KEYS.includes(fileKey)) {
    throw new LearningError('FORBIDDEN_SOURCE', `unknown source fileKey: ${String(fileKey)}`);
  }
  if (typeof oldHash !== 'string' || !HASH_RE.test(oldHash)) {
    throw new LearningError('SCHEMA_VALIDATION', 'invalidateSource requires oldHash (sha256 hex)');
  }
  if (newHash !== null && (typeof newHash !== 'string' || !HASH_RE.test(newHash))) {
    throw new LearningError('SCHEMA_VALIDATION', 'newHash must be sha256 hex or null (deleted)');
  }
  const deleted = newHash === null;
  const nowIso = ctx.now().toISOString();
  const marker = `${fileKey}@${oldHash}`;
  const summary = {
    fileKey,
    deleted,
    staleAnswers: [],
    revokedAnswers: [],
    staleProcedures: [],
    rejectedDrafts: [],
    staleInsights: [],
    notifiedBlockers: [],
    untouchedBlockers: [],
  };

  const { items: answers } = listRecords(ctx, 'answers', { limit: 500 });
  for (const a of answers) {
    if (!['approved', 'proposed'].includes(a.status)) continue;
    const bound = (a.data.sourceRefs ?? []).some((r) => r.fileKey === fileKey && r.sha256 === oldHash);
    if (!bound) continue;
    const next = deleted ? 'revoked' : 'stale';
    await commitRecord(ctx, 'answers', a.id, a.data,
      { expectedRevision: a.revision, status: next, sourceIds: a.sourceIds });
    (deleted ? summary.revokedAnswers : summary.staleAnswers).push(a.id);
  }

  const { items: procedures } = listRecords(ctx, 'procedures', { limit: 500 });
  for (const p of procedures) {
    if (!['candidate', 'tested', 'active'].includes(p.status)) continue;
    if (!p.sourceIds.includes(marker)) continue;
    await commitRecord(ctx, 'procedures', p.id, p.data,
      { expectedRevision: p.revision, status: 'stale', sourceIds: p.sourceIds });
    summary.staleProcedures.push(p.id);
  }

  const { items: insights } = listRecords(ctx, 'insights', { limit: 500 });
  for (const i of insights) {
    if (!['draft', 'published'].includes(i.status)) continue;
    if (!i.sourceIds.includes(marker)) continue;
    await commitRecord(ctx, 'insights', i.id, i.data,
      { expectedRevision: i.revision, status: 'stale', sourceIds: i.sourceIds });
    summary.staleInsights.push(i.id);
  }

  const { items: proposals } = listRecords(ctx, 'proposals', { limit: 500 });
  for (const p of proposals) {
    if (!['draft', 'proposed'].includes(p.status)) continue;
    if (!['answer', 'positioning'].includes(p.data.kind)) continue;
    const bound = (p.data.affectedSources ?? []).some((s) => s.fileKey === fileKey && s.sha256 === oldHash);
    if (!bound) continue;
    await commitRecord(ctx, 'proposals', p.id, p.data,
      { expectedRevision: p.revision, status: 'rejected', sourceIds: p.sourceIds });
    summary.rejectedDrafts.push(p.id);
  }

  // Notify ONLY affected blockers. An unknown submission is never requeued by
  // a source edit, and no application/job state is touched here.
  const { items: blockers } = listRecords(ctx, 'blockers', { limit: 500 });
  for (const b of blockers) {
    if (!['open', 'waiting'].includes(b.status)) continue;
    const refs = Array.isArray(b.data.sourceVersions) ? b.data.sourceVersions : [];
    const bound = refs.some((r) => r?.fileKey === fileKey && r?.sha256 === oldHash);
    if (!bound || b.data.type === 'submission_unknown') {
      summary.untouchedBlockers.push(b.id);
      continue;
    }
    await commitRecord(ctx, 'blockers', b.id, { ...b.data, nextCheckAt: nowIso },
      { expectedRevision: b.revision, status: 'open', sourceIds: b.sourceIds });
    summary.notifiedBlockers.push(b.id);
  }

  const changeId = `srcchg-${randomUUID()}`;
  await commitRecord(ctx, 'sourceChanges', changeId, {
    fileKey, oldHash, newHash, changedAt: nowIso,
    impact: {
      staleAnswers: summary.staleAnswers,
      revokedAnswers: summary.revokedAnswers,
      staleProcedures: summary.staleProcedures,
      rejectedDrafts: summary.rejectedDrafts,
      staleInsights: summary.staleInsights,
      notifiedBlockers: summary.notifiedBlockers,
    },
  }, { expectedRevision: 0, status: 'recorded', sourceIds: [marker] });
  summary.sourceChangeId = changeId;
  return summary;
}

/**
 * previewForget(ctx,{scope,targets}) -> preview (T08). Lists what a forget
 * request would cover: canonical learning versions, derived indexes, exports,
 * and the STILL-EXISTING original audit artifacts. The preview deletes
 * nothing and NEVER claims complete erasure while originals remain; only an
 * explicitly approved deletion removes originals.
 */
export async function previewForget(ctx, { scope = 'answers', targets = [] } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'previewForget requires at least one {collection,id} target');
  }
  const root = learningDataRoot(ctx);
  const canonicalVersions = [];
  for (const t of targets) {
    if (!isPlainObject(t) || typeof t.collection !== 'string' || typeof t.id !== 'string') {
      throw new LearningError('SCHEMA_VALIDATION', 'each target must be {collection,id}');
    }
    const dir = join(root, 'records', t.collection, t.id);
    let revisions = [];
    try {
      revisions = readdirSync(dir)
        .filter((n) => /^\d+\.json$/.test(n))
        .map((n) => Number(n.replace('.json', '')))
        .sort((a, b) => a - b);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    canonicalVersions.push({ collection: t.collection, id: t.id, revisions });
  }
  let derivedIndexes = [];
  try {
    derivedIndexes = readdirSync(join(root, 'indexes')).filter((n) => n.startsWith('gen-'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  // Original audit artifacts still on disk that reference a targeted answer.
  const targetAnswerIds = targets.filter((t) => t.collection === 'answers').map((t) => t.id);
  const remainingOriginalAudits = [];
  if (targetAnswerIds.length > 0) {
    const { items: observations } = listRecords(ctx, 'observations', { limit: 500 });
    for (const o of observations) {
      if (!targetAnswerIds.includes(o.data.answerRef)) continue;
      const artifact = o.data.sourceArtifact;
      const rel = typeof artifact === 'string' ? artifact : artifact?.relativePath;
      if (typeof rel === 'string' && existsSync(join(ctx.dataRoot, rel))) {
        remainingOriginalAudits.push(rel);
      }
    }
  }
  const originalsRemain = remainingOriginalAudits.length > 0;
  const requestId = `forget-${randomUUID()}`;
  await commitRecord(ctx, 'forgetRequests', requestId, {
    scope,
    requestedAt: ctx.now().toISOString(),
    targets: targets.map((t) => ({ collection: t.collection, id: t.id })),
    previewRef: null,
    appliedAt: null,
    accounting: {
      canonicalVersionCount: canonicalVersions.reduce((n, c) => n + c.revisions.length, 0),
      derivedIndexCount: derivedIndexes.length,
      remainingOriginalAuditCount: remainingOriginalAudits.length,
    },
  }, { expectedRevision: 0, status: 'previewed', sourceIds: [] });
  return {
    requestId,
    canonicalVersions,
    derivedIndexes,
    exports: [],
    remainingOriginalAudits,
    originalsRemain,
    claimsCompleteErasure: false,
    note: originalsRemain
      ? 'preview only: original audit artifacts remain on disk; this is NOT erasure — only an explicitly approved deletion removes originals'
      : 'preview only: nothing has been deleted yet',
  };
}
