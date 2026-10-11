// auto/learning/store.mjs — versioned local learning records (CONTRACTS C/E,
// T02). Immutable revision files under records/<collection>/<id>/<rev>.json,
// per-entity locks via withPipelineLock, atomic temp+fsync+rename writes,
// batch index generations with an atomic current.json pointer.
// Nothing executes at import time. Never imports core/db.mjs.

import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import {
  COLLECTIONS, LIMITS, SCHEMA_VERSION, LearningError,
  assertCollection, assertId, isValidId, statusEnumFor,
  validateEnvelope, validateRecordData,
} from './contracts.mjs';
import { learningDataRoot } from './context.mjs';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const REV_FILE_RE = /^(\d{1,9})\.json$/;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

function mkdirPrivate(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

// Atomic write: exclusive owner-only temp file in the target directory,
// complete write + fsync before rename, then best-effort directory fsync.
function writeFileAtomic(targetPath, content) {
  const dir = dirname(targetPath);
  mkdirPrivate(dir);
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
  try {
    const dfd = openSync(dir, 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* directory fsync not supported everywhere */ }
}

function recordsRoot(ctx) {
  return join(learningDataRoot(ctx), 'records');
}

function indexesRoot(ctx) {
  return join(learningDataRoot(ctx), 'indexes');
}

function lockPathFor(ctx, collection, id) {
  // withPipelineLock locks "<path>.lock"; one lock file name per entity.
  return join(learningDataRoot(ctx), 'locks', `${collection}--${id}`);
}

// Resolve the directory holding one entity's revisions, refusing symlinked
// directories and anything that escapes the learning root.
function entityDir(ctx, collection, id) {
  assertCollection(collection);
  assertId(id);
  const root = learningDataRoot(ctx);
  const dir = join(root, 'records', collection, id);
  if (existsSync(dir)) {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new LearningError('FORBIDDEN_PATH', `entity directory is a symlink: ${collection}/${id}`);
    }
    const realRoot = realpathSync(root);
    const realDir = realpathSync(dir);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      throw new LearningError('FORBIDDEN_PATH', `entity directory escapes the learning root: ${collection}/${id}`);
    }
  }
  return dir;
}

function listRevisionNumbers(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw new LearningError('READ_ERROR', `cannot read entity directory ${dir}: ${err.message}`);
  }
  const revs = [];
  for (const name of names) {
    const m = REV_FILE_RE.exec(name);
    if (m) revs.push(Number(m[1]));
  }
  revs.sort((a, b) => a - b);
  return revs;
}

function readRevisionFile(path, { collection }) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new LearningError('READ_ERROR', `revision file vanished: ${path}`);
    }
    throw new LearningError('READ_ERROR', `cannot read revision file ${path}: ${err.message}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    // Malformed is NOT missing: a corrupt file is a loud error, never null.
    throw new LearningError('CORRUPT_RECORD', `malformed JSON in ${path}`);
  }
  validateEnvelope(envelope, { collection });
  return envelope;
}

/**
 * getRecord(ctx, collection, id) -> envelope | null (CONTRACTS E).
 * Returns the latest immutable revision, null only when no revision exists.
 */
export function getRecord(ctx, collection, id) {
  const dir = entityDir(ctx, collection, id);
  const revs = listRevisionNumbers(dir);
  if (revs.length === 0) return null;
  const latest = revs[revs.length - 1];
  return readRevisionFile(join(dir, `${latest}.json`), { collection });
}

/**
 * commitRecord(ctx, collection, id, data, {expectedRevision, status, sourceIds})
 * -> envelope (CONTRACTS E). expectedRevision 0 creates; revisions start at 1.
 * Validates the latest revision under a per-entity lock and rejects stale
 * commits with code REVISION_CONFLICT. Never overwrites an existing revision.
 */
export async function commitRecord(ctx, collection, id, data, options = {}) {
  const { expectedRevision, status, sourceIds = [] } = options;
  assertCollection(collection);
  assertId(id);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'expectedRevision must be an integer >= 0 (0 creates)');
  }
  if (!statusEnumFor(collection).includes(status)) {
    throw new LearningError('SCHEMA_VALIDATION',
      `invalid status "${String(status)}" for ${collection} (allowed: ${statusEnumFor(collection).join('|')})`);
  }
  validateRecordData(collection, data);

  return withPipelineLock(lockPathFor(ctx, collection, id), async () => {
    const dir = entityDir(ctx, collection, id);
    const revs = listRevisionNumbers(dir);
    const latest = revs.length === 0 ? 0 : revs[revs.length - 1];
    if (latest !== expectedRevision) {
      throw new LearningError('REVISION_CONFLICT',
        `stale commit for ${collection}/${id}: expectedRevision ${expectedRevision}, latest is ${latest}`,
        { collection, id, expectedRevision, actualRevision: latest });
    }
    const nowIso = ctx.now().toISOString();
    let createdAt = nowIso;
    if (latest > 0) {
      createdAt = readRevisionFile(join(dir, `${latest}.json`), { collection }).createdAt;
    }
    const revision = latest + 1;
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      id,
      revision,
      createdAt,
      updatedAt: nowIso,
      sourceIds: [...sourceIds],
      status,
      data,
    };
    validateEnvelope(envelope, { collection });
    const serialized = JSON.stringify(envelope, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > LIMITS.maxRecordBytes) {
      throw new LearningError('LIMIT_EXCEEDED', `record exceeds ${LIMITS.maxRecordBytes} bytes`);
    }
    const target = join(dir, `${revision}.json`);
    if (existsSync(target)) {
      // A duplicate revision file means someone wrote without the lock or a
      // crash left inconsistent state. Never blindly overwrite an immutable rev.
      throw new LearningError('REVISION_CONFLICT',
        `revision ${revision} already exists for ${collection}/${id}`,
        { collection, id, expectedRevision, actualRevision: revision });
    }
    writeFileAtomic(target, serialized);
    return envelope;
  });
}

function currentIndexPointer(ctx) {
  const path = join(indexesRoot(ctx), 'current.json');
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new LearningError('CORRUPT_RECORD', `malformed index pointer ${path}`);
  }
  if (typeof parsed?.generation !== 'string') {
    throw new LearningError('CORRUPT_RECORD', `index pointer missing generation: ${path}`);
  }
  return parsed;
}

function scanAllRecords(ctx) {
  const root = recordsRoot(ctx);
  const byCollection = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
  const errors = [];
  let collectionDirs = [];
  try {
    collectionDirs = readdirSync(root);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  for (const collection of collectionDirs) {
    if (!COLLECTIONS.includes(collection)) {
      errors.push({ code: 'INVALID_COLLECTION', path: `records/${collection}` });
      continue;
    }
    let ids = [];
    try {
      ids = readdirSync(join(root, collection));
    } catch { continue; }
    for (const id of ids) {
      if (!isValidId(id)) {
        errors.push({ code: 'INVALID_ID', path: `records/${collection}/${id}` });
        continue;
      }
      let dir;
      try {
        dir = entityDir(ctx, collection, id);
      } catch (err) {
        errors.push({ code: err.code ?? 'READ_ERROR', path: `records/${collection}/${id}` });
        continue;
      }
      const revs = listRevisionNumbers(dir);
      if (revs.length === 0) continue;
      const latest = revs[revs.length - 1];
      try {
        const envelope = readRevisionFile(join(dir, `${latest}.json`), { collection });
        byCollection[collection].push({ id, revision: envelope.revision, status: envelope.status });
      } catch (err) {
        errors.push({ code: err.code ?? 'READ_ERROR', path: `records/${collection}/${id}/${latest}.json` });
      }
    }
    byCollection[collection].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return { byCollection, errors };
}

function generationDigest(byCollection) {
  const hash = createHash('sha256');
  for (const collection of COLLECTIONS) {
    for (const entry of byCollection[collection]) {
      hash.update(`${collection}/${entry.id}@${entry.revision}\n`);
    }
  }
  return hash.digest('hex');
}

/**
 * rebuildIndexes(ctx, {apply}) -> {generation, counts, errors} (CONTRACTS E).
 * Builds a complete generation from explicit immutable input revisions, then
 * atomically swaps indexes/current.json. apply:false validates without
 * writing or swapping anything.
 */
export async function rebuildIndexes(ctx, { apply = false } = {}) {
  const { byCollection, errors } = scanAllRecords(ctx);
  const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, byCollection[c].length]));
  const digest = generationDigest(byCollection);
  if (!apply) {
    return { generation: null, counts, errors };
  }
  const generation = `gen-${ctx.now().getTime()}-${digest.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const genDir = join(indexesRoot(ctx), generation);
  mkdirPrivate(genDir);
  for (const collection of COLLECTIONS) {
    writeFileAtomic(join(genDir, `${collection}.json`), JSON.stringify(byCollection[collection], null, 2));
  }
  writeFileAtomic(join(genDir, 'meta.json'), JSON.stringify({
    generation, digest, counts, createdAt: ctx.now().toISOString(),
  }, null, 2));
  // Readers see either the old complete generation or this new complete one.
  writeFileAtomic(join(indexesRoot(ctx), 'current.json'), JSON.stringify({
    generation, digest, createdAt: ctx.now().toISOString(),
  }, null, 2));
  return { generation, counts, errors };
}

function parseCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'cursor must be a nonempty string');
  }
  const sepIdx = cursor.lastIndexOf('::');
  if (sepIdx <= 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'malformed cursor');
  }
  return { generation: cursor.slice(0, sepIdx), lastId: cursor.slice(sepIdx + 2) };
}

/**
 * listRecords(ctx, collection, {cursor, limit, filters}) -> {items, nextCursor,
 * generation} (CONTRACTS E). Pages a single complete index generation; a
 * cursor naming an obsolete generation returns a refresh-required error
 * (code REFRESH_REQUIRED), never silently mixed pages. Without any built
 * index a deterministic direct scan is served under the pseudo-generation
 * "unindexed".
 */
export function listRecords(ctx, collection, { cursor, limit, filters } = {}) {
  assertCollection(collection);
  const pageSize = limit === undefined ? DEFAULT_LIST_LIMIT
    : (Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT);
  const pointer = currentIndexPointer(ctx);
  const generation = pointer?.generation ?? 'unindexed';

  let entries;
  if (pointer) {
    const path = join(indexesRoot(ctx), pointer.generation, `${collection}.json`);
    try {
      entries = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      throw new LearningError(err?.code === 'ENOENT' ? 'READ_ERROR' : 'CORRUPT_RECORD',
        `cannot read index ${path}`);
    }
  } else {
    entries = scanAllRecords(ctx).byCollection[collection];
  }

  if (filters?.status !== undefined) {
    entries = entries.filter((e) => e.status === filters.status);
  }

  let startIdx = 0;
  if (cursor !== undefined && cursor !== null) {
    const parsed = parseCursor(cursor);
    if (parsed.generation !== generation) {
      throw new LearningError('REFRESH_REQUIRED',
        `pagination cursor names obsolete generation ${parsed.generation}; current is ${generation} — refresh required`);
    }
    startIdx = entries.findIndex((e) => e.id > parsed.lastId);
    if (startIdx === -1) startIdx = entries.length;
  }

  const page = entries.slice(startIdx, startIdx + pageSize);
  const items = page.map((entry) =>
    readRevisionFile(join(recordsRoot(ctx), collection, entry.id, `${entry.revision}.json`), { collection }));
  const nextCursor = startIdx + pageSize < entries.length
    ? `${generation}::${page[page.length - 1].id}`
    : null;
  return { items, nextCursor, generation };
}
