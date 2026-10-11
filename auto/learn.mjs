#!/usr/bin/env node
// auto/learn.mjs — learning backfill + worker-attempt CLI (T05/T10,
// CONTRACTS B/J). Main-module guard only: nothing executes at import time.
// Read-only except for the explicitly requested dry-run report artifact,
// `backfill --apply` store commits, and the attempt-scoped subcommands below.
//
//   node auto/learn.mjs inspect --json
//   node auto/learn.mjs backfill --dry-run --out <path>
//   node auto/learn.mjs backfill --apply --manifest <path>
//   node auto/learn.mjs rebuild --verify
//   node auto/learn.mjs observe-page --attempt-id ID --input FILE --apply
//   node auto/learn.mjs resolve-page --attempt-id ID --input FILE
//   node auto/learn.mjs checkpoint --attempt-id ID --phase PHASE --input FILE
//   node auto/learn.mjs capture-attempt --attempt-id ID --apply
//
// The attempt subcommands (CONTRACTS J) are the restricted executor's ONLY
// write surface into the learning store: strict JSON in/out, inputs must be
// executor-owned files beneath that attempt's audit directory, and every
// command refuses when config/learning.yml is disabled. A checkpoint can
// never declare delivery, approve answers, or change policy — the trusted
// parent owns final capture and outcome reconciliation.
// Never starts a worker, panel, model, or browser. Dry run writes ONLY the
// --out artifact (refused if it points inside the learning store).

import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { createLearningContext, learningDataRoot, readLearningConfig } from './learning/context.mjs';
import { commitRecord, getRecord, rebuildIndexes } from './learning/store.mjs';
import {
  buildBackfillManifest, backfillHistory, captureAttempt, discoverHistory,
} from './learning/evidence.mjs';
import { LearningError, isSecretKey } from './learning/contracts.mjs';
import { recordOccurrence } from './learning/questions.mjs';
import { buildContextPacket } from './learning/retrieval.mjs';

const USAGE = `Usage:
  node auto/learn.mjs inspect --json
  node auto/learn.mjs backfill --dry-run --out <path>
  node auto/learn.mjs backfill --apply --manifest <path>
  node auto/learn.mjs rebuild --verify
  node auto/learn.mjs observe-page --attempt-id ID --input FILE --apply
  node auto/learn.mjs resolve-page --attempt-id ID --input FILE
  node auto/learn.mjs checkpoint --attempt-id ID --phase PHASE --input FILE
  node auto/learn.mjs capture-attempt --attempt-id ID --apply`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (['out', 'manifest', 'attempt-id', 'input', 'phase'].includes(name)) {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`);
      flags[name] = value;
      i += 1;
    } else if (['json', 'dry-run', 'apply', 'verify'].includes(name)) {
      flags[name] = true;
    } else {
      throw new Error(`unknown flag: --${name}`);
    }
  }
  return { command, flags };
}

function buildCtx() {
  const dataRoot = getCareerOpsRoot();
  const codeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return createLearningContext({ codeRoot, dataRoot, now: () => new Date() });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function summarize(entries, gaps) {
  const byAdapter = {};
  for (const e of entries) byAdapter[e.adapter] = (byAdapter[e.adapter] ?? 0) + 1;
  const gapsByType = {};
  for (const g of gaps) gapsByType[g.type] = (gapsByType[g.type] ?? 0) + 1;
  return {
    entries: entries.length,
    settled: entries.filter((e) => e.settled).length,
    unsettled: entries.filter((e) => !e.settled).length,
    byAdapter,
    coverageGaps: gaps.length,
    gapsByType,
  };
}

// ---------------------------------------------------------------------------
// Attempt-scoped capture surface (CONTRACTS J / T10)

const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const CHECKPOINT_PHASES = Object.freeze([
  'observed', 'resolved', 'filled', 'pre_submit', 'submit_attempted',
]);
// Field keys the executor may supply per observed control (CONTRACTS D1).
// Everything else — identity, provenance, disposition — is set by this layer.
const FIELD_KEYS = Object.freeze([
  'fieldId', 'fieldType', 'originalText', 'options', 'required',
  'parentCondition', 'unit', 'currency', 'timeHorizon', 'locale',
]);
const PAGE_IDENTITY_KEYS = Object.freeze([
  'companyId', 'employerName', 'atsVendor', 'atsTenant', 'roleTitle',
  'roleFamily', 'country', 'locale',
]);
const FIELD_TYPES = Object.freeze([
  'text', 'textarea', 'select', 'radio', 'checkbox', 'date', 'number', 'file', 'custom', 'unknown',
]);

function sha40(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 40);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertLearningEnabled(ctx) {
  const config = readLearningConfig(ctx);
  if (!config.enabled) {
    throw new LearningError('SCHEMA_VALIDATION',
      'learning is disabled (config/learning.yml enabled: false) — attempt capture refused');
  }
  return config;
}

/**
 * Locate the audit directory of an ACTIVE attempt by its id. The directory
 * name is `attempt-<id>` under output/<appKey>/audit/ (the only approved
 * root), and must carry the learning/meta.json the trusted worker wrote at
 * attempt start — that file, not caller input, binds the application identity.
 */
export function locateAttempt(ctx, attemptId) {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) {
    throw new LearningError('SCHEMA_VALIDATION', 'invalid attempt id');
  }
  const outputRoot = join(ctx.dataRoot, 'output');
  if (!existsSync(outputRoot)) {
    throw new LearningError('SCHEMA_VALIDATION', `no attempt found for id ${attemptId}`);
  }
  for (const app of readdirSync(outputRoot)) {
    const auditDir = join(outputRoot, app, 'audit', `attempt-${attemptId}`);
    if (!existsSync(auditDir)) continue;
    const metaPath = join(auditDir, 'learning', 'meta.json');
    if (!existsSync(metaPath)) {
      throw new LearningError('FORBIDDEN_PATH',
        `attempt ${attemptId} has no learning/meta.json — not a learning-enabled attempt`);
    }
    let meta;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {
      throw new LearningError('SCHEMA_VALIDATION', `attempt ${attemptId}: malformed learning/meta.json`);
    }
    if (meta.attemptId !== attemptId) {
      throw new LearningError('SCHEMA_VALIDATION', `attempt ${attemptId}: meta.json identity mismatch`);
    }
    return { auditDir, meta, rel: `output/${app}/audit/attempt-${attemptId}` };
  }
  throw new LearningError('SCHEMA_VALIDATION', `no attempt found for id ${attemptId}`);
}

/** Read an executor-owned JSON input: resolved real path must stay beneath
 *  this attempt's audit directory, within the configured size cap. */
function readOwnedInput(auditDir, inputPath, maxBytes) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', '--input requires a file path');
  }
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new LearningError('SCHEMA_VALIDATION', `input file not found: ${resolved}`);
  }
  const realInput = realpathSync(resolved);
  const realAudit = realpathSync(auditDir);
  if (realInput !== realAudit && !realInput.startsWith(realAudit + sep)) {
    throw new LearningError('FORBIDDEN_PATH',
      'input file must live beneath the attempt\'s own audit directory');
  }
  const size = statSync(realInput).size;
  if (size > maxBytes) {
    throw new LearningError('LIMIT_EXCEEDED', `input file exceeds ${maxBytes} bytes`);
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(realInput, 'utf8')); } catch {
    throw new LearningError('SCHEMA_VALIDATION', 'input file is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new LearningError('SCHEMA_VALIDATION', 'input file must contain a JSON object');
  }
  return { input: parsed, realInput, realAudit };
}

function relUnderAudit(realAudit, realInput, locatedRel) {
  return `${locatedRel}${realInput.slice(realAudit.length).replaceAll('\\', '/')}`;
}

/** Build one CONTRACTS D1 observation from an executor-captured field. The
 *  caller's identity claims are VERIFIED against the trusted meta, never
 *  copied: a wrong-job field is rejected outright. */
function observationFromField({ field, index, pageIdentity, stepId, meta, attemptId, observedAt, sourceArtifact }) {
  if (!isPlainObject(field)) {
    throw new LearningError('SCHEMA_VALIDATION', `fields[${index}] must be an object`);
  }
  if (typeof field.fieldId !== 'string' || field.fieldId.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', `fields[${index}].fieldId must be a nonempty string`);
  }
  if (typeof field.originalText !== 'string' || field.originalText.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', `fields[${index}].originalText must be a nonempty string`);
  }
  if (field.applicationId !== undefined && field.applicationId !== meta.applicationId) {
    throw new LearningError('SCHEMA_VALIDATION',
      `fields[${index}]: applicationId does not match this attempt's application — wrong job identity rejected`);
  }
  if (field.attemptId !== undefined && field.attemptId !== attemptId) {
    throw new LearningError('SCHEMA_VALIDATION', `fields[${index}]: attemptId mismatch rejected`);
  }
  if (isSecretKey(field.fieldId) || isSecretKey(field.originalText)) {
    return { rejected: { index, fieldId: field.fieldId, reason: 'SECRET_LABEL' } };
  }
  const observation = {
    applicationId: meta.applicationId ?? null,
    attemptId,
    stepId,
    observedAt,
    sourceArtifact,
    captureMethod: 'live_structured',
    coverage: 'observed',
    answerDisposition: 'unanswered',
  };
  for (const key of PAGE_IDENTITY_KEYS) {
    if (pageIdentity[key] !== undefined) observation[key] = pageIdentity[key];
  }
  for (const key of FIELD_KEYS) {
    if (field[key] !== undefined) observation[key] = field[key];
  }
  if (!FIELD_TYPES.includes(observation.fieldType)) observation.fieldType = 'unknown';
  if (observation.options !== undefined && !Array.isArray(observation.options)) {
    throw new LearningError('SCHEMA_VALIDATION', `fields[${index}].options must be an array`);
  }
  return { observation };
}

function parseObserveInput(ctx, located, input, { inputPath, config }) {
  const { stepId, pageIdentity = {}, fields, expectedFieldCount = null } = input;
  if (typeof stepId !== 'string' || stepId.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'input.stepId must be a nonempty string');
  }
  if (!isPlainObject(pageIdentity)) {
    throw new LearningError('SCHEMA_VALIDATION', 'input.pageIdentity must be an object');
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'input.fields must be a nonempty array');
  }
  if (fields.length > config.capture.max_fields_per_page) {
    throw new LearningError('LIMIT_EXCEEDED',
      `fields exceeds capture.max_fields_per_page (${config.capture.max_fields_per_page})`);
  }
  const { realInput, realAudit } = inputPath;
  const relPath = relUnderAudit(realAudit, realInput, located.rel);
  const inputText = readFileSync(realInput, 'utf8');
  const sourceArtifact = { relativePath: relPath, sha256: createHash('sha256').update(inputText).digest('hex') };
  const observedAt = ctx.now().toISOString();
  const observations = [];
  const rejected = [];
  fields.forEach((field, index) => {
    const built = observationFromField({
      field, index, pageIdentity, stepId,
      meta: located.meta, attemptId: located.meta.attemptId, observedAt, sourceArtifact,
    });
    if (built.rejected) rejected.push(built.rejected);
    else observations.push(built.observation);
  });
  const incomplete = Number.isInteger(expectedFieldCount) && expectedFieldCount > fields.length;
  return { stepId, expectedFieldCount, observations, rejected, incomplete };
}

/**
 * observe-page (CONTRACTS J): persist one page's labeled controls — including
 * unanswered optional fields — as D1 observations BEFORE the executor advances.
 * Writes a per-step progress marker under <audit>/learning/ so the trusted
 * finalizer can tell promised captures from missing ones.
 */
export async function observePage(ctx, { attemptId, inputPath, apply = false } = {}) {
  const config = assertLearningEnabled(ctx);
  const located = locateAttempt(ctx, attemptId);
  const owned = readOwnedInput(located.auditDir, inputPath, config.capture.max_artifact_bytes);
  const page = parseObserveInput(ctx, located, owned.input, { inputPath: owned, config });
  const results = [];
  if (apply) {
    for (const observation of page.observations) {
      results.push(await recordOccurrence(ctx, observation));
    }
    const slug = page.stepId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64);
    const marker = {
      stepId: page.stepId,
      fieldCount: page.observations.length,
      expectedFieldCount: page.expectedFieldCount,
      incomplete: page.incomplete,
      rejected: page.rejected.length,
      occurrenceIds: results.map((r) => r.occurrenceId),
      restricted: results.filter((r) => r.restricted).length,
      recordedAt: ctx.now().toISOString(),
    };
    mkdirSync(join(located.auditDir, 'learning'), { recursive: true });
    writeFileSync(join(located.auditDir, 'learning', `observe-${slug}.json`),
      `${JSON.stringify(marker, null, 2)}\n`);
  }
  return {
    attemptId,
    stepId: page.stepId,
    applied: apply,
    fields: page.observations.length,
    recorded: results.length,
    deduplicated: results.filter((r) => r.deduplicated).length,
    restricted: results.filter((r) => r.restricted).length,
    rejected: page.rejected,
    incomplete: page.incomplete,
  };
}

/**
 * resolve-page (CONTRACTS J): return the bounded context packet for one page.
 * Approved answers come back with provenance; every unresolved question is a
 * gap and opens a structured missing_answer blocker — NEVER a model guess.
 * The consumed memory/source versions and reuse reasons are persisted beside
 * the attempt for later audit.
 */
export async function resolvePage(ctx, { attemptId, inputPath } = {}) {
  const config = assertLearningEnabled(ctx);
  const located = locateAttempt(ctx, attemptId);
  const owned = readOwnedInput(located.auditDir, inputPath, config.capture.max_artifact_bytes);
  const page = parseObserveInput(ctx, located, owned.input, { inputPath: owned, config });
  if (page.observations.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'no valid fields to resolve');
  }
  const packet = buildContextPacket(ctx, {
    applicationId: located.meta.applicationId ?? null,
    observations: page.observations,
  });
  const textByQuestion = new Map();
  for (const o of page.observations) textByQuestion.set(o.fieldId, o.originalText);
  const blockers = [];
  for (const gap of packet.gaps) {
    if (gap.status !== 'blocked' || !gap.questionId || gap.reason === 'byte_budget_exceeded') continue;
    const blockerId = `blk-${sha40(`missing:${located.meta.applicationId}:${gap.questionId}`)}`;
    if (!getRecord(ctx, 'blockers', blockerId)) {
      await commitRecord(ctx, 'blockers', blockerId, {
        applicationId: located.meta.applicationId ?? null,
        attemptId,
        type: 'missing_answer',
        question: textByQuestion.get(gap.fieldId) ?? gap.questionId,
        requiredResolution: 'user_provides_answer',
        sourceVersions: { sourceHashes: packet.versions.sourceHashes, policyVersion: packet.versions.policyVersion },
      }, { expectedRevision: 0, status: 'open', sourceIds: [] });
    }
    blockers.push(blockerId);
  }
  const slug = page.stepId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64);
  mkdirSync(join(located.auditDir, 'learning'), { recursive: true });
  writeFileSync(join(located.auditDir, 'learning', `resolve-${slug}.json`), `${JSON.stringify({
    stepId: page.stepId,
    consumed: packet.versions,
    answers: packet.answers.map((a) => ({
      questionId: a.questionId, fieldId: a.fieldId, answerId: a.answerId,
      sourceRefs: a.sourceRefs, reason: a.reason,
    })),
    gaps: packet.gaps,
    blockers,
    resolvedAt: ctx.now().toISOString(),
  }, null, 2)}\n`);
  return { attemptId, stepId: page.stepId, packet, blockers };
}

/**
 * checkpoint (CONTRACTS J): record executor progress evidence. The input may
 * carry ONLY evidenceRefs and an optional blockerRequest — a checkpoint can
 * never declare confirmed delivery, clear submissionPossible, approve an
 * answer, or change policy; any such key is rejected.
 */
export async function recordCheckpoint(ctx, { attemptId, phase, inputPath } = {}) {
  const config = assertLearningEnabled(ctx);
  if (!CHECKPOINT_PHASES.includes(phase)) {
    throw new LearningError('SCHEMA_VALIDATION',
      `invalid checkpoint phase "${String(phase)}" (allowed: ${CHECKPOINT_PHASES.join(', ')})`);
  }
  const located = locateAttempt(ctx, attemptId);
  const owned = readOwnedInput(located.auditDir, inputPath, config.capture.max_artifact_bytes);
  for (const key of Object.keys(owned.input)) {
    if (!['evidenceRefs', 'blockerRequest'].includes(key)) {
      throw new LearningError('SCHEMA_VALIDATION',
        `checkpoint input key "${key}" is not permitted — checkpoints carry evidence only`);
    }
  }
  const evidenceRefs = owned.input.evidenceRefs ?? [];
  if (!Array.isArray(evidenceRefs)) {
    throw new LearningError('SCHEMA_VALIDATION', 'evidenceRefs must be an array');
  }
  const realAudit = owned.realAudit;
  const refs = evidenceRefs.map((ref) => {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new LearningError('SCHEMA_VALIDATION', 'evidenceRefs entries must be nonempty strings');
    }
    const target = resolve(located.auditDir, ref);
    if (!existsSync(target)) {
      throw new LearningError('SCHEMA_VALIDATION', `evidence ref does not exist: ${ref}`);
    }
    const real = realpathSync(target);
    if (real !== realAudit && !real.startsWith(realAudit + sep)) {
      throw new LearningError('FORBIDDEN_PATH', `evidence ref escapes the audit directory: ${ref}`);
    }
    return ref;
  });
  let blockerId = null;
  const request = owned.input.blockerRequest;
  if (request !== undefined && request !== null) {
    if (!isPlainObject(request) || typeof request.type !== 'string' || typeof request.question !== 'string') {
      throw new LearningError('SCHEMA_VALIDATION', 'blockerRequest requires {type, question}');
    }
    blockerId = `blk-${sha40(`checkpoint:${attemptId}:${phase}:${request.type}:${request.question}`)}`;
    if (!getRecord(ctx, 'blockers', blockerId)) {
      await commitRecord(ctx, 'blockers', blockerId, {
        applicationId: located.meta.applicationId ?? null,
        attemptId,
        type: request.type,
        question: request.question,
        requiredResolution: typeof request.requiredResolution === 'string' ? request.requiredResolution : null,
      }, { expectedRevision: 0, status: 'open', sourceIds: [] });
    }
  }
  const learnDir = join(located.auditDir, 'learning');
  mkdirSync(learnDir, { recursive: true });
  const seq = readdirSync(learnDir).filter((f) => f.startsWith('checkpoint-')).length + 1;
  writeFileSync(join(learnDir, `checkpoint-${String(seq).padStart(3, '0')}-${phase}.json`), `${JSON.stringify({
    attemptId, phase, evidenceRefs: refs, blockerId, recordedAt: ctx.now().toISOString(),
  }, null, 2)}\n`);
  return { attemptId, phase, evidenceRefs: refs.length, blockerId };
}

/**
 * Trusted-side attempt finalization (T10): reconcile the promised per-page
 * capture markers against what actually landed, ingest the legacy final
 * answers.json (labeled legacy, never a substitute for live capture), stamp a
 * coverage verdict — a completed-looking attempt without its promised live
 * captures is INCOMPLETE, not silently backfilled — and enqueue one local
 * consolidation sync task. Never manufactures a submission status and never
 * starts another application; a capture failure here is the caller's to log.
 */
export async function finalizeAttemptCapture(ctx, { attemptId, auditDir = null, verdictStatus } = {}) {
  assertLearningEnabled(ctx);
  let located;
  if (auditDir) {
    const rel = (auditDir.startsWith(ctx.dataRoot + sep) ? auditDir.slice(ctx.dataRoot.length + 1) : auditDir)
      .replaceAll('\\', '/');
    let meta = null;
    const metaPath = join(auditDir, 'learning', 'meta.json');
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { meta = null; }
    }
    located = { auditDir, rel, meta: meta ?? { attemptId, applicationId: null } };
  } else {
    located = locateAttempt(ctx, attemptId);
  }
  const learnDir = join(located.auditDir, 'learning');
  let pagesObserved = 0;
  let incompletePages = false;
  if (existsSync(learnDir)) {
    for (const f of readdirSync(learnDir)) {
      if (!f.startsWith('observe-') || !f.endsWith('.json')) continue;
      try {
        const marker = JSON.parse(readFileSync(join(learnDir, f), 'utf8'));
        pagesObserved += 1;
        if (marker.incomplete) incompletePages = true;
      } catch { incompletePages = true; }
    }
  }
  let legacy = { added: 0, duplicate: 0, rejected: [] };
  if (existsSync(join(located.auditDir, 'answers.json'))) {
    // allowUnsettled: the executor already exited and the verdict is final,
    // so answers.json is complete even though it was written moments ago.
    legacy = await captureAttempt(ctx, { attemptDir: located.auditDir, apply: true, allowUnsettled: true });
  }
  const completedLooking = ['submitted', 'filled_no_submit'].includes(verdictStatus);
  let coverage;
  if (pagesObserved === 0) coverage = completedLooking ? 'incomplete' : 'none';
  else coverage = incompletePages ? 'partial' : 'complete';
  const taskId = `sync-${sha40(`consolidate:${attemptId}`)}`;
  if (!getRecord(ctx, 'syncTasks', taskId)) {
    await commitRecord(ctx, 'syncTasks', taskId, {
      taskType: 'local_consolidation',
      applicationId: located.meta.applicationId ?? null,
      attemptId,
      payloadRef: `${located.rel}/learning/capture-summary.json`,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
    }, { expectedRevision: 0, status: 'pending', sourceIds: [] });
  }
  const summary = {
    attemptId,
    verdictStatus,
    coverage,
    pagesObserved,
    incompletePages,
    legacyIngest: { added: legacy.added, duplicate: legacy.duplicate, rejected: legacy.rejected.length },
    consolidationTaskId: taskId,
    finalizedAt: ctx.now().toISOString(),
  };
  mkdirSync(learnDir, { recursive: true });
  writeFileSync(join(learnDir, 'capture-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  const ctx = buildCtx();

  if (command === 'inspect') {
    // Read-only discovery; --json is the only output form.
    const { entries, gaps } = discoverHistory(ctx);
    print({ dataRoot: ctx.dataRoot, ...summarize(entries, gaps) });
    return 0;
  }

  if (command === 'backfill') {
    if (flags['dry-run'] && flags.apply) throw new Error('--dry-run and --apply are mutually exclusive');
    if (flags['dry-run']) {
      if (!flags.out) throw new Error('backfill --dry-run requires --out <path>');
      const outPath = resolve(flags.out);
      const storeRoot = learningDataRoot(ctx);
      if (outPath === storeRoot || outPath.startsWith(storeRoot + sep)) {
        throw new Error('--out must not point inside the learning store');
      }
      const manifest = buildBackfillManifest(ctx);
      writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
      print({ wrote: outPath, ...manifest.summary });
      return 0;
    }
    if (flags.apply) {
      if (!flags.manifest) throw new Error('backfill --apply requires --manifest <path>');
      const summary = await backfillHistory(ctx, { manifestPath: resolve(flags.manifest), apply: true });
      print(summary);
      return 0;
    }
    throw new Error('backfill requires --dry-run or --apply');
  }

  if (command === 'rebuild') {
    if (!flags.verify) throw new Error('rebuild requires --verify');
    if (!existsSync(learningDataRoot(ctx))) {
      // No store: report that honestly without creating one.
      print({ store: 'absent', note: 'no learning store exists; nothing to rebuild' });
      return 0;
    }
    const applied = await rebuildIndexes(ctx, { apply: true });
    const check = await rebuildIndexes(ctx, { apply: false });
    const countsMatch = JSON.stringify(applied.counts) === JSON.stringify(check.counts);
    print({ generation: applied.generation, counts: applied.counts, errors: applied.errors, verified: countsMatch });
    return countsMatch ? 0 : 1;
  }

  // Attempt-scoped subcommands (CONTRACTS J): strict JSON out on stdout.
  if (['observe-page', 'resolve-page', 'checkpoint', 'capture-attempt'].includes(command)) {
    const attemptId = flags['attempt-id'];
    if (!attemptId) throw new Error(`${command} requires --attempt-id ID`);
    if (command === 'capture-attempt') {
      if (!flags.apply) throw new Error('capture-attempt requires --apply');
      assertLearningEnabled(ctx);
      const located = locateAttempt(ctx, attemptId);
      print(await captureAttempt(ctx, { attemptDir: located.auditDir, apply: true }));
      return 0;
    }
    if (!flags.input) throw new Error(`${command} requires --input FILE`);
    if (command === 'observe-page') {
      print(await observePage(ctx, { attemptId, inputPath: flags.input, apply: Boolean(flags.apply) }));
      return 0;
    }
    if (command === 'resolve-page') {
      print(await resolvePage(ctx, { attemptId, inputPath: flags.input }));
      return 0;
    }
    if (!flags.phase) throw new Error('checkpoint requires --phase PHASE');
    print(await recordCheckpoint(ctx, { attemptId, phase: flags.phase, inputPath: flags.input }));
    return 0;
  }

  throw new Error(`unknown command: ${String(command)}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
