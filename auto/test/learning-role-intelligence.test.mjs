// auto/test/learning-role-intelligence.test.mjs — T16: role/capability
// intelligence from distinct evidence. All data is synthetic, from
// auto/test/fixtures/learning/role-intelligence.json, committed to an isolated
// scratch store. Covers: 100 repeated observations of one requisition vs five
// distinct jobs, multiple role tags, sparse samples, an ATS boilerplate
// cluster, reclassified roles, and unsupported candidate metrics.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { getRecord, listRecords, commitRecord } from '../learning/store.mjs';
import {
  ROLE_FAMILIES, classifyRoleTitle, roleCorrectionId, recordRoleCorrection,
  classifyQuestionOrigin, joinCapabilitiesToExperience, screenProposedTopics,
  deriveRoleInsights, saveRoleInsight,
} from '../learning/intelligence.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const fixturesPath = fileURLToPath(new URL('./fixtures/learning/role-intelligence.json', import.meta.url));
const F = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

const fixedNow = new Date('2026-10-11T00:00:00Z');

function observationData(job, question, extra = {}) {
  const data = {
    applicationId: job.applicationId,
    companyId: job.companyId,
    employerName: job.employerName,
    atsVendor: job.atsVendor,
    roleTitle: job.roleTitle,
    locale: question.locale,
    stepId: 'step-1',
    fieldId: `fld-${question.fieldType}`,
    fieldType: question.fieldType,
    originalText: question.originalText,
    required: question.required,
    observedAt: job.observedAt,
    captureMethod: 'live_structured',
    coverage: job.coverage,
    answerDisposition: job.answerDisposition,
    ...extra,
  };
  if (job.country != null) data.country = job.country;
  if (question.options) data.options = question.options;
  if (job.attemptId) data.attemptId = job.attemptId;
  return data;
}

async function commitObs(ctx, id, data) {
  return commitRecord(ctx, 'observations', id, data, {
    expectedRevision: 0, status: 'recorded', sourceIds: [],
  });
}

let fixture;
let ctx;
before(async () => {
  fixture = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  // Approved CV material backing the capability/experience join.
  writeFileSync(join(fixture.dataRoot, 'cv.md'), F.cvMarkdown);

  // 100 repeated observations of ONE requisition at co-syn-x (same field,
  // different attempts) — raw audit volume, exactly one distinct job.
  for (let i = 1; i <= F.repeatedJob.repeats; i += 1) {
    await commitObs(ctx, `obs-a-${String(i).padStart(4, '0')}`, observationData(
      F.repeatedJob, F.boilerplateQuestion, { attemptId: `att-syn-alpha-${i}` },
    ));
  }
  // Four more distinct requisitions across co-syn-y and co-syn-z.
  for (const job of F.singleJobs) {
    await commitObs(ctx, `obs-${job.applicationId}`, observationData(job, F[job.question]));
  }
  // Multi-tag title (ai_engineering + engineering_leadership).
  await commitObs(ctx, 'obs-eng', observationData(F.multiTagJob, F[F.multiTagJob.question]));
  // Sparse sample: one solutions_architecture job, two questions, no country.
  for (const [i, q] of F.sparseJob.questions.entries()) {
    await commitObs(ctx, `obs-sa-${i + 1}`, observationData(F.sparseJob, F[q]));
  }
  // Same question at two companies/vendors: origin must stay unknown.
  for (const job of F.twoCompanyJobs) {
    await commitObs(ctx, `obs-${job.applicationId}`, observationData(job, F[job.question]));
  }
});
after(() => fixture.cleanup());

test('fixture isolation: everything happens under the scratch root, never the live checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
});

test('plan-required assertions: 100 repeats of one requisition vs five distinct jobs', () => {
  const insights = deriveRoleInsights(ctx,{roleFamily:'ai_transformation_leadership',filters:{},asOf:fixedNow});
  assert.equal(insights[0].data.distinctJobs,5);
  assert.equal(insights[0].data.distinctCompanies,3);
  assert.equal(insights[0].data.rawOccurrences,104);
  assert.ok(insights[0].data.sourceIds.length>0);
  // Window: earliest observed evidence through asOf.
  assert.equal(insights[0].data.from, '2026-09-01T00:00:00.000Z');
  assert.equal(insights[0].data.to, fixedNow.toISOString());
  assert.equal(insights[0].status, 'draft');
  // Sample framing, never market framing.
  assert.equal(insights[0].data.statistics.basis, 'observed_sample');
  assert.match(insights[0].data.statistics.note, /observed in your sampled roles/);
});

test('ATS boilerplate cluster and role-specific question are tagged by origin, counted over distinct denominators', () => {
  const [insight] = deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
  const caps = insight.data.statistics.capabilities;
  const boilerplate = caps.find((c) => c.label.includes('hear'));
  // 103 raw rows (100 repeats + 3 singles) but only 4 distinct jobs at 3 companies.
  assert.equal(boilerplate.rawOccurrences, 103);
  assert.equal(boilerplate.distinctJobs, 4);
  assert.equal(boilerplate.distinctCompanies, 3);
  assert.equal(boilerplate.origin, 'ats_boilerplate');
  // Share uses DISTINCT jobs, never raw rows (103/104 would be ~0.99).
  assert.equal(boilerplate.shareOfSampledJobs, 0.8);
  const kubernetes = caps.find((c) => c.label.includes('kubernetes'));
  assert.equal(kubernetes.distinctJobs, 1);
  assert.equal(kubernetes.origin, 'role_specific');
  assert.equal(kubernetes.shareOfSampledJobs, 0.2);
  for (const c of caps) assert.ok(c.shareOfSampledJobs <= 1);
});

test('coverage keeps unanswered questions, partially observed forms and the applied/discovered split visible', () => {
  const [insight] = deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
  const { coverage } = insight.data;
  assert.equal(coverage.unansweredQuestions, 3);
  assert.equal(coverage.partiallyObservedFormJobs, 1);
  assert.equal(coverage.byObservation.observed, 103);
  assert.equal(coverage.byObservation.partially_observed, 1);
  assert.deepEqual(
    { appliedJobs: coverage.sample.appliedJobs, discoveredOnlyJobs: coverage.sample.discoveredOnlyJobs },
    { appliedJobs: 2, discoveredOnlyJobs: 3 },
  );
});

test('multi-role title keeps every tag and appears in both family cohorts; employer title never rewritten', () => {
  const [ai] = deriveRoleInsights(ctx, { roleFamily: 'ai_engineering', filters: {}, asOf: fixedNow });
  const [eng] = deriveRoleInsights(ctx, { roleFamily: 'engineering_leadership', filters: {}, asOf: fixedNow });
  const inAi = ai.data.statistics.jobs.find((j) => j.applicationId === 'app-syn-eng');
  const inEng = eng.data.statistics.jobs.find((j) => j.applicationId === 'app-syn-eng');
  assert.ok(inAi && inEng);
  assert.equal(inAi.originalTitle, 'Head of AI Engineering'); // verbatim
  assert.deepEqual([...inAi.roleTags].sort(), ['ai_engineering', 'engineering_leadership']);
  // Not pulled into the leadership-transformation cohort.
  const [atl] = deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
  assert.equal(atl.data.statistics.jobs.some((j) => j.applicationId === 'app-syn-eng'), false);
});

test('sparse sample stays honest: tiny denominators reported, unknown stays unknown', () => {
  const [insight] = deriveRoleInsights(ctx, { roleFamily: 'solutions_architecture', filters: {}, asOf: fixedNow });
  assert.equal(insight.data.distinctJobs, 1);
  assert.equal(insight.data.distinctCompanies, 1);
  const job = insight.data.statistics.jobs[0];
  assert.equal(job.seniority.value, 'senior');
  // No country observed and no company size/funding evidence: unknown, not guessed.
  assert.deepEqual(job.country, { value: 'unknown', source: 'none', confidence: 'none' });
  assert.deepEqual(job.companyType, { value: 'unknown', source: 'none', confidence: 'none' });
});

test('same question at only two companies stays origin unknown, never promoted to boilerplate', () => {
  const [insight] = deriveRoleInsights(ctx, { roleFamily: 'software_engineering', filters: {}, asOf: fixedNow });
  assert.equal(insight.data.distinctJobs, 2);
  assert.equal(insight.data.distinctCompanies, 2);
  const notice = insight.data.statistics.capabilities.find((c) => c.label.includes('notice'));
  assert.equal(notice.origin, 'unknown');
});

test('capability join yields three outputs and never adds a qualification or public clearance', () => {
  const [atl] = deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
  const rec = atl.data.recommendations;
  // Kubernetes is already supported by approved CV material: verbatim quote only.
  const supported = rec.alreadySupported.find((s) => s.capability.includes('kubernetes'));
  assert.ok(supported);
  assert.equal(supported.action, 'emphasize_existing_experience');
  assert.ok(F.cvMarkdown.includes(supported.quote)); // verbatim span, nothing synthesized
  assert.equal(supported.publicUse, 'applications_only'); // never cleared for public use
  // The boilerplate source question has no supporting evidence: genuine gap.
  assert.ok(rec.genuineGaps.some((g) => g.capability.includes('hear')));

  // Partial signal (Azure only, of Terraform/Ansible/Azure/governance) ASKS the user.
  const [sa] = deriveRoleInsights(ctx, { roleFamily: 'solutions_architecture', filters: {}, asOf: fixedNow });
  const ask = sa.data.recommendations.userMightSupply.find((s) => s.capability.includes('terraform'));
  assert.ok(ask);
  assert.equal(ask.action, 'ask_user');
  assert.equal('quote' in ask, false); // nothing asserted on the user's behalf
  assert.equal(ask.publicUse, 'applications_only');
});

test('filters narrow the cohort: appliedOnly and companyId', () => {
  const [applied] = deriveRoleInsights(ctx, {
    roleFamily: 'ai_transformation_leadership', filters: { appliedOnly: true }, asOf: fixedNow,
  });
  assert.equal(applied.data.distinctJobs, 2); // alpha + beta carry attemptIds
  const [companyZ] = deriveRoleInsights(ctx, {
    roleFamily: 'ai_transformation_leadership', filters: { companyId: 'co-syn-z' }, asOf: fixedNow,
  });
  assert.equal(companyZ.data.distinctJobs, 2);
  assert.equal(companyZ.data.distinctCompanies, 1);
  const [all] = deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
  assert.notEqual(applied.id, all.id); // different filters, different insight identity
  assert.throws(() => deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: { market: true } }),
    /unknown filter/);
  assert.throws(() => deriveRoleInsights(ctx, { roleFamily: 'cto', filters: {} }), /roleFamily/);
});

test('saveRoleInsight persists drafts with revision history', async () => {
  const [insight] = deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
  const first = await saveRoleInsight(ctx, insight);
  assert.equal(first.revision, 1);
  assert.equal(first.status, 'draft');
  const [again] = deriveRoleInsights(ctx, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
  const second = await saveRoleInsight(ctx, again);
  assert.equal(second.revision, 2);
  assert.equal(getRecord(ctx, 'insights', insight.id).revision, 2);
});

test('reclassified roles: a reviewed correction overrides the heuristic without rewriting observations', async () => {
  const rc = createLearningFixture();
  try {
    const ctx2 = createLearningContext({ codeRoot: rc.codeRoot, dataRoot: rc.dataRoot, now: fixedClock() });
    const job = F.reclassifiedJob;
    await commitObs(ctx2, 'obs-rc', observationData(job, F[job.question]));

    // Heuristic puts the ambiguous title in 'other'.
    const [uncorrected] = deriveRoleInsights(ctx2, { roleFamily: 'other', filters: {}, asOf: fixedNow });
    assert.equal(uncorrected.data.distinctJobs, 1);

    // Invalid taxonomy tags are rejected.
    await assert.rejects(recordRoleCorrection(ctx2, {
      applicationId: job.applicationId, roleTags: ['cto'], reason: 'x',
    }), /role taxonomy/);

    await recordRoleCorrection(ctx2, {
      applicationId: job.applicationId,
      originalTitle: job.roleTitle,
      roleTags: ['ai_transformation_leadership'],
      reason: 'synthetic JD describes an AI transformation mandate',
      reviewedBy: 'user',
      evidenceIds: ['obs-rc'],
    });

    const [corrected] = deriveRoleInsights(ctx2, { roleFamily: 'ai_transformation_leadership', filters: {}, asOf: fixedNow });
    assert.equal(corrected.data.distinctJobs, 1);
    const detail = corrected.data.statistics.jobs[0];
    assert.equal(detail.originalTitle, 'Transformation Manager'); // employer title verbatim
    assert.equal(detail.role.source, 'reviewed_correction');
    assert.ok(corrected.data.contradictions.some((c) => c.type === 'role_reclassified'
      && c.applicationId === job.applicationId));
    // The old family no longer claims the job; the raw observation is untouched.
    const [afterOther] = deriveRoleInsights(ctx2, { roleFamily: 'other', filters: {}, asOf: fixedNow });
    assert.equal(afterOther.data.distinctJobs, 0);
    const stored = getRecord(ctx2, 'observations', 'obs-rc');
    assert.equal(stored.revision, 1);
    assert.equal(stored.data.roleTitle, 'Transformation Manager');
    // Correction is a reviewed proposal record, not a mutation.
    const corr = getRecord(ctx2, 'proposals', roleCorrectionId(job.applicationId));
    assert.equal(corr.status, 'approved');
    assert.equal(corr.data.diff.correctionType, 'role_tags');
  } finally {
    rc.cleanup();
  }
});

// --- Pure functions (no store) -------------------------------------------------

test('classifyRoleTitle: closed taxonomy, multi-tag, unknown stays unknown', () => {
  assert.deepEqual(ROLE_FAMILIES.slice(-2), ['other', 'unknown']);
  assert.deepEqual(classifyRoleTitle(null).roleTags, ['unknown']);
  assert.deepEqual(classifyRoleTitle('  ').roleTags, ['unknown']);
  assert.deepEqual(classifyRoleTitle('Accountant').roleTags, ['other']);
  const multi = classifyRoleTitle('Head of AI Engineering');
  assert.deepEqual([...multi.roleTags].sort(), ['ai_engineering', 'engineering_leadership']);
  assert.equal(multi.originalTitle, 'Head of AI Engineering'); // never rewritten
});

test('classifyQuestionOrigin: conservative labels, sparse evidence stays unknown', () => {
  assert.equal(classifyQuestionOrigin({ distinctCompanies: 3, distinctJobs: 5, atsVendors: ['v1'] }), 'ats_boilerplate');
  assert.equal(classifyQuestionOrigin({ distinctCompanies: 3, distinctJobs: 5, atsVendors: ['v1', 'v2'] }), 'unknown');
  assert.equal(classifyQuestionOrigin({ distinctCompanies: 1, distinctJobs: 3, atsVendors: ['v1'] }), 'employer_general');
  assert.equal(classifyQuestionOrigin({ distinctCompanies: 1, distinctJobs: 1, atsVendors: ['v1'] }), 'role_specific');
  assert.equal(classifyQuestionOrigin({ distinctCompanies: 2, distinctJobs: 2, atsVendors: ['v1', 'v2'] }), 'unknown');
  assert.equal(classifyQuestionOrigin({}), 'unknown');
});

test('unsupported candidate metrics: fabricated percentages and unverifiable quotes are rejected', () => {
  const { evidenceBacked, rejected } = screenProposedTopics(F.proposedTopics, F.topicSources);
  assert.equal(evidenceBacked.length, 1);
  assert.equal(evidenceBacked[0].topic, 'Kubernetes demand in sampled roles');
  assert.equal(evidenceBacked[0].evidenceBacked, true);
  assert.deepEqual(rejected.map((r) => r.reason),
    ['fabricated_percentage', 'quote_not_in_source', 'unknown_source']);
  assert.ok(rejected.every((r) => r.evidenceBacked === false));
});

test('joinCapabilitiesToExperience is pure and keeps the three outputs disjoint', () => {
  const stories = [{
    id: 'story-1',
    sourceRef: { fileKey: 'cv', sha256: 'x', span: { startLine: 1, endLine: 3 } },
    roleTags: [], capabilityTags: ['kubernetes'],
    claims: [
      '- Operated Kubernetes clusters in production for 40 synthetic teams',
      '- Deployed workloads on Azure for a regulated synthetic client',
    ],
    publicUse: 'applications_only',
  }];
  const out = joinCapabilitiesToExperience({
    capabilities: [
      { definitionId: 'qd-1', label: 'kubernetes production experience' },
      { definitionId: 'qd-2', label: 'terraform ansible azure governance' },
      { definitionId: 'qd-3', label: 'quantum annealing research' },
    ],
    stories,
  });
  assert.equal(out.alreadySupported.length, 1);
  assert.equal(out.userMightSupply.length, 1); // 'azure' overlap only (1 of 4 tokens): ask, never assert
  assert.equal(out.genuineGaps.length, 1);
  assert.equal(out.genuineGaps[0].definitionId, 'qd-3');
});
