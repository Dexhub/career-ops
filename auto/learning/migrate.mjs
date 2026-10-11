// auto/learning/migrate.mjs — migration/backup/restore/rollback helpers
// (T26, reused by the T27 activation gate). Pure functions over explicit
// roots: data manifests with hashes, owner-protected (0700) backups that
// exclude credential-named files, hash-verified restores, a store-meta
// reader/writer-compatibility marker, and the rollback snapshot guard that
// refuses to restore a pre-submission snapshot over a submitted job.
// Nothing executes at import time. Never imports core/db.mjs.

import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { LearningError, SCHEMA_VERSION, isSecretKey } from './contracts.mjs';
import { learningDataRoot } from './context.mjs';

export const DATA_MANIFEST_KIND = 'learning-data-manifest';
export const DATA_MANIFEST_SCHEMA_VERSION = 1;
export const BACKUP_MANIFEST_FILENAME = 'backup-manifest.json';
export const STORE_META_FILENAME = 'store-meta.json';
export const STORE_META_KIND = 'learning-store-meta';
// Reader/writer compatibility floor for the current store layout. An old
// writer (schema version < minWriterVersion) must be refused against this
// store; readers below minReaderVersion cannot interpret revision envelopes.
export const STORE_COMPAT = Object.freeze({
  storeSchemaVersion: SCHEMA_VERSION,
  minReaderVersion: 1,
  minWriterVersion: 1,
});

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeFileAtomic(targetPath, content) {
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

/** A path NAME (any segment, extension stripped) that looks credential-bearing. */
export function isCredentialPath(relativePath) {
  return String(relativePath).split('/').some((segment) =>
    isSecretKey(segment.replace(/\.[A-Za-z0-9]+$/, '')));
}

function walkFiles(root, relDir, out) {
  const absDir = join(root, relDir);
  let names;
  try {
    names = readdirSync(absDir).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    const rel = relDir ? `${relDir}/${name}` : name;
    const st = lstatSync(join(root, rel));
    if (st.isSymbolicLink()) {
      out.skipped.push({ relativePath: rel, reason: 'SYMLINK_REFUSED' });
      continue;
    }
    if (st.isDirectory()) walkFiles(root, rel, out);
    else out.files.push({ relativePath: rel, bytes: st.size, sha256: sha256File(join(root, rel)) });
  }
}

/**
 * buildDataManifest(root, {now}) -> pre-migration manifest of every regular
 * file under root with sizes and sha256 hashes. Symlinks are recorded as
 * skipped, never followed. Read-only.
 */
export function buildDataManifest(root, { now = () => new Date() } = {}) {
  const out = { files: [], skipped: [] };
  walkFiles(root, '', out);
  return {
    kind: DATA_MANIFEST_KIND,
    schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    root: resolve(root),
    files: out.files,
    skipped: out.skipped,
  };
}

/**
 * backupDataPaths({sourceRoot, destRoot, approvedPaths, now}) -> {manifest,
 * copied, refused}. Copies ONLY files under the approved relative prefixes to
 * destRoot (created owner-only 0700), hashing source and copy and refusing a
 * mismatch. Explicitly approving a credential-named path throws; a
 * credential-named file discovered under an approved prefix is refused
 * (recorded, never copied). The backup manifest carries names and hashes
 * only, never file values. A backup is NOT accepted until restoreBackup to a
 * separate scratch root reproduces the expected records.
 */
export function backupDataPaths({ sourceRoot, destRoot, approvedPaths, now = () => new Date() } = {}) {
  if (!Array.isArray(approvedPaths) || approvedPaths.length === 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'approvedPaths must be a nonempty array of relative paths');
  }
  for (const p of approvedPaths) {
    if (typeof p !== 'string' || p.startsWith('/') || p.split('/').some((s) => s === '..')) {
      throw new LearningError('FORBIDDEN_PATH', `approved path must be relative without "..": ${String(p)}`);
    }
    if (isCredentialPath(p)) {
      throw new LearningError('FORBIDDEN_SOURCE', `credential-named path may not be approved for backup: ${p}`);
    }
  }
  mkdirSync(destRoot, { recursive: true, mode: DIR_MODE });
  chmodSync(destRoot, DIR_MODE); // mkdir mode is umask-filtered; enforce 0700
  const all = { files: [], skipped: [] };
  walkFiles(sourceRoot, '', all);
  const approved = (rel) => approvedPaths.some((p) =>
    rel === p.replace(/\/$/, '') || rel.startsWith(p.endsWith('/') ? p : `${p}/`));
  const copied = [];
  const refused = [];
  for (const file of all.files) {
    if (!approved(file.relativePath)) continue;
    if (isCredentialPath(file.relativePath)) {
      refused.push({ relativePath: file.relativePath, reason: 'CREDENTIAL_NAME_REFUSED' });
      continue;
    }
    const target = join(destRoot, 'files', file.relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE });
    copyFileSync(join(sourceRoot, file.relativePath), target);
    chmodSync(target, FILE_MODE);
    const copyHash = sha256File(target);
    if (copyHash !== file.sha256) {
      throw new LearningError('BACKUP_HASH_MISMATCH',
        `copied file hash differs for ${file.relativePath}`);
    }
    copied.push(file);
  }
  const manifest = {
    kind: DATA_MANIFEST_KIND,
    schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    sourceRoot: resolve(sourceRoot),
    approvedPaths: [...approvedPaths],
    files: copied,
    refused,
    skipped: all.skipped,
  };
  writeFileAtomic(join(destRoot, BACKUP_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  return { manifest, copied: copied.length, refused };
}

/**
 * restoreBackup({backupRoot, destRoot}) -> {restored, verified}. Copies every
 * manifest file into destRoot and re-verifies each restored file's hash
 * against the backup manifest. Throws on any mismatch; a restore that cannot
 * be verified means the backup is NOT acceptable.
 */
export function restoreBackup({ backupRoot, destRoot } = {}) {
  const manifestPath = join(backupRoot, BACKUP_MANIFEST_FILENAME);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new LearningError('MANIFEST_MALFORMED', `cannot read backup manifest: ${err.message}`);
  }
  if (manifest?.kind !== DATA_MANIFEST_KIND || manifest?.schemaVersion !== DATA_MANIFEST_SCHEMA_VERSION) {
    throw new LearningError('MANIFEST_MALFORMED', 'not a supported backup manifest');
  }
  mkdirSync(destRoot, { recursive: true, mode: DIR_MODE });
  let restored = 0;
  for (const file of manifest.files) {
    const src = join(backupRoot, 'files', file.relativePath);
    const target = join(destRoot, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
    const hash = sha256File(target);
    if (hash !== file.sha256) {
      throw new LearningError('RESTORE_HASH_MISMATCH',
        `restored file hash differs for ${file.relativePath}`);
    }
    restored += 1;
  }
  return { restored, verified: true, manifest };
}

/**
 * writeStoreMeta(ctx, {inputManifest}) -> meta. Writes the store's
 * schema/version manifest + reader-compatibility marker after a migration:
 * input manifest identity, output store schema version, reader/writer floors
 * and adapter versions. Atomic, owner-only.
 */
export function writeStoreMeta(ctx, { inputManifest } = {}) {
  const meta = {
    kind: STORE_META_KIND,
    ...STORE_COMPAT,
    adapterVersions: inputManifest?.adapterVersions ?? {},
    input: inputManifest ? {
      kind: inputManifest.kind,
      schemaVersion: inputManifest.schemaVersion,
      generatedAt: inputManifest.generatedAt,
      entries: Array.isArray(inputManifest.entries) ? inputManifest.entries.length : 0,
    } : null,
    migratedAt: ctx.now().toISOString(),
  };
  writeFileAtomic(join(learningDataRoot(ctx), STORE_META_FILENAME), JSON.stringify(meta, null, 2));
  return meta;
}

/** readStoreMeta(ctx) -> meta | null (malformed meta is a loud error). */
export function readStoreMeta(ctx) {
  const path = join(learningDataRoot(ctx), STORE_META_FILENAME);
  if (!existsSync(path)) return null;
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new LearningError('CORRUPT_RECORD', `malformed store meta ${path}`);
  }
  if (meta?.kind !== STORE_META_KIND) {
    throw new LearningError('CORRUPT_RECORD', `unexpected store meta kind in ${path}`);
  }
  return meta;
}

/**
 * assertWriterCompatible(ctx, {writerSchemaVersion}) — refuse running an
 * unsupported old writer against a newer store. No marker means a pre-marker
 * store: writers at the current schema version may proceed.
 */
export function assertWriterCompatible(ctx, { writerSchemaVersion } = {}) {
  if (!Number.isInteger(writerSchemaVersion) || writerSchemaVersion < 0) {
    throw new LearningError('SCHEMA_VALIDATION', 'writerSchemaVersion must be an integer >= 0');
  }
  const meta = readStoreMeta(ctx);
  const minWriter = meta?.minWriterVersion ?? STORE_COMPAT.minWriterVersion;
  const storeVersion = meta?.storeSchemaVersion ?? STORE_COMPAT.storeSchemaVersion;
  if (writerSchemaVersion < minWriter) {
    throw new LearningError('WRITER_INCOMPATIBLE',
      `writer schema version ${writerSchemaVersion} is below the store's minimum writer version ${minWriter} (store schema ${storeVersion})`);
  }
  return { storeSchemaVersion: storeVersion, minWriterVersion: minWriter };
}

// Stages at/after which an application has had an irreversible external
// effect. Restoring an earlier snapshot over these would fabricate an
// un-submitted state that no rollback can make true.
const EXTERNALLY_COMMITTED_STAGES = Object.freeze(['submitted']);

/**
 * guardSnapshotRestore({current, snapshot}) — never restore an old "queued"
 * (or any pre-submission) snapshot over a newly submitted job. Throws
 * LearningError ROLLBACK_UNSAFE; returns {allowed:true} otherwise.
 */
export function guardSnapshotRestore({ current, snapshot } = {}) {
  const curStage = current?.stage;
  const snapStage = snapshot?.stage;
  if (typeof curStage !== 'string' || typeof snapStage !== 'string') {
    throw new LearningError('SCHEMA_VALIDATION', 'current.stage and snapshot.stage must be strings');
  }
  if (EXTERNALLY_COMMITTED_STAGES.includes(curStage) && !EXTERNALLY_COMMITTED_STAGES.includes(snapStage)) {
    throw new LearningError('ROLLBACK_UNSAFE',
      `refusing to restore a "${snapStage}" snapshot over a job already "${curStage}": the external submission cannot be unsent`);
  }
  return { allowed: true };
}
