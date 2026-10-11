# T26 — migration/backup/restore/rollback rehearsal evidence (2026-10-11)

All rehearsal happened inside a single mkdtemp fixture root (first assertion
of the suite verifies tmpdir isolation). No live data was read or written; no
live rollback was performed; no cycles, browsers or model calls.

## Suite

`node --test auto/test/learning-migration.test.mjs` — 11/11 pass:

- synthetic legacy root is mkdtemp-isolated and the pre-migration manifest covers it
- backup refuses explicitly approved credential-named paths
- backup copies only approved paths to an owner-protected 0700 destination with verified hashes
- backup is accepted only after a restore to a second scratch root reproduces expected records
- migration preview classifies the legacy root without writing anything
- migration apply -> interrupt -> restart is idempotent and rejects the malformed file loudly
- store meta records input/output schema versions and the reader-compatibility marker; old writers are rejected
- indexes can be discarded and rebuilt without losing authoritative records
- a failed index generation leaves the previous generation usable
- rollback rehearsal: safe boundary, parked outcomes, features disabled, verified data restore, tracker recheck
- operator README documents irreversible external effects of a rollback

Full regression: `node --test auto/test/learning-*.test.mjs auto/learning/cloud/test/*.test.mjs`
= **409 pass / 0 fail** (398 prior + 11 new).

## Backup/restore evidence

- Synthetic legacy root: 2 legacy v0 jobs (one `submitted` with pending
  trackerSync, one `queued`), reused-attempt history (same question in
  attempt-1 and attempt-2), a missing `answers.json` (attempt-3), a malformed
  `answers.json`, staged standing answers, and a synthetic
  `config/credentials.json`.
- Pre-migration manifest (`buildDataManifest`): every legacy file enumerated
  with size + sha256 (64-hex asserted per file).
- Backup (`backupDataPaths`): approved prefixes `output/`, `data/auto/jobs/`,
  `config/`; destination mode asserted `0700`; 7 files copied, each copy
  re-hashed against its source; `config/credentials.json` REFUSED
  (`CREDENTIAL_NAME_REFUSED`) and absent from the backup tree; manifest
  contains names/hashes only (asserted no secret value in serialized form).
  Explicitly approving a credential-named path throws `FORBIDDEN_SOURCE`.
- Restore (`restoreBackup`) to a second scratch root: 7/7 files restored and
  hash-verified; restored submitted job reproduces `stage: submitted` +
  `trackerSync.status: pending`; restored answers parse to expected values;
  credential file not present. Backup acceptance flag set ONLY after this.

## Migration/compatibility evidence

- Preview (`buildBackfillManifest`, real T05 production path): 3 audit
  entries (settled under a +60s offset clock per the T25 settled-mtime
  gotcha); `missing_answers` coverage gap recorded for attempt-3; no learning
  records written by preview.
- Apply/interrupt/restart (`backfillHistory --apply` semantics): truncated
  manifest run committed 2 observations (simulated interrupt); full-manifest
  restart detected those as duplicates and added the remaining 1; malformed
  file rejected with `MALFORMED_JSON`; third full run added 0 (idempotent).
  Final authoritative count: 3 `observations`, all `recorded`.
- Store meta (`writeStoreMeta`/`readStoreMeta` in new `auto/learning/migrate.mjs`):
  `store-meta.json` records input manifest kind/version/entry-count/adapter
  versions, output `storeSchemaVersion: 1`, `minReaderVersion: 1`,
  `minWriterVersion: 1` (reader-compatibility marker).
  `assertWriterCompatible(writerSchemaVersion: 1)` passes;
  `writerSchemaVersion: 0` is rejected with `WRITER_INCOMPATIBLE`.

## Index evidence

- `rebuildIndexes(apply:true)` → generation with `counts.observations: 3`;
  deleting the entire `indexes/` tree still serves all 3 records via the
  `unindexed` deterministic scan; rebuild produces a fresh working generation.
- Failed-generation simulation: a partial garbage generation directory
  without a `current.json` swap leaves the pointer and reads on the previous
  generation fully intact (3/3 records).

## Rollback evidence

- Safe boundary recorded before restore (synthetic stopped-writers marker;
  no live process exists in the fixture).
- Unresolved external outcome (attempts record, status `unknown`) stays
  parked through the rehearsal — never resolved, deleted or retried.
- New features disabled in restored config (`enabled: false` read back via
  `readLearningConfig`).
- Data restored from the verified backup into a rollback root (hash-verified);
  canonical tracker recheck: submitted job still `submitted` with pending
  sync task intact.
- `guardSnapshotRestore` REFUSES restoring an old `queued` snapshot over the
  newly `submitted` job (`ROLLBACK_UNSAFE`); queued-over-queued allowed.
- Irreversible external effects documented in `auto/learning/README.md`
  (cannot unsend applications, delete employer accounts, retract messages,
  undo publications) and asserted by the suite.

## Files

- `auto/learning/migrate.mjs` (new, additive; nothing at import time; T27 reuse)
- `auto/test/learning-migration.test.mjs` (new, node:test, 11 tests)
- `auto/learning/README.md` (new operator guide; `auto/README.md` untouched)
