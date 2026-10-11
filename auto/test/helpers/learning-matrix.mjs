// auto/test/helpers/learning-matrix.mjs — T25 shared end-to-end fixture
// driver for the acceptance matrix (A01–A17 here; A18–A34 reuse this).
// REAL store/resolvers/checkpoints/workflow + instrumented fakes with call
// counters (model, mailbox, accounts, tracker) — never always-success stubs.
// Everything runs under an mkdtemp CAREER_OPS_ROOT/CAREER_OPS_DB; synthetic
// values only; injected clocks; learning enabled via the fixture config copy.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture } from './learning.mjs';

export const T0 = Date.parse('2026-10-11T00:00:00Z');
export const MIN = 60_000;
export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const TENANT = 'jobs.example.test';
export const LOGIN_REF = 'login-identity-01';
export const CRED_REF = 'credstore:synthetic/alpha';

/** Synthetic CONTRACTS D1 observations shared with the other learning tests. */
export const F = JSON.parse(readFileSync(
  fileURLToPath(new URL('../fixtures/learning/observations.json', import.meta.url)), 'utf-8'));

export const snapshot = (sources) => ({ sources, capturedAt: '2026-10-11T00:00:00.000Z' });
export const standingSource = (sha, values) => ({
  fileKey: 'standing', sha256: sha, valuesBySelector: values,
  publicUse: 'applications_only', confirmedAt: '2026-10-01T00:00:00.000Z',
});

/**
 * createMatrixDriver() -> driver. Must be awaited once per test file (each
 * node:test file is its own process). Imports state/db/apply-worker only
 * AFTER the fixture env + config copies exist, so nothing live is touched.
 */
export async function createMatrixDriver() {
  const fixture = createLearningFixture();
  // Config copies BEFORE any import that resolves roots/config at load.
  writeFileSync(join(fixture.dataRoot, 'config', 'auto.yml'),
    'score_threshold: 4.0\nats_allowlist:\n  - synthetic\n');
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'),
    'schema_version: 1\nenabled: true\nmode: shadow\n');
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'),
    'filled_in_by_user: true\n\ncustom:\n  "existing synthetic question?": "Existing synthetic answer"\n');
  writeFileSync(join(fixture.dataRoot, 'config', 'profile.yml'), 'name: Fixture Person\n');
  writeFileSync(join(fixture.dataRoot, 'cv.md'), '# Synthetic CV\n');
  writeFileSync(join(fixture.dataRoot, 'resume.pdf'), 'synthetic-pdf');

  const state = await import('../../state.mjs');
  const db = await import('../../../core/db.mjs');
  const workflow = await import('../../learning/workflow.mjs');
  const store = await import('../../learning/store.mjs');
  const answers = await import('../../learning/answers.mjs');
  const questions = await import('../../learning/questions.mjs');
  const evidence = await import('../../learning/evidence.mjs');
  const diagnose = await import('../../diagnose.mjs');
  const applyWorker = await import('../../apply-worker.mjs');
  const { createLearningContext } = await import('../../learning/context.mjs');

  // Injected advancing clock — never the wall clock.
  let nowMs = T0;
  const clock = { now: () => new Date(nowMs), advance: (ms) => { nowMs += ms; } };
  const ctx = createLearningContext({
    codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: clock.now,
  });

  // ---- instrumented fakes (counters, not always-success stubs) ----
  const model = { calls: 0, draft: () => { model.calls += 1; return 'synthetic-model-draft'; } };

  // Fake mailbox transport: messages become visible at deliverAt. A scoped
  // search filters by recipient; an unscoped search counts unrelated reads.
  const mailbox = {
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

  const accounts = { created: 0 };

  // Coverage counters asserted by the matrix summary test.
  const cov = {
    observations: 0,       // real observation records written
    reuses: 0,             // actual approved-answer reuse (ready, no model)
    preventedReuses: 0,    // bad reuse explicitly refused
    blockersResolved: 0,   // pending blocker -> resolved
    trackerRepairs: 0,     // failed tracker sync later repaired
  };

  // ---- seed helpers (fixture paths only) ----
  let reportSeq = 8200;
  function seedJob(url, company, { stages = ['evaluated', 'queued', 'resume_ready'] } = {}) {
    const { job } = state.createJob({ url, company, role: 'Engineer', ats: 'synthetic' });
    for (const stage of stages) state.transition(job, stage, {});
    Object.assign(job, {
      resumePdf: join(fixture.dataRoot, 'resume.pdf'),
      resumeVariant: 'default',
      reportPath: `reports/${reportSeq += 1}-synthetic.md`,
      score: 4.5,
    });
    state.saveJob(job);
    return state.loadJob(job.urlKey);
  }

  function seedSubmittedJob(company, { markPending = true } = {}) {
    const reportNum = (reportSeq += 1);
    const url = `https://${TENANT}/${company}/${reportNum}`;
    const { job } = state.createJob({ url, company, role: 'Engineer', ats: 'synthetic' });
    for (const stage of ['evaluated', 'queued', 'resume_ready', 'applying', 'submitted']) {
      state.transition(job, stage, {});
    }
    job.reportPath = `reports/${reportNum}-synthetic.md`;
    job.auditDir = join(fixture.dataRoot, 'output', company, 'audit');
    if (markPending) {
      job.trackerSync = { status: 'pending', taskId: workflow.trackerSyncTaskId(job) };
    }
    state.saveJob(job);
    return { job: state.loadJob(job.urlKey), reportNum };
  }

  /** Allocate + persist intent + CAS-claim an attempt, mirroring the worker. */
  async function claimAttempt(urlKey, { launched = true, submissionPossible = true } = {}) {
    let job = state.loadJob(urlKey);
    const attempt = state.allocateAttempt({
      job, auditRoot: join(fixture.dataRoot, 'output', job.company, 'audit'),
      policyVersion: 'pol-1', sourceVersion: 'src-1',
    });
    mkdirSync(join(attempt.auditDir, 'learning'), { recursive: true });
    await workflow.recordAttemptIntent(ctx, {
      applicationId: job.applicationId, attemptId: attempt.attemptId, urlKey,
      policyVersion: 'pol-1', sourceVersion: 'src-1',
      employerId: job.company, tenant: TENANT, allocatedAt: attempt.allocatedAt,
    });
    job = await state.updateJob(urlKey, {
      transitionTo: 'applying',
      patch: {
        attempts: 1, auditDir: attempt.auditDir,
        execution: {
          attemptId: attempt.attemptId, phase: 'in_progress',
          submissionPossible, submissionOutcome: null,
        },
      },
    });
    if (launched) await workflow.markAttemptLaunched(ctx, { attemptId: attempt.attemptId });
    return { job, attempt };
  }

  function writeBoundConfirmation(auditDir, { attemptId, employerId, tenant = TENANT, ...overrides }) {
    writeFileSync(join(auditDir, 'learning', 'confirmation.json'), JSON.stringify({
      attemptId, employerId, tenant,
      sourceArtifact: 'learning/confirmation-page.json',
      capturedAt: new Date(Date.now() + MIN).toISOString(), // after allocation
      ...overrides,
    }));
  }

  /** Fresh audit dir under output/<app>/audit/<attempt> with core artifacts. */
  let auditSeq = 0;
  function makeAuditDir({ app = 'matrix-app', answers: rows, answersRaw } = {}) {
    const dir = join(fixture.root, 'output', app, 'audit', `attempt-${auditSeq += 1}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'filled_no_submit' }));
    writeFileSync(join(dir, '01-form-filled.png'), 'png');
    if (answersRaw !== undefined) writeFileSync(join(dir, 'answers.json'), answersRaw);
    else if (rows !== undefined) writeFileSync(join(dir, 'answers.json'), JSON.stringify(rows));
    return dir;
  }

  /** Approved family + answer bound to a standing selector/hash. */
  async function seedApprovedAnswer({ famId, ansId, observation, selector = 'custom.synthetic', sha = SHA_A, answerData = {}, answerStatus = 'approved' }) {
    const def = questions.normalizeQuestion(observation);
    await store.commitRecord(ctx, 'families', famId, {
      label: `synthetic ${famId}`, questionIds: [def.id], scope: {},
    }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
    await store.commitRecord(ctx, 'answers', ansId, {
      questionFamilyId: famId, kind: 'source_reference', authority: 'user_confirmed',
      sourceRefs: [{ fileKey: 'standing', selector, sha256: sha }],
      scope: {}, ...answerData,
    }, { expectedRevision: 0, status: answerStatus, sourceIds: [`standing@${sha}`] });
    return def;
  }

  /** In-memory canonical tracker + sanctioned-script stand-ins. */
  function fakeTracker(rows) {
    const calls = { merge: 0, setStatus: [] };
    const tracker = { listApplications: () => rows.map((r) => ({ ...r })) };
    const executor = {
      mergeTracker() { calls.merge += 1; return { status: 0 }; },
      setStatus({ reportNum, status }) {
        calls.setStatus.push({ reportNum, status });
        const row = rows.find((r) => String(r.report).includes(`reports/${reportNum}-`));
        if (!row) return { status: 2, stdout: '{"error":"not-found"}' };
        row.status = status;
        return { status: 0, stdout: JSON.stringify({ changed: true, num: row.num }) };
      },
    };
    return { rows, calls, tracker, executor };
  }

  const trackerRow = (num, reportNum, { company = 'synthco', status = 'Evaluated', url = null } = {}) => ({
    num, company, role: 'Engineer', status,
    report: `[${reportNum}](reports/${reportNum}-synthetic.md)`, notes: '', url,
  });

  async function runSync(job, t, extra = {}) {
    return workflow.syncSubmittedJobs(ctx, {
      taskId: workflow.trackerSyncTaskId(job),
      executeStatus: t.executor, tracker: t.tracker, jobs: state, ...extra,
    });
  }

  const requeue = (urlKey) =>
    state.updateJob(urlKey, { transitionTo: 'queued', patch: { attempts: 0, lastError: null } });

  return {
    fixture, ctx, clock, model, mailbox, accounts, cov,
    state, db, workflow, store, answers, questions, evidence, diagnose,
    verifyAudit: applyWorker.verifyAudit,
    createLearningContext,
    seedJob, seedSubmittedJob, claimAttempt, writeBoundConfirmation,
    makeAuditDir, seedApprovedAnswer, fakeTracker, trackerRow, runSync, requeue,
    cleanup() { db.closeDb(); fixture.cleanup(); },
  };
}
