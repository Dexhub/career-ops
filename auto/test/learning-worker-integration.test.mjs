// auto/test/learning-worker-integration.test.mjs — T10: apply-worker
// integration of continuous learning capture/retrieval. Everything runs
// against an isolated mkdtemp fixture with a scripted (injected) executor:
// no real browser, model, agent CLI, panel, or live data is ever touched.
// node:test only; synthetic values only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

// Module handles — dynamically imported AFTER the fixture sets
// CAREER_OPS_ROOT/CAREER_OPS_DB, because auto/lib/config.mjs and state.mjs
// resolve their roots at import time.
let runApply; let preflightExecutor; let composeApplyPrompt; let renderPrompt; let learningRuntime;
let observePage; let resolvePage; let recordCheckpoint; let finalizeAttemptCapture; let locateAttempt;
let createLearningContext; let state; let storeMod; let normalizeQuestion; let hashText;
let clearContextPacketCache; let commitRecord; let getRecord; let listRecords;

let fixture;
let ctx; // learning context bound to the fixture, used by the fake executor

const STANDING_YML = [
  'filled_in_by_user: true',
  'custom:',
  '  notice_period: "4 weeks"',
  '',
].join('\n');

const LEARNING_YML_ON = 'schema_version: 1\nenabled: true\nmode: shadow\n';
const LEARNING_YML_OFF = 'schema_version: 1\nenabled: false\nmode: shadow\n';

// Synthetic question content (never real employer/user data).
const NOTICE_FIELD = {
  fieldId: 'field-notice',
  fieldType: 'select',
  originalText: 'What is your notice period?',
  options: [
    { value: '2w', label: '2 weeks' },
    { value: '4w', label: '4 weeks' },
    { value: '8w', label: '8 weeks' },
  ],
  required: true,
  parentCondition: null,
  locale: 'en-US',
};
const OPTIONAL_LANG_FIELD = {
  fieldId: 'field-language',
  fieldType: 'select',
  originalText: 'Which additional language do you speak?',
  options: [{ value: 'de', label: 'German' }, { value: 'fr', label: 'French' }],
  required: false,
  parentCondition: null,
  locale: 'en-US',
};
const RELOCATE_FIELD = {
  fieldId: 'field-relocate',
  fieldType: 'radio',
  originalText: 'Are you willing to relocate for this synthetic role?',
  options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
  required: true,
  parentCondition: null,
  locale: 'en-US',
};

function seedJob({ url, company, role, reportNum }) {
  const { job } = state.createJob({ url, company, role, ats: 'synthetic' });
  for (const stage of ['evaluated', 'queued', 'resume_ready']) state.transition(job, stage, {});
  Object.assign(job, {
    resumePdf: join(fixture.dataRoot, 'resume.pdf'),
    resumeVariant: 'default',
    reportPath: `reports/${reportNum}-synthetic.md`,
    score: 4.5,
  });
  return state.saveJob(job);
}

/**
 * Scripted learning-capable executor: capability-restricted, Neo/CDP tools,
 * task-owned tabs. Drives observe-page -> resolve-page -> checkpoint per page,
 * answers ONLY from the resolved packet (memory) or a scripted fallback
 * (counted as a "model call"), then writes the audit artifacts. No browser.
 */
function makeExecutor({ pages, outcome = 'submitted', failAfterPages = Infinity, skipLearningCalls = false, callLog = [] }) {
  const ex = {
    modelCalls: 0,
    runCalls: 0,
    callLog,
    capabilities: () => ({
      tools: ['browseros_snapshot', 'browseros_act', 'browseros_read'],
      boundary: 'restricted',
      taskOwnedTabs: true,
    }),
    async run({ auditDir, attemptId, submit }) {
      ex.runCalls += 1;
      const learnDir = join(auditDir, 'learning');
      const answers = [];
      for (const [i, page] of pages.entries()) {
        const stepId = `step-${i + 1}`;
        if (!skipLearningCalls) {
          const inputPath = join(learnDir, `input-${stepId}.json`);
          writeFileSync(inputPath, JSON.stringify({
            stepId,
            pageIdentity: page.pageIdentity ?? {},
            expectedFieldCount: page.expectedFieldCount ?? page.fields.length,
            fields: page.fields,
          }));
          callLog.push(`observe:${stepId}`);
          await observePage(ctx, { attemptId, inputPath, apply: true });
          callLog.push(`resolve:${stepId}`);
          const { packet } = await resolvePage(ctx, { attemptId, inputPath });
          for (const field of page.fields) {
            const hit = packet.answers.find((a) => a.fieldId === field.fieldId);
            if (hit) {
              answers.push({ label: field.originalText, value: hit.value, source: 'memory' });
            } else if (field.required) {
              ex.modelCalls += 1; // scripted stand-in for "the model had to answer"
              answers.push({ label: field.originalText, value: 'synthetic-fallback', source: 'model' });
            } // optional unresolved fields stay unanswered
          }
          const ckPath = join(learnDir, `ck-${stepId}.json`);
          writeFileSync(ckPath, JSON.stringify({ evidenceRefs: [`learning/input-${stepId}.json`] }));
          callLog.push(`checkpoint:${stepId}`);
          await recordCheckpoint(ctx, { attemptId, phase: 'filled', inputPath: ckPath });
        } else {
          for (const field of page.fields) {
            answers.push({ label: field.originalText, value: 'synthetic', source: 'model' });
          }
        }
        if (i + 1 >= failAfterPages) {
          // Partial form: artifacts for the pages reached, then a failure.
          writeFileSync(join(auditDir, 'answers.json'), JSON.stringify(answers));
          writeFileSync(join(auditDir, '01-form-filled.png'), 'png');
          writeFileSync(join(auditDir, 'result.json'),
            JSON.stringify({ status: 'failed', reason: 'synthetic page failure' }));
          return { exitCode: 1 };
        }
      }
      if (outcome === 'parked') {
        writeFileSync(join(auditDir, 'result.json'),
          JSON.stringify({ status: 'parked', reason: 'synthetic captcha' }));
        return { exitCode: 0 };
      }
      writeFileSync(join(auditDir, 'answers.json'), JSON.stringify(answers));
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

before(async () => {
  fixture = createLearningFixture();
  // Config BEFORE any import that resolves roots at module load.
  writeFileSync(join(fixture.dataRoot, 'config', 'auto.yml'), 'score_threshold: 4.0\n');
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_YML_ON);
  writeFileSync(join(fixture.dataRoot, 'config', 'standing-answers.yml'), STANDING_YML);
  writeFileSync(join(fixture.dataRoot, 'config', 'profile.yml'), 'name: Fixture Person\n');
  writeFileSync(join(fixture.dataRoot, 'cv.md'), '# Synthetic CV\n- fixture only\n');
  writeFileSync(join(fixture.dataRoot, 'resume.pdf'), 'synthetic-pdf');

  ({
    runApply, preflightExecutor, composeApplyPrompt, renderPrompt, learningRuntime,
  } = await import('../apply-worker.mjs'));
  ({
    observePage, resolvePage, recordCheckpoint, finalizeAttemptCapture, locateAttempt,
  } = await import('../learn.mjs'));
  ({ createLearningContext } = await import('../learning/context.mjs'));
  state = await import('../state.mjs');
  storeMod = await import('../learning/store.mjs');
  ({ commitRecord, getRecord, listRecords } = storeMod);
  ({ normalizeQuestion } = await import('../learning/questions.mjs'));
  ({ hashText } = await import('../learning/answers.mjs'));
  ({ clearContextPacketCache } = await import('../learning/retrieval.mjs'));

  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  clearContextPacketCache();
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

test('flag off: learningRuntime is null and the composed prompt is byte-identical', () => {
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_YML_OFF);
  try {
    assert.equal(learningRuntime(() => {}), null);
    const args = {
      job: { company: 'synthco', role: 'Engineer', url: 'https://jobs.example.test/synthco/1', resumePdf: '/tmp/x.pdf' },
      submit: true,
      auditDir: '/tmp/audit-synthetic',
      profileYaml: 'name: X', standingYaml: 'filled_in_by_user: true', cvText: '# CV', resumeSha: 'abc',
    };
    // String identity: with learning off the worker composes EXACTLY the
    // pre-learning prompt — no injected instructions, no marker text.
    assert.equal(composeApplyPrompt(args, { learning: null }), renderPrompt(args));
    assert.ok(!composeApplyPrompt(args, { learning: null }).includes('observe-page'));
  } finally {
    writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_YML_ON);
  }
});

test('flag on: prompt = exact base prompt + capture protocol, injected at composition time', () => {
  const learning = learningRuntime(() => {});
  assert.ok(learning, 'learning runtime should be enabled');
  const args = {
    job: { company: 'synthco', role: 'Engineer', url: 'https://jobs.example.test/synthco/1', resumePdf: '/tmp/x.pdf' },
    submit: true,
    auditDir: '/tmp/audit-synthetic',
    profileYaml: 'name: X', standingYaml: 'filled_in_by_user: true', cvText: '# CV', resumeSha: 'abc',
  };
  const composed = composeApplyPrompt(args, { learning, attemptId: 'att-123' });
  assert.ok(composed.startsWith(renderPrompt(args)));
  assert.ok(composed.includes('observe-page --attempt-id att-123'));
  assert.ok(composed.includes('resolve-page'));
  assert.ok(composed.includes('checkpoint'));
});

test('preflight: no Neo/CDP-capable executor -> tool_unavailable, nothing launches, job untouched', async () => {
  const job = seedJob({ url: 'https://jobs.example.test/preflight-co/1', company: 'preflight-co', role: 'Engineer', reportNum: '090' });
  // No executor at all.
  const res = await runApply({ needle: 'preflight-co', submit: true, log: () => {} });
  assert.equal(res.verdict.status, 'tool_unavailable');
  assert.equal(res.auditDir, null);
  const fresh = state.loadJob(job.urlKey);
  assert.equal(fresh.stage, 'resume_ready');
  assert.equal(fresh.attempts || 0, 0);
  // Degraded executors are also refused: missing tools / unrestricted / shared tabs.
  const base = makeExecutor({ pages: [] });
  assert.equal(preflightExecutor({ ...base, capabilities: () => ({ tools: ['browseros_snapshot'], boundary: 'restricted', taskOwnedTabs: true }) }).ok, false);
  assert.equal(preflightExecutor({ ...base, capabilities: () => ({ tools: base.capabilities().tools, boundary: 'unrestricted', taskOwnedTabs: true }) }).ok, false);
  assert.equal(preflightExecutor({ ...base, capabilities: () => ({ tools: base.capabilities().tools, boundary: 'restricted', taskOwnedTabs: false }) }).ok, false);
  assert.equal(base.runCalls, 0, 'no executor launch on failed preflight');
});

// --- Full fake application 1: new question -> observed, blocked, never guessed

let app1AuditDir;
let app1AttemptId;

test('application 1: new question is captured per-page and blocked, not model-inferred', async () => {
  seedJob({ url: 'https://jobs.example.test/acme-one/1', company: 'acme-one', role: 'Engineer', reportNum: '091' });
  const callLog = [];
  const ex = makeExecutor({
    pages: [{ fields: [NOTICE_FIELD, OPTIONAL_LANG_FIELD], pageIdentity: { employerName: 'Acme Synthetic' } }],
    outcome: 'parked',
    callLog,
  });
  const res = await runApply({ needle: 'acme-one', submit: true, executor: ex, log: () => {} });
  assert.equal(res.verdict.status, 'parked');
  assert.equal(res.job.stage, 'parked');
  app1AuditDir = res.auditDir;
  app1AttemptId = JSON.parse(readFileSync(join(app1AuditDir, 'learning', 'meta.json'), 'utf8')).attemptId;

  // Expected call order per page: observe -> resolve -> checkpoint.
  assert.deepEqual(callLog, ['observe:step-1', 'resolve:step-1', 'checkpoint:step-1']);

  // The injected prompt carried the capture protocol for this attempt.
  const prompt = readFileSync(join(app1AuditDir, 'prompt.md'), 'utf8');
  assert.ok(prompt.includes(`observe-page --attempt-id ${app1AttemptId}`));

  // Both fields — including the unanswered optional one — are stored as observations.
  const { items: observations } = listRecords(ctx, 'observations', { limit: 100 });
  const texts = observations.map((o) => o.data.originalText);
  assert.ok(texts.includes(NOTICE_FIELD.originalText));
  assert.ok(texts.includes(OPTIONAL_LANG_FIELD.originalText));
  const optional = observations.find((o) => o.data.fieldId === 'field-language');
  assert.equal(optional.data.answerDisposition, 'unanswered');
  assert.equal(optional.data.required, false);

  // Missing facts became structured blockers (missing_answer), never guesses.
  const { items: blockers } = listRecords(ctx, 'blockers', { limit: 100 });
  const missing = blockers.filter((b) => b.data.type === 'missing_answer');
  assert.ok(missing.some((b) => b.data.question === NOTICE_FIELD.originalText));

  // Resolve provenance persisted beside the attempt: consumed versions + gaps.
  const resolveFile = JSON.parse(readFileSync(join(app1AuditDir, 'learning', 'resolve-step-1.json'), 'utf8'));
  assert.equal(resolveFile.answers.length, 0, 'nothing reusable yet');
  assert.ok(resolveFile.consumed.sourceHashes.length > 0);
  assert.ok(resolveFile.gaps.some((g) => g.status === 'blocked'));

  // Finalized capture: complete page coverage + consolidation enqueued.
  const summary = JSON.parse(readFileSync(join(app1AuditDir, 'learning', 'capture-summary.json'), 'utf8'));
  assert.equal(summary.coverage, 'complete');
  assert.equal(summary.pagesObserved, 1);
  const task = getRecord(ctx, 'syncTasks', summary.consolidationTaskId);
  assert.equal(task.data.taskType, 'local_consolidation');
  assert.equal(task.status, 'pending');
});

// --- Full fake application 2: the SAME question answered from memory, zero model calls

test('application 2: reused question resolves from memory with ZERO model calls', async () => {
  // User approves the notice answer (source-bound to the standing file).
  const standingHash = hashText(STANDING_YML);
  const defId = normalizeQuestion(NOTICE_FIELD).id;
  await commitRecord(ctx, 'families', 'fam-notice', {
    label: 'synthetic notice period', questionIds: [defId], scope: {},
  }, { expectedRevision: 0, status: 'approved', sourceIds: [] });
  await commitRecord(ctx, 'answers', 'ans-notice', {
    questionFamilyId: 'fam-notice',
    kind: 'source_reference',
    authority: 'user_confirmed',
    sourceRefs: [{ fileKey: 'standing', selector: 'custom.notice_period', sha256: standingHash }],
    scope: {},
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    dependencies: [],
    approvalRef: null,
    publicUse: 'applications_only',
    lastValidatedAt: '2026-10-01T00:00:00.000Z',
    template: null,
  }, { expectedRevision: 0, status: 'approved', sourceIds: [`standing@${standingHash}`] });
  clearContextPacketCache();

  seedJob({ url: 'https://jobs.example.test/maple-two/1', company: 'maple-two', role: 'Engineer', reportNum: '092' });
  const ex = makeExecutor({
    pages: [{ fields: [NOTICE_FIELD], pageIdentity: { employerName: 'Maple Synthetic' } }],
    outcome: 'submitted',
  });
  const res = await runApply({ needle: 'maple-two', submit: true, executor: ex, log: () => {} });
  assert.equal(res.verdict.status, 'submitted');
  assert.equal(res.job.stage, 'submitted');
  assert.equal(ex.modelCalls, 0, 'reused answer must require zero model calls');

  const answers = JSON.parse(readFileSync(join(res.auditDir, 'answers.json'), 'utf8'));
  assert.deepEqual(answers, [{ label: NOTICE_FIELD.originalText, value: '4 weeks', source: 'memory' }]);

  // Reuse provenance: consumed memory + source versions and the reuse reason.
  const resolveFile = JSON.parse(readFileSync(join(res.auditDir, 'learning', 'resolve-step-1.json'), 'utf8'));
  assert.equal(resolveFile.answers.length, 1);
  assert.equal(resolveFile.answers[0].answerId, 'ans-notice');
  assert.ok(resolveFile.answers[0].reason.length > 0);
  assert.deepEqual(resolveFile.answers[0].sourceRefs,
    [{ fileKey: 'standing', selector: 'custom.notice_period', sha256: standingHash }]);
  assert.ok(resolveFile.consumed.sourceHashes.includes(standingHash));

  const summary = JSON.parse(readFileSync(join(res.auditDir, 'learning', 'capture-summary.json'), 'utf8'));
  assert.equal(summary.coverage, 'complete');
});

// --- Changed options are revalidated, not blindly reused

test('same question with different options is NOT reused — revalidation blocks it', async () => {
  const attemptId = 'direct-options-1';
  const auditDir = join(fixture.dataRoot, 'output', '093-direct-synthetic', 'audit', `attempt-${attemptId}`);
  mkdirSync(join(auditDir, 'learning'), { recursive: true });
  writeFileSync(join(auditDir, 'learning', 'meta.json'),
    JSON.stringify({ attemptId, applicationId: 'app-direct-1' }));
  const changed = {
    ...NOTICE_FIELD,
    options: [{ value: '2w', label: '2 weeks' }, { value: '6w', label: '6 weeks' }], // "4 weeks" gone
  };
  const inputPath = join(auditDir, 'learning', 'input-step-1.json');
  writeFileSync(inputPath, JSON.stringify({ stepId: 'step-1', pageIdentity: {}, fields: [changed] }));
  const { packet } = await resolvePage(ctx, { attemptId, inputPath });
  assert.equal(packet.answers.length, 0, 'changed options must not reuse the stored answer');
  assert.ok(packet.gaps.some((g) => g.fieldId === 'field-notice' && g.status === 'blocked'));
});

// --- Wrong job identity is rejected outright

test('a capture claiming a different application identity is rejected', async () => {
  const before1 = listRecords(ctx, 'observations', { limit: 200 }).items.length;
  const auditDir = join(fixture.dataRoot, 'output', '093-direct-synthetic', 'audit', 'attempt-direct-options-1');
  const inputPath = join(auditDir, 'learning', 'input-evil.json');
  writeFileSync(inputPath, JSON.stringify({
    stepId: 'step-evil',
    pageIdentity: {},
    fields: [{ ...NOTICE_FIELD, applicationId: 'app-SOME-OTHER-JOB' }],
  }));
  await assert.rejects(
    observePage(ctx, { attemptId: 'direct-options-1', inputPath, apply: true }),
    /wrong job identity rejected/,
  );
  assert.equal(listRecords(ctx, 'observations', { limit: 200 }).items.length, before1,
    'no observation stored for a mismatched identity');
  // Inputs outside the attempt's own audit dir are refused too.
  const foreign = join(fixture.dataRoot, 'foreign-input.json');
  writeFileSync(foreign, JSON.stringify({ stepId: 's', pageIdentity: {}, fields: [NOTICE_FIELD] }));
  await assert.rejects(
    observePage(ctx, { attemptId: 'direct-options-1', inputPath: foreign, apply: true }),
    /audit directory/,
  );
});

// --- Partial capture survives a failed attempt

test('a failed attempt retains the already-observed pages', async () => {
  seedJob({ url: 'https://jobs.example.test/cog-three/1', company: 'cog-three', role: 'Engineer', reportNum: '094' });
  const ex = makeExecutor({
    pages: [
      { fields: [RELOCATE_FIELD], pageIdentity: { employerName: 'Cog Synthetic' } },
      { fields: [OPTIONAL_LANG_FIELD] }, // never reached
    ],
    failAfterPages: 1,
  });
  const res = await runApply({ needle: 'cog-three', submit: true, executor: ex, log: () => {} });
  assert.equal(res.verdict.status, 'failed');
  assert.equal(res.job.stage, 'applying', 'first failure stays retryable');

  // Page 1's observation survived the failure.
  const { items: observations } = listRecords(ctx, 'observations', { limit: 200 });
  assert.ok(observations.some((o) => o.data.originalText === RELOCATE_FIELD.originalText));

  // Capture finalized visibly even for the failed outcome.
  const summary = JSON.parse(readFileSync(join(res.auditDir, 'learning', 'capture-summary.json'), 'utf8'));
  assert.equal(summary.verdictStatus, 'failed');
  assert.equal(summary.pagesObserved, 1);
  assert.ok(getRecord(ctx, 'syncTasks', summary.consolidationTaskId));
});

// --- A completed-looking run without its promised captures is incomplete

test('completed-looking run with no live captures -> coverage incomplete, not hidden', async () => {
  seedJob({ url: 'https://jobs.example.test/dyna-four/1', company: 'dyna-four', role: 'Engineer', reportNum: '095' });
  const uniqueField = {
    ...NOTICE_FIELD,
    fieldId: 'field-start-date',
    originalText: 'What is your earliest synthetic start date?',
    options: [],
    fieldType: 'text',
  };
  const ex = makeExecutor({
    pages: [{ fields: [uniqueField] }],
    outcome: 'submitted',
    skipLearningCalls: true, // writes submitted artifacts but never observes
  });
  const res = await runApply({ needle: 'dyna-four', submit: true, executor: ex, log: () => {} });
  assert.equal(res.verdict.status, 'submitted');
  const summary = JSON.parse(readFileSync(join(res.auditDir, 'learning', 'capture-summary.json'), 'utf8'));
  assert.equal(summary.coverage, 'incomplete',
    'final-audit import must not masquerade as live capture coverage');
  assert.equal(summary.pagesObserved, 0);
  assert.ok(summary.legacyIngest.added > 0, 'legacy answers.json still ingested, labeled as legacy');
});

// --- Checkpoints cannot claim outcomes; interrupted attempts still finalize

test('checkpoint carries evidence only; outcome claims are rejected', async () => {
  const auditDir = join(fixture.dataRoot, 'output', '093-direct-synthetic', 'audit', 'attempt-direct-options-1');
  const bad = join(auditDir, 'learning', 'ck-bad.json');
  writeFileSync(bad, JSON.stringify({ evidenceRefs: [], submissionPossible: false }));
  await assert.rejects(
    recordCheckpoint(ctx, { attemptId: 'direct-options-1', phase: 'filled', inputPath: bad }),
    /not permitted/,
  );
  await assert.rejects(
    recordCheckpoint(ctx, { attemptId: 'direct-options-1', phase: 'confirmed_delivery', inputPath: bad }),
    /invalid checkpoint phase/,
  );
  // A legitimate blocker request is allowed and recorded.
  const good = join(auditDir, 'learning', 'ck-good.json');
  writeFileSync(good, JSON.stringify({
    evidenceRefs: ['learning/input-step-1.json'],
    blockerRequest: { type: 'captcha', question: 'synthetic captcha wall', requiredResolution: 'human_solves_captcha' },
  }));
  const out = await recordCheckpoint(ctx, { attemptId: 'direct-options-1', phase: 'pre_submit', inputPath: good });
  assert.ok(out.blockerId);
  assert.equal(getRecord(ctx, 'blockers', out.blockerId).data.type, 'captcha');
});

test('interrupted attempt finalizes evidence and enqueues consolidation (run.mjs path)', async () => {
  const auditDir = join(fixture.dataRoot, 'output', '093-direct-synthetic', 'audit', 'attempt-direct-options-1');
  const learning = learningRuntime(() => {});
  const summary = await finalizeAttemptCapture(learning.ctx, {
    attemptId: 'direct-options-1', auditDir, verdictStatus: 'interrupted',
  });
  assert.equal(summary.verdictStatus, 'interrupted');
  assert.notEqual(summary.coverage, 'incomplete', 'interrupted is not completed-looking');
  assert.ok(getRecord(ctx, 'syncTasks', summary.consolidationTaskId));
  assert.ok(existsSync(join(auditDir, 'learning', 'capture-summary.json')));
});

// --- Flag-off no-op is structural, not incidental

test('everything learning-specific lives behind the gate: disabled config leaves no trace', async () => {
  writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_YML_OFF);
  try {
    assert.equal(learningRuntime(() => {}), null);
    // Attempt subcommands refuse outright when disabled.
    await assert.rejects(
      observePage(ctx, { attemptId: 'direct-options-1', inputPath: 'x', apply: true }),
      /disabled/,
    );
    await assert.rejects(resolvePage(ctx, { attemptId: 'direct-options-1', inputPath: 'x' }), /disabled/);
    await assert.rejects(
      finalizeAttemptCapture(ctx, { attemptId: 'direct-options-1', verdictStatus: 'failed' }),
      /disabled/,
    );
  } finally {
    writeFileSync(join(fixture.dataRoot, 'config', 'learning.yml'), LEARNING_YML_ON);
  }
});
