// auto/test/learning-migration.test.mjs — T26: rehearse migration, backup,
// restore and version rollback ENTIRELY inside synthetic fixture roots.
// No live data is read or written; no live rollback is performed; no cycles,
// browsers or model calls. node:test only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createLearningFixture } from './helpers/learning.mjs';
import { createLearningContext, readLearningConfig } from '../learning/context.mjs';
import {
  buildBackfillManifest, backfillHistory, MANIFEST_KIND,
} from '../learning/evidence.mjs';
import { commitRecord, getRecord, listRecords, rebuildIndexes } from '../learning/store.mjs';
import {
  BACKUP_MANIFEST_FILENAME, DATA_MANIFEST_KIND, STORE_COMPAT, STORE_META_KIND,
  assertWriterCompatible, backupDataPaths, buildDataManifest, guardSnapshotRestore,
  isCredentialPath, readStoreMeta, restoreBackup, writeStoreMeta,
} from '../learning/migrate.mjs';

// ---------------------------------------------------------------------------
// Shared synthetic fixture. Everything below lives under one mkdtemp root.
const fixture = createLearningFixture();
test.after(() => fixture.cleanup());

// Settled-clock gotcha (T25 log): artifacts written during the test carry a
// wall-time mtime, so ctx.now() runs 60s AHEAD of the wall clock to make them
// deterministically settled for discoverHistory/backfillHistory.
const ctx = createLearningContext({
  codeRoot: fixture.codeRoot,
  dataRoot: fixture.dataRoot,
  now: () => new Date(Date.now() + 60_000),
});

const LEGACY_JOB_SUBMITTED = '100-synthco-engineer';
const LEGACY_JOB_QUEUED = '101-oldco-engineer';
let preMigrationManifest = null;
let backupRoot = null;
let backupResult = null;
let backupAccepted = false;
let fullManifestPath = null;
let backfillManifest = null;

function writeLegacyRoot() {
  const root = fixture.dataRoot;
  writeFileSync(join(root, 'config', 'learning.yml'),
    'schema_version: 1\nenabled: true\nmode: shadow\n');
  // Staged answers awaiting operator confirmation (synthetic).
  writeFileSync(join(root, 'config', 'standing-answers.yml'),
    'filled_in_by_user: true\n\ncustom:\n  "staged synthetic question?": "staged synthetic answer"\n');
  // Synthetic credential file that must NEVER enter a backup archive.
  writeFileSync(join(root, 'config', 'credentials.json'),
    JSON.stringify({ note: 'synthetic secret placeholder' }));
  // Old job versions (legacy schemaVersion 0 shape) + pending tracker update.
  writeFileSync(join(root, 'data', 'auto', 'jobs', `${LEGACY_JOB_SUBMITTED}.json`), JSON.stringify({
    schemaVersion: 0, urlKey: LEGACY_JOB_SUBMITTED, company: 'synthco', role: 'Engineer',
    stage: 'submitted', attempts: 2,
    trackerSync: { status: 'pending', taskId: 'tracker-sync-synthetic-100' },
  }, null, 2));
  writeFileSync(join(root, 'data', 'auto', 'jobs', `${LEGACY_JOB_QUEUED}.json`), JSON.stringify({
    schemaVersion: 0, urlKey: LEGACY_JOB_QUEUED, company: 'oldco', role: 'Engineer',
    stage: 'queued', attempts: 0,
  }, null, 2));
  // Reused-attempt history: two attempts of the same application answered the
  // same synthetic question. attempt-3 has a MISSING answers.json artifact.
  const auditA = join(root, 'output', LEGACY_JOB_SUBMITTED, 'audit');
  for (const attempt of ['attempt-1', 'attempt-2', 'attempt-3']) {
    mkdirSync(join(auditA, attempt), { recursive: true });
  }
  writeFileSync(join(auditA, 'attempt-1', 'answers.json'), JSON.stringify({
    'How many years of synthetic experience?': '5',
    'Preferred synthetic location?': 'Remote',
  }));
  writeFileSync(join(auditA, 'attempt-2', 'answers.json'), JSON.stringify({
    'How many years of synthetic experience?': '5',
  }));
  // Malformed file: unreadable JSON must be classified, never silently fixed.
  const auditB = join(root, 'output', LEGACY_JOB_QUEUED, 'audit', 'attempt-1');
  mkdirSync(auditB, { recursive: true });
  writeFileSync(join(auditB, 'answers.json'), '{ this is not valid json');
}

// ---------------------------------------------------------------------------
test('synthetic legacy root is mkdtemp-isolated and the pre-migration manifest covers it', () => {
  // FIRST assertion: the fixture root is an isolated scratch directory under
  // the system tmpdir, never the repository or any live data root.
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.root.startsWith(realTmp + sep),
    `fixture root ${fixture.root} must live under tmpdir`);
  assert.notEqual(resolve(fixture.root), resolve(process.cwd()));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.root);

  writeLegacyRoot();
  preMigrationManifest = buildDataManifest(fixture.dataRoot, { now: ctx.now });
  assert.equal(preMigrationManifest.kind, DATA_MANIFEST_KIND);
  const rels = preMigrationManifest.files.map((f) => f.relativePath);
  for (const expected of [
    'config/learning.yml',
    'config/standing-answers.yml',
    'config/credentials.json',
    `data/auto/jobs/${LEGACY_JOB_SUBMITTED}.json`,
    `data/auto/jobs/${LEGACY_JOB_QUEUED}.json`,
    `output/${LEGACY_JOB_SUBMITTED}/audit/attempt-1/answers.json`,
    `output/${LEGACY_JOB_SUBMITTED}/audit/attempt-2/answers.json`,
    `output/${LEGACY_JOB_QUEUED}/audit/attempt-1/answers.json`,
  ]) {
    assert.ok(rels.includes(expected), `manifest must include ${expected}`);
  }
  for (const f of preMigrationManifest.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof f.bytes, 'number');
  }
  // The missing artifact (attempt-3) genuinely has no answers.json.
  assert.ok(!rels.includes(`output/${LEGACY_JOB_SUBMITTED}/audit/attempt-3/answers.json`));
});

test('backup refuses explicitly approved credential-named paths', () => {
  assert.ok(isCredentialPath('config/credentials.json'));
  assert.ok(!isCredentialPath('config/standing-answers.yml'));
  assert.throws(
    () => backupDataPaths({
      sourceRoot: fixture.dataRoot,
      destRoot: join(fixture.root, 'backup-bad'),
      approvedPaths: ['config/credentials.json'],
    }),
    (err) => err.code === 'FORBIDDEN_SOURCE');
});

test('backup copies only approved paths to an owner-protected 0700 destination with verified hashes', () => {
  backupRoot = join(fixture.root, 'backup');
  backupResult = backupDataPaths({
    sourceRoot: fixture.dataRoot,
    destRoot: backupRoot,
    approvedPaths: ['output/', 'data/auto/jobs/', 'config/'],
    now: ctx.now,
  });
  // Owner-protected destination: 0700, no group/world access.
  assert.equal(statSync(backupRoot).mode & 0o777, 0o700);
  // Credential-named file under an approved prefix was refused, not copied.
  assert.deepEqual(backupResult.refused.map((r) => r.relativePath), ['config/credentials.json']);
  assert.ok(!existsSync(join(backupRoot, 'files', 'config', 'credentials.json')));
  // Every copied file hash was verified against the source.
  assert.ok(backupResult.copied >= 7);
  const manifest = JSON.parse(readFileSync(join(backupRoot, BACKUP_MANIFEST_FILENAME), 'utf-8'));
  assert.equal(manifest.kind, DATA_MANIFEST_KIND);
  assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  // The manifest carries names/hashes only — no secret values anywhere.
  assert.ok(!JSON.stringify(manifest).includes('synthetic secret placeholder'));
  // NOT accepted yet: acceptance requires a verified restore (next test).
  assert.equal(backupAccepted, false);
});

test('backup is accepted only after a restore to a second scratch root reproduces expected records', () => {
  const restoreRoot = join(fixture.root, 'restore-check');
  const result = restoreBackup({ backupRoot, destRoot: restoreRoot });
  assert.equal(result.verified, true);
  assert.equal(result.restored, backupResult.copied);
  // The restored records byte-match and parse to the expected legacy state.
  const job = JSON.parse(readFileSync(
    join(restoreRoot, 'data', 'auto', 'jobs', `${LEGACY_JOB_SUBMITTED}.json`), 'utf-8'));
  assert.equal(job.stage, 'submitted');
  assert.equal(job.trackerSync.status, 'pending');
  const answers = JSON.parse(readFileSync(
    join(restoreRoot, 'output', LEGACY_JOB_SUBMITTED, 'audit', 'attempt-1', 'answers.json'), 'utf-8'));
  assert.equal(answers['How many years of synthetic experience?'], '5');
  // The credential file was never in the backup, so it is not restored.
  assert.ok(!existsSync(join(restoreRoot, 'config', 'credentials.json')));
  backupAccepted = true; // acceptance ONLY after the verified restore
  assert.equal(backupAccepted, true);
});

test('migration preview classifies the legacy root without writing anything', () => {
  backfillManifest = buildBackfillManifest(ctx);
  assert.equal(backfillManifest.kind, MANIFEST_KIND);
  // 3 audit answers.json artifacts discovered (incl. the malformed one —
  // byte-level discovery; rejection happens at apply).
  const auditEntries = backfillManifest.entries.filter((e) => e.adapter === 'audit-answers');
  assert.equal(auditEntries.length, 3);
  assert.ok(auditEntries.every((e) => e.settled), 'entries must be settled under the offset clock');
  // The missing artifact is a recorded coverage gap, not an invented record.
  assert.ok(backfillManifest.coverageGaps.some((g) =>
    g.type === 'missing_answers' && g.path.includes('attempt-3')));
  // Preview wrote no learning records.
  assert.ok(!existsSync(join(fixture.dataRoot, 'data', 'auto', 'learning', 'records')));
  fullManifestPath = join(fixture.root, 'migration-manifest.json');
  writeFileSync(fullManifestPath, JSON.stringify(backfillManifest, null, 2));
});

test('migration apply -> interrupt -> restart is idempotent and rejects the malformed file loudly', async () => {
  // Interrupted first run: only the first manifest entry was processed before
  // the (simulated) crash.
  const partial = { ...backfillManifest, entries: backfillManifest.entries.slice(0, 1) };
  const partialPath = join(fixture.root, 'migration-manifest-partial.json');
  writeFileSync(partialPath, JSON.stringify(partial, null, 2));
  const first = await backfillHistory(ctx, { manifestPath: partialPath, apply: true });
  assert.ok(first.added >= 1, 'interrupted run committed at least one observation');

  // Restart with the FULL manifest: already-committed records are detected as
  // duplicates; the remainder is added; the malformed file is rejected.
  const second = await backfillHistory(ctx, { manifestPath: fullManifestPath, apply: true });
  assert.ok(second.duplicate >= first.added, 'restart must not re-add interrupted-run records');
  assert.ok(second.rejected.some((r) => r.reason === 'MALFORMED_JSON'
    && r.relativePath.includes(LEGACY_JOB_QUEUED)));

  // A third full run adds nothing: migration restart is idempotent.
  const third = await backfillHistory(ctx, { manifestPath: fullManifestPath, apply: true });
  assert.equal(third.added, 0);
  assert.ok(third.duplicate >= second.added + first.added);

  // Authoritative record count matches the distinct synthetic questions:
  // 2 questions in attempt-1 + 1 reused question in attempt-2 = 3 observations.
  const { items } = listRecords(ctx, 'observations', { limit: 100 });
  assert.equal(items.length, 3);
  assert.ok(items.every((r) => r.status === 'recorded'));
});

test('store meta records input/output schema versions and the reader-compatibility marker; old writers are rejected', () => {
  const meta = writeStoreMeta(ctx, { inputManifest: backfillManifest });
  assert.equal(meta.kind, STORE_META_KIND);
  assert.equal(meta.storeSchemaVersion, STORE_COMPAT.storeSchemaVersion);
  assert.equal(meta.minReaderVersion, STORE_COMPAT.minReaderVersion);
  assert.equal(meta.minWriterVersion, STORE_COMPAT.minWriterVersion);
  assert.equal(meta.input.kind, MANIFEST_KIND);
  assert.equal(meta.input.entries, backfillManifest.entries.length);
  assert.deepEqual(meta.adapterVersions, backfillManifest.adapterVersions);
  const readBack = readStoreMeta(ctx);
  assert.deepEqual(readBack, meta);
  // A current writer may proceed; an unsupported OLD writer is refused.
  assert.deepEqual(
    assertWriterCompatible(ctx, { writerSchemaVersion: STORE_COMPAT.storeSchemaVersion }),
    { storeSchemaVersion: 1, minWriterVersion: 1 });
  assert.throws(
    () => assertWriterCompatible(ctx, { writerSchemaVersion: 0 }),
    (err) => err.code === 'WRITER_INCOMPATIBLE');
});

test('indexes can be discarded and rebuilt without losing authoritative records', async () => {
  const built = await rebuildIndexes(ctx, { apply: true });
  assert.ok(built.generation);
  assert.equal(built.counts.observations, 3);
  const indexed = listRecords(ctx, 'observations', { limit: 100 });
  assert.equal(indexed.generation, built.generation);
  assert.equal(indexed.items.length, 3);

  // DISCARD all index generations: authoritative revision files alone still
  // serve every record through the deterministic unindexed scan.
  const indexesDir = join(fixture.dataRoot, 'data', 'auto', 'learning', 'indexes');
  rmSync(indexesDir, { recursive: true, force: true });
  const unindexed = listRecords(ctx, 'observations', { limit: 100 });
  assert.equal(unindexed.generation, 'unindexed');
  assert.equal(unindexed.items.length, 3);

  // Rebuild produces a fresh usable generation with identical records.
  const rebuilt = await rebuildIndexes(ctx, { apply: true });
  assert.notEqual(rebuilt.generation, built.generation);
  assert.equal(listRecords(ctx, 'observations', { limit: 100 }).items.length, 3);
});

test('a failed index generation leaves the previous generation usable', async () => {
  const indexesDir = join(fixture.dataRoot, 'data', 'auto', 'learning', 'indexes');
  const pointer = JSON.parse(readFileSync(join(indexesDir, 'current.json'), 'utf-8'));
  // Simulate a generation build that CRASHED before the atomic pointer swap:
  // a partial directory exists but current.json still names the old one.
  const failedDir = join(indexesDir, 'gen-failed-partial');
  mkdirSync(failedDir, { recursive: true });
  writeFileSync(join(failedDir, 'observations.json'), '{ truncated garbage');
  const after = JSON.parse(readFileSync(join(indexesDir, 'current.json'), 'utf-8'));
  assert.equal(after.generation, pointer.generation, 'pointer untouched by the failed build');
  const page = listRecords(ctx, 'observations', { limit: 100 });
  assert.equal(page.generation, pointer.generation);
  assert.equal(page.items.length, 3, 'previous generation still serves all records');
  rmSync(failedDir, { recursive: true, force: true });
});

test('rollback rehearsal: safe boundary, parked outcomes, features disabled, verified data restore, tracker recheck', async () => {
  // 1. Stop reviewer/application writers at an approved safe boundary. In
  //    this rehearsal the boundary is a synthetic marker recorded BEFORE any
  //    restore; no live process exists inside the fixture to stop.
  const rollbackRoot = join(fixture.root, 'rollback');
  mkdirSync(rollbackRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(rollbackRoot, 'boundary.json'), JSON.stringify({
    stoppedWriters: ['reviewer', 'apply-worker'], boundary: 'between-attempts',
    recordedAt: ctx.now().toISOString(),
  }));

  // 2. Unresolved external outcomes stay PARKED: an attempt whose submission
  //    outcome is unknown is not resolved, deleted or retried by rollback.
  await commitRecord(ctx, 'attempts', 'attempt-unknown-outcome', {
    applicationId: LEGACY_JOB_SUBMITTED, attemptId: 'attempt-unknown-outcome',
  }, { expectedRevision: 0, status: 'unknown', sourceIds: [] });

  // 3. Disable new features in the restored configuration.
  const restoredData = join(rollbackRoot, 'data-root');
  const restore = restoreBackup({ backupRoot, destRoot: restoredData });
  assert.equal(restore.verified, true);
  writeFileSync(join(restoredData, 'config', 'learning.yml'),
    'schema_version: 1\nenabled: false\nmode: shadow\n');
  const restoredCtx = createLearningContext({
    codeRoot: fixture.codeRoot, dataRoot: restoredData, now: ctx.now,
  });
  assert.equal(readLearningConfig(restoredCtx).enabled, false,
    'new features disabled in the rolled-back config');

  // 4. Compatible data restored with verified hashes (step 3's restoreBackup)
  //    and the canonical tracker rechecked against the restored jobs: the
  //    submitted job is still submitted with its pending sync task intact.
  const restoredJob = JSON.parse(readFileSync(
    join(restoredData, 'data', 'auto', 'jobs', `${LEGACY_JOB_SUBMITTED}.json`), 'utf-8'));
  const syntheticTracker = [
    { num: 1, company: 'synthco', status: 'Submitted', urlKey: LEGACY_JOB_SUBMITTED },
    { num: 2, company: 'oldco', status: 'Evaluated', urlKey: LEGACY_JOB_QUEUED },
  ];
  const trackerRow = syntheticTracker.find((r) => r.urlKey === restoredJob.urlKey);
  assert.equal(trackerRow.status, 'Submitted');
  assert.equal(restoredJob.stage, 'submitted');
  assert.equal(restoredJob.trackerSync.status, 'pending', 'pending tracker update survives rollback');

  // 5. NEVER restore an old "queued" snapshot over a newly submitted job.
  const oldQueuedSnapshot = { urlKey: LEGACY_JOB_SUBMITTED, stage: 'queued' };
  assert.throws(
    () => guardSnapshotRestore({ current: restoredJob, snapshot: oldQueuedSnapshot }),
    (err) => err.code === 'ROLLBACK_UNSAFE');
  // Restoring a queued snapshot over a still-queued job is allowed.
  assert.deepEqual(
    guardSnapshotRestore({
      current: { stage: 'queued' }, snapshot: { stage: 'queued' },
    }),
    { allowed: true });

  // The parked unknown-outcome attempt is still parked after the rehearsal.
  const parked = getRecord(ctx, 'attempts', 'attempt-unknown-outcome');
  assert.equal(parked.status, 'unknown');
});

test('operator README documents irreversible external effects of a rollback', () => {
  const readmePath = new URL('../learning/README.md', import.meta.url);
  const text = readFileSync(readmePath, 'utf-8');
  for (const phrase of [
    'cannot unsend',          // applications cannot be unsent
    'employer account',       // accounts cannot be deleted by local restore
    'retract',                // messages cannot be retracted
    'publication',            // public-profile publications cannot be undone
  ]) {
    assert.ok(text.toLowerCase().includes(phrase.toLowerCase()),
      `operator README must document: ${phrase}`);
  }
  // The suite performed NO live rollback: everything above happened inside
  // the mkdtemp fixture root.
  assert.ok(fixture.root.startsWith(realpathSync(tmpdir()) + sep));
});
