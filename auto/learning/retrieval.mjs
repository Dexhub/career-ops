// auto/learning/retrieval.mjs — small, source-bound answer and experience
// packets (CONTRACTS E, T09). Synchronous, read-only packet assembly over the
// learning store and approved source files; nothing executes at import time.
// Never imports core/db.mjs.
//
// buildContextPacket(ctx,{applicationId,observations,maxBytes})
//   -> {answers,stories,procedures,gaps,versions,bytes}
// versions = {sourceHashes,policyVersion,procedureVersions,questionRevisions}

import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { LearningError, isSecretKey } from './contracts.mjs';
import { readLearningConfig } from './context.mjs';
import { commitRecord, listRecords, getRecord } from './store.mjs';
import { normalizeQuestion } from './questions.mjs';
import { resolveAnswer } from './answers.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// --- Approved source files (read-only) ---------------------------------------
// Only these DATA-root files back packets. `notes` is deliberately absent:
// auto-loading can never confer the explicit user confirmation it requires.
const SOURCE_PATHS = Object.freeze({
  profile: ['config', 'profile.yml'],
  standing: ['config', 'standing-answers.yml'],
  cv: ['cv.md'],
});

// Flatten YAML scalars/arrays-of-scalars to dotted selectors. A key matching
// the shared secret pattern is skipped entirely: its value never leaves disk.
function flattenSelectors(value, prefix, out) {
  if (!isPlainObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    const selector = prefix ? `${prefix}.${key}` : key;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[selector] = v;
    } else if (Array.isArray(v) && v.every((e) => typeof e === 'string')) {
      out[selector] = v;
    } else if (isPlainObject(v)) {
      flattenSelectors(v, selector, out);
    }
  }
}

/**
 * loadSourceSnapshot(ctx) -> {snapshot,texts}. Reads whichever approved source
 * files exist under the data root, hashing exact content. cv is narrative
 * material (stories only), so it exposes no selectors.
 */
export function loadSourceSnapshot(ctx) {
  const sources = [];
  const texts = {};
  for (const [fileKey, parts] of Object.entries(SOURCE_PATHS)) {
    const path = join(ctx.dataRoot, ...parts);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf-8');
    texts[fileKey] = text;
    const valuesBySelector = {};
    if (fileKey !== 'cv') {
      let parsed;
      try {
        parsed = yaml.load(text);
      } catch (err) {
        throw new LearningError('SOURCE_MALFORMED', `${fileKey} source failed to parse: ${err.message}`);
      }
      flattenSelectors(parsed, '', valuesBySelector);
    }
    sources.push({
      fileKey, sha256: sha256(text), valuesBySelector, publicUse: 'applications_only',
    });
  }
  return { snapshot: { sources, capturedAt: ctx.now().toISOString() }, texts };
}

// --- Experience stories from approved CV material ----------------------------
// A story points at a verbatim span of the approved source; it never
// synthesizes a metric or accomplishment absent from that source. Lines whose
// text matches the shared secret pattern are dropped, never carried.
const MAX_STORY_CLAIMS = 8;
const MAX_CLAIM_CHARS = 300;

function tokensOf(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

/** extractExperienceStories({fileKey,text,sha256hex}) -> stories[] (pure). */
export function extractExperienceStories({ fileKey, text, sha256hex }) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split('\n');
  const stories = [];
  let current = null;
  const flush = () => {
    if (current && current.claims.length > 0) stories.push(current);
    current = null;
  };
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      current = {
        id: `story-${sha256(`${sha256hex}:${i}:${heading[1]}`).slice(0, 24)}`,
        label: heading[1],
        sourceRef: { fileKey, sha256: sha256hex, span: { startLine: i + 1, endLine: i + 1 } },
        roleTags: [...tokensOf(heading[1])],
        capabilityTags: [],
        publicUse: 'applications_only',
        claims: [],
      };
      continue;
    }
    if (!current || line === '') continue;
    current.sourceRef.span.endLine = i + 1;
    if (isSecretKey(line)) continue; // secret-bearing line never becomes a claim
    if (current.claims.length < MAX_STORY_CLAIMS) {
      current.claims.push(line.slice(0, MAX_CLAIM_CHARS));
      if (/^[-*]\s/.test(line)) current.capabilityTags.push(...tokensOf(line));
    }
  }
  flush();
  for (const s of stories) s.capabilityTags = [...new Set(s.capabilityTags)].slice(0, 20);
  return stories;
}

// --- Relevant procedures ------------------------------------------------------

function procedureScopeMatches(scope, observations) {
  if (!isPlainObject(scope) || Object.keys(scope).length === 0) return true;
  return observations.some((o) => (scope.employerId == null || scope.employerId === (o.companyId ?? null))
    && (scope.country == null || scope.country === (o.country ?? null))
    && (scope.roleFamily == null || scope.roleFamily === (o.roleFamily ?? null))
    && (scope.locale == null || scope.locale === (o.locale ?? null))
    && (scope.atsVendor == null || scope.atsVendor === (o.atsVendor ?? null)));
}

const MAX_PROCEDURES = 5;

function relevantProcedures(ctx, observations) {
  const { items } = listRecords(ctx, 'procedures', { limit: 500 });
  return items
    .filter((p) => ['active', 'tested'].includes(p.status) && procedureScopeMatches(p.data.scope, observations))
    .sort((a, b) => String(b.data.lastVerifiedAt ?? '').localeCompare(String(a.data.lastVerifiedAt ?? '')))
    .slice(0, MAX_PROCEDURES)
    .map((p) => ({ id: p.id, version: p.revision, scope: p.data.scope ?? {} }));
}

// --- Packet cache -------------------------------------------------------------
// Keyed by job/JD revision + question/option fingerprints + source hashes +
// policy/procedure versions + locale — NEVER by role title alone. Any relevant
// change produces a different key, so stale packets are unreachable.
const PACKET_CACHE = new Map();
const PACKET_CACHE_MAX = 50;

export function clearContextPacketCache() {
  PACKET_CACHE.clear();
}

function cacheKeyOf({ ctx, applicationId, jdRevision, definitions, snapshot, policyVersion, procedures }) {
  return sha256(JSON.stringify({
    dataRoot: ctx.dataRoot,
    applicationId: applicationId ?? null,
    jdRevision: jdRevision ?? null,
    // Definition ids embed normalized text, options hash, locale, units and
    // constraints — the question/option fingerprint.
    questionFingerprints: definitions.map((d) => d.id),
    sourceHashes: snapshot.sources.map((s) => `${s.fileKey}@${s.sha256}`),
    policyVersion,
    procedureVersions: procedures.map((p) => `${p.id}@${p.version}`),
    locales: definitions.map((d) => d.locale ?? null),
  }));
}

// Byte measurement: size the packet with its own `bytes` field set to the cap
// (worst-case digit count), so a packet that "fits" still fits once the real
// byte count is written in.
function sizeWith(packet, cap) {
  return Buffer.byteLength(JSON.stringify({ ...packet, bytes: cap }), 'utf-8');
}

/**
 * buildContextPacket(ctx,{applicationId,observations,maxBytes,policy,
 * sourceSnapshot,jdRevision}) -> {answers,stories,procedures,gaps,versions,
 * bytes} (CONTRACTS E, T09). Read-only and synchronous. Retrieves only
 * answers relevant to the currently observed questions (at most the
 * configured candidate cap), under the configured byte cap. Space for gaps
 * (blockers), provenance and the most relevant procedures is reserved before
 * optional experience stories. Zero model calls for deterministic resolution.
 */
export function buildContextPacket(ctx, {
  applicationId, observations, maxBytes, policy = {}, sourceSnapshot = null, jdRevision = null,
} = {}) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'buildContextPacket requires a nonempty observations array');
  }
  const config = readLearningConfig(ctx);
  const byteCap = Math.min(
    Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : config.retrieval.max_context_bytes,
    config.retrieval.max_context_bytes,
  );
  const candidateCap = config.retrieval.max_candidates;

  const loaded = sourceSnapshot ? { snapshot: sourceSnapshot, texts: {} } : loadSourceSnapshot(ctx);
  const snapshot = loaded.snapshot;
  const definitions = observations.map((o) => normalizeQuestion(o));
  // Policy version: a fingerprint of the validated config plus the caller's
  // declarative policy (mappings/disclosure), never model output.
  const policyVersion = `pol-${sha256(JSON.stringify({
    config, mappings: policy.mappings ?? [], disclosure: policy.disclosure ?? null,
  })).slice(0, 16)}`;
  const procedures = relevantProcedures(ctx, observations);

  const key = cacheKeyOf({ ctx, applicationId, jdRevision, definitions, snapshot, policyVersion, procedures });
  if (PACKET_CACHE.has(key)) {
    return structuredClone(PACKET_CACHE.get(key));
  }

  // Resolve each observed question; only `ready` becomes a reusable answer.
  const answers = [];
  const gaps = [];
  const questionRevisions = {};
  for (const [i, observation] of observations.entries()) {
    const definition = definitions[i];
    questionRevisions[definition.id] = getRecord(ctx, 'questions', definition.id)?.revision ?? 0;
    const resolved = resolveAnswer(ctx, { observation, sourceSnapshot: snapshot, policy });
    if (resolved.status === 'ready' && answers.length < candidateCap) {
      answers.push({
        questionId: definition.id,
        fieldId: observation.fieldId ?? null,
        value: resolved.value,
        answerId: resolved.answerId,
        sourceRefs: resolved.sourceRefs,
        reason: resolved.reason,
      });
    } else if (resolved.status !== 'ready') {
      gaps.push({
        questionId: definition.id,
        fieldId: observation.fieldId ?? null,
        status: resolved.status,
        reason: resolved.reason,
      });
    }
  }

  // Open blockers for this application are part of the reserved gap space.
  if (applicationId) {
    const { items: blockers } = listRecords(ctx, 'blockers', { limit: 500 });
    for (const b of blockers) {
      if (!['open', 'waiting'].includes(b.status)) continue;
      if ((b.data.applicationId ?? null) !== applicationId) continue;
      gaps.push({ blockerId: b.id, status: 'blocked', type: b.data.type, reason: b.data.question ?? null });
    }
  }

  const versions = {
    sourceHashes: snapshot.sources.map((s) => s.sha256),
    policyVersion,
    procedureVersions: Object.fromEntries(procedures.map((p) => [p.id, p.version])),
    questionRevisions,
  };

  // Assemble under the byte cap: answers/gaps/provenance first, then the most
  // relevant procedures, then optional stories — dropped first under pressure.
  const packet = { answers, stories: [], procedures: [], gaps, versions, bytes: 0 };
  while (packet.answers.length > 0 && sizeWith(packet, byteCap) > byteCap) {
    const dropped = packet.answers.pop();
    packet.gaps.push({ questionId: dropped.questionId, status: 'blocked', reason: 'byte_budget_exceeded' });
  }
  for (const procedure of procedures) {
    packet.procedures.push(procedure);
    if (sizeWith(packet, byteCap) > byteCap) { packet.procedures.pop(); break; }
  }
  // Stories only help free-text generation; skip them entirely otherwise.
  const wantsStories = observations.some((o) => ['text', 'textarea'].includes(o.fieldType ?? ''));
  if (wantsStories && loaded.texts.cv) {
    const cvHash = snapshot.sources.find((s) => s.fileKey === 'cv')?.sha256;
    const queryTokens = tokensOf(observations.map((o) => o.originalText).join(' '));
    const stories = extractExperienceStories({ fileKey: 'cv', text: loaded.texts.cv, sha256hex: cvHash })
      .map((story) => {
        const storyTokens = new Set([...story.roleTags, ...story.capabilityTags]);
        let overlap = 0;
        for (const t of storyTokens) if (queryTokens.has(t)) overlap += 1;
        return { story, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap)
      .map((s) => s.story);
    for (const story of stories) {
      packet.stories.push(story);
      if (sizeWith(packet, byteCap) > byteCap) { packet.stories.pop(); break; }
    }
  }
  // Converge on the real byte count (digit width can shrink it slightly; the
  // assembly loop already guaranteed the worst case fits the cap).
  packet.bytes = sizeWith(packet, byteCap);
  packet.bytes = Buffer.byteLength(JSON.stringify(packet), 'utf-8');

  if (PACKET_CACHE.size >= PACKET_CACHE_MAX) {
    PACKET_CACHE.delete(PACKET_CACHE.keys().next().value);
  }
  PACKET_CACHE.set(key, structuredClone(packet));
  return packet;
}

// --- Free-text draft storage ---------------------------------------------------

const METRIC_RE = /\d[\d,.]*\s*(%|percent|years?|weeks?|months?|k\b|million|billion|x\b)?/gi;

/**
 * storeDraftAnswer(ctx,{observation,draftText,packet}) -> {proposalId,
 * findings} (T09). Stores generated role-specific free text as a DRAFT
 * proposal with its source references and validation findings. The phrasing
 * is never promoted into a personal fact: no answers record is created here.
 * Validation flags every metric in the draft that is absent from the packet's
 * allowed claims (a story cannot synthesize a metric absent from its source).
 */
export async function storeDraftAnswer(ctx, { observation, draftText, packet } = {}) {
  if (typeof draftText !== 'string' || draftText.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'storeDraftAnswer requires draftText');
  }
  if (!isPlainObject(packet) || !Array.isArray(packet.stories)) {
    throw new LearningError('SCHEMA_VALIDATION', 'storeDraftAnswer requires the evidence packet');
  }
  const definition = normalizeQuestion(observation);
  const allowedClaims = packet.stories.flatMap((s) => s.claims ?? []);
  const claimText = allowedClaims.join('\n');
  const findings = [];
  for (const match of draftText.matchAll(METRIC_RE)) {
    const metric = match[0].trim();
    if (metric !== '' && /\d/.test(metric) && !claimText.includes(metric)) {
      findings.push({ kind: 'unsupported_metric', metric });
    }
  }
  const sourceRefs = packet.stories.map((s) => s.sourceRef);
  const proposalId = `draft-${randomUUID()}`;
  await commitRecord(ctx, 'proposals', proposalId, {
    kind: 'answer',
    evidenceIds: packet.stories.map((s) => s.id),
    intendedBenefit: 'reusable free-text draft (requires review)',
    risk: findings.length > 0 ? 'high' : 'low',
    baseline: null,
    evaluationResult: null,
    affectedSources: sourceRefs.map((r) => ({ fileKey: r.fileKey, selector: null, sha256: r.sha256 })),
    requiredApprovals: ['user'],
    rollbackVersion: null,
    diff: {
      question: { normalizedText: definition.normalizedText, fieldType: definition.fieldType },
      draftText,
      sourceRefs,
      validationFindings: findings,
    },
  }, { expectedRevision: 0, status: 'draft', sourceIds: sourceRefs.map((r) => `${r.fileKey}@${r.sha256}`) });
  return { proposalId, findings };
}
