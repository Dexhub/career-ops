// auto/test/learning-freshness.test.mjs — T11: truthful posting dates and the
// shared queue comparator. Runs entirely against the T01 fixture root (temp
// CAREER_OPS_ROOT + CAREER_OPS_DB); never touches live state, never starts an
// application. All values synthetic.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import {
  readJobDates, orderJobs, pipelineRowLabels, classifyDateValue,
  postedAgeDays, freshnessBucket, dateEnrichmentReport,
  ORDER_MODES, FRESHNESS_BUCKETS,
} from '../learning/freshness.mjs';
// Parity REFERENCE only (plan T11): the web parser is imported by the test to
// assert both sides read the same `posted:` label; freshness.mjs itself has no
// runtime dependency on the web app.
import { parseInbox } from '../../web/src/lib/pipeline-table.mjs';

let fx; // fixture: { root, dataRoot, cleanup }
let state; // ../state.mjs, imported only after the fixture env is set
let evalQueue; // ../eval-queue.mjs (pure parsePendingRows only)
let db;

before(async () => {
  fx = createLearningFixture();
  state = await import('../state.mjs');
  evalQueue = await import('../eval-queue.mjs');
  db = await import('../../core/db.mjs');
});
after(() => {
  db.closeDb();
  fx.cleanup();
});

const fixedNow = fixedClock('2026-10-11T12:00:00Z');

// ---------- synthetic fixtures (plan T11 checkbox 1) ----------

const LINES = {
  postedLabel: '- [ ] https://jobs.example/t11/1 | Acme GmbH | Staff Engineer | Berlin | posted: 2026-10-08',
  noPostedLabel: '- [ ] https://jobs.example/t11/2 | Beta AG | Platform Lead | Remote | note: referred',
  shortRow: '- [ ] https://jobs.example/t11/3 | Gamma | SRE',
  futurePosted: '- [ ] https://jobs.example/t11/4 | Delta | CTO | posted: 2027-01-01',
  invalidPosted: '- [ ] https://jobs.example/t11/5 | Epsi | VP | posted: yesterday-ish',
  nakedTimestamp: '- [ ] https://jobs.example/t11/6 | Zeta | Head of Eng | posted: 2026-10-08T09:30',
  colonRole: '- [ ] https://jobs.example/t11/7 | Eta | Engineer: Platform | Munich | posted: 2026-10-07',
};
const historyRow = { firstSeenAt: '2026-10-02T07:00:00.000Z', lastCheckedAt: '2026-10-10T06:00:00.000Z' };
const noPostedLabel = LINES.noPostedLabel;

/** Pickable synthetic job. */
function mkJob(urlKey, over = {}) {
  return {
    urlKey,
    stage: 'resume_ready',
    score: 3,
    attempts: 0,
    priority: 0,
    held: false,
    timestamps: [{ stage: 'discovered', at: '2026-10-01T00:00:00.000Z' }],
    dates: {
      postedAt: null, postedPrecision: null, postedSource: null,
      firstSeenAt: '2026-10-01T00:00:00.000Z', lastCheckedAt: null, repostedAt: null,
    },
    ...over,
  };
}
function withDates(urlKey, dates, over = {}) {
  return mkJob(urlKey, { ...over, dates: { ...mkJob(urlKey).dates, ...dates } });
}

// ---------- 1. fixture isolation (always the first assertion) ----------

test('fixture isolation: everything runs under a scratch root, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fx.dataRoot.startsWith(realTmp + sep), 'fixture must live under tmpdir');
  assert.equal(process.env.CAREER_OPS_ROOT, fx.root);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fx.root + sep), 'DB must be the fixture DB');
});

// ---------- readJobDates ----------

test('posted: label reads as a day-precision publication date, in parity with the web parser', () => {
  const d = readJobDates({ pipelineLine: LINES.postedLabel, historyRow, now: fixedNow });
  assert.equal(d.postedAt, '2026-10-08');
  assert.equal(d.postedPrecision, 'day'); // timezone unknown — stays explicit
  assert.equal(d.postedSource, 'pipeline_label');
  assert.equal(d.firstSeenAt, historyRow.firstSeenAt);
  assert.equal(d.lastCheckedAt, historyRow.lastCheckedAt);
  // Parity reference: web parseInbox extracts the identical posted date.
  const web = parseInbox(LINES.postedLabel)[0];
  assert.equal(web.postedAt, d.postedAt);
  assert.equal(web.role, 'Staff Engineer');
});

test('labels never pollute role/location; colon-y roles are not misread as labels', () => {
  const labels = pipelineRowLabels(LINES.colonRole);
  assert.equal(labels.get('posted'), '2026-10-07');
  const web = parseInbox(LINES.colonRole)[0];
  assert.equal(web.role, 'Engineer: Platform');
  assert.equal(web.location, 'Munich');
  // eval-queue's pending parser keeps company/role clean and surfaces labels
  const row = evalQueue.parsePendingRows(LINES.postedLabel)[0];
  assert.equal(row.company, 'Acme GmbH');
  assert.equal(row.role, 'Staff Engineer');
  assert.equal(row.labels.posted, '2026-10-08');
  assert.equal(row.raw, LINES.postedLabel);
});

test('provider published timestamp wins with timestamp precision; modification date is never a publication date', () => {
  const d = readJobDates({
    pipelineLine: LINES.postedLabel,
    historyRow,
    providerEvidence: { publishedAt: '2026-10-09T08:00:00Z', modifiedAt: '2026-10-10T10:00:00Z' },
    now: fixedNow,
  });
  assert.equal(d.postedAt, '2026-10-09T08:00:00.000Z');
  assert.equal(d.postedPrecision, 'timestamp');
  assert.equal(d.postedSource, 'provider_published');
  // modifiedAt alone must NOT become postedAt
  const modOnly = readJobDates({ historyRow, providerEvidence: { modifiedAt: '2026-10-10T10:00:00Z' }, now: fixedNow });
  assert.equal(modOnly.postedAt, null);
  assert.equal(modOnly.postedSource, null);
});

test('first-seen-only records stay unknown: discovery is never relabeled as publication', () => {
  const d = readJobDates({ pipelineLine: LINES.shortRow, historyRow, now: fixedNow });
  assert.equal(d.postedAt, null);
  assert.equal(d.postedPrecision, null);
  assert.equal(d.firstSeenAt, historyRow.firstSeenAt); // kept, separately
  assert.equal(d.repostedAt, null);
});

test('unknown, future and invalid values read as null, never guesses', () => {
  assert.equal(readJobDates({ pipelineLine: LINES.futurePosted, now: fixedNow }).postedAt, null);
  assert.equal(readJobDates({ pipelineLine: LINES.invalidPosted, now: fixedNow }).postedAt, null);
  assert.equal(readJobDates({ providerEvidence: { publishedAt: '2027-05-05T00:00:00Z' }, now: fixedNow }).postedAt, null);
  assert.equal(readJobDates({ now: fixedNow }).postedAt, null);
  assert.equal(classifyDateValue('2026-13-45', fixedNow()), null);
});

test('timezone-less timestamps degrade to explicit day precision (no fake exact hour)', () => {
  const d = readJobDates({ pipelineLine: LINES.nakedTimestamp, now: fixedNow });
  assert.equal(d.postedAt, '2026-10-08');
  assert.equal(d.postedPrecision, 'day');
  assert.equal(postedAgeDays(d, fixedNow), 3); // whole calendar days only
});

test('changed posting text does not move dates; a later verified publication is a true repost', () => {
  const a = readJobDates({ pipelineLine: LINES.postedLabel, historyRow, now: fixedNow });
  const changedText = LINES.postedLabel.replace('Staff Engineer', 'Staff Engineer (f/m/d)');
  const b = readJobDates({ pipelineLine: changedText, historyRow, now: fixedNow });
  assert.deepEqual(b, a); // text churn alone is not a repost
  // true repost: provider publication postdates OUR first discovery
  const repost = readJobDates({
    historyRow: { firstSeenAt: '2026-09-01T00:00:00.000Z', lastCheckedAt: null },
    providerEvidence: { publishedAt: '2026-10-08T09:00:00Z' },
    now: fixedNow,
  });
  assert.equal(repost.repostedAt, '2026-10-08T09:00:00.000Z');
  assert.equal(repost.postedAt, '2026-10-08T09:00:00.000Z');
  // publication before discovery (the normal case) is NOT a repost
  assert.equal(a.repostedAt, null);
});

// ---------- comparator ----------

test('day precision sorts by calendar day; exact timestamps refine only among themselves', () => {
  const dayJob = withDates('day-job', { postedAt: '2026-10-09', postedPrecision: 'day', firstSeenAt: '2026-10-01T00:00:00.000Z' });
  const tsJob = withDates('ts-job', { postedAt: '2026-10-09T23:00:00.000Z', postedPrecision: 'timestamp', firstSeenAt: '2026-10-02T00:00:00.000Z' });
  // same calendar day + mixed precision -> tie at day level -> first-seen asc
  const mixed = orderJobs([tsJob, dayJob], { maxAttempts: 2, mode: 'fit_then_freshness', now: fixedNow });
  assert.deepEqual(mixed.map((j) => j.urlKey), ['day-job', 'ts-job']);
  // both timestamp precision -> the later hour wins
  const early = withDates('early', { postedAt: '2026-10-09T01:00:00.000Z', postedPrecision: 'timestamp' });
  const late = withDates('late', { postedAt: '2026-10-09T22:00:00.000Z', postedPrecision: 'timestamp' });
  const both = orderJobs([early, late], { maxAttempts: 2, mode: 'fit_then_freshness', now: fixedNow });
  assert.deepEqual(both.map((j) => j.urlKey), ['late', 'early']);
  // a stored future date is unknown, not ultra-fresh
  assert.equal(freshnessBucket({ postedAt: '2027-01-01' }, fixedNow), 'unknown');
});

test('existing mode preserves the legacy pickOrder ordering exactly', () => {
  const mk = (o) => ({ attempts: 0, timestamps: [{ stage: o.stage, at: '2026-01-01T00:00:00Z' }], ...o });
  const jobs = [
    mk({ urlKey: 'a', stage: 'resume_ready', score: 5 }),
    mk({ urlKey: 'b', stage: 'resume_ready', score: 3, priority: 1 }),
    mk({ urlKey: 'c', stage: 'resume_ready', score: 4, held: true }),
    mk({ urlKey: 'd', stage: 'applying', score: 5, attempts: 2 }),
    mk({ urlKey: 'e', stage: 'applying', score: 2, attempts: 1 }),
    mk({ urlKey: 'f', stage: 'queued', score: 5 }),
  ];
  // the legacy comparator, verbatim, as the reference implementation
  const legacy = jobs
    .filter((j) => !j.held && (j.stage === 'resume_ready' || (j.stage === 'applying' && (j.attempts || 0) < 2)))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)
      || (b.score || 0) - (a.score || 0)
      || (a.timestamps?.at(-1)?.at || '').localeCompare(b.timestamps?.at(-1)?.at || ''))
    .map((j) => j.urlKey);
  assert.deepEqual(legacy, ['b', 'a', 'e']);
  assert.deepEqual(orderJobs(jobs, { maxAttempts: 2, mode: 'existing' }).map((j) => j.urlKey), legacy);
  assert.deepEqual(state.pickOrder(jobs, 2).map((j) => j.urlKey), legacy); // default delegation
  assert.deepEqual(ORDER_MODES[0], 'existing');
  assert.throws(() => orderJobs(jobs, { mode: 'newest_first' }), (e) => e.code === 'ORDER_MODE_UNKNOWN');
});

test('modes filter held/ineligible/exhausted first and preserve manual priority', () => {
  const fresh = withDates('fresh', { postedAt: '2026-10-10', postedPrecision: 'day' }, { score: 2 });
  const mid = withDates('mid', { postedAt: '2026-10-06', postedPrecision: 'day' }, { score: 5 });
  const old = withDates('old', { postedAt: '2026-09-01', postedPrecision: 'day' }, { score: 5 });
  const unknown = mkJob('unknown', { score: 5 });
  const bumped = withDates('bumped', { postedAt: '2026-08-01', postedPrecision: 'day' }, { score: 1, priority: 1 });
  const held = withDates('held', { postedAt: '2026-10-11', postedPrecision: 'day' }, { held: true });
  const exhausted = withDates('exhausted', { postedAt: '2026-10-11', postedPrecision: 'day' }, { stage: 'applying', attempts: 2 });
  const parked = withDates('parked', { postedAt: '2026-10-11', postedPrecision: 'day' }, { stage: 'parked' });
  const pool = [old, unknown, mid, fresh, bumped, held, exhausted, parked];

  const freshFirst = orderJobs(pool, { maxAttempts: 2, mode: 'freshness_then_fit', now: fixedNow });
  // priority first, then buckets 0-2 / 3-7 / 8-30(none) / older / unknown; fit inside a bucket
  assert.deepEqual(freshFirst.map((j) => j.urlKey), ['bumped', 'fresh', 'mid', 'old', 'unknown']);
  assert.deepEqual(
    freshFirst.map((j) => freshnessBucket(j.dates, fixedNow)),
    ['older', '0-2', '3-7', 'older', 'unknown'],
  );
  assert.deepEqual(FRESHNESS_BUCKETS, ['0-2', '3-7', '8-30', 'older', 'unknown']);

  const fitFirst = orderJobs(pool, { maxAttempts: 2, mode: 'fit_then_freshness', now: fixedNow });
  // priority, then score desc, then verified posted desc; unknown date after known at equal score
  assert.deepEqual(fitFirst.map((j) => j.urlKey), ['bumped', 'mid', 'old', 'unknown', 'fresh']);
});

test('deterministic ties: first-seen ascending, then stable urlKey; distinct similar-titled requisitions stay distinct', () => {
  const reqA = withDates('greenhouse-acme-100', { postedAt: '2026-10-09', postedPrecision: 'day', firstSeenAt: '2026-10-03T00:00:00.000Z' }, { company: 'Acme', role: 'Staff Engineer' });
  const reqB = withDates('greenhouse-acme-200', { postedAt: '2026-10-09', postedPrecision: 'day', firstSeenAt: '2026-10-03T00:00:00.000Z' }, { company: 'Acme', role: 'Staff Engineer' });
  const seenEarlier = withDates('zzz-earlier', { postedAt: '2026-10-09', postedPrecision: 'day', firstSeenAt: '2026-10-02T00:00:00.000Z' });
  const ranked = orderJobs([reqB, seenEarlier, reqA], { maxAttempts: 2, mode: 'freshness_then_fit', now: fixedNow });
  assert.deepEqual(ranked.map((j) => j.urlKey), ['zzz-earlier', 'greenhouse-acme-100', 'greenhouse-acme-200']);
  assert.equal(new Set(ranked.map((j) => j.urlKey)).size, 3, 'similar-titled requisitions never merge');
});

test('a recent state transition does not reset a job\'s place in the freshness order', () => {
  const steady = withDates('steady', { postedAt: '2026-10-09', postedPrecision: 'day', firstSeenAt: '2026-10-01T00:00:00.000Z' });
  const churned = withDates('churned', { postedAt: '2026-10-09', postedPrecision: 'day', firstSeenAt: '2026-09-20T00:00:00.000Z' }, {
    timestamps: [
      { stage: 'discovered', at: '2026-09-20T00:00:00.000Z' },
      { stage: 'resume_ready', at: '2026-10-11T11:59:00.000Z' }, // just requeued/released
    ],
  });
  const ranked = orderJobs([steady, churned], { maxAttempts: 2, mode: 'freshness_then_fit', now: fixedNow });
  assert.deepEqual(ranked.map((j) => j.urlKey), ['churned', 'steady'], 'first-seen, not the last transition, breaks ties');
});

// ---------- required assertions (plan 03/T11, verbatim) ----------

test('required T11 assertions: freshness ranking, honest unknown dates, UI/worker parity', () => {
  const older = withDates('older-key', { postedAt: '2026-09-15', postedPrecision: 'day', postedSource: 'pipeline_label' }, { score: 5 });
  const newer = withDates('newer-key', { postedAt: '2026-10-10', postedPrecision: 'day', postedSource: 'pipeline_label' }, { score: 3 });
  const unknown = mkJob('unknown-key', { score: 5 });
  // Fixture adapters: HOW the panel and the worker ask for the order — both
  // call the same exported comparator (panel via state.pickOrder delegation,
  // worker via orderJobs), with the SAME explicit options. Not two algorithms.
  const SHARED = { maxAttempts: 2, mode: 'freshness_then_fit', now: fixedNow };
  const panelOrder = (jobs) => state.pickOrder(jobs, SHARED.maxAttempts, SHARED).map((j) => j.urlKey);
  const workerOrder = (jobs) => orderJobs(jobs, SHARED).map((j) => j.urlKey);

  const ranked = orderJobs([older,newer,unknown],{maxAttempts:2,mode:'freshness_then_fit',now:fixedNow});
  assert.equal(ranked[0].urlKey,newer.urlKey);
  assert.equal(readJobDates({pipelineLine:noPostedLabel,historyRow,now:fixedNow}).postedAt,null);
  assert.deepEqual(panelOrder(ranked), workerOrder(ranked));

  // unknown dates are ranked last, never hard-discarded
  assert.deepEqual(ranked.map((j) => j.urlKey), ['newer-key', 'older-key', 'unknown-key']);
});

// ---------- state integration: createJob dates + pickOrder delegation ----------

test('createJob stores scanner-provided publication metadata separately from discovery', () => {
  const { job, created } = state.createJob({
    url: 'https://boards.greenhouse.io/t11fixture/jobs/1',
    company: 'T11 Fixture', role: 'Synthetic Role',
    dates: { postedAt: '2026-10-08', postedPrecision: 'day', postedSource: 'pipeline_label' },
  });
  assert.equal(created, true);
  assert.equal(job.dates.postedAt, '2026-10-08');
  assert.equal(job.dates.postedSource, 'pipeline_label');
  assert.ok(job.dates.firstSeenAt, 'discovery time recorded');
  assert.notEqual(job.dates.firstSeenAt, job.dates.postedAt, 'first seen is not the posting date');
  const reloaded = state.loadJob(job.urlKey);
  assert.deepEqual(reloaded.dates, job.dates);
  // without scanner metadata, publication stays honestly unknown
  const { job: bare } = state.createJob({ url: 'https://boards.greenhouse.io/t11fixture/jobs/2', company: 'T11', role: 'Bare' });
  assert.equal(bare.dates.postedAt, null);
  assert.ok(bare.dates.firstSeenAt);
});

test('pickOrder(jobs,maxAttempts,options) delegates to the pure comparator', () => {
  const jobs = [
    withDates('p1', { postedAt: '2026-10-10', postedPrecision: 'day' }, { score: 1 }),
    withDates('p2', { postedAt: '2026-09-01', postedPrecision: 'day' }, { score: 5 }),
  ];
  for (const mode of ORDER_MODES) {
    assert.deepEqual(
      state.pickOrder(jobs, 2, { mode, now: fixedNow }).map((j) => j.urlKey),
      orderJobs(jobs, { maxAttempts: 2, mode, now: fixedNow }).map((j) => j.urlKey),
      `pickOrder must equal orderJobs for mode ${mode}`,
    );
  }
  // shared explicit options helper used by panel/orchestrator/worker
  assert.deepEqual(state.queueOrderOptions(), { mode: 'existing' });
});

// ---------- dry-run enrichment + rank difference ----------

test('dateEnrichmentReport: dry run enriches nothing on disk and reports rank differences', async () => {
  // two legacy jobs in the fixture DB, driven to pickable stages
  const { job: j1 } = state.createJob({ url: 'https://boards.greenhouse.io/t11legacy/jobs/10', company: 'Legacy1', role: 'R1' });
  const { job: j2 } = state.createJob({ url: 'https://boards.greenhouse.io/t11legacy/jobs/20', company: 'Legacy2', role: 'R2' });
  for (const j of [j1, j2]) {
    state.transition(j, 'evaluated', { score: j.urlKey === j1.urlKey ? 3 : 5 });
    state.transition(j, 'queued');
    state.transition(j, 'resume_ready');
  }
  const jobs = [state.loadJob(j1.urlKey), state.loadJob(j2.urlKey)];
  const lineFor = (job) => (job.urlKey === j1.urlKey
    ? `- [ ] ${job.url} | Legacy1 | R1 | posted: 2026-10-10`
    : null);
  const report = await dateEnrichmentReport({
    jobs, pipelineLineFor: lineFor, now: fixedNow, maxAttempts: 2, compareMode: 'freshness_then_fit',
  });
  assert.equal(report.dryRun, true);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].urlKey, j1.urlKey);
  assert.equal(report.entries[0].after.postedAt, '2026-10-10');
  assert.ok(report.entries[0].after.firstSeenAt, 'firstSeen backfilled from the creation timestamp');
  // rank difference: existing order favors j2 (score 5); freshness favors enriched j1
  assert.deepEqual(report.orderBefore, [j2.urlKey, j1.urlKey]);
  assert.deepEqual(report.orderAfter, [j1.urlKey, j2.urlKey]);
  assert.equal(report.rankDiff.length, 2);
  assert.equal(report.applied, 0);
  // nothing committed: stored records unchanged
  assert.equal(state.loadJob(j1.urlKey).dates.postedAt, null);
});

test('dateEnrichmentReport apply: version recheck via updateJob, manual priority/held preserved, no application started', async () => {
  const { job: ja } = state.createJob({ url: 'https://boards.greenhouse.io/t11apply/jobs/1', company: 'ApplyA', role: 'RA' });
  const { job: jb } = state.createJob({ url: 'https://boards.greenhouse.io/t11apply/jobs/2', company: 'ApplyB', role: 'RB' });
  for (const j of [ja, jb]) {
    state.transition(j, 'evaluated', { score: 4 });
    state.transition(j, 'queued');
    state.transition(j, 'resume_ready');
  }
  await state.updateJob(ja.urlKey, { patch: { priority: 2, held: true } }); // manual operator intent
  const snapshot = [state.loadJob(ja.urlKey), state.loadJob(jb.urlKey)];
  // concurrent change AFTER the snapshot: jb's version moves on
  await state.updateJob(jb.urlKey, { patch: { lastError: 'concurrent touch' } });
  const lineFor = (job) => `- [ ] ${job.url} | X | Y | posted: 2026-10-09`;
  const report = await dateEnrichmentReport({
    jobs: snapshot, pipelineLineFor: lineFor, now: fixedNow, apply: true, updateJob: state.updateJob,
  });
  assert.equal(report.applied, 1);
  assert.deepEqual(report.conflicts.map((c) => ({ urlKey: c.urlKey, code: c.code })),
    [{ urlKey: jb.urlKey, code: 'VERSION_CONFLICT' }], 'stale snapshot refused, not overwritten');
  const a = state.loadJob(ja.urlKey);
  assert.equal(a.dates.postedAt, '2026-10-09');
  assert.equal(a.priority, 2, 'manual priority preserved');
  assert.equal(a.held, true, 'held preserved');
  assert.equal(a.stage, 'resume_ready', 'no transition — never starts an application');
  assert.equal(a.execution.phase, 'not_started');
  const b = state.loadJob(jb.urlKey);
  assert.equal(b.dates.postedAt, null, 'conflicted job left untouched');
});

// ---------- eval-queue parsing retains metadata without role pollution ----------

test('parsePendingRows: labeled rows keep clean positional fields across shapes', () => {
  const text = [
    LINES.postedLabel,
    LINES.shortRow,
    '- [ ] https://jobs.example/t11/8 | Theta | Director | Hamburg | 90k | posted: 2026-10-05 | trust: 70',
    '- [x] https://jobs.example/t11/9 | Done | Checked | posted: 2026-10-01', // checked rows are not pending
  ].join('\n');
  const rows = evalQueue.parsePendingRows(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.role), ['Staff Engineer', 'SRE', 'Director']);
  assert.equal(rows[2].labels.posted, '2026-10-05');
  assert.equal(rows[2].labels.trust, '70');
  assert.equal(rows[1].labels.posted, undefined);
  // parity with the web parser on the fully-labeled row
  const web = parseInbox(text)[2];
  assert.equal(web.compensation, '90k');
  assert.equal(web.postedAt, '2026-10-05');
});
