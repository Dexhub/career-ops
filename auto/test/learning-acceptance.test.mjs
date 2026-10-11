// auto/test/learning-acceptance.test.mjs — T25 (first half): acceptance
// matrix rows A01–A17 as independently named tests over the shared driver in
// helpers/learning-matrix.mjs. Real store/resolvers/checkpoints/workflow;
// instrumented fakes with call counters; synthetic values only; isolated
// mkdtemp roots; node:test only. A18–A34 live in learning-adversarial.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMatrixDriver, F, MIN, SHA_A, SHA_B, TENANT, LOGIN_REF, CRED_REF,
  snapshot, standingSource,
} from './helpers/learning-matrix.mjs';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

let d; // the matrix driver
before(async () => { d = await createMatrixDriver(); });
after(() => d.cleanup());

// -- first assertion of the suite: isolation ---------------------------------

test('A00 isolation: all roots live under the mkdtemp scratch dir, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(d.fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!d.fixture.dataRoot.startsWith(repoRoot));
  assert.equal(process.env.CAREER_OPS_ROOT, d.fixture.dataRoot);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(d.fixture.dataRoot + sep));
});

// -- A01–A06: answers, scope, invalidation, approval, revocation -------------

test('A01 exact approved repeat question reuses the approved answer with zero model calls', () => {
  const policy = {
    mappings: [{
      normalizedText: 'what is your notice period',
      fileKey: 'standing', selector: 'custom.notice_period', sha256: SHA_A,
    }],
    modelClient: d.model,
  };
  const sources = snapshot([standingSource(SHA_A, { 'custom.notice_period': '4 weeks' })]);
  const result = d.answers.resolveAnswer(d.ctx, { observation: F.noticeQuestion, sourceSnapshot: sources, policy });
  assert.equal(result.status, 'ready');
  assert.equal(result.value, '4 weeks');
  assert.equal(d.model.calls, 0, 'reuse must not invoke the model');
  d.cov.reuses += 1;
});

test('A02 different jurisdiction/time-horizon/currency refuses cross-scope reuse', async () => {
  // Approved base-salary USD answer exists…
  await d.seedApprovedAnswer({ famId: 'fam-a02-salary', ansId: 'ans-a02-salary', observation: F.baseSalaryUSD });
  const sources = snapshot([standingSource(SHA_A, { 'custom.synthetic': '123000' })]);
  // …but the total-compensation CAD question never reuses it.
  const cad = d.answers.resolveAnswer(d.ctx, { observation: F.totalCompensationCAD, sourceSnapshot: sources, policy: {} });
  assert.equal(cad.status, 'blocked');
  assert.equal(cad.value, null);
  assert.match(cad.reason, /missing_information/);
  // Approved current-authorization answer never reaches the future-horizon question.
  await d.seedApprovedAnswer({ famId: 'fam-a02-auth', ansId: 'ans-a02-auth', observation: F.currentAuthorization });
  const future = d.answers.resolveAnswer(d.ctx, { observation: F.futureSponsorship, sourceSnapshot: sources, policy: {} });
  assert.notEqual(future.status, 'ready');
  assert.equal(future.value, null);
  d.cov.preventedReuses += 1;
});

test('A03 source changed after caching: the cached answer is invalidated before any fill', async () => {
  const observation = { originalText: 'Synthetic A03 cached-reuse question?', fieldType: 'text', locale: 'en-US' };
  await d.seedApprovedAnswer({ famId: 'fam-a03', ansId: 'ans-a03', observation });
  const sources = snapshot([standingSource(SHA_A, { 'custom.synthetic': 'Synthetic retained value' })]);
  const before1 = d.answers.resolveAnswer(d.ctx, { observation, sourceSnapshot: sources, policy: {} });
  assert.equal(before1.status, 'ready', 'cache resolves while the source is unchanged');
  assert.equal(before1.value, 'Synthetic retained value');
  d.cov.reuses += 1;
  // The underlying source changes AFTER the answer was cached/approved.
  const summary = await d.answers.invalidateSource(d.ctx, { fileKey: 'standing', oldHash: SHA_A, newHash: SHA_B });
  assert.ok(summary.staleAnswers.includes('ans-a03'));
  assert.equal(d.store.getRecord(d.ctx, 'answers', 'ans-a03').status, 'stale');
  const after1 = d.answers.resolveAnswer(d.ctx, { observation, sourceSnapshot: sources, policy: {} });
  assert.notEqual(after1.status, 'ready');
  assert.equal(after1.value, null, 'a stale fact never fills a form');
  d.cov.preventedReuses += 1;
  // Restore the other approved answers for later rows: re-seeding not needed —
  // rows below bind their own hashes explicitly.
});

test('A04 a previously generated answer accepted on success never becomes a personal fact', async () => {
  // Resolution: a stored generated draft is needs_confirmation, never ready.
  await d.seedApprovedAnswer({
    famId: 'fam-a04', ansId: 'ans-a04', observation: F.optionalLanguage,
    answerData: { kind: 'draft', authority: 'generated' },
  });
  const sources = snapshot([standingSource(SHA_A, { 'custom.synthetic': 'Deutsch' })]);
  const result = d.answers.resolveAnswer(d.ctx, { observation: F.optionalLanguage, sourceSnapshot: sources, policy: {} });
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.value, null);
  // Import: a generated audit row keeps source 'generated', never user_confirmed.
  const out = d.evidence.normalizeAuditAnswers(
    { Questions: { 'Why us': { value: 'synthetic essay', source: 'generated' } } });
  assert.equal(out.entries[0].source, 'generated');
  assert.notEqual(out.entries[0].source, 'user_confirmed');
  d.cov.preventedReuses += 1;
});

test('A05 answer -> reload -> resume uses the committed source version', async () => {
  const standingPath = d.answers.standingSourcePath(d.ctx);
  const beforeHash = d.answers.hashFileHex(standingPath);
  const proposal = await d.answers.proposeAnswer(d.ctx, {
    question: { normalizedText: 'synthetic a05 resume question?', originalText: 'Synthetic A05 resume question?', fieldType: 'text' },
    fileKey: 'standing',
    selector: 'custom.synthetic a05 resume question?',
    proposedValue: 'Synthetic A05 committed answer',
    sourceHash: beforeHash,
    affectedApplicationIds: ['app-fixture-a05'],
    scope: {},
  });
  const approval = d.answers.createUserApproval({ approvedBy: 'synthetic-harness-user' });
  const applied = await d.answers.approveAnswer(d.ctx, {
    proposalId: proposal.id, expectedRevision: proposal.revision, approval,
  });
  assert.equal(applied.status, 'applied');
  // Reload: a fresh context on the same roots sees the committed version…
  const ctx2 = d.createLearningContext({
    codeRoot: d.fixture.codeRoot, dataRoot: d.fixture.dataRoot, now: d.clock.now,
  });
  const answer = d.store.getRecord(ctx2, 'answers', `ans-${proposal.id}`);
  assert.equal(answer.status, 'approved');
  assert.equal(answer.data.sourceRefs[0].sha256, applied.sourceHash);
  // …and resume resolves against the COMMITTED hash, not the pre-answer one.
  const observation = {
    originalText: 'Synthetic A05 resume question?', fieldType: 'text', locale: 'en-US',
  };
  const policy = {
    mappings: [{
      normalizedText: d.questions.normalizeQuestion(observation).normalizedText,
      fileKey: 'standing', selector: 'custom.synthetic a05 resume question?', sha256: applied.sourceHash,
    }],
    modelClient: d.model,
  };
  const committedSources = snapshot([standingSource(applied.sourceHash,
    { 'custom.synthetic a05 resume question?': 'Synthetic A05 committed answer' })]);
  const resumed = d.answers.resolveAnswer(ctx2, { observation, sourceSnapshot: committedSources, policy });
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.value, 'Synthetic A05 committed answer');
  // The STALE pre-commit snapshot never fills.
  const staleSources = snapshot([standingSource(beforeHash,
    { 'custom.synthetic a05 resume question?': 'Synthetic A05 committed answer' })]);
  assert.notEqual(
    d.answers.resolveAnswer(ctx2, { observation, sourceSnapshot: staleSources, policy }).status,
    'ready');
  d.cov.reuses += 1;
});

test('A06 revoking a source marks dependent answers revoked, not reusable', async () => {
  await d.store.commitRecord(d.ctx, 'answers', 'ans-a06-revoke', {
    questionFamilyId: 'fam-a06', kind: 'source_reference', authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'cv', selector: 'cv.synthetic_section', sha256: SHA_A }],
    scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [`cv@${SHA_A}`] });
  const summary = await d.answers.invalidateSource(d.ctx, { fileKey: 'cv', oldHash: SHA_A, newHash: null });
  assert.equal(summary.deleted, true);
  assert.deepEqual(summary.revokedAnswers, ['ans-a06-revoke']);
  assert.equal(d.store.getRecord(d.ctx, 'answers', 'ans-a06-revoke').status, 'revoked');
  d.cov.preventedReuses += 1;
});

// -- A07–A10: observations, coverage, legacy evidence -------------------------

test('A07 the same question across retries keeps one occurrence without inflating metrics', async () => {
  const first = await d.questions.recordOccurrence(d.ctx, F.currentAuthorization);
  assert.equal(first.deduplicated, false);
  assert.equal(first.fieldRevision, 1);
  d.cov.observations += 1;
  const retry = await d.questions.recordOccurrence(d.ctx, { ...F.currentAuthorization, attemptId: 'att-matrix-retry-1' });
  assert.equal(retry.occurrenceId, first.occurrenceId, 'retry maps to the same occurrence');
  assert.equal(retry.deduplicated, true, 'retry does not create a new occurrence');
  assert.equal(retry.fieldRevision, 1, 'metrics are not inflated by retries');
  assert.equal(d.store.getRecord(d.ctx, 'observations', first.occurrenceId).revision, 1);
});

test('A08 an unreached conditional step records a coverage gap, never an invented question', async () => {
  const res = await d.questions.recordOccurrence(d.ctx, {
    ...F.conditionalRelocation, coverage: 'not_reached',
  });
  const stored = d.store.getRecord(d.ctx, 'observations', res.occurrenceId);
  assert.equal(stored.data.coverage, 'not_reached', 'the gap is recorded explicitly');
  assert.equal(stored.data.answerDisposition, 'unanswered', 'no answer is invented for it');
  assert.equal(stored.data.answerRef, null);
  d.cov.observations += 1;
  // The unreached question never resolves to a fillable value.
  const result = d.answers.resolveAnswer(d.ctx, {
    observation: F.conditionalRelocation,
    sourceSnapshot: snapshot([standingSource(SHA_B, {})]),
    policy: {},
  });
  assert.notEqual(result.status, 'ready');
  assert.equal(result.value, null);
});

test('A09 object-form legacy answers: import, verifyAudit and diagnostics agree without crashing', () => {
  const keyed = { Contact: { Email: { value: 'sample@example.invalid', source: 'profile' } } };
  const normalized = d.evidence.normalizeAuditAnswers(keyed);
  assert.equal(normalized.entries.length, 1);
  assert.equal(normalized.entries[0].label, 'Email');
  assert.equal(normalized.rejected.length, 0);
  // verifyAudit accepts the legacy keyed representation.
  const legacyAudit = { my_information: { name: 'X' }, application_questions: [] };
  assert.equal(d.verifyAudit(d.makeAuditDir({ app: 'legacy-app', answers: legacyAudit }), { submit: false }).ok, true);
  // diagnostics renders normalized object-form answers without crashing.
  assert.doesNotThrow(() => d.diagnose.buildReport([{
    app: 'legacy-app', attempt: 'attempt-a09', dir: '/fixture',
    result: { status: 'filled_no_submit' },
    verdict: { status: 'filled_no_submit', ok: true, reason: '' },
    answers: normalized.entries, answersGap: null, error: null,
  }]));
});

test('A10 missing or overwritten evidence surfaces as an explicit gap, not silent success', async () => {
  d.makeAuditDir({ app: 'gap-app' }); // no answers.json at all
  d.makeAuditDir({ app: 'gap-app', answersRaw: '{broken' }); // malformed
  const attempts = d.diagnose.collectAttempts(join(d.fixture.root, 'output'));
  const gapStates = attempts.filter((a) => a.app === 'gap-app').map((a) => a.answersGap).sort();
  assert.ok(gapStates.includes('missing'));
  assert.ok(gapStates.includes('malformed'));
  const report = d.diagnose.buildReport(attempts.filter((a) => a.app === 'gap-app'));
  assert.ok(report.includes('Evidence gaps'));
  // Learning capture reports the same gap instead of inventing observations.
  const missingDir = d.makeAuditDir({ app: 'gap-app' });
  const captured = await d.evidence.captureAttempt(d.ctx, { attemptDir: missingDir, apply: true });
  assert.equal(captured.added, 0);
  assert.deepEqual(captured.coverage.gaps.map((g) => g.type), ['missing_answers']);
});

// -- A11–A12: panel vs worker, immutable attempts ------------------------------

test('A11 a panel hold landed during a worker run survives the worker final patch', async () => {
  const job = d.seedJob(`https://${TENANT}/a11-holdco/1`, 'a11-holdco');
  // Worker claims the job and remembers its record version (no lock held).
  const claimed = await d.state.updateJob(job.urlKey, {
    transitionTo: 'applying',
    patch: { attempts: 1, execution: { attemptId: 'att-a11', phase: 'in_progress' } },
  });
  // Panel decision while the worker runs: hold.
  await d.state.updateJob(job.urlKey, { patch: { held: true } });
  // The worker's final patch with its stale version is refused (CAS)…
  await assert.rejects(
    d.state.updateJob(job.urlKey, {
      expectedVersion: claimed.recordVersion, patch: { lastError: 'synthetic worker summary' },
    }),
    (e) => e.code === 'VERSION_CONFLICT',
  );
  // …so the worker rereads and reapplies; the hold is preserved either way.
  const fresh = d.state.loadJob(job.urlKey);
  await d.state.updateJob(job.urlKey, {
    expectedVersion: fresh.recordVersion, patch: { lastError: 'synthetic worker summary' },
  });
  const done = d.state.loadJob(job.urlKey);
  assert.equal(done.held, true, 'the panel hold must not be lost');
  assert.equal(done.lastError, 'synthetic worker summary');
});

test('A12 requeue allocates a fresh immutable attempt dir; the old audit dir is untouched', async () => {
  const { readdirSync } = await import('node:fs');
  const dirHash = (dir) => {
    const h = createHash('sha256');
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      h.update(entry.name); h.update('\0');
      if (entry.isFile()) h.update(readFileSync(join(dir, entry.name)));
    }
    return h.digest('hex');
  };
  const job = d.seedJob(`https://${TENANT}/a12-attemptco/1`, 'a12-attemptco');
  const { attempt: first } = await d.claimAttempt(job.urlKey, { submissionPossible: false });
  writeFileSync(join(first.auditDir, 'result.json'), JSON.stringify({ status: 'failed', reason: 'synthetic form error' }));
  const originalHash = dirHash(first.auditDir);
  // Panel: hold, park, requeue.
  await d.state.updateJob(job.urlKey, { patch: { held: true } });
  await d.state.updateJob(job.urlKey, { transitionTo: 'parked', patch: {} });
  await d.requeue(job.urlKey);
  const cur = d.state.loadJob(job.urlKey);
  assert.equal(cur.attempts, 0, 'requeue reset the retry budget');
  const second = d.state.allocateAttempt({
    job: cur, auditRoot: join(d.fixture.dataRoot, 'output', cur.company, 'audit'),
  });
  assert.notEqual(second.attemptId, first.attemptId);
  assert.notEqual(second.auditDir, first.auditDir);
  assert.equal(second.applicationId, cur.applicationId, 'same application identity');
  assert.equal(dirHash(first.auditDir), originalHash, 'old audit dir is immutable');
  assert.equal(d.state.loadJob(job.urlKey).held, true, 'the hold survives the requeue');
});

// -- A13–A16: accounts, verification, submission recovery ----------------------

test('A13 delayed verification across restarts: exactly one account, correct tenant, same application', async () => {
  const job = d.seedJob(`https://${TENANT}/a13-delayed/1`, 'a13-delayed-co',
    { stages: ['evaluated', 'queued', 'resume_ready', 'applying'] });
  const originalApplicationId = job.applicationId;
  const tenant = 'a13-delayed.vendor.test';
  d.mailbox.reset();
  // The ATS delivers the verification mail 3 minutes after the request.
  const base = d.clock.now().getTime();
  d.mailbox.messages.push({
    recipientRef: 'alias-a13', tenant, kind: 'verification',
    sentAt: new Date(base + 3 * MIN).toISOString(), destinationHost: tenant,
    deliverAt: base + 3 * MIN,
  });
  const resume = async () => {
    const res = await d.workflow.beginVerificationWait(d.ctx, {
      applicationId: job.applicationId, attemptId: 'att-a13-1',
      account: { tenant, employerId: 'a13-delayed-co', loginIdentityRef: LOGIN_REF, credentialRef: CRED_REF },
      recipientRef: 'alias-a13',
    }, { jobs: d.state });
    if (res.created) d.accounts.created += 1;
    if (res.status !== 'waiting') return res;
    d.clock.advance(2 * MIN); // bounded interval, never a tight poll
    return d.workflow.checkVerification(d.ctx, { blockerId: res.blocker.id, mailbox: d.mailbox }, { jobs: d.state });
  };
  await resume(); // restart 1: still waiting (mail not delivered yet)
  const final = await resume(); // restart 2: mail delivered, verified
  assert.equal(final.status, 'verified');
  assert.equal(final.account.data.tenant, tenant, 'account bound to the correct tenant');
  assert.equal(d.accounts.created, 1, 'exactly one account across restarts');
  const current = d.state.loadJob(job.urlKey);
  assert.equal(current.applicationId, originalApplicationId, 'same application resumed');
  assert.equal(current.execution.phase, 'preparing');
  d.cov.blockersResolved += 1; // the verification blocker went pending -> resolved
});

test('A14 wrong or stale verification messages are never used and the mailbox stays untouched', async () => {
  const job = d.seedJob(`https://${TENANT}/a14-noise/1`, 'a14-noise-co',
    { stages: ['evaluated', 'queued', 'resume_ready', 'applying'] });
  const tenant = 'a14-noise.vendor.test';
  d.mailbox.reset();
  const base = d.clock.now().getTime();
  d.mailbox.messages.push(
    // Verification for ANOTHER tenant/employer.
    { recipientRef: 'alias-other', tenant: 'elsewhere.vendor.test', kind: 'verification', sentAt: new Date(base).toISOString(), destinationHost: 'elsewhere.vendor.test', deliverAt: base },
    // STALE verification sent before the request existed.
    { recipientRef: 'alias-a14', tenant, kind: 'verification', sentAt: new Date(base - 30 * MIN).toISOString(), destinationHost: tenant, deliverAt: base - 30 * MIN },
    // Marketing noise.
    { recipientRef: 'alias-a14', tenant, kind: 'marketing', sentAt: new Date(base).toISOString(), destinationHost: tenant, deliverAt: base, body: 'synthetic marketing http://marketing.test/opt-in' },
  );
  const begun = await d.workflow.beginVerificationWait(d.ctx, {
    applicationId: job.applicationId, attemptId: 'att-a14-1',
    account: { tenant, employerId: 'a14-noise-co', loginIdentityRef: LOGIN_REF, credentialRef: CRED_REF },
    recipientRef: 'alias-a14',
  }, { jobs: d.state });
  assert.equal(begun.status, 'waiting');
  d.clock.advance(1 * MIN);
  const check = await d.workflow.checkVerification(d.ctx, { blockerId: begun.blocker.id, mailbox: d.mailbox }, { jobs: d.state });
  assert.equal(check.status, 'waiting', 'noise and stale messages never verify');
  assert.equal(d.mailbox.unrelatedReads, 0, 'only narrow scoped reads — the mailbox is otherwise untouched');
  const stored = JSON.stringify(d.store.getRecord(d.ctx, 'blockers', begun.blocker.id));
  assert.ok(!stored.includes('http'), 'no link or body is persisted as a lesson');
});

test('A15 timeout after a possible submit: outcome unknown, no second submit, resolution clears it', async () => {
  const seeded = d.seedJob(`https://${TENANT}/a15-timeout/1`, 'a15-timeout-co');
  const { job, attempt } = await d.claimAttempt(seeded.urlKey);
  // The dying worker leaves a success NARRATIVE and a screenshot — nothing bound.
  writeFileSync(join(attempt.auditDir, 'result.json'),
    JSON.stringify({ status: 'submitted', confirmation_text: 'Thanks! (synthetic)' }));
  writeFileSync(join(attempt.auditDir, '02-confirmation.png'), 'png');
  const rec = await d.workflow.reconcileAttempt(d.ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: d.state });
  assert.equal(rec.status, 'unknown', 'a narrative is not confirmation');
  assert.ok(rec.blockerId);
  assert.equal(d.store.getRecord(d.ctx, 'blockers', rec.blockerId).status, 'open');
  const fresh = d.state.loadJob(job.urlKey);
  assert.equal(fresh.execution.submissionOutcome, 'unknown');
  // No second submit: a generic requeue is refused while the outcome is unknown.
  await d.state.updateJob(job.urlKey, { transitionTo: 'parked', patch: {} });
  await assert.rejects(d.requeue(job.urlKey), (e) => e.code === 'SUBMISSION_OUTCOME_UNKNOWN');
  // A read-only human portal review later settles it; the blocker resolves.
  const settled = await d.workflow.reconcileAttempt(d.ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { resolution: { outcome: 'submitted', by: 'operator-portal-review' } },
  }, { jobs: d.state });
  assert.equal(settled.status, 'confirmed');
  assert.equal(d.store.getRecord(d.ctx, 'blockers', rec.blockerId).status, 'resolved');
  d.cov.blockersResolved += 1;
});

test('A16 a confirmation belonging to another job or tenant is never accepted', async () => {
  const seeded = d.seedJob(`https://${TENANT}/a16-mismatch/1`, 'a16-mismatch-co');
  const { job, attempt } = await d.claimAttempt(seeded.urlKey);
  // A thank-you capture bound to the WRONG tenant contradicts the attempt.
  d.writeBoundConfirmation(attempt.auditDir, {
    attemptId: attempt.attemptId, employerId: 'a16-mismatch-co', tenant: 'jobs.other-tenant.test',
  });
  const rec = await d.workflow.reconcileAttempt(d.ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { auditDir: attempt.auditDir },
  }, { jobs: d.state });
  assert.equal(rec.status, 'unknown');
  assert.match(rec.reason, /contradicts/);
  // A capture bound to ANOTHER attempt id never confirms this one.
  const foreign = {
    attemptId: 'att-someone-elses', employerId: 'a16-mismatch-co', tenant: TENANT,
    sourceArtifact: 'learning/confirmation-page.json',
    capturedAt: new Date(Date.now() + MIN).toISOString(),
  };
  const rec2 = await d.workflow.reconcileAttempt(d.ctx, {
    applicationId: job.applicationId, attemptId: attempt.attemptId,
    evidence: { confirmation: foreign },
  }, { jobs: d.state });
  assert.equal(rec2.status, 'unknown');
  assert.equal(d.state.loadJob(job.urlKey).execution.submissionOutcome, 'unknown');
});

// -- A17: tracker repair --------------------------------------------------------

test('A17 tracker write fails after a confirmed submit: submitted stands, retry bookkeeping only, later repaired', async () => {
  const { job, reportNum } = d.seedSubmittedJob('a17-repairco');
  await d.workflow.ensureSyncTask(d.ctx, { job });
  // First sync attempt: the canonical tracker is locked -> failure retained.
  const broken = d.fakeTracker([]);
  broken.tracker.listApplications = () => { throw new Error('tracker locked by another writer'); };
  const failed = await d.runSync(job, broken, { now: new Date('2026-10-11T00:00:00Z') });
  assert.equal(failed.failed, 1);
  const taskId = d.workflow.trackerSyncTaskId(job);
  let task = d.store.getRecord(d.ctx, 'syncTasks', taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.data.attempts, 1, 'retry bookkeeping only');
  assert.match(task.data.lastError, /tracker locked/);
  let after = d.state.loadJob(job.urlKey);
  assert.equal(after.stage, 'submitted', 'the submitted stage is never rolled back');
  assert.equal(after.trackerSync.status, 'pending');
  // After the backoff, a working tracker repairs the row and completes the task.
  const fixedT = d.fakeTracker([d.trackerRow(1, reportNum, { company: 'a17-repairco', url: job.urlKey })]);
  const repaired = await d.runSync(job, fixedT, {
    now: new Date(Date.parse('2026-10-11T00:00:00Z') + d.workflow.TRACKER_SYNC_BACKOFF_BASE_MS + MIN),
  });
  assert.equal(repaired.completed, 1);
  assert.deepEqual(fixedT.calls.setStatus, [{ reportNum, status: 'Applied' }]);
  task = d.store.getRecord(d.ctx, 'syncTasks', taskId);
  assert.equal(task.status, 'done');
  after = d.state.loadJob(job.urlKey);
  assert.equal(after.stage, 'submitted');
  assert.equal(after.trackerSync.status, 'complete');
  d.cov.trackerRepairs += 1;
});

// -- summary: the matrix exercised every coverage dimension ---------------------

test('A01–A17 summary: nonzero observations, real reuse, prevented bad reuse, resolved blocker, tracker repair', () => {
  assert.ok(d.cov.observations > 0, `observations recorded: ${d.cov.observations}`);
  assert.ok(d.cov.reuses >= 1, `actual reuses: ${d.cov.reuses}`);
  assert.ok(d.cov.preventedReuses >= 1, `prevented bad reuses: ${d.cov.preventedReuses}`);
  assert.ok(d.cov.blockersResolved >= 1, `blockers pending -> resolved: ${d.cov.blockersResolved}`);
  assert.ok(d.cov.trackerRepairs >= 1, `tracker repairs: ${d.cov.trackerRepairs}`);
  assert.equal(d.model.calls, 0, 'no matrix row silently fell back to the model');
});
