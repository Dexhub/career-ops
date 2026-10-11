// auto/test/learning-backfill.test.mjs — T05: repeatable history backfill.
// Runs entirely against the T01 fixture root (CAREER_OPS_ROOT = mkdtemp dir);
// never reads or writes live data. CLI subprocesses inherit the fixture env.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createLearningFixture } from './helpers/learning.mjs';
import { createLearningContext, learningDataRoot } from '../learning/context.mjs';
import { listRecords } from '../learning/store.mjs';
import {
  backfillHistory, buildBackfillManifest, captureAttempt, discoverHistory,
} from '../learning/evidence.mjs';
import { formatApplicationAnswersSection } from '../../application-answers.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LEARN_CLI = join(REPO_ROOT, 'auto', 'learn.mjs');

let fx;
let ctx;
const originalHashes = new Map(); // relativePath -> sha256, for "originals unchanged"

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hashOf = (rel) => sha256(readFileSync(join(fx.root, rel)));

/** Write a fixture source; backdate mtime so it reads as settled. */
function seed(rel, content, { settled = true } = {}) {
  const abs = join(fx.root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  if (settled) {
    const old = new Date(Date.now() - 120_000);
    utimesSync(abs, old, old);
  }
  return abs;
}

function runCli(args) {
  const res = spawnSync(process.execPath, [LEARN_CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: fx.root },
    encoding: 'utf-8',
  });
  return res;
}

const ARRAY_ANSWERS = JSON.stringify([
  { label: 'Notice period', value: '30 days', source: 'profile' },
  { label: 'Willing to relocate', value: 'Yes', source: 'profile' },
]);
const OBJECT_ANSWERS = JSON.stringify({
  Contact: {
    Email: { value: 'sample@example.invalid', source: 'profile' },
    Phone: '000-0000',
  },
});

before(() => {
  fx = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fx.codeRoot, dataRoot: fx.root, now: () => new Date() });

  // Array and keyed-object audit attempts (the array/object mix).
  seed('output/001-acme-staff-engineer/audit/attempt-1/answers.json', ARRAY_ANSWERS);
  seed('output/002-globex-vp-engineering/audit/attempt-1/answers.json', OBJECT_ANSWERS);
  // A missing audit: attempt directory with no answers.json.
  mkdirSync(join(fx.root, 'output/003-initech-cto/audit/attempt-1'), { recursive: true });
  // A live-changing (unsettled) artifact: fresh mtime, inside the settle window.
  seed('output/004-hooli-cfo/audit/attempt-1/answers.json',
    JSON.stringify([{ label: 'Still being written', value: 'x', source: 'profile' }]),
    { settled: false });
  // A symlinked application directory escaping the root: refused, never read.
  const outside = join(realpathSync(tmpdir()), `career-escape-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(fx.root, 'output/005-evil-escape'));

  // A report with an Application Answers section AND a Block H draft section.
  const section = formatApplicationAnswersSection({
    state: 'filled',
    date: '2026-01-01',
    freeText: [{ question: 'Why Acme?', answer: 'Because.' }],
    selections: [{ question: 'Remote?', selection: 'Yes' }],
  });
  seed('reports/001-acme-2026-01-01.md',
    `# Report 001 — Acme\n\n${section}\n## H) Draft Application Answers (draft)\n\n**Years of Go experience?**\nSeven years.\n`);
  // A report with no answers section at all: absent data, not parser success.
  seed('reports/900-nowhere-2026-01-01.md', '# Report 900\n\nNo answers here.\n');

  for (const rel of [
    'output/001-acme-staff-engineer/audit/attempt-1/answers.json',
    'reports/001-acme-2026-01-01.md',
    'reports/900-nowhere-2026-01-01.md',
  ]) originalHashes.set(rel, hashOf(rel));
});

after(() => fx.cleanup());

test('FIRST: fixture isolation — CAREER_OPS_ROOT names the helper temp dir', () => {
  assert.equal(process.env.CAREER_OPS_ROOT, fx.root);
  assert.ok(fx.root.startsWith(realpathSync(tmpdir())));
  assert.notEqual(realpathSync(process.env.CAREER_OPS_ROOT), realpathSync(REPO_ROOT));
});

test('discovery enumerates audits/reports and flags every gap honestly', () => {
  const { entries, gaps } = discoverHistory(ctx);
  const byPath = Object.fromEntries(entries.map((e) => [e.relativePath, e]));
  const audit1 = byPath['output/001-acme-staff-engineer/audit/attempt-1/answers.json'];
  assert.ok(audit1);
  assert.equal(audit1.adapter, 'audit-answers');
  assert.equal(audit1.settled, true);
  assert.equal(audit1.linked.applicationId, '001-acme-staff-engineer');
  assert.equal(audit1.linked.attemptId, 'attempt-1');
  assert.ok(typeof audit1.sha256 === 'string' && audit1.sha256.length === 64);
  assert.ok(byPath['output/002-globex-vp-engineering/audit/attempt-1/answers.json']);
  const report = byPath['reports/001-acme-2026-01-01.md'];
  assert.ok(report);
  assert.deepEqual(report.sections, ['application_answers', 'draft_block_h']);
  assert.equal(report.linked.applicationId, '001-acme-staff-engineer');
  // Unsettled artifact is listed but flagged, never silently importable.
  assert.equal(byPath['output/004-hooli-cfo/audit/attempt-1/answers.json'].settled, false);
  const gapTypes = gaps.map((g) => `${g.type}:${g.path}`);
  assert.ok(gapTypes.includes('missing_answers:output/003-initech-cto/audit/attempt-1'));
  assert.ok(gapTypes.includes('report_without_answers:reports/900-nowhere-2026-01-01.md'));
  assert.ok(gapTypes.some((g) => g.startsWith('unsettled:output/004-hooli-cfo')));
  assert.ok(gapTypes.includes('symlink_refused:output/005-evil-escape'));
});

test('CLI inspect --json is read-only and reports counts', () => {
  const res = runCli(['inspect', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.entries, 4); // 2 audits + 1 unsettled audit + 1 report
  assert.ok(out.gapsByType.missing_answers >= 1);
  assert.ok(!existsSync(learningDataRoot(ctx)), 'inspect must not create the store');
});

test('CLI backfill --dry-run writes only the requested artifact, never the store', () => {
  const outPath = join(fx.root, 'backfill-preview.json');
  const res = runCli(['backfill', '--dry-run', '--out', outPath]);
  assert.equal(res.status, 0, res.stderr);
  const manifest = JSON.parse(readFileSync(outPath, 'utf-8'));
  assert.equal(manifest.kind, 'learning-backfill-manifest');
  assert.equal(manifest.rootIdentity.dataRootReal, realpathSync(fx.root));
  assert.equal(manifest.entries.length, 4);
  assert.ok(manifest.entries.every((e) => typeof e.sha256 === 'string' && typeof e.bytes === 'number'
    && typeof e.adapter === 'string' && typeof e.adapterVersion === 'number'
    && typeof e.settled === 'boolean' && 'applicationId' in e.linked));
  assert.ok(!existsSync(learningDataRoot(ctx)), 'dry run must not create the store');
  // Dry run refuses an --out inside the learning store.
  const bad = runCli(['backfill', '--dry-run', '--out', join(learningDataRoot(ctx), 'x.json')]);
  assert.equal(bad.status, 1);
  assert.ok(!existsSync(learningDataRoot(ctx)));
});

test('crash mid-batch then rerun: resumed import adds only remaining records', async () => {
  // Keep 004 inside the settle window so the manifest deterministically
  // records it as unsettled regardless of elapsed test wall time.
  seed('output/004-hooli-cfo/audit/attempt-1/answers.json',
    JSON.stringify([{ label: 'Still being written', value: 'x', source: 'profile' }]),
    { settled: false });
  const manifest = buildBackfillManifest(ctx);
  const partialPath = join(fx.root, 'manifest-partial.json');
  const fullPath = join(fx.root, 'manifest-full.json');
  writeFileSync(partialPath, JSON.stringify({
    ...manifest,
    entries: manifest.entries.filter((e) => e.relativePath.includes('001-acme-staff-engineer')),
  }));
  writeFileSync(fullPath, JSON.stringify(manifest));

  // "Crash" after the first entry of the batch: only 001's audit imported.
  const run1 = await backfillHistory(ctx, { manifestPath: partialPath, apply: true });
  assert.equal(run1.added, 2);
  assert.equal(run1.duplicate, 0);
  assert.equal(run1.distinctJobs, 1);

  // Rerun with the full manifest: only the remaining records are added.
  const run2 = await backfillHistory(ctx, { manifestPath: fullPath, apply: true });
  assert.equal(run2.duplicate, 2); // 001's two rows, not re-added
  assert.equal(run2.added, 5); // 002's two rows + report's three
  assert.equal(run2.distinctJobs, 2); // no duplicated job counts
  assert.equal(run2.distinctCompanySlugs, 2); // acme, globex
  // The unsettled artifact is a visible rejection, never a silent skip.
  assert.ok(run2.rejected.some((r) => r.relativePath.includes('004-hooli') && r.reason === 'UNSETTLED_AT_PREVIEW'));
  // Coverage gaps from the preview travel with the summary.
  assert.ok(run2.coverageGaps.some((g) => g.type === 'report_without_answers'));

  // Third run: fully idempotent — nothing added, counts stable.
  const run3 = await backfillHistory(ctx, { manifestPath: fullPath, apply: true });
  assert.equal(run3.added, 0);
  assert.equal(run3.duplicate, 7);
  assert.equal(run3.distinctJobs, run2.distinctJobs);
  assert.equal(run3.distinctCompanySlugs, run2.distinctCompanySlugs);

  const { items } = listRecords(ctx, 'observations', { limit: 500 });
  assert.equal(items.length, 7);
});

test('generated drafts never become observed employer questions', () => {
  const { items } = listRecords(ctx, 'observations', { limit: 500 });
  const draft = items.find((r) => r.data.originalText === 'Years of Go experience?');
  assert.ok(draft, 'Block H draft question was imported');
  assert.equal(draft.data.coverage, 'unknown'); // never 'observed'
  assert.equal(draft.data.captureMethod, 'report_section');
  const sectionObs = items.find((r) => r.data.originalText === 'Why Acme?');
  assert.equal(sectionObs.data.coverage, 'partially_observed');
  const liveAudit = items.find((r) => r.data.originalText === 'Notice period');
  assert.equal(liveAudit.data.coverage, 'observed');
  assert.equal(liveAudit.data.captureMethod, 'legacy_array');
  const keyed = items.find((r) => r.data.originalText === 'Email');
  assert.equal(keyed.data.captureMethod, 'legacy_object');
  // The report with no answers produced zero observations.
  assert.ok(!items.some((r) => r.data.sourceArtifact.relativePath.includes('900-nowhere')));
  // No answer values are stored in observations at all.
  assert.ok(items.every((r) => !('value' in r.data)));
});

test('duplicate sources in one manifest do not duplicate records or counts', async () => {
  const manifest = buildBackfillManifest(ctx);
  const entry = manifest.entries.find((e) => e.relativePath.includes('001-acme-staff-engineer'));
  const dupPath = join(fx.root, 'manifest-dup.json');
  writeFileSync(dupPath, JSON.stringify({ ...manifest, entries: [entry, entry] }));
  const run = await backfillHistory(ctx, { manifestPath: dupPath, apply: true });
  assert.equal(run.added, 0);
  assert.equal(run.duplicate, 4); // 2 rows x 2 listings, all deduplicated
  assert.equal(run.distinctJobs, 1);
  assert.equal(listRecords(ctx, 'observations', { limit: 500 }).items.length, 7);
});

test('an overwritten legacy directory is rejected, not silently reimported', async () => {
  const manifest = buildBackfillManifest(ctx);
  const keep = manifest.entries.filter((e) =>
    e.relativePath.includes('001-acme-staff-engineer') || e.relativePath.includes('002-globex'));
  const path = join(fx.root, 'manifest-overwrite.json');
  writeFileSync(path, JSON.stringify({ ...manifest, entries: keep }));
  // History overwritten between preview and apply.
  seed('output/002-globex-vp-engineering/audit/attempt-1/answers.json',
    JSON.stringify([{ label: 'Rewritten history', value: 'nope', source: 'profile' }]));
  const run = await backfillHistory(ctx, { manifestPath: path, apply: true });
  assert.deepEqual(
    run.rejected.map((r) => `${r.reason}:${r.relativePath}`),
    ['SOURCE_CHANGED:output/002-globex-vp-engineering/audit/attempt-1/answers.json'],
  );
  assert.equal(run.added, 0, 'nothing from the overwritten source was imported');
  assert.equal(listRecords(ctx, 'observations', { limit: 500 }).items.length, 7);
});

test('a source missing at apply time is a visible rejection', async () => {
  seed('output/006-umbrella-ceo/audit/attempt-1/answers.json',
    JSON.stringify([{ label: 'Transient', value: 'x', source: 'profile' }]));
  const manifest = buildBackfillManifest(ctx);
  const entry = manifest.entries.find((e) => e.relativePath.includes('006-umbrella'));
  assert.ok(entry);
  const path = join(fx.root, 'manifest-missing.json');
  writeFileSync(path, JSON.stringify({ ...manifest, entries: [entry] }));
  rmSync(join(fx.root, entry.relativePath));
  const run = await backfillHistory(ctx, { manifestPath: path, apply: true });
  assert.equal(run.added, 0);
  assert.ok(run.rejected.some((r) => r.reason === 'SOURCE_MISSING' && r.relativePath === entry.relativePath));
});

test('a manifest from a different data root is refused', async () => {
  const manifest = buildBackfillManifest(ctx);
  const path = join(fx.root, 'manifest-foreign.json');
  writeFileSync(path, JSON.stringify({
    ...manifest, rootIdentity: { dataRootReal: '/somewhere/else' },
  }));
  await assert.rejects(
    backfillHistory(ctx, { manifestPath: path, apply: true }),
    (err) => err.code === 'ROOT_MISMATCH',
  );
});

test('captureAttempt: dry count, apply, then idempotent duplicates; unsettled refused', async () => {
  seed('output/007-stark-cto/audit/attempt-1/answers.json',
    JSON.stringify([
      { label: 'Security clearance', value: 'None', source: 'profile' },
      { label: 'Start date', value: '2026-11-01', source: 'profile' },
    ]));
  const attemptDir = 'output/007-stark-cto/audit/attempt-1';
  const dry = await captureAttempt(ctx, { attemptDir, apply: false });
  assert.equal(dry.added, 2);
  assert.equal(listRecords(ctx, 'observations', { limit: 500 }).items.length, 7, 'dry run wrote nothing');
  const applied = await captureAttempt(ctx, { attemptDir: join(fx.root, attemptDir), apply: true });
  assert.equal(applied.added, 2);
  const again = await captureAttempt(ctx, { attemptDir, apply: true });
  assert.equal(again.added, 0);
  assert.equal(again.duplicate, 2);
  // A live-changing file is refused as unsettled, visibly.
  writeFileSync(join(fx.root, 'output/004-hooli-cfo/audit/attempt-1/answers.json'),
    JSON.stringify([{ label: 'Still being written', value: 'x', source: 'profile' }]));
  const live = await captureAttempt(ctx, { attemptDir: 'output/004-hooli-cfo/audit/attempt-1', apply: true });
  assert.equal(live.added, 0);
  assert.ok(live.rejected.some((r) => r.reason === 'UNSETTLED'));
  // A missing audit is a coverage gap, not an import.
  const missing = await captureAttempt(ctx, { attemptDir: 'output/003-initech-cto/audit/attempt-1', apply: true });
  assert.equal(missing.added, 0);
  assert.ok(missing.coverage.gaps.some((g) => g.type === 'missing_answers'));
  // Paths outside the approved audit roots are refused.
  await assert.rejects(
    captureAttempt(ctx, { attemptDir: 'config/learning.yml', apply: false }),
    (err) => err.code === 'FORBIDDEN_PATH',
  );
});

test('original artifacts are unchanged after every import', () => {
  for (const [rel, hash] of originalHashes) {
    assert.equal(hashOf(rel), hash, `${rel} must be byte-identical after import`);
  }
});

test('CLI rebuild --verify validates the store it just indexed', () => {
  const res = runCli(['rebuild', '--verify']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.verified, true);
  assert.equal(out.counts.observations, 9); // 7 backfilled + 2 captured
});
