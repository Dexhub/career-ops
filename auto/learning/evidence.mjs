// auto/learning/evidence.mjs — audit-answer normalization (T04) and history
// backfill/capture (T05), CONTRACTS E. Nothing executes at import time.
// normalizeAuditAnswers remains pure; the T05 section below performs explicit
// read-only discovery plus store commits only when apply:true.
//
// normalizeAuditAnswers(input) -> { entries, rejected }
//   entry    = { fieldId, label, value, source, section }
//   rejected = { pointer, reason }   (JSON-pointer-ish source pointer; the
//                                     reason NEVER contains an answer value)
//
// Supported historical representations (inventoried 2026-10-11 from
// output/*/audit/attempt-*/answers.json, keys only — no personal values):
//   (a) arrays of labeled rows        [{label, value, source, section|step?}]
//   (b) section objects of rows       {Section: [{label, value, source}]}
//   (c) keyed section/value objects   {Section: {Label: {value, source}}}
//       including the observed flat variant {Section: {Label: scalar}} and
//       top-level scalar fields {label: scalar}.
//
// Rules (plan T04): unknown/missing source -> 'unverified', never
// 'user_confirmed'; ambiguous nested objects are rejected with a reason and
// pointer, never recursively guessed; secret-bearing keys/labels are rejected
// using the same pattern as contracts.mjs and their values never leak through
// rejection messages. Shape normalization here is NOT answer-reuse
// authorization — that stays a separate learning-layer decision (CONTRACTS D3).

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { parseApplicationAnswersSection, parseDraftAnswersBlockH } from '../../application-answers.mjs';
import { LearningError, isIngestiblePath, isSecretKey } from './contracts.mjs';
import { readLearningConfig } from './context.mjs';
import { commitRecord, getRecord } from './store.mjs';

const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isScalarArray(value) {
  return Array.isArray(value) && value.every(isScalar);
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
}

/** Unknown/absent source labels become 'unverified' — never 'user_confirmed'. */
function normalizeSource(raw) {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return 'unverified';
}

function makeEntry({ section, label, value, source, fieldId }) {
  const sec = typeof section === 'string' && section.length > 0 ? section : null;
  return {
    fieldId: typeof fieldId === 'string' && fieldId.length > 0
      ? fieldId
      : (sec ? `${slugify(sec)}.${slugify(label)}` : slugify(label)),
    label,
    value: value === undefined ? null : value,
    source: normalizeSource(source),
    section: sec,
  };
}

/** Returns a rejection reason for a forbidden key name, or null. Key NAME only. */
function forbiddenKeyReason(key) {
  if (PROTO_KEYS.has(key)) return `prototype-related key "${key}" rejected`;
  if (isSecretKey(key)) return `secret-bearing key "${key}" rejected (value withheld)`;
  return null;
}

/** One labeled answer row from an array representation. */
function normalizeRow(row, pointer, sectionDefault, entries, rejected) {
  if (!isPlainObject(row)) {
    rejected.push({ pointer, reason: 'answer row is not a plain object' });
    return;
  }
  for (const key of Object.keys(row)) {
    const reason = forbiddenKeyReason(key);
    if (reason) { rejected.push({ pointer, reason }); return; }
  }
  const label = row.label;
  if (typeof label !== 'string' || label.length === 0) {
    rejected.push({ pointer, reason: 'answer row has no string label' });
    return;
  }
  const labelReason = forbiddenKeyReason(label);
  if (labelReason) { rejected.push({ pointer, reason: labelReason }); return; }
  const value = 'value' in row ? row.value : null;
  if (!isScalar(value) && !isScalarArray(value)) {
    rejected.push({ pointer, reason: `non-scalar value for label "${label}" (value withheld)` });
    return;
  }
  const section = typeof row.section === 'string' && row.section
    ? row.section
    : (typeof row.step === 'string' && row.step ? row.step : sectionDefault);
  entries.push(makeEntry({ section, label, value, source: row.source, fieldId: row.fieldId }));
}

/** Keyed section object: {Label: scalar} or {Label: {value, source}}. */
function normalizeKeyedSection(obj, pointer, section, entries, rejected) {
  for (const label of Object.keys(obj)) {
    const childPointer = `${pointer}.${label}`;
    const keyReason = forbiddenKeyReason(label);
    if (keyReason) { rejected.push({ pointer: childPointer, reason: keyReason }); continue; }
    const v = obj[label];
    if (isScalar(v) || isScalarArray(v)) {
      entries.push(makeEntry({ section, label, value: v }));
      continue;
    }
    if (isPlainObject(v)) {
      if (!Object.prototype.hasOwnProperty.call(v, 'value')) {
        rejected.push({
          pointer: childPointer,
          reason: 'ambiguous nested object (no "value" key); not recursively guessed',
        });
        continue;
      }
      let bad = null;
      for (const key of Object.keys(v)) {
        bad = forbiddenKeyReason(key);
        if (bad) break;
      }
      if (bad) { rejected.push({ pointer: childPointer, reason: bad }); continue; }
      if (!isScalar(v.value) && !isScalarArray(v.value)) {
        rejected.push({ pointer: childPointer, reason: 'non-scalar "value" (value withheld)' });
        continue;
      }
      entries.push(makeEntry({ section, label, value: v.value, source: v.source }));
      continue;
    }
    rejected.push({ pointer: childPointer, reason: 'unsupported value shape; not guessed' });
  }
}

/**
 * normalizeAuditAnswers(input) -> {entries, rejected} (CONTRACTS E / T04).
 * Pure; never throws on untrusted shapes. Unknown shapes are rejected with a
 * source pointer, not recursively guessed; a generic string object is never
 * parsed as a credential or an approved personal fact.
 */
export function normalizeAuditAnswers(input) {
  const entries = [];
  const rejected = [];

  if (Array.isArray(input)) {
    input.forEach((row, i) => normalizeRow(row, `$[${i}]`, null, entries, rejected));
    return { entries, rejected };
  }

  if (isPlainObject(input)) {
    for (const key of Object.keys(input)) {
      const pointer = `$.${key}`;
      const keyReason = forbiddenKeyReason(key);
      if (keyReason) { rejected.push({ pointer, reason: keyReason }); continue; }
      const v = input[key];
      if (isScalar(v)) {
        // Observed flat variant: a top-level labeled scalar field.
        entries.push(makeEntry({ section: null, label: key, value: v }));
        continue;
      }
      if (Array.isArray(v)) {
        // Section object containing labeled rows (an empty section is no data).
        v.forEach((row, i) => normalizeRow(row, `${pointer}[${i}]`, key, entries, rejected));
        continue;
      }
      if (isPlainObject(v)) {
        normalizeKeyedSection(v, pointer, key, entries, rejected);
        continue;
      }
      rejected.push({ pointer, reason: `unsupported value shape under "${key}"; not guessed` });
    }
    return { entries, rejected };
  }

  rejected.push({
    pointer: '$',
    reason: `unsupported answers shape (${input === null ? 'null' : typeof input}); expected an array or object`,
  });
  return { entries, rejected };
}

// ---------------------------------------------------------------------------
// T05 — read-only history discovery, captureAttempt, backfillHistory.
//
// Approved source roots are the ingestion allowlist prefixes under
// ctx.dataRoot (contracts.isIngestiblePath). Resolved paths must stay inside
// the real data root; symlinks are refused; reads are capped by
// config capture.max_artifact_bytes; artifacts modified within SETTLE_MS of
// ctx.now() are "unsettled" and are never imported. Overwritten history is
// never reconstructed from timestamps alone: an artifact whose hash no longer
// matches its manifest entry is rejected (SOURCE_CHANGED), requiring a
// refreshed preview. Generated drafts (report Block H) are never recorded as
// observed employer questions: their coverage is 'unknown'.

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_KIND = 'learning-backfill-manifest';
export const ADAPTER_VERSIONS = Object.freeze({ 'audit-answers': 1, 'report-answers': 1 });
const SETTLE_MS = 10_000;
const AUDIT_REL_RE = /^output\/[^/]+\/audit\/[^/]+$/;

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Resolve a relative source path under the approved roots or throw. */
function resolveApprovedSource(ctx, relPathRaw) {
  const rel = String(relPathRaw).replaceAll('\\', '/');
  if (!isIngestiblePath(rel)) {
    throw new LearningError('FORBIDDEN_SOURCE', `source path is not under an approved root: ${rel}`);
  }
  const abs = resolve(ctx.dataRoot, rel);
  const rootReal = realpathSync(ctx.dataRoot);
  if (existsSync(abs)) {
    if (lstatSync(abs).isSymbolicLink()) {
      throw new LearningError('FORBIDDEN_PATH', `symlink refused: ${rel}`);
    }
    const real = realpathSync(abs);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new LearningError('FORBIDDEN_PATH', `source escapes the data root: ${rel}`);
    }
  }
  return abs;
}

/** lstat-based status: {missing} | {symlink} | {bytes, mtimeMs, settled}. */
function sourceStatus(ctx, abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    throw new LearningError('READ_ERROR', `cannot stat source: ${err.message}`);
  }
  if (st.isSymbolicLink()) return { symlink: true };
  return {
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    settled: ctx.now().getTime() - st.mtimeMs >= SETTLE_MS,
  };
}

function readSource(ctx, rel, maxBytes) {
  const abs = resolveApprovedSource(ctx, rel);
  const status = sourceStatus(ctx, abs);
  if (status.missing) return { status: { missing: true } };
  if (status.symlink) return { status: { symlink: true } };
  if (status.bytes > maxBytes) return { status: { ...status, oversized: true } };
  const text = readFileSync(abs, 'utf-8');
  return { status, text, sha256: sha256Hex(text) };
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

/** Heuristic lower-bound company slug: first token after the numeric prefix. */
function companySlugOf(applicationId) {
  if (typeof applicationId !== 'string') return null;
  const stripped = applicationId.replace(/^\d+-/, '');
  const token = stripped.split('-')[0];
  return token || null;
}

/**
 * discoverHistory(ctx) -> {entries, gaps} — read-only enumeration of actual
 * audit directories and report sections under the approved roots. Never
 * writes, never invokes a model.
 */
export function discoverHistory(ctx) {
  const config = readLearningConfig(ctx);
  const maxBytes = config.capture.max_artifact_bytes;
  const entries = [];
  const gaps = [];

  // Audit attempt directories: output/<appKey>/audit/<attempt>/answers.json
  const outputRoot = join(ctx.dataRoot, 'output');
  for (const appKey of safeReaddir(outputRoot)) {
    const auditDir = join(outputRoot, appKey, 'audit');
    let appStat;
    try { appStat = lstatSync(join(outputRoot, appKey)); } catch { continue; }
    if (appStat.isSymbolicLink()) {
      gaps.push({ type: 'symlink_refused', path: `output/${appKey}` });
      continue;
    }
    if (!existsSync(auditDir)) continue;
    for (const attempt of safeReaddir(auditDir)) {
      if (!attempt.startsWith('attempt-')) continue;
      const rel = `output/${appKey}/audit/${attempt}/answers.json`;
      let read;
      try {
        read = readSource(ctx, rel, maxBytes);
      } catch (err) {
        gaps.push({ type: err.code === 'FORBIDDEN_PATH' ? 'symlink_refused' : 'unreadable', path: rel });
        continue;
      }
      if (read.status.missing) {
        gaps.push({ type: 'missing_answers', path: `output/${appKey}/audit/${attempt}` });
        continue;
      }
      if (read.status.symlink) { gaps.push({ type: 'symlink_refused', path: rel }); continue; }
      if (read.status.oversized) { gaps.push({ type: 'oversized', path: rel }); continue; }
      entries.push({
        relativePath: rel,
        bytes: read.status.bytes,
        sha256: read.sha256,
        adapter: 'audit-answers',
        adapterVersion: ADAPTER_VERSIONS['audit-answers'],
        settled: read.status.settled,
        linked: { applicationId: appKey, attemptId: attempt },
      });
      if (!read.status.settled) gaps.push({ type: 'unsettled', path: rel });
    }
  }

  // Reports: reports/*.md with a recognizable answers section. A report with
  // neither section is absent data (a coverage gap), not a parser success.
  const reportsRoot = join(ctx.dataRoot, 'reports');
  const outputKeys = safeReaddir(outputRoot);
  for (const name of safeReaddir(reportsRoot)) {
    if (!name.endsWith('.md')) continue;
    const rel = `reports/${name}`;
    let read;
    try {
      read = readSource(ctx, rel, maxBytes);
    } catch (err) {
      gaps.push({ type: err.code === 'FORBIDDEN_PATH' ? 'symlink_refused' : 'unreadable', path: rel });
      continue;
    }
    if (read.status.missing || read.status.symlink) {
      gaps.push({ type: read.status.symlink ? 'symlink_refused' : 'unreadable', path: rel });
      continue;
    }
    if (read.status.oversized) { gaps.push({ type: 'oversized', path: rel }); continue; }
    const sections = [];
    if (parseApplicationAnswersSection(read.text) !== null) sections.push('application_answers');
    if (parseDraftAnswersBlockH(read.text) !== null) sections.push('draft_block_h');
    if (sections.length === 0) {
      gaps.push({ type: 'report_without_answers', path: rel });
      continue;
    }
    // Link to a job through the shared report-number convention when possible.
    const num = /^(\d+)-/.exec(name)?.[1];
    const linkedKey = num ? outputKeys.find((k) => k.startsWith(`${num}-`)) ?? null : null;
    if (!linkedKey) gaps.push({ type: 'unlinked_report', path: rel });
    entries.push({
      relativePath: rel,
      bytes: read.status.bytes,
      sha256: read.sha256,
      adapter: 'report-answers',
      adapterVersion: ADAPTER_VERSIONS['report-answers'],
      settled: read.status.settled,
      sections,
      linked: { applicationId: linkedKey, attemptId: null },
    });
    if (!read.status.settled) gaps.push({ type: 'unsettled', path: rel });
  }

  return { entries, gaps };
}

/** buildBackfillManifest(ctx) -> manifest object (read-only; caller writes it). */
export function buildBackfillManifest(ctx) {
  const { entries, gaps } = discoverHistory(ctx);
  const byAdapter = {};
  for (const e of entries) byAdapter[e.adapter] = (byAdapter[e.adapter] ?? 0) + 1;
  const gapsByType = {};
  for (const g of gaps) gapsByType[g.type] = (gapsByType[g.type] ?? 0) + 1;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    generatedAt: ctx.now().toISOString(),
    rootIdentity: { dataRootReal: realpathSync(ctx.dataRoot) },
    adapterVersions: { ...ADAPTER_VERSIONS },
    entries,
    coverageGaps: gaps,
    summary: {
      entries: entries.length,
      settled: entries.filter((e) => e.settled).length,
      unsettled: entries.filter((e) => !e.settled).length,
      byAdapter,
      gapsByType,
      distinctJobs: new Set(entries.map((e) => e.linked.applicationId).filter(Boolean)).size,
      distinctCompanySlugs: new Set(entries.map((e) => companySlugOf(e.linked.applicationId)).filter(Boolean)).size,
    },
  };
}

/** Deterministic observation identity (CONTRACTS C): attempt + field + digest. */
function observationId({ applicationId, attemptId, relativePath, fieldId, artifactSha }) {
  return sha256Hex(`${applicationId ?? ''}|${attemptId ?? ''}|${relativePath}|${fieldId}|${artifactSha}`);
}

function buildObservation({
  applicationId, attemptId, relativePath, artifactSha, observedAt,
  fieldId, originalText, stepId, fieldType, captureMethod, coverage, answerDisposition,
}) {
  return {
    id: observationId({ applicationId, attemptId, relativePath, fieldId, artifactSha }),
    data: {
      applicationId: applicationId ?? null,
      attemptId: attemptId ?? null,
      questionId: null,
      companyId: null,
      employerName: null,
      atsVendor: null,
      atsTenant: null,
      roleTitle: null,
      roleFamily: null,
      country: null,
      locale: null,
      stepId: stepId ?? null,
      fieldId,
      fieldType,
      originalText,
      options: [],
      required: null,
      parentCondition: null,
      unit: null,
      currency: null,
      timeHorizon: null,
      observedAt,
      sourceArtifact: { relativePath, sha256: artifactSha },
      captureMethod,
      coverage,
      answerDisposition,
      answerRef: null,
    },
  };
}

/** Parse one source artifact into observation candidates. Values stay out of
 * the ledger entirely (D1 has no value field); only question identity,
 * provenance and disposition are recorded. */
function adaptArtifact(entry, text, observedAt) {
  const observations = [];
  const rejectedRows = [];
  const base = {
    applicationId: entry.linked?.applicationId ?? null,
    attemptId: entry.linked?.attemptId ?? null,
    relativePath: entry.relativePath,
    artifactSha: entry.sha256,
    observedAt,
  };

  if (entry.adapter === 'audit-answers') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { observations, rejectedRows, malformed: true };
    }
    const captureMethod = Array.isArray(parsed) ? 'legacy_array' : 'legacy_object';
    const { entries: rows, rejected } = normalizeAuditAnswers(parsed);
    for (const r of rejected) rejectedRows.push({ pointer: r.pointer, reason: r.reason });
    for (const row of rows) {
      observations.push(buildObservation({
        ...base,
        fieldId: row.fieldId,
        originalText: row.label,
        stepId: row.section,
        fieldType: 'unknown',
        captureMethod,
        // The form was actually driven for this attempt: the question itself
        // was observed, even though the artifact is a legacy export.
        coverage: 'observed',
        answerDisposition: 'drafted',
      }));
    }
    return { observations, rejectedRows, malformed: false };
  }

  if (entry.adapter === 'report-answers') {
    const section = parseApplicationAnswersSection(text);
    if (section !== null) {
      const groups = [
        [section.freeText, 'question', 'textarea'],
        [section.selections, 'question', 'select'],
        [section.fieldValues, 'question', 'text'],
      ];
      for (const [rows, labelKey, fieldType] of groups) {
        for (const row of rows) {
          const label = row[labelKey];
          if (typeof label !== 'string' || !label) continue;
          if (isSecretKey(label)) {
            rejectedRows.push({ pointer: entry.relativePath, reason: `secret-bearing label rejected (value withheld)` });
            continue;
          }
          observations.push(buildObservation({
            ...base,
            fieldId: slugify(label),
            originalText: label,
            stepId: 'application_answers',
            fieldType,
            captureMethod: 'report_section',
            coverage: 'partially_observed',
            answerDisposition: 'drafted',
          }));
        }
      }
    }
    const draft = parseDraftAnswersBlockH(text);
    if (draft !== null) {
      for (const row of draft.freeText) {
        if (typeof row.question !== 'string' || !row.question) continue;
        if (isSecretKey(row.question)) {
          rejectedRows.push({ pointer: entry.relativePath, reason: `secret-bearing label rejected (value withheld)` });
          continue;
        }
        observations.push(buildObservation({
          ...base,
          fieldId: slugify(row.question),
          originalText: row.question,
          stepId: 'draft_block_h',
          fieldType: 'unknown',
          captureMethod: 'report_section',
          // Generated drafts are NEVER observed employer questions without
          // separate source evidence.
          coverage: 'unknown',
          answerDisposition: 'drafted',
        }));
      }
    }
    return { observations, rejectedRows, malformed: false };
  }

  return { observations, rejectedRows, malformed: false, unknownAdapter: true };
}

/** Idempotent commit of observation candidates through the T02 store. */
async function commitObservations(ctx, observations, { apply, seen, counters }) {
  for (const obs of observations) {
    if (seen.has(obs.id)) { counters.duplicate += 1; continue; }
    seen.add(obs.id);
    const existing = getRecord(ctx, 'observations', obs.id);
    if (existing) { counters.duplicate += 1; continue; }
    if (apply) {
      try {
        await commitRecord(ctx, 'observations', obs.id, obs.data, {
          expectedRevision: 0,
          status: 'recorded',
          sourceIds: [`sha256:${obs.data.sourceArtifact.sha256}`.slice(0, 128)],
        });
      } catch (err) {
        if (err?.code === 'REVISION_CONFLICT') { counters.duplicate += 1; continue; }
        throw err;
      }
    }
    counters.added += 1;
  }
}

/**
 * captureAttempt(ctx, {attemptDir, apply}) -> {added, duplicate, rejected,
 * coverage} (CONTRACTS E / T05). attemptDir may be absolute (under dataRoot)
 * or relative; it must match output/<appKey>/audit/<attempt>. apply:false
 * counts without writing the store.
 */
export async function captureAttempt(ctx, { attemptDir, apply = false } = {}) {
  if (typeof attemptDir !== 'string' || attemptDir.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'attemptDir must be a nonempty path');
  }
  const rel = (isAbsolute(attemptDir) ? relative(ctx.dataRoot, attemptDir) : attemptDir)
    .replaceAll('\\', '/');
  if (!AUDIT_REL_RE.test(rel)) {
    throw new LearningError('FORBIDDEN_PATH', `attemptDir is not an approved audit directory: ${rel}`);
  }
  const config = readLearningConfig(ctx);
  const answersRel = `${rel}/answers.json`;
  const counters = { added: 0, duplicate: 0 };
  const rejected = [];
  const gaps = [];
  const read = readSource(ctx, answersRel, config.capture.max_artifact_bytes);
  if (read.status.missing) {
    gaps.push({ type: 'missing_answers', path: rel });
    return { added: 0, duplicate: 0, rejected, coverage: { gaps } };
  }
  if (read.status.symlink) {
    rejected.push({ relativePath: answersRel, reason: 'SYMLINK_REFUSED' });
    return { added: 0, duplicate: 0, rejected, coverage: { gaps } };
  }
  if (read.status.oversized) {
    rejected.push({ relativePath: answersRel, reason: 'OVERSIZED' });
    return { added: 0, duplicate: 0, rejected, coverage: { gaps } };
  }
  if (!read.status.settled) {
    rejected.push({ relativePath: answersRel, reason: 'UNSETTLED' });
    return { added: 0, duplicate: 0, rejected, coverage: { gaps } };
  }
  const parts = rel.split('/');
  const entry = {
    relativePath: answersRel,
    sha256: read.sha256,
    adapter: 'audit-answers',
    linked: { applicationId: parts[1], attemptId: parts[3] },
  };
  const observedAt = new Date(read.status.mtimeMs).toISOString();
  const adapted = adaptArtifact(entry, read.text, observedAt);
  if (adapted.malformed) {
    rejected.push({ relativePath: answersRel, reason: 'MALFORMED_JSON' });
    return { added: 0, duplicate: 0, rejected, coverage: { gaps } };
  }
  for (const r of adapted.rejectedRows) rejected.push({ relativePath: answersRel, reason: r.reason, pointer: r.pointer });
  await commitObservations(ctx, adapted.observations, { apply, seen: new Set(), counters });
  return { added: counters.added, duplicate: counters.duplicate, rejected, coverage: { gaps } };
}

/**
 * backfillHistory(ctx, {manifestPath, apply}) -> summary (CONTRACTS E / T05).
 * Verifies root identity and per-entry hashes against the previewed manifest;
 * creates idempotent observations via the T02 store when apply:true. Every
 * rejection and missing link is listed in the summary — no silent skipping.
 */
export async function backfillHistory(ctx, { manifestPath, apply = false } = {}) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'manifestPath must be a nonempty path');
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new LearningError('MANIFEST_MALFORMED', `cannot read manifest ${manifestPath}: ${err.message}`);
  }
  if (manifest?.kind !== MANIFEST_KIND || manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new LearningError('MANIFEST_MALFORMED',
      `not a supported ${MANIFEST_KIND} v${MANIFEST_SCHEMA_VERSION} manifest: ${manifestPath}`);
  }
  const rootReal = realpathSync(ctx.dataRoot);
  if (manifest.rootIdentity?.dataRootReal !== rootReal) {
    throw new LearningError('ROOT_MISMATCH',
      `manifest was previewed against a different data root (${String(manifest.rootIdentity?.dataRootReal)}); refresh the preview`);
  }
  if (!Array.isArray(manifest.entries)) {
    throw new LearningError('MANIFEST_MALFORMED', 'manifest.entries must be an array');
  }
  const config = readLearningConfig(ctx);
  const maxBytes = config.capture.max_artifact_bytes;
  const counters = { added: 0, duplicate: 0 };
  const seen = new Set();
  const rejected = [];
  const jobs = new Set();
  const companies = new Set();
  let imported = 0;

  for (const entry of manifest.entries) {
    const rel = entry?.relativePath;
    if (typeof rel !== 'string' || typeof entry?.sha256 !== 'string' || !(entry?.adapter in ADAPTER_VERSIONS)) {
      rejected.push({ relativePath: String(rel), reason: 'MANIFEST_ENTRY_INVALID' });
      continue;
    }
    if (entry.adapterVersion !== ADAPTER_VERSIONS[entry.adapter]) {
      rejected.push({ relativePath: rel, reason: 'ADAPTER_VERSION_MISMATCH' });
      continue;
    }
    if (entry.settled === false) {
      rejected.push({ relativePath: rel, reason: 'UNSETTLED_AT_PREVIEW' });
      continue;
    }
    let read;
    try {
      read = readSource(ctx, rel, maxBytes);
    } catch (err) {
      rejected.push({ relativePath: rel, reason: err.code ?? 'READ_ERROR' });
      continue;
    }
    if (read.status.missing) { rejected.push({ relativePath: rel, reason: 'SOURCE_MISSING' }); continue; }
    if (read.status.symlink) { rejected.push({ relativePath: rel, reason: 'SYMLINK_REFUSED' }); continue; }
    if (read.status.oversized) { rejected.push({ relativePath: rel, reason: 'OVERSIZED' }); continue; }
    if (!read.status.settled) { rejected.push({ relativePath: rel, reason: 'UNSETTLED' }); continue; }
    if (read.sha256 !== entry.sha256 || (typeof entry.bytes === 'number' && entry.bytes !== read.status.bytes)) {
      rejected.push({ relativePath: rel, reason: 'SOURCE_CHANGED' });
      continue;
    }
    const observedAt = new Date(read.status.mtimeMs).toISOString();
    const adapted = adaptArtifact(entry, read.text, observedAt);
    if (adapted.malformed) { rejected.push({ relativePath: rel, reason: 'MALFORMED_JSON' }); continue; }
    for (const r of adapted.rejectedRows) rejected.push({ relativePath: rel, reason: r.reason, pointer: r.pointer });
    await commitObservations(ctx, adapted.observations, { apply, seen, counters });
    imported += 1;
    if (entry.linked?.applicationId) {
      jobs.add(entry.linked.applicationId);
      const slug = companySlugOf(entry.linked.applicationId);
      if (slug) companies.add(slug);
    }
  }

  return {
    apply,
    manifestPath,
    entries: manifest.entries.length,
    importedSources: imported,
    added: counters.added,
    duplicate: counters.duplicate,
    rejected,
    coverageGaps: Array.isArray(manifest.coverageGaps) ? manifest.coverageGaps : [],
    distinctJobs: jobs.size,
    distinctCompanySlugs: companies.size,
  };
}
