// auto/test/learning-store.test.mjs — T02: versioned storage, locks, indexes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, realpathSync,
  readdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext, learningDataRoot } from '../learning/context.mjs';
import { getRecord, listRecords, commitRecord, rebuildIndexes } from '../learning/store.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

let fixture;
let ctx;
before(() => {
  fixture = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
});
after(() => fixture.cleanup());

test('all store writes land under the fixture root only', async () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  const envelope = await commitRecord(ctx, 'observations', 'obs-seed-1', {
    questionId: 'q-notice-1',
    originalText: 'What is your notice period?',
    fieldType: 'text',
    coverage: 'observed',
    answerDisposition: 'unanswered',
  }, { expectedRevision: 0, status: 'recorded', sourceIds: [] });
  assert.equal(envelope.revision, 1);
  const written = join(learningDataRoot(ctx), 'records', 'observations', 'obs-seed-1', '1.json');
  assert.ok(existsSync(written));
  assert.ok(written.startsWith(fixture.dataRoot + sep));
  assert.ok(!existsSync(join(repoRoot, 'data', 'auto', 'learning')),
    'no learning store may appear in the live checkout');
});

test('a nonempty fixture record round-trips: create at expectedRevision 0, revision starts at 1', async () => {
  const envelope = await commitRecord(ctx, 'families', 'family-salary', {
    label: 'Salary expectation', questionIds: ['q-salary-1'], scope: { country: 'DE' },
  }, { expectedRevision: 0, status: 'proposed', sourceIds: ['obs-seed-1'] });
  assert.equal(envelope.revision, 1);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.createdAt, '2026-10-11T00:00:00.000Z');
  const read = getRecord(ctx, 'families', 'family-salary');
  assert.deepEqual(read, envelope);
  assert.equal(read.data.label, 'Salary expectation');
  assert.notEqual(Object.keys(read.data).length, 0, 'fixture record must be nonempty');
});

test('sequential update bumps revision; earlier revisions stay immutable', async () => {
  const r2 = await commitRecord(ctx, 'families', 'family-salary', {
    label: 'Salary expectation (base)', questionIds: ['q-salary-1'], scope: { country: 'DE' },
  }, { expectedRevision: 1, status: 'approved', sourceIds: [] });
  assert.equal(r2.revision, 2);
  assert.equal(r2.createdAt, '2026-10-11T00:00:00.000Z', 'createdAt is preserved from revision 1');
  const dir = join(learningDataRoot(ctx), 'records', 'families', 'family-salary');
  const rev1 = JSON.parse(readFileSync(join(dir, '1.json'), 'utf-8'));
  assert.equal(rev1.data.label, 'Salary expectation', 'revision 1 unchanged');
  assert.equal(getRecord(ctx, 'families', 'family-salary').revision, 2);
});

test('two writers with the same expected revision: exactly one wins, the other gets REVISION_CONFLICT', async () => {
  await commitRecord(ctx, 'families', 'family-notice', {
    label: 'Notice', questionIds: [], scope: {},
  }, { expectedRevision: 0, status: 'proposed', sourceIds: [] });

  const outcomes = await Promise.allSettled([
    commitRecord(ctx, 'families', 'family-notice', { label: 'Notice period', questionIds: [], scope: {} }, { expectedRevision: 1, status: 'approved', sourceIds: [] }),
    commitRecord(ctx, 'families', 'family-notice', { label: 'Notice period revised', questionIds: [], scope: {} }, { expectedRevision: 1, status: 'approved', sourceIds: [] }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const latest = getRecord(ctx, 'families', 'family-notice');
  assert.equal(latest.revision, 2, 'exactly one accepted revision');
});

test('stale create and duplicate sequential commits reject with REVISION_CONFLICT', async () => {
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-notice', { label: 'x', questionIds: [], scope: {} }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'REVISION_CONFLICT');
  // Identical payload, re-sent with the already-consumed expectedRevision.
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-notice', { label: 'Notice period', questionIds: [], scope: {} }, { expectedRevision: 1, status: 'approved', sourceIds: [] }),
    (err) => err.code === 'REVISION_CONFLICT' && err.actualRevision === 2);
});

test('missing is null; corrupt JSON is a loud CORRUPT_RECORD, never null', async () => {
  assert.equal(getRecord(ctx, 'answers', 'nope-never-written'), null);
  await commitRecord(ctx, 'blockers', 'blk-1', { type: 'captcha', applicationId: 'app-1' },
    { expectedRevision: 0, status: 'open', sourceIds: [] });
  const path = join(learningDataRoot(ctx), 'records', 'blockers', 'blk-1', '1.json');
  writeFileSync(path, '{not json', { mode: 0o600 });
  assert.throws(() => getRecord(ctx, 'blockers', 'blk-1'), (err) => err.code === 'CORRUPT_RECORD');
});

test('future schema versions are refused, not permissively parsed', async () => {
  const dir = join(learningDataRoot(ctx), 'records', 'procedures', 'proc-future');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1.json'), JSON.stringify({
    schemaVersion: 2, id: 'proc-future', revision: 1,
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z',
    sourceIds: [], status: 'candidate', data: { scope: 'x' },
  }));
  assert.throws(() => getRecord(ctx, 'procedures', 'proc-future'),
    (err) => err.code === 'UNSUPPORTED_SCHEMA_VERSION');
});

test('traversal, unknown collections and symlink escapes are rejected', async () => {
  await assert.rejects(
    commitRecord(ctx, 'families', '../evil', { label: 'x', questionIds: [], scope: {} }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'INVALID_ID');
  await assert.rejects(
    commitRecord(ctx, 'families', 'a/b', { label: 'x', questionIds: [], scope: {} }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'INVALID_ID');
  await assert.rejects(
    commitRecord(ctx, 'credentials', 'cred-1', { label: 'x' }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'INVALID_COLLECTION');
  assert.throws(() => getRecord(ctx, 'families', '..'), (err) => err.code === 'INVALID_ID');
  // Symlinked entity directory pointing outside the learning root.
  const outside = join(fixture.root, 'output', 'escape-target');
  mkdirSync(outside, { recursive: true });
  const linkPath = join(learningDataRoot(ctx), 'records', 'families', 'link-escape');
  mkdirSync(join(learningDataRoot(ctx), 'records', 'families'), { recursive: true });
  symlinkSync(outside, linkPath);
  assert.throws(() => getRecord(ctx, 'families', 'link-escape'), (err) => err.code === 'FORBIDDEN_PATH');
  await assert.rejects(
    commitRecord(ctx, 'families', 'link-escape', { label: 'x', questionIds: [], scope: {} }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'FORBIDDEN_PATH');
  rmSync(linkPath);
});

test('prototype keys, oversized values and unknown data keys are rejected', async () => {
  const protoData = JSON.parse('{"label":"x","questionIds":[],"scope":{"__proto__":{"polluted":1}}}');
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-proto', protoData, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'FORBIDDEN_KEY');
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-big', { label: 'y'.repeat(20001), questionIds: [], scope: {} }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'LIMIT_EXCEEDED');
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-unknown', { label: 'x', questionIds: [], scope: {}, surprise: 1 }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'SCHEMA_VALIDATION');
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-nan', { label: 'x', questionIds: [], scope: { weight: Number.NaN } }, { expectedRevision: 0, status: 'proposed', sourceIds: [] }),
    (err) => err.code === 'SCHEMA_VALIDATION');
  await assert.rejects(
    commitRecord(ctx, 'families', 'family-status', { label: 'x', questionIds: [], scope: {} }, { expectedRevision: 0, status: 'not-a-status', sourceIds: [] }),
    (err) => err.code === 'SCHEMA_VALIDATION');
});

test('index generations: build, paginate, pin revisions, stale cursor refuses', async () => {
  const dryRun = await rebuildIndexes(ctx, { apply: false });
  assert.equal(dryRun.generation, null, 'apply:false must not swap indexes');
  assert.ok(!existsSync(join(learningDataRoot(ctx), 'indexes', 'current.json')));

  const built = await rebuildIndexes(ctx, { apply: true });
  assert.ok(built.generation);
  assert.equal(built.counts.families, 2, 'family-salary and family-notice');
  assert.equal(built.counts.observations, 1);
  assert.ok(built.errors.some((e) => e.code === 'CORRUPT_RECORD'), 'corrupt blk-1 surfaces as an error');
  assert.ok(built.errors.some((e) => e.code === 'UNSUPPORTED_SCHEMA_VERSION'), 'future-version record surfaces');

  const page1 = listRecords(ctx, 'families', { limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.equal(page1.generation, built.generation);
  assert.ok(page1.nextCursor);
  const page2 = listRecords(ctx, 'families', { cursor: page1.nextCursor, limit: 1 });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextCursor, null);
  const allIds = [...page1.items, ...page2.items].map((e) => e.id).sort();
  assert.deepEqual(allIds, ['family-notice', 'family-salary']);

  // A commit after the build is invisible until rebuild: the generation pins
  // its input revisions, so readers see the old complete generation.
  await commitRecord(ctx, 'families', 'family-salary', {
    label: 'Salary expectation (total comp separate)', questionIds: ['q-salary-1'], scope: { country: 'DE' },
  }, { expectedRevision: 2, status: 'approved', sourceIds: [] });
  const pinned = listRecords(ctx, 'families', { limit: 10 });
  const salary = pinned.items.find((e) => e.id === 'family-salary');
  assert.equal(salary.revision, 2, 'old generation serves the pinned revision, not the new rev 3');

  const rebuilt = await rebuildIndexes(ctx, { apply: true });
  assert.notEqual(rebuilt.generation, built.generation);
  assert.throws(() => listRecords(ctx, 'families', { cursor: page1.nextCursor }),
    (err) => err.code === 'REFRESH_REQUIRED');
  const fresh = listRecords(ctx, 'families', { limit: 10 });
  assert.equal(fresh.items.find((e) => e.id === 'family-salary').revision, 3);

  // status filter
  const approved = listRecords(ctx, 'families', { filters: { status: 'approved' } });
  assert.ok(approved.items.every((e) => e.status === 'approved'));
});

test('deleting indexes and rebuilding yields the same counts and query results', async () => {
  const beforeList = listRecords(ctx, 'families', { limit: 50 });
  const beforeIds = beforeList.items.map((e) => `${e.id}@${e.revision}`).sort();
  rmSync(join(learningDataRoot(ctx), 'indexes'), { recursive: true, force: true });
  const rebuilt = await rebuildIndexes(ctx, { apply: true });
  assert.equal(rebuilt.counts.families, beforeList.items.length);
  const afterList = listRecords(ctx, 'families', { limit: 50 });
  assert.deepEqual(afterList.items.map((e) => `${e.id}@${e.revision}`).sort(), beforeIds);
  assert.deepEqual(afterList.items.map((e) => e.data.label).sort(),
    beforeList.items.map((e) => e.data.label).sort());
});

test('revision files are immutable artifacts: nothing rewrites them on list/get', async () => {
  const dir = join(learningDataRoot(ctx), 'records', 'families', 'family-salary');
  const beforeFiles = readdirSync(dir).sort();
  const beforeBytes = beforeFiles.map((f) => readFileSync(join(dir, f), 'utf-8'));
  getRecord(ctx, 'families', 'family-salary');
  listRecords(ctx, 'families', { limit: 50 });
  await rebuildIndexes(ctx, { apply: false });
  assert.deepEqual(readdirSync(dir).sort(), beforeFiles);
  assert.deepEqual(beforeFiles.map((f) => readFileSync(join(dir, f), 'utf-8')), beforeBytes);
});
