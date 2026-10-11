// auto/test/learning-policy.test.mjs — T12: one execution policy, resolved
// from config/auto.yml, validated, version-pinned per attempt, and enforced
// in the REAL dispatcher/worker path (not a parallel evaluator). Everything
// runs against an isolated mkdtemp fixture with an injected executor: no
// browser, no model, no live data. node:test only; synthetic values only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture } from './helpers/learning.mjs';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

// Module handles — dynamically imported AFTER the fixture sets
// CAREER_OPS_ROOT/CAREER_OPS_DB (config.mjs and state.mjs resolve roots at
// import time).
let fixture;
let state;
let configMod; // POLICY_RANGES, resolveExecutionPolicy, previewPolicyEnforcement, loadAutoConfig
let worker;    // runApply
let runMod;    // runCycle
let panelMod;  // EDITABLE_CONFIG, applyConfigEdits

const LEARNING_YML_ON = 'schema_version: 1\nenabled: true\nmode: shadow\n';
const STANDING_YML = 'filled_in_by_user: true\ncustom:\n  notice_period: "4 weeks"\n';

/** Render a synthetic config/auto.yml. The 'synthetic' ATS family is on the
 *  allowlist so ordinary test jobs dispatch; 'workday' is deliberately not. */
function autoYml(overrides = {}) {
  const o = {
    score_threshold: 4.0, daily_soft_limit: 100,
    jitter_min_minutes: 2, jitter_max_minutes: 10,
    max_attempts: 2, timeout_minutes: 25,
    ats: ['greenhouse', 'lever', 'synthetic'],
    ...overrides,
  };
  return [
    `score_threshold: ${o.score_threshold}`,
    `daily_soft_limit: ${o.daily_soft_limit}`,
    `jitter_min_minutes: ${o.jitter_min_minutes}`,
    `jitter_max_minutes: ${o.jitter_max_minutes}`,
    `max_attempts: ${o.max_attempts}`,
    'ats_allowlist:',
    ...o.ats.map((a) => `  - ${a}`),
    'agent:',
    '  primary: claude',
    '  fallback: codex',
    `  timeout_minutes: ${o.timeout_minutes}`,
    '',
  ].join('\n');
}

function setConfig(overrides = {}) {
  const text = typeof overrides === 'string' ? overrides : autoYml(overrides);
  writeFileSync(join(fixture.dataRoot, 'config', 'auto.yml'), text);
  configMod.loadAutoConfig({ fresh: true }); // bust the module cache
}

let seedCounter = 0;
function seedJob({ company, ats = 'synthetic', score = 4.5, priority = 0, held = false, stage = 'resume_ready', attempts = 0, extra = {} } = {}) {
  seedCounter += 1;
  const url = `https://jobs.example.test/${company}/${seedCounter}`;
  const { job } = state.createJob({ url, company, role: 'Engineer', ats });
  for (const s of ['evaluated', 'queued', 'resume_ready']) state.transition(job, s, {});
  Object.assign(job, {
    resumePdf: join(fixture.dataRoot, 'resume.pdf'),
    resumeVariant: 'default',
    reportPath: `reports/${String(seedCounter).padStart(3, '0')}-synthetic.md`,
    score, priority, held,
    ...extra,
  });
  let saved = state.saveJob(job);
  if (stage === 'applying') saved = state.transition(saved, 'applying', { attempts });
  return saved;
}

/** Minimal learning-capable scripted executor: passes preflight, records the
 *  args it was launched with, writes audit artifacts. No learning subcommand
 *  calls (capture-coverage warnings are logged, never verdict-altering). */
function makeExecutor({ outcome = 'submitted', onRun = null } = {}) {
  const ex = {
    runs: [],
    capabilities: () => ({
      tools: ['browseros_snapshot', 'browseros_act', 'browseros_read'],
      boundary: 'restricted',
      taskOwnedTabs: true,
    }),
    async run(args) {
      ex.runs.push({ timeoutMins: args.timeoutMins, submit: args.submit, auditDir: args.auditDir });
      if (onRun) await onRun(args);
      const { auditDir, submit } = args;
      if (outcome === 'failed') {
        writeFileSync(join(auditDir, 'result.json'),
          JSON.stringify({ status: 'failed', reason: 'synthetic failure' }));
        return { exitCode: 1 };
      }
      writeFileSync(join(auditDir, 'answers.json'),
        JSON.stringify([{ label: 'Q', value: 'A', source: 'profile' }]));
      writeFileSync(join(auditDir, '01-form-filled.png'), 'png');
      if (outcome === 'submitted' && submit) {
        writeFileSync(join(auditDir, '02-confirmation.png'), 'png');
        writeFileSync(join(auditDir, 'result.json'),
          JSON.stringify({ status: 'submitted', confirmation_text: 'Application received (synthetic)' }));
      } else {
        writeFileSync(join(auditDir, 'result.json'), JSON.stringify({ status: 'filled_no_submit' }));
      }
      return { exitCode: 0 };
    },
  };
  return ex;
}

const quiet = () => {};

before(async () => {
  fixture = createLearningFixture();
  writeFileSync(join(fixture.dataRoot, 'config', 'auto.yml'), autoYml());
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_YML_ON);
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'), STANDING_YML);
  writeFileSync(join(fixture.dataRoot, 'config', 'profile.yml'), 'name: Fixture Person\n');
  writeFileSync(join(fixture.dataRoot, 'cv.md'), '# Synthetic CV\n- fixture only\n');
  writeFileSync(join(fixture.dataRoot, 'resume.pdf'), 'synthetic-pdf');

  configMod = await import('../lib/config.mjs');
  state = await import('../state.mjs');
  worker = await import('../apply-worker.mjs');
  runMod = await import('../run.mjs');
  panelMod = await import('../panel.mjs');
  setConfig();
});
after(() => fixture.cleanup());

// ---------------------------------------------------------------------------

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.dataRoot);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fixture.dataRoot + sep));
});

test('resolution: valid config -> one validated policy with a stable version digest', () => {
  const p1 = configMod.resolveExecutionPolicy();
  // Values come from the file, through validation — these are also exactly
  // the legacy hardcoded constants, so default behavior is unchanged.
  assert.equal(p1.timeoutMinutes, 25);
  assert.equal(p1.maxAttempts, 2);
  assert.equal(p1.scoreThreshold, 4.0);
  assert.equal(p1.dailySoftLimit, 100);
  assert.deepEqual([...p1.atsAllowlist], ['greenhouse', 'lever', 'synthetic']);
  assert.ok(Object.isFrozen(p1));
  assert.match(p1.policyVersion, /^p1-[0-9a-f]{16}$/);
  // Same config -> same digest; changed config -> different digest.
  assert.equal(configMod.resolveExecutionPolicy().policyVersion, p1.policyVersion);
  setConfig({ max_attempts: 3 });
  try {
    assert.notEqual(configMod.resolveExecutionPolicy().policyVersion, p1.policyVersion);
  } finally { setConfig(); }
});

test('resolution: garbled or out-of-range values are an explicit refusal, never a silent default', async () => {
  const cases = [
    [{ score_threshold: 9 }, /score_threshold/],
    [{ max_attempts: 0 }, /max_attempts/],
    [{ max_attempts: 2.5 }, /max_attempts/],
    [{ timeout_minutes: 'soon' }, /timeout_minutes/],
    [{ timeout_minutes: 0 }, /timeout_minutes/],
    [{ daily_soft_limit: -1 }, /daily_soft_limit/],
    [{ jitter_min_minutes: 20, jitter_max_minutes: 10 }, /jitter/],
    [{ ats: [] }, /ats_allowlist/],
  ];
  try {
    for (const [overrides, re] of cases) {
      setConfig(overrides);
      assert.throws(() => configMod.resolveExecutionPolicy(), (err) => {
        assert.equal(err.code, 'POLICY_INVALID', `expected POLICY_INVALID for ${JSON.stringify(overrides)}`);
        assert.match(err.message, re);
        return true;
      });
    }
    // The worker refuses to start on an invalid policy — even a dry run.
    setConfig({ timeout_minutes: 'soon' });
    await assert.rejects(
      worker.runApply({ needle: 'no-such-job', submit: false, executor: makeExecutor({}), log: quiet }),
      (err) => err.code === 'POLICY_INVALID',
    );
  } finally { setConfig(); }
});

test('BUG FIX timeout: config agent.timeout_minutes reaches the executor (was cfg.apply.* + hardcoded 25)', async () => {
  setConfig({ timeout_minutes: 7 });
  try {
    seedJob({ company: 'timeoutco' });
    const ex = makeExecutor({ outcome: 'filled_no_submit' });
    const res = await worker.runApply({ needle: 'timeoutco', submit: false, executor: ex, log: quiet });
    assert.equal(ex.runs.length, 1);
    assert.equal(ex.runs[0].timeoutMins, 7, 'configured timeout must reach the executor');
    assert.equal(res.verdict.ok, true);
  } finally { setConfig(); }
});

test('pinning: policy + source versions persist on the attempt BEFORE execution', async () => {
  const job = seedJob({ company: 'pinco' });
  const expected = configMod.resolveExecutionPolicy();
  let during = null;
  const ex = makeExecutor({
    onRun: () => { during = state.loadJob(job.urlKey); },
  });
  const res = await worker.runApply({ needle: 'pinco', submit: true, executor: ex, log: quiet });
  assert.ok(during, 'executor ran');
  assert.equal(during.stage, 'applying');
  assert.equal(during.execution.phase, 'in_progress');
  assert.equal(during.execution.policyVersion, expected.policyVersion, 'policy version pinned before launch');
  assert.match(String(during.execution.sourceVersion), /^src1-[0-9a-f]{16}$/, 'source version pinned before launch');
  assert.deepEqual(during.execution.pinnedPolicy, { maxAttempts: 2, timeoutMinutes: 25 });
  assert.equal(res.job.stage, 'submitted');
});

test('BUG FIX picking: max_attempts=3 lets an applying job with 2 attempts be picked (was hardcoded 2)', async () => {
  setConfig({ max_attempts: 3 });
  try {
    const job = seedJob({ company: 'retryco', stage: 'applying', attempts: 2, priority: 10 });
    const ex = makeExecutor({ outcome: 'failed' });
    const res = await worker.runApply({ submit: true, executor: ex, log: quiet });
    assert.ok(res, 'a job must be picked');
    assert.equal(res.job.urlKey, job.urlKey, 'the 2-attempt job is pickable under max_attempts=3');
    // Attempt 3 failed and 3 >= 3: finalized as failed under the SAME policy.
    assert.equal(res.job.stage, 'failed');
    assert.equal(res.job.attempts, 3);
  } finally { setConfig(); }
});

test('BUG FIX finalization: a failure at attempt 2 of 3 stays in applying (was failed at hardcoded 2)', async () => {
  setConfig({ max_attempts: 3 });
  try {
    const job = seedJob({ company: 'budgetco' });
    const ex = makeExecutor({ outcome: 'failed' });
    const r1 = await worker.runApply({ needle: 'budgetco', submit: true, executor: ex, log: quiet });
    assert.equal(r1.job.stage, 'applying', 'attempt 1 of 3: retry budget left');
    const r2 = await worker.runApply({ needle: 'budgetco', submit: true, executor: ex, log: quiet });
    assert.equal(r2.job.attempts, 2);
    assert.equal(r2.job.stage, 'applying', 'attempt 2 of 3 must NOT fail the job under max_attempts=3');
    const fresh = state.loadJob(job.urlKey);
    assert.deepEqual(fresh.execution.pinnedPolicy.maxAttempts, 3, 'attempt pinned the policy it ran under');
  } finally { setConfig(); }
});

test('enforcement: ATS family outside the allowlist is refused before any executor time', async () => {
  const job = seedJob({ company: 'workdayco', ats: 'workday' });
  const ex = makeExecutor({});
  // No executor needed to refuse: the policy gate sits before preflight.
  const res = await worker.runApply({ needle: 'workdayco', submit: true, executor: null, log: quiet });
  assert.equal(res.verdict.status, 'policy_blocked');
  assert.match(res.verdict.reason, /ats "workday"/);
  assert.equal(res.auditDir, null);
  // Dry runs drive a real browser too — the ATS gate applies to them as well.
  const dry = await worker.runApply({ needle: 'workdayco', submit: false, executor: ex, log: quiet });
  assert.equal(dry.verdict.status, 'policy_blocked');
  assert.equal(ex.runs.length, 0, 'no executor launch for a blocked ATS');
  const fresh = state.loadJob(job.urlKey);
  assert.equal(fresh.stage, 'resume_ready', 'refusal mutates nothing');
  assert.equal(fresh.attempts || 0, 0);
});

test('enforcement: unknown/empty ATS is refused, not waved through', async () => {
  seedJob({ company: 'mysteryco', ats: '' });
  const res = await worker.runApply({ needle: 'mysteryco', submit: true, executor: null, log: quiet });
  assert.equal(res.verdict.status, 'policy_blocked');
  assert.match(res.verdict.reason, /ats "unknown"/);
});

test('enforcement: score below threshold is refused at dispatch', async () => {
  seedJob({ company: 'lowscoreco', score: 3.2 });
  const ex = makeExecutor({});
  const res = await worker.runApply({ needle: 'lowscoreco', submit: true, executor: ex, log: quiet });
  assert.equal(res.verdict.status, 'policy_blocked');
  assert.match(res.verdict.reason, /score 3\.2 below threshold 4/);
  assert.equal(ex.runs.length, 0);
});

test('enforcement: held job is refused even when named directly', async () => {
  seedJob({ company: 'heldco', held: true });
  const res = await worker.runApply({ needle: 'heldco', submit: true, executor: null, log: quiet });
  assert.equal(res.verdict.status, 'policy_blocked');
  assert.match(res.verdict.reason, /held/);
});

test('enforcement: daily soft limit blocks dispatch at execution grain', async () => {
  // The pinning test above submitted one job today in this fixture.
  setConfig({ daily_soft_limit: 1 });
  try {
    seedJob({ company: 'capco' });
    const res = await worker.runApply({ needle: 'capco', submit: true, executor: null, log: quiet });
    assert.equal(res.verdict.status, 'policy_blocked');
    assert.match(res.verdict.reason, /daily soft limit reached \(1\/1\)/);
  } finally { setConfig(); }
});

test('enforcement: pause flag refuses dispatch and is NEVER consumed by the worker', async () => {
  const pauseFlag = join(fixture.dataRoot, 'data', 'auto', 'pause-requested');
  mkdirSync(dirname(pauseFlag), { recursive: true });
  writeFileSync(pauseFlag, '');
  try {
    seedJob({ company: 'pausedco' });
    const res = await worker.runApply({ needle: 'pausedco', submit: true, executor: null, log: quiet });
    assert.equal(res.verdict.status, 'policy_blocked');
    assert.match(res.verdict.reason, /pause/);
    assert.ok(existsSync(pauseFlag), 'the worker must never unlink the pause sentinel');
  } finally { unlinkSync(pauseFlag); }
});

test('enforcement: a missing required source refuses BEFORE allocating or claiming an attempt', async () => {
  const job = seedJob({ company: 'nosourceco' });
  const ex = makeExecutor({});
  const cv = join(fixture.dataRoot, 'cv.md');
  renameSync(cv, `${cv}.away`);
  try {
    await assert.rejects(
      worker.runApply({ needle: 'nosourceco', submit: true, executor: ex, log: quiet }),
      /required source missing or unreadable/,
    );
    assert.equal(ex.runs.length, 0);
    const fresh = state.loadJob(job.urlKey);
    assert.equal(fresh.stage, 'resume_ready');
    assert.equal(fresh.attempts || 0, 0, 'no attempt burned on a missing source');
    const auditRoot = join(fixture.dataRoot, 'output');
    const dirs = existsSync(auditRoot)
      ? readdirSync(auditRoot).filter((d) => d.includes('nosourceco'))
      : [];
    assert.equal(dirs.length, 0, 'no attempt directory allocated');
  } finally { renameSync(`${cv}.away`, cv); }
});

test('backlog preview: enforcement is previewed; historical submissions surface for reconciliation, never retro-labeled', () => {
  const policy = configMod.resolveExecutionPolicy();
  const jobs = [
    { urlKey: 'k1', company: 'old-wd', stage: 'submitted', ats: 'workday', score: 4.5 },
    { urlKey: 'k2', company: 'new-wd', stage: 'resume_ready', ats: 'workday', score: 4.5 },
    { urlKey: 'k3', company: 'low', stage: 'queued', ats: 'synthetic', score: 3.0 },
    { urlKey: 'k4', company: 'benched', stage: 'resume_ready', ats: 'synthetic', score: 4.5, held: true },
    { urlKey: 'k5', company: 'fine', stage: 'resume_ready', ats: 'synthetic', score: 4.5 },
    { urlKey: 'k6', company: 'spent', stage: 'applying', ats: 'synthetic', score: 4.5, attempts: 2 },
  ];
  const preview = configMod.previewPolicyEnforcement(jobs, policy);
  assert.equal(preview.policyVersion, policy.policyVersion);
  assert.deepEqual(preview.blockedAts.map((e) => e.urlKey), ['k2'], 'only actionable jobs are blocked');
  assert.deepEqual(preview.belowThreshold.map((e) => e.urlKey), ['k3']);
  assert.deepEqual(preview.held.map((e) => e.urlKey), ['k4']);
  assert.deepEqual(preview.overAttempts.map((e) => e.urlKey), ['k6']);
  assert.deepEqual(preview.historicalOutsideAllowlist.map((e) => e.urlKey), ['k1']);
  assert.equal(preview.historicalOutsideAllowlist[0].workday, true);
  // k5 is clean: appears nowhere.
  for (const list of [preview.blockedAts, preview.belowThreshold, preview.held, preview.overAttempts, preview.historicalOutsideAllowlist]) {
    assert.ok(!list.some((e) => e.urlKey === 'k5'));
  }
  // Historical note asks for operator reconciliation and explicitly does NOT
  // retro-label past submissions as unauthorized or touch the allowlist.
  const note = preview.notes.join(' ');
  assert.match(note, /reconcile/i);
  assert.match(note, /not retroactively unauthorized/i);
  assert.deepEqual([...policy.atsAllowlist], ['greenhouse', 'lever', 'synthetic'], 'preview never mutates the policy');
});

test('shrink safety: recovery surfaces a pending policy change instead of silently failing pinned in-flight jobs', async () => {
  // Three stale applying jobs at 2 attempts under current max_attempts=2:
  //  A pinned to maxAttempts 3 (started under a wider policy) -> stays, surfaced
  //  B pinned to maxAttempts 2 -> failed (its own policy is exhausted)
  //  C legacy, no pin          -> failed (current policy applies)
  const mkStale = (company, pinnedMax) => seedJob({
    company, stage: 'applying', attempts: 2,
    extra: pinnedMax ? { execution: { attemptId: null, phase: 'in_progress', pinnedPolicy: { maxAttempts: pinnedMax } } } : {},
  });
  const a = mkStale('pendingco', 3);
  const b = mkStale('exhaustedco', 2);
  const c = mkStale('legacyco', null);
  const pauseFlag = join(fixture.dataRoot, 'data', 'auto', 'stale-test-pause');
  mkdirSync(dirname(pauseFlag), { recursive: true });
  writeFileSync(pauseFlag, ''); // break the apply loop before any dispatch
  const lines = [];
  await runMod.runCycle({
    applyOnly: true,
    apply: async () => null, // stub: recovery is the subject, not applies
    pauseFlag,
    log: (m) => lines.push(String(m)),
  });
  assert.equal(state.loadJob(a.urlKey).stage, 'applying', 'pinned-wider job is left for reconciliation');
  assert.ok(lines.some((l) => /policy change pending/.test(l) && l.includes('pendingco')),
    `expected a pending-policy-change line, got:\n${lines.join('\n')}`);
  assert.equal(state.loadJob(b.urlKey).stage, 'failed');
  assert.equal(state.loadJob(c.urlKey).stage, 'failed');
});

test('UI agreement: panel limits are the SAME ranges the dispatcher enforces, and the timeout is editable', () => {
  const { POLICY_RANGES } = configMod;
  const editable = panelMod.EDITABLE_CONFIG;
  for (const [key, spec] of Object.entries(POLICY_RANGES)) {
    assert.ok(editable[key], `${key} must be editable from the panel`);
    assert.equal(editable[key].kind, spec.kind, `${key} kind agrees`);
    assert.equal(editable[key].min, spec.min, `${key} min agrees`);
    assert.equal(editable[key].max, spec.max, `${key} max agrees`);
  }
  // Round-trip: a valid timeout edit lands on the nested agent key; invalid
  // values are refused with the same ranges the policy validates.
  const yml = autoYml();
  const ok = panelMod.applyConfigEdits(yml, { 'agent.timeout_minutes': 30 });
  assert.deepEqual(ok.errors, []);
  assert.match(ok.text, /^ {2}timeout_minutes: 30$/m);
  const bad = panelMod.applyConfigEdits(yml, { 'agent.timeout_minutes': 0, max_attempts: 99 });
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.changed.length, 0);
});
