// auto/test/learning-account-flow.test.mjs — T13: account memory and
// verification waits. Fake browser/email only: an injected clock and an
// injected mailbox transport stand in for Neo and Gmail; nothing real is ever
// touched. Repeated delayed-verification resumes must create exactly ONE fake
// account and read zero unrelated mail. node:test only; synthetic values only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture } from './helpers/learning.mjs';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

const T0 = Date.parse('2026-10-11T00:00:00Z');
const MIN = 60_000;

let fixture;
let ctx;
let state;
let workflow;
let getRecord; let listRecords; let commitRecord;

// Injected advancing clock (never the wall clock).
let nowMs = T0;
const clock = { now: () => new Date(nowMs), advance: (ms) => { nowMs += ms; } };

// Fake mailbox transport: messages become visible at deliverAt. A SCOPED
// search (recipient + tenant + since — what the workflow must always send)
// filters server-side by recipient and delivery like a real narrow query but
// still returns near-miss messages (other tenant, stale) so the workflow's
// own validation is exercised. An UNSCOPED search is a broad mailbox read:
// every message it returns counts as an unrelated read.
const fakeMailbox = {
  messages: [],
  unrelatedReads: 0,
  reset() { this.messages = []; this.unrelatedReads = 0; },
  async search({ recipientRef, tenant, since } = {}) {
    const delivered = this.messages.filter((m) => m.deliverAt <= nowMs);
    if (!recipientRef || !tenant || !since) {
      this.unrelatedReads += delivered.length;
      return delivered;
    }
    return delivered.filter((m) => m.recipientRef === recipientRef);
  },
};

// Fake account counter driven by the public workflow result.
const fakeAccounts = { created: 0 };

const LOGIN_REF = 'login-identity-01';
const CRED_REF = 'credstore:synthetic/alpha';

function seedJob(url, company) {
  const { job } = state.createJob({ url, company, role: 'Engineer', ats: 'synthetic' });
  for (const stage of ['evaluated', 'queued', 'resume_ready', 'applying']) state.transition(job, stage, {});
  state.saveJob(job);
  return state.loadJob(job.urlKey);
}

before(async () => {
  fixture = createLearningFixture();
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'),
    'schema_version: 1\nenabled: true\nmode: shadow\n');
  state = await import('../state.mjs');
  workflow = await import('../learning/workflow.mjs');
  ({ getRecord, listRecords, commitRecord } = await import('../learning/store.mjs'));
  const { createLearningContext } = await import('../learning/context.mjs');
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: clock.now });
});
after(() => fixture.cleanup());

test('fixture isolation: all roots live under the scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.dataRoot);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fixture.dataRoot + sep));
});

test('account memory is keyed by employer/tenant/login identity, never the shared vendor host', () => {
  const a = workflow.accountIdFor({ tenant: 'acme.vendor.test', employerId: 'acme', loginIdentityRef: LOGIN_REF });
  const b = workflow.accountIdFor({ tenant: 'other.vendor.test', employerId: 'other', loginIdentityRef: LOGIN_REF });
  const c = workflow.accountIdFor({ tenant: 'acme.vendor.test', employerId: 'acme', loginIdentityRef: LOGIN_REF });
  // Same ATS vendor host family, different tenant -> DIFFERENT account.
  assert.notEqual(a, b);
  // Same employer/tenant/login identity -> always the SAME account.
  assert.equal(a, c);
});

test('credential REFERENCES only: plaintext-shaped values are refused and never stored', async () => {
  await assert.rejects(workflow.ensureAccount(ctx, {
    tenant: 'guard.vendor.test', employerId: 'guard', loginIdentityRef: LOGIN_REF,
    credentialRef: 'hunter2 synthetic-plaintext=secret',
  }), (err) => err.code === 'FORBIDDEN_KEY');
  // The contracts layer refuses secret-bearing keys outright.
  await assert.rejects(commitRecord(ctx, 'accounts', 'acct-guard-direct', {
    tenant: 'guard.vendor.test', employerId: 'guard', loginIdentityRef: LOGIN_REF,
    credentialRef: CRED_REF, lifecycle: 'existing', createdAtSource: null, lastUsedAt: null,
    password: 'synthetic-plaintext',
  }, { expectedRevision: 0, status: 'active', sourceIds: [] }),
  (err) => err.code === 'FORBIDDEN_KEY' || err.code === 'SCHEMA_VALIDATION');
  // Nothing plaintext-shaped reached the ledger.
  const root = join(fixture.dataRoot, 'data', 'learning');
  const bytes = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else bytes.push(readFileSync(p, 'utf8'));
    }
  };
  try { walk(root); } catch { /* ledger may not exist yet */ }
  assert.ok(!bytes.join('\n').includes('synthetic-plaintext'));
});

test('existing authorized account: ready immediately, no new account, no blocker', async () => {
  seedJob('https://jobs.example.test/known-co/1', 'known-co');
  const job = state.listJobs('applying').map((j) => state.loadJob(j.urlKey))
    .find((j) => j.company === 'known-co');
  const seeded = await workflow.ensureAccount(ctx, {
    tenant: 'known.vendor.test', employerId: 'known-co', loginIdentityRef: LOGIN_REF,
    credentialRef: CRED_REF, lifecycle: 'existing',
  });
  assert.ok(seeded.created);
  const res = await workflow.beginVerificationWait(ctx, {
    applicationId: job.applicationId, attemptId: 'att-known-1',
    account: { tenant: 'known.vendor.test', employerId: 'known-co', loginIdentityRef: LOGIN_REF, credentialRef: CRED_REF, lifecycle: 'existing' },
    recipientRef: 'alias-known',
  }, { jobs: state });
  assert.equal(res.status, 'ready');
  assert.equal(res.created, false);
  assert.equal(state.loadJob(job.urlKey).execution.blockerId, null);
});

test('immediate verification: scoped retrieval validates sender/recipient/timing/destination', async () => {
  const job = seedJob('https://jobs.example.test/fast-co/1', 'fast-co');
  const tenant = 'fast.vendor.test';
  // Mailbox noise that a broad read would pick up: marketing mail, another
  // employer's verification, and a STALE verification sent before the request.
  fakeMailbox.reset();
  fakeMailbox.messages.push(
    { recipientRef: 'alias-fast', tenant, kind: 'marketing', sentAt: new Date(nowMs).toISOString(), destinationHost: tenant, deliverAt: nowMs, body: 'synthetic marketing opt-in http://marketing.test/opt-in' },
    { recipientRef: 'alias-other', tenant: 'elsewhere.vendor.test', kind: 'verification', sentAt: new Date(nowMs).toISOString(), destinationHost: 'elsewhere.vendor.test', deliverAt: nowMs },
    { recipientRef: 'alias-fast', tenant, kind: 'verification', sentAt: new Date(nowMs - 30 * MIN).toISOString(), destinationHost: tenant, deliverAt: nowMs - 30 * MIN },
  );
  const begun = await workflow.beginVerificationWait(ctx, {
    applicationId: job.applicationId, attemptId: 'att-fast-1',
    account: { tenant, employerId: 'fast-co', loginIdentityRef: LOGIN_REF, credentialRef: CRED_REF },
    recipientRef: 'alias-fast',
  }, { jobs: state });
  assert.equal(begun.status, 'waiting');
  assert.equal(state.loadJob(job.urlKey).execution.phase, 'waiting_verification');

  // Only noise: every candidate fails validation -> still waiting, bounded.
  clock.advance(1 * MIN);
  let check = await workflow.checkVerification(ctx, { blockerId: begun.blocker.id, mailbox: fakeMailbox }, { jobs: state });
  assert.equal(check.status, 'waiting');
  assert.ok(Date.parse(check.nextCheckAt) <= Date.parse(begun.blocker.data.deadline));

  // The genuine message arrives: validated and accepted; account verified.
  fakeMailbox.messages.push({
    recipientRef: 'alias-fast', tenant, kind: 'verification',
    sentAt: new Date(nowMs).toISOString(), destinationHost: tenant, deliverAt: nowMs,
  });
  check = await workflow.checkVerification(ctx, { blockerId: begun.blocker.id, mailbox: fakeMailbox }, { jobs: state });
  assert.equal(check.status, 'verified');
  assert.equal(check.account.status, 'active');
  assert.equal(check.account.data.lifecycle, 'verified');
  const after1 = state.loadJob(job.urlKey);
  assert.equal(after1.execution.phase, 'preparing');
  assert.equal(after1.execution.blockerId, null);
  // Narrow scoping was used throughout: zero unrelated reads, and no link,
  // OTP, or message body was persisted as a lesson.
  assert.equal(fakeMailbox.unrelatedReads, 0);
  const stored = JSON.stringify(getRecord(ctx, 'blockers', begun.blocker.id));
  assert.ok(!stored.includes('http'));
  assert.ok(!stored.includes('opt-in'));
});

// --- Delayed verification across restarts: the T13 acceptance scenario -----

let delayedJob;
const DELAYED_TENANT = 'delayed.vendor.test';

/** One "resume": re-enter the wait (idempotent) and run one bounded check. */
async function resumeWithDelayedVerification() {
  const res = await workflow.beginVerificationWait(ctx, {
    applicationId: delayedJob.applicationId, attemptId: 'att-delayed-1',
    account: { tenant: DELAYED_TENANT, employerId: 'delayed-co', loginIdentityRef: LOGIN_REF, credentialRef: CRED_REF },
    recipientRef: 'alias-delayed',
  }, { jobs: state });
  if (res.created) fakeAccounts.created += 1;
  if (res.status !== 'waiting') return res;
  clock.advance(2 * MIN); // bounded interval, never a tight poll
  return workflow.checkVerification(ctx, { blockerId: res.blocker.id, mailbox: fakeMailbox }, { jobs: state });
}

test('delayed verification: repeated resumes create exactly one account and resume the same application', async () => {
  delayedJob = seedJob('https://jobs.example.test/delayed-co/1', 'delayed-co');
  const originalApplicationId = delayedJob.applicationId;
  fakeMailbox.reset();
  // The ATS delivers the verification mail 3 minutes after the request.
  fakeMailbox.messages.push({
    recipientRef: 'alias-delayed', tenant: DELAYED_TENANT, kind: 'verification',
    sentAt: new Date(nowMs + 3 * MIN).toISOString(), destinationHost: DELAYED_TENANT,
    deliverAt: nowMs + 3 * MIN,
  });

  await resumeWithDelayedVerification(fixture);
  await resumeWithDelayedVerification(fixture);
  const currentJob = state.loadJob(delayedJob.urlKey);
  assert.equal(fakeAccounts.created, 1);
  assert.equal(fakeMailbox.unrelatedReads, 0);
  assert.equal(currentJob.applicationId, originalApplicationId);
  assert.equal(currentJob.execution.phase, 'preparing');
});

test('no message: the wait is bounded by the ~10-minute ceiling, never indefinite', async () => {
  const job = seedJob('https://jobs.example.test/silent-co/1', 'silent-co');
  fakeMailbox.reset();
  const begun = await workflow.beginVerificationWait(ctx, {
    applicationId: job.applicationId, attemptId: 'att-silent-1',
    account: { tenant: 'silent.vendor.test', employerId: 'silent-co', loginIdentityRef: LOGIN_REF, credentialRef: CRED_REF },
    recipientRef: 'alias-silent',
    ceilingMinutes: 60, // configurable, but CLAMPED to the 10-minute ceiling
  }, { jobs: state });
  assert.equal(Date.parse(begun.blocker.data.deadline) - Date.parse(begun.blocker.data.requestedAt), 10 * MIN);

  clock.advance(11 * MIN);
  const check = await workflow.checkVerification(ctx, { blockerId: begun.blocker.id, mailbox: fakeMailbox }, { jobs: state });
  assert.equal(check.status, 'expired');
  assert.equal(getRecord(ctx, 'blockers', begun.blocker.id).status, 'expired');
  const after2 = state.loadJob(job.urlKey);
  assert.equal(after2.execution.phase, 'blocked');
  // Expiry never implies creating another account: still exactly one record
  // for this key, left pending for a human.
  const dupes = listRecords(ctx, 'accounts', { limit: 500 }).items
    .filter((a) => a.data.tenant === 'silent.vendor.test');
  assert.equal(dupes.length, 1);
});

test('existing account with unknown password: account_conflict for a human, never a second account', async () => {
  const job = seedJob('https://jobs.example.test/locked-co/1', 'locked-co');
  await workflow.ensureAccount(ctx, {
    tenant: 'locked.vendor.test', employerId: 'locked-co', loginIdentityRef: LOGIN_REF,
    credentialRef: null, lifecycle: 'password_unknown',
  });
  const res = await workflow.beginVerificationWait(ctx, {
    applicationId: job.applicationId, attemptId: 'att-locked-1',
    account: { tenant: 'locked.vendor.test', employerId: 'locked-co', loginIdentityRef: LOGIN_REF },
    recipientRef: 'alias-locked',
  }, { jobs: state });
  assert.equal(res.status, 'conflict');
  assert.equal(res.created, false);
  assert.equal(res.blocker.data.type, 'account_conflict');
  assert.equal(state.loadJob(job.urlKey).execution.phase, 'blocked');
  const accounts = listRecords(ctx, 'accounts', { limit: 500 }).items
    .filter((a) => a.data.tenant === 'locked.vendor.test');
  assert.equal(accounts.length, 1);
  // Human resolution resumes the same application at its safe resume point.
  const resolved = await workflow.resolveBlocker(ctx, {
    blockerId: res.blocker.id, approval: { approvedBy: 'fixture-human' },
  }, { jobs: state });
  assert.equal(resolved.job.applicationId, job.applicationId);
  assert.equal(resolved.job.execution.phase, 'preparing');
});
