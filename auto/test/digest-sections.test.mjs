// auto/test/digest-sections.test.mjs
//
// Lean tests for:
//   1. digest section assembly (park Pareto, park-drain questions, ATS rates,
//      backlog economics, cost line, stale jobs, resume fallback, decisions block)
//   2. stale-activity alarm threshold (T2.3)
//   3. F11: pipeline inbox count appears in backlog line
//   4. F12: resume fallbacks split by stage (submitted vs not submitted)
//   5. F13: verdictAt included in cost-line today computation
//
// Uses node:test. No DB access; all inputs are in-memory fixture data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Import the units under test ───────────────────────────────────────────────

const { buildDigest, aggregateParkDrain, computeCostLine, sendDigest } =
  await import('../digest.mjs');
const { staleActivityAlarm } = await import('../panel.mjs');

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeJob(overrides) {
  return {
    stage: 'discovered',
    company: 'Acme',
    role: 'Engineer',
    score: null,
    ats: 'greenhouse',
    lastError: null,
    url: 'https://x.test/1',
    timestamps: [],
    ...overrides,
  };
}

const DAY = '2026-10-12';

// ── Test 1: buildDigest section headers ───────────────────────────────────────

test('buildDigest: contains all required T1.2/T1.3/T2.2/T2.3 sections', () => {
  const jobs = [
    makeJob({ stage: 'submitted', company: 'Alpha', role: 'VP Eng', score: 4.5, ats: 'greenhouse',
      timestamps: [{ stage: 'submitted', at: `${DAY}T10:00:00Z` }] }),
    makeJob({ stage: 'parked', company: 'Beta', role: 'Director', lastError: 'login-or-captcha',
      timestamps: [{ stage: 'parked', at: `${DAY}T09:00:00Z` }] }),
    makeJob({ stage: 'discovered', company: 'Gamma', role: 'Analyst' }),
    makeJob({ stage: 'parked', company: 'Delta', role: 'Principal Engineer',
      lastError: 'score-correction (real 3.2 < 4.0)', ats: 'lever',
      resumeNote: 'default resume used — no Principal IC variant',
      timestamps: [{ stage: 'parked', at: '2026-10-07T08:00:00Z' }] }),
    makeJob({ stage: 'parked', company: 'Epsilon', role: 'CTO',
      lastError: 'EEO question — no self-identify option found', ats: 'ashby',
      timestamps: [{ stage: 'parked', at: '2026-10-09T08:00:00Z' }] }),
  ];

  const { text, movedToday, parkedCount } = buildDigest(jobs, DAY);

  // Basic movement
  assert.equal(movedToday.length, 2, 'two jobs moved today');
  assert.equal(parkedCount, 1, 'one parked today');

  // T1.3: Park-reason Pareto
  assert.ok(text.includes('Park-reason Pareto'), 'park pareto section header');
  assert.ok(text.includes('login-or-captcha'), 'park reason in table');

  // T1.2: Park-drain questions
  assert.ok(text.includes('Answer these 4 questions'), 'park-drain questions count');
  assert.ok(text.includes('EEO questions'), 'EEO policy prompt');
  assert.ok(text.includes('Quirky culture'), 'quirky culture prompt');
  assert.ok(text.includes('Non-USD salary'), 'non-USD OTE prompt');
  assert.ok(text.includes('Attestation'), 'attestations prompt');
  assert.ok(text.includes('PROPOSALS ONLY'), 'approval-gated reminder');
  assert.ok(text.includes('standing-answers.yml'), 'YAML target file mentioned');

  // T1.3: ATS rates
  assert.ok(text.includes('Per-ATS rates'), 'ATS rates section');
  assert.ok(text.includes('greenhouse'), 'greenhouse ATS present');

  // T1.3: Backlog economics
  assert.ok(text.includes('Backlog:'), 'backlog economics line');
  assert.ok(text.includes('unranked'), 'discovered/unranked count');

  // T1.3: Cost line
  assert.ok(text.includes('Cost:'), 'cost line present');

  // T1.3: Stale parked jobs (Delta is ~5 days old, Epsilon ~3 days; DAY=10-12)
  assert.ok(text.includes('Stale parked jobs'), 'stale jobs section');

  // T2.2: Resume fallback — parked job with fallback note should appear somewhere in coverage section
  assert.ok(text.includes('Resume-variant coverage'), 'resume variant coverage section');
  assert.ok(text.includes('Principal Engineer'), 'fallback job in resume section');

  // Score-correction count
  assert.ok(text.includes('Score-correction parks'), 'score-correction count line');

  // Decisions needed block
  assert.ok(text.includes('Decisions needed'), 'decisions needed block');
  assert.ok(text.includes('Push channel'), 'push channel decision');
  assert.ok(text.includes('Scan cadence'), 'scan cadence decision');
  assert.ok(text.includes('Standing-answer proposals'), 'standing-answer decision');
});

// ── Test 2: aggregateParkDrain counts ────────────────────────────────────────

test('aggregateParkDrain: counts parked/discovered/ATS/stale correctly', () => {
  const jobs = [
    makeJob({ stage: 'submitted', ats: 'greenhouse' }),
    makeJob({ stage: 'parked', ats: 'greenhouse', lastError: 'login-or-captcha',
      timestamps: [{ stage: 'parked', at: '2026-10-08T00:00:00Z' }] }),
    makeJob({ stage: 'parked', ats: 'lever', lastError: 'login-or-captcha',
      timestamps: [{ stage: 'parked', at: '2026-10-11T00:00:00Z' }] }),
    makeJob({ stage: 'parked', ats: 'ashby', lastError: 'score-correction (real 3.0 < 4.0)',
      timestamps: [{ stage: 'parked', at: '2026-10-07T00:00:00Z' }] }),
    makeJob({ stage: 'discovered' }),
    makeJob({ stage: 'discovered' }),
  ];

  const pd = aggregateParkDrain(jobs);

  assert.equal(pd.backlogCount, 2, 'two discovered jobs');
  assert.equal(pd.totalParked, 3, 'three parked jobs');
  assert.equal(pd.scoreCorrectionCount, 1, 'one score-correction park');

  // login-or-captcha is the top reason (x2)
  assert.equal(pd.parkPareto[0].reason, 'login-or-captcha');
  assert.equal(pd.parkPareto[0].count, 2);

  // Stale parked: > 3 days. On 2026-10-12:
  //   2026-10-08 → 4 days → stale
  //   2026-10-11 → 1 day  → not stale
  //   2026-10-07 → 5 days → stale
  assert.equal(pd.stalledParked.length, 2, 'two stale parked jobs');

  // ATS summary: greenhouse has 1 submitted + 1 parked
  const gh = pd.atsSummary.find((a) => a.ats === 'greenhouse');
  assert.ok(gh, 'greenhouse in ATS summary');
  assert.equal(gh.submitted, 1);
  assert.equal(gh.parked, 1);
  assert.equal(gh.parkRate, 50, 'greenhouse 50% park rate');

  // questionsToUnlock: all 4 always present
  assert.equal(pd.questionsToUnlock.length, 4, '4 policy questions always shown');
});

// ── Test 3: staleActivityAlarm (T2.3) ─────────────────────────────────────────

test('staleActivityAlarm: detects stuck cycle after 2h', () => {
  const now = new Date('2026-10-12T14:00:00Z').getTime();
  const cycle = { running: true };

  // Last activity 1h ago → not stale
  const r1 = staleActivityAlarm(cycle, '2026-10-12T13:00:00Z', now);
  assert.equal(r1.stale, false, 'not stale at 1h silence');

  // Last activity 2h 1min ago → stale
  const r2 = staleActivityAlarm(cycle, '2026-10-12T11:59:00Z', now);
  assert.equal(r2.stale, true, 'stale at 2h 1min silence');
  assert.ok(r2.silenceMs > 2 * 3600 * 1000, 'silenceMs > 2h');

  // Exactly 2h → not stale (> not >=)
  const r3 = staleActivityAlarm(cycle, '2026-10-12T12:00:00Z', now);
  assert.equal(r3.stale, false, 'not stale at exactly 2h');
});

test('staleActivityAlarm: never stale when cycle not running', () => {
  const now = new Date('2026-10-12T14:00:00Z').getTime();
  const r = staleActivityAlarm({ running: false }, '2026-10-12T08:00:00Z', now);
  assert.equal(r.stale, false, 'stale alarm off when cycle not running');
});

test('staleActivityAlarm: never stale when no lastActivityAt', () => {
  const now = Date.now();
  const r = staleActivityAlarm({ running: true }, null, now);
  assert.equal(r.stale, false, 'stale alarm off when no log yet');
});

// ── Test 4: buildDigest empty case ───────────────────────────────────────────

test('buildDigest: empty job list renders gracefully', () => {
  const { text } = buildDigest([], '2026-10-01');
  assert.ok(text.includes('No submissions'), 'empty digest says no submissions');
  assert.ok(text.includes('Park-reason Pareto'), 'pareto section present even empty');
  assert.ok(text.includes('Decisions needed'), 'decisions block always present');
});

// ── Test 5: sendDigest channel interface ─────────────────────────────────────

test('sendDigest: calls channel.send with the digest text', async () => {
  let received = null;
  const ch = { name: 'test', send: (t) => { received = t; } };
  await sendDigest('hello-digest', ch);
  assert.equal(received, 'hello-digest', 'channel.send received the text');
});

test('sendDigest: no-ops when channel is null', async () => {
  // Should not throw
  await sendDigest('hello', null);
});

test('sendDigest: no-ops when channel has no .send', async () => {
  await sendDigest('hello', { name: 'broken' });
});

// ── Test 6 (F11): pipeline inbox count appears in backlog line ────────────────

test('buildDigest F11: pipelineInboxCount appears in backlog line', () => {
  const jobs = [
    makeJob({ stage: 'discovered' }),
    makeJob({ stage: 'discovered' }),
    makeJob({ stage: 'submitted', timestamps: [{ stage: 'submitted', at: `${DAY}T10:00:00Z` }] }),
  ];

  const { text } = buildDigest(jobs, DAY, { pipelineInboxCount: 2662 });
  assert.ok(text.includes('2662'), 'pipeline inbox count in backlog line');
  assert.ok(text.includes('pipeline inbox'), 'labels it as pipeline inbox');
  assert.ok(text.includes('unranked (auto_jobs)'), 'also shows discovered auto_jobs count');
});

test('buildDigest F11: no pipelineInboxCount omits inbox part gracefully', () => {
  const jobs = [makeJob({ stage: 'discovered' })];
  const { text } = buildDigest(jobs, DAY);
  assert.ok(text.includes('Backlog:'), 'backlog line present');
  assert.ok(text.includes('unranked'), 'discovered count present');
  assert.ok(!text.includes('pipeline inbox'), 'no inbox segment when not provided');
});

// ── Test 7 (F12): resume fallbacks split by stage ────────────────────────────

test('buildDigest F12: splits fallbacks into submitted vs not-submitted groups', () => {
  const jobs = [
    makeJob({ stage: 'submitted', company: 'SubCo', role: 'SWE',
      resumeNote: 'default resume used — no SWE variant',
      timestamps: [{ stage: 'submitted', at: `${DAY}T10:00:00Z` }] }),
    makeJob({ stage: 'parked', company: 'ParkCo', role: 'Staff Engineer',
      resumeNote: 'fallback resume used',
      timestamps: [{ stage: 'parked', at: `${DAY}T11:00:00Z` }] }),
  ];

  const { text } = buildDigest(jobs, DAY);

  // submitted group
  assert.ok(text.includes('submitted** with the default resume'), 'submitted group header');
  assert.ok(text.includes('SubCo'), 'submitted company present');

  // not-submitted group
  assert.ok(text.includes('not yet submitted'), 'not-submitted group header');
  assert.ok(text.includes('ParkCo'), 'parked company present');
  assert.ok(text.includes('parked'), 'stage shown in not-submitted table');
});

test('aggregateParkDrain F12: resumeFallbacks carries stage field', () => {
  const jobs = [
    makeJob({ stage: 'submitted', resumeNote: 'default resume used' }),
    makeJob({ stage: 'parked', resumeNote: 'fallback resume used' }),
    makeJob({ stage: 'failed', resumeNote: 'head.of.ai resume fallback' }),
  ];
  const pd = aggregateParkDrain(jobs);
  assert.equal(pd.resumeFallbacks.length, 3, 'all three fallback jobs captured');
  const stages = pd.resumeFallbacks.map(f => f.stage);
  assert.ok(stages.includes('submitted'), 'submitted stage present');
  assert.ok(stages.includes('parked'), 'parked stage present');
  assert.ok(stages.includes('failed'), 'failed stage present');
});

// ── Test 8 (F13): verdictAt included in cost-line today computation ───────────

test('computeCostLine F13: counts verdictAt as today timestamp', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'career-ops-cost-test-'));
  // Create a minimal output directory with one verdict that only has verdictAt
  const jobDir = join(tmpDir, 'attempt-1');
  mkdirSync(jobDir, { recursive: true });
  const todayStr = new Date().toISOString().slice(0, 10);
  const verdict = {
    verdictAt: `${todayStr}T12:00:00Z`,  // no submittedAt, no timestamp
    usage: { costUsd: 0.07 },
  };
  writeFileSync(join(jobDir, 'verdict.json'), JSON.stringify(verdict), 'utf-8');

  const result = computeCostLine(tmpDir);
  assert.ok(result.estCostToday !== null, 'today cost is non-null when verdictAt is today');
  assert.ok(Math.abs(result.estCostToday - 0.07) < 0.001, 'today cost matches verdict.usage.costUsd');
});

test('computeCostLine F13: submittedAt still works (regression)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'career-ops-cost-test-sub-'));
  const jobDir = join(tmpDir, 'attempt-1');
  mkdirSync(jobDir, { recursive: true });
  const todayStr = new Date().toISOString().slice(0, 10);
  const verdict = {
    submittedAt: `${todayStr}T09:00:00Z`,
    usage: { costUsd: 0.05 },
  };
  writeFileSync(join(jobDir, 'verdict.json'), JSON.stringify(verdict), 'utf-8');

  const result = computeCostLine(tmpDir);
  assert.ok(result.estCostToday !== null, 'today cost non-null when submittedAt is today');
  assert.ok(Math.abs(result.estCostToday - 0.05) < 0.001, 'today cost matches');
});
