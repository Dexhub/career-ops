# Learning layer — operator guide: migration, backup, restore, rollback

This README covers the operator procedures rehearsed by
`auto/test/learning-migration.test.mjs` (T26). The helpers live in
`auto/learning/migrate.mjs` and are reused by the T27 activation gate.
Everything here operates on explicit roots; nothing runs at import time.

## Migration (preview → apply → restart)

1. **Preview** (read-only): `node auto/learn.mjs backfill --dry-run --out <manifest.json>`
   builds the backfill manifest (`buildBackfillManifest`) — entry hashes,
   adapter versions, settled flags and coverage gaps. Preview never writes
   learning records.
2. **Pre-migration manifest**: before applying, snapshot the data root with
   `buildDataManifest(root)` (every file, size, sha256). Keep it with the run.
3. **Apply**: `node auto/learn.mjs backfill --apply --manifest <manifest.json>`.
   Sources are re-hashed at apply time; changed/missing/malformed/unsettled
   sources are rejected per entry, never silently fixed.
4. **Interrupt/restart**: apply is idempotent. If interrupted, re-run with the
   same manifest; already-committed observations are counted as duplicates and
   never re-added or overwritten.
5. **Store meta / compatibility marker**: after a successful apply, write
   `store-meta.json` via `writeStoreMeta(ctx, { inputManifest })`. It records
   the input manifest identity, output store schema version, adapter versions
   and the reader/writer compatibility floors. Before any writer touches a
   store, call `assertWriterCompatible(ctx, { writerSchemaVersion })` — an
   unsupported old writer is refused with `WRITER_INCOMPATIBLE`.

## Backup

- Back up **only approved data paths** with
  `backupDataPaths({ sourceRoot, destRoot, approvedPaths })`. The destination
  is created owner-only (`0700`); each copy is hash-verified against the
  source; a `backup-manifest.json` (names + hashes only, never values) is
  written inside the backup.
- **Credentials never enter a backup**: approving a credential-named path
  throws; a credential-named file found under an approved prefix is refused
  and recorded in the manifest's `refused` list. Do not commit backup data or
  place it in an unprotected archive.
- **A backup is not accepted until restored**: run
  `restoreBackup({ backupRoot, destRoot })` against a *separate scratch root*
  and verify the expected records reproduce (hashes are re-checked file by
  file). Only then treat the backup as valid.

## Index rebuild

Index generations are derivative. They can be discarded entirely
(`rm -r data/auto/learning/indexes`) without losing authoritative revision
files — reads fall back to a deterministic unindexed scan — and rebuilt with
`rebuildIndexes(ctx, { apply: true })`. A failed generation build never swaps
`current.json`, so the previous generation stays usable.

## Rollback procedure

1. Stop the reviewer and application writers at an approved safe boundary
   (between attempts; use the panel's pause-after-current control — never kill
   mid-submission).
2. Keep unresolved external outcomes **parked**: an attempt with an unknown
   submission outcome stays `unknown` until reconciled; rollback must not
   resolve, delete or retry it.
3. Disable new features (`config/learning.yml` → `enabled: false`) before
   restarting anything.
4. Restore compatible code/config/data from a hash-verified backup (or use a
   verified adapter for cross-version data). Verify the restore as above.
5. Recheck the canonical tracker against the restored jobs before resuming.
   **Never restore an old "queued" snapshot over a newly submitted job** —
   `guardSnapshotRestore` refuses this with `ROLLBACK_UNSAFE`.

## Irreversible external effects — a rollback CANNOT undo these

A local restore only rewinds local state. It **cannot unsend** an application
that was already submitted to an employer, **cannot delete** an
employer account created on an external ATS, **cannot retract** a message sent
to a recruiter or employer, and **cannot undo** a public-profile publication.
Treat every external side effect as permanent: park it, reconcile it, and
record it in the canonical tracker — do not pretend the rollback erased it.
