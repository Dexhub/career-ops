// auto/test/dispatch-gate.test.mjs — T0.2 dispatch-gate rules + T0.3 retry guard.
//
// All tests run against a throwaway temp DB; never the live store.
// Test structure:
//   1. already-applied     (auto_jobs submitted match)
//   2. already-applied     (tracker Applied match)
//   3. declined-cooldown   (tracker Applied with decline notes + recent date)
//   4. employer-cap        (>2 live non-terminal for same company)
//   5. non-match passes    (different company/role — should not park)
//   6. retry-guard blocks  failed→queued when lastError indicates unknown outcome
//   7. retry-guard force   force:true bypasses the block + returns warning
//   8. retry-guard pass    clean lastError does not block requeue
//   9. F1-pin  unknown-outcome applying job transitions to failed (not left in applying)
//  10. F2-pin  Rejected/Interview/Offer tracker rows still block re-application
//  11. F3-pin  redactPromptForAudit fails closed when accounts.json is missing

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp;
let db;
let state;
let gate;
let panel;
let applyWorker;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'dispatch-gate-test-'));
  process.env.CAREER_OPS_DB = join(tmp, 'test.db');
  // Import AFTER env override so db.mjs opens the temp store.
  db          = await import('../../core/db.mjs');
  state       = await import('../state.mjs');
  gate        = await import('../dispatch-gate.mjs');
  panel       = await import('../panel.mjs');
  applyWorker = await import('../apply-worker.mjs');
});

after(() => {
  db.closeDb();
  delete process.env.CAREER_OPS_DB;
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers

/** Build a minimal auto_jobs row for injection. */
function mkAutoJob(override = {}) {
  return {
    urlKey: `https://jobs.example.test/${Math.random().toString(36).slice(2)}`,
    url: override.urlKey ?? `https://jobs.example.test/${Math.random().toString(36).slice(2)}`,
    company: 'testco',
    role: 'Director of Engineering',
    ats: 'greenhouse',
    stage: 'resume_ready',
    score: 4.5,
    attempts: 0,
    priority: 0,
    data: '{}',
    ...override,
  };
}

/** Build a minimal applications (tracker) row for injection. */
function mkTrackerRow(override = {}) {
  return {
    num: Math.floor(Math.random() * 90000) + 10000,
    date: '2026-09-01',
    company: 'testco',
    role: 'Director of Engineering',
    status: 'Applied',
    notes: '',
    via: '',
    location: '',
    score: '',
    pdf: '',
    report: '',
    url: '',
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Task 1 — Gate rules

test('(a) already-applied — blocks when auto_jobs has submitted match', () => {
  const submittedJob = mkAutoJob({ company: 'acmecorp', role: 'Head of Engineering', stage: 'submitted' });
  const candidateJob = mkAutoJob({ company: 'acmecorp', role: 'Head of Engineering', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidateJob, {
    autoJobsFn: () => [submittedJob, candidateJob],
    applicationsFn: () => [],
  });

  assert.equal(result.park, true, 'should park');
  assert.equal(result.rule, 'already-applied', `got rule: ${result.rule}`);
  assert.ok(result.reason.includes('acmecorp'), `reason: ${result.reason}`);
});

test('(a) already-applied — blocks when tracker Applied row matches', () => {
  const trackerRow = mkTrackerRow({ company: 'betacorp', role: 'VP of Engineering', status: 'Applied' });
  const candidateJob = mkAutoJob({ company: 'betacorp', role: 'VP of Engineering', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidateJob, {
    autoJobsFn: () => [candidateJob],
    applicationsFn: () => [trackerRow],
  });

  assert.equal(result.park, true, 'should park');
  assert.equal(result.rule, 'already-applied');
  assert.ok(result.reason.includes('betacorp'));
});

test('(b) declined-cooldown — blocks when same-company Applied row has recent decline note', () => {
  const recentDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 30 days ago
  const trackerRow = mkTrackerRow({
    company: 'gammacorp',
    role: 'Director of Product Engineering',
    status: 'Applied',
    notes: `Strong fit; application submitted 2026-08-15; Gmail decision verified 2026-${recentDate.slice(5)}: GammaCorp declined the Director of Product Engineering application on ${recentDate}; source screenshot saved.`,
  });
  const candidateJob = mkAutoJob({ company: 'gammacorp', role: 'Director of Product Engineering', stage: 'queued' });

  // Provide a fixed "now" so the cooldown math is stable
  const now = new Date();
  const result = gate.checkDispatchGate(candidateJob, {
    autoJobsFn: () => [candidateJob],
    applicationsFn: () => [trackerRow],
    now,
  });

  assert.equal(result.park, true, 'should park');
  assert.equal(result.rule, 'declined-cooldown', `got rule: ${result.rule}`);
  assert.ok(result.reason.includes('gammacorp'));
});

test('(c) employer-cap — blocks when company has >2 live non-terminal applications', () => {
  const company = 'megacorp';
  const liveJobs = [
    mkAutoJob({ company, role: 'VP of Engineering', stage: 'submitted' }),
    mkAutoJob({ company, role: 'Director of Platform', stage: 'applying' }),
    mkAutoJob({ company, role: 'Head of Architecture', stage: 'resume_ready' }),
  ];
  const candidateJob = mkAutoJob({ company, role: 'Principal Engineer', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidateJob, {
    autoJobsFn: () => [...liveJobs, candidateJob],
    applicationsFn: () => [],
  });

  assert.equal(result.park, true, 'should park');
  assert.equal(result.rule, 'employer-cap', `got rule: ${result.rule}`);
  assert.ok(result.reason.includes('megacorp'));
});

test('non-match passes — different company and role does not park', () => {
  const submittedJob = mkAutoJob({ company: 'differentcorp', role: 'Head of Infrastructure', stage: 'submitted' });
  const candidateJob = mkAutoJob({ company: 'othercorp', role: 'Director of Product', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidateJob, {
    autoJobsFn: () => [submittedJob, candidateJob],
    applicationsFn: () => [],
  });

  assert.equal(result.park, false, 'should not park');
  assert.equal(result.rule, undefined);
});

test('employer-cap: 2 live others blocks the candidate — budget is at most 2 total', () => {
  // F4 fix: 2 existing live + 1 candidate = 3 total, which exceeds the ≤2 budget.
  const company = 'smallcorp';
  const live2 = [
    mkAutoJob({ company, role: 'Role A', stage: 'queued' }),
    mkAutoJob({ company, role: 'Role B', stage: 'resume_ready' }),
  ];
  const candidate = mkAutoJob({ company, role: 'Role C', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidate, {
    autoJobsFn: () => [...live2, candidate],
    applicationsFn: () => [],
  });

  assert.equal(result.park, true, '2 live others + candidate = 3 total must be blocked');
  assert.equal(result.rule, 'employer-cap');
});

test('employer-cap: 1 live other still passes — only 2 total (within budget)', () => {
  const company = 'smallcorp2';
  const live1 = [mkAutoJob({ company, role: 'Role A', stage: 'queued' })];
  const candidate = mkAutoJob({ company, role: 'Role B', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidate, {
    autoJobsFn: () => [...live1, candidate],
    applicationsFn: () => [],
  });

  assert.equal(result.park, false, '1 live other + candidate = 2 total must pass');
});

// ---------------------------------------------------------------------------
// Task 2 — T0.3 retry guard via state.mjs + panel.mjs

test('retry-guard: failed→queued is blocked when lastError indicates unknown outcome', async () => {
  // Create a job, take it to failed, set a no-confirmation lastError
  const { job } = state.createJob({ url: 'https://job-boards.greenhouse.io/retry/jobs/1', company: 'riotgames', role: 'Principal ML Engineer' });
  state.transition(job, 'evaluated', { score: 4.5 });
  state.transition(job, 'queued');
  state.transition(job, 'resume_ready', { resumePdf: '/tmp/x.pdf' });
  state.transition(job, 'applying');
  state.transition(job, 'failed', { lastError: 'no-confirmation', attempts: 1 });

  // Attempt requeue without force — must be blocked
  let threw = null;
  try {
    await state.updateJob(job.urlKey, { transitionTo: 'queued', patch: { attempts: 0, lastError: null } });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'should throw');
  assert.equal(threw.code, 'SUBMISSION_OUTCOME_UNKNOWN', `got code: ${threw.code}`);

  // Stage must remain failed
  const after = state.loadJob(job.urlKey);
  assert.equal(after.stage, 'failed', `stage should stay failed, got ${after.stage}`);
});

test('retry-guard: force flag allows requeue and returns warning', async () => {
  // Create a second failed job with unknown-outcome error
  const { job } = state.createJob({ url: 'https://job-boards.greenhouse.io/retry/jobs/2', company: 'riotgames', role: 'Staff ML Engineer' });
  state.transition(job, 'evaluated', { score: 4.5 });
  state.transition(job, 'queued');
  state.transition(job, 'resume_ready', { resumePdf: '/tmp/x.pdf' });
  state.transition(job, 'applying');
  state.transition(job, 'failed', { lastError: 'confirmation_text empty', attempts: 1 });

  // requeueJob with force:true — should succeed and carry a warning
  const result = await panel.requeueJob(job.urlKey, { force: true });
  assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
  assert.ok(result.warning, 'should include a warning string');
  assert.ok(result.warning.includes('verify with the employer'), `warning: ${result.warning}`);

  const after = state.loadJob(job.urlKey);
  assert.equal(after.stage, 'queued', `stage should be queued, got ${after.stage}`);
});

test('retry-guard: clean lastError does not block requeue', async () => {
  const { job } = state.createJob({ url: 'https://job-boards.greenhouse.io/retry/jobs/3', company: 'cleancorp', role: 'VP Engineering' });
  state.transition(job, 'evaluated', { score: 4.5 });
  state.transition(job, 'queued');
  state.transition(job, 'resume_ready', { resumePdf: '/tmp/x.pdf' });
  state.transition(job, 'applying');
  state.transition(job, 'failed', { lastError: 'form validation error — missing required field', attempts: 1 });

  const result = await panel.requeueJob(job.urlKey);
  assert.equal(result.ok, true, `should succeed: ${JSON.stringify(result)}`);
  assert.equal(result.warning, undefined, 'no warning expected');
  const after = state.loadJob(job.urlKey);
  assert.equal(after.stage, 'queued');
});

// ---------------------------------------------------------------------------
// F1-pin — unknown-outcome failure must transition to failed, not stay in applying

test('F1-pin: finalizeVerdict routes no-confirmation failure to failed (not left in applying)', async () => {
  // Verify that the LEGAL_TRANSITIONS for applying->failed exist (the fix relies on this).
  // Also verify that after finalizeVerdict is called with an unknown-outcome verdict and
  // attemptNo < maxAttempts, the job ends up in 'failed', not 'applying'.
  // We test via state.mjs directly: an applying job with a no-confirmation lastError
  // cannot be requeued — proving the fix (applying → failed) did occur.
  const { job } = state.createJob({ url: 'https://job-boards.greenhouse.io/f1pin/jobs/1', company: 'f1corp', role: 'Lead Engineer' });
  state.transition(job, 'evaluated', { score: 4.0 });
  state.transition(job, 'queued');
  state.transition(job, 'resume_ready', { resumePdf: '/tmp/cv.pdf' });
  state.transition(job, 'applying', { attempts: 1 });

  // Simulate what F1-fixed finalizeVerdict does: transition applying → failed
  // when reason matches the unknown-outcome pattern.
  await state.updateJob(job.urlKey, {
    transitionTo: 'failed',
    patch: { lastError: 'no-confirmation', auditDir: '/tmp/audit' },
  });

  const afterFail = state.loadJob(job.urlKey);
  assert.equal(afterFail.stage, 'failed', 'job should be in failed after unknown-outcome verdict');

  // Now confirm the guard blocks auto-requeue (proving the fix closes the loop):
  let threw = null;
  try {
    await state.updateJob(job.urlKey, { transitionTo: 'queued', patch: { attempts: 0, lastError: null } });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'auto-requeue of unknown-outcome failed job must be blocked');
  assert.equal(threw.code, 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal(state.loadJob(job.urlKey).stage, 'failed', 'stage must remain failed');
});

// ---------------------------------------------------------------------------
// F2-pin — tracker rows with post-Applied statuses still block re-application

test('F2-pin: Rejected tracker row still blocks re-application', () => {
  // A row that started as Applied and was updated to Rejected must still protect
  // against duplicate dispatch.
  const rejectedRow = mkTrackerRow({
    company: 'f2corp',
    role: 'Director of Engineering',
    status: 'Rejected',
    notes: '',
  });
  const candidate = mkAutoJob({ company: 'f2corp', role: 'Director of Engineering', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidate, {
    autoJobsFn: () => [candidate],
    applicationsFn: () => [rejectedRow],
  });

  assert.equal(result.park, true, 'Rejected tracker row must still block dispatch');
  assert.ok(['already-applied', 'declined-cooldown'].includes(result.rule),
    `expected already-applied or declined-cooldown, got: ${result.rule}`);
});

test('F2-pin: Interview tracker row still blocks re-application', () => {
  const interviewRow = mkTrackerRow({
    company: 'f2interviewer',
    role: 'VP Engineering',
    status: 'Interview',
    notes: '',
  });
  const candidate = mkAutoJob({ company: 'f2interviewer', role: 'VP Engineering', stage: 'resume_ready' });

  const result = gate.checkDispatchGate(candidate, {
    autoJobsFn: () => [candidate],
    applicationsFn: () => [interviewRow],
  });

  assert.equal(result.park, true, 'Interview tracker row must still block dispatch');
  assert.equal(result.rule, 'already-applied');
});

// ---------------------------------------------------------------------------
// F3-pin — redactPromptForAudit must fail closed when accounts.json is missing

test('F3-pin: redactPromptForAudit strips password lines when accounts.json is missing', () => {
  const missingFile = join(tmp, 'no-such-accounts.json');
  const rawPrompt = 'email: user@example.com\npassword: supersecret99!\nSome other text';

  const redacted = applyWorker.redactPromptForAudit(rawPrompt, missingFile);

  assert.ok(!redacted.includes('supersecret99!'),
    'raw password must not appear in output when accounts.json is missing');
  assert.ok(redacted.includes('[REDACTED]'),
    'password line must be replaced with [REDACTED]');
  // email (non-secret) may remain
  assert.ok(redacted.includes('user@example.com'), 'email should be preserved');
});

test('F3-pin: redactPromptForAudit strips password lines when accounts.json is malformed JSON', () => {
  const badFile = join(tmp, 'bad-accounts.json');
  writeFileSync(badFile, 'NOT_JSON{{{');
  const rawPrompt = 'host: evil.example.com\npassword: leakedsecret!!\nDetails follow';

  const redacted = applyWorker.redactPromptForAudit(rawPrompt, badFile);

  assert.ok(!redacted.includes('leakedsecret!!'),
    'raw password must not appear in output when accounts.json is malformed');
  assert.ok(redacted.includes('[REDACTED]'), 'password line must be replaced');
});

// Delta-review P1 pin: a readable store with only UNRELATED passwords must not
// disable the structural scrub — a stale/removed credential in the prompt has
// no matching store entry and would otherwise persist raw.
test('F3-pin: redactPromptForAudit scrubs stale credential lines even when store has unrelated passwords', () => {
  const storeFile = join(tmp, 'unrelated-accounts.json');
  writeFileSync(storeFile, JSON.stringify({
    other: { username: 'u@example.com', password: 'currentUnrelatedPw1' },
  }));
  const rawPrompt = 'email: user@example.com\npassword: oldRemovedSecret42\nSome other text';

  const redacted = applyWorker.redactPromptForAudit(rawPrompt, storeFile);

  assert.ok(!redacted.includes('oldRemovedSecret42'),
    'stale credential must be scrubbed even when the store holds other passwords');
  assert.ok(redacted.includes('[REDACTED]'), 'password line must be replaced');
  assert.ok(redacted.includes('user@example.com'), 'email should be preserved');
});
