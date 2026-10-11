# Phase 4: Intelligence and bounded improvement implementation plan

> **For agentic workers:** Execute T16–T20 after the required memory/workflow tasks. Implement cloud code with mocked transports first. Missing cloud approval disables that lane, not local capture, retrieval, indexing or deterministic analysis.

**Goal:** Learn role expectations and operational procedures, then evaluate improvements with provenance, budgets and honest outcomes.
**Architecture:** Local computations own counts and eligibility. A Lambda/Bedrock analysis backend may propose semantic groupings or lessons from minimized evidence. Local validators and approval policy decide whether proposals become usable.
**Tech Stack:** Existing Node modules, isolated AWS SDK package for Lambda, IAM-authenticated synchronous invocation, fixed evaluation fixtures. No public API, external vector store or remote browser.

## T16. Produce role/capability intelligence from distinct evidence

**Create:** `auto/learning/intelligence.mjs`, `auto/test/learning-role-intelligence.test.mjs`.
**Consumes:** job/JD evidence, question occurrences/families and role corrections.
**Produces:** `deriveRoleInsights` and source-bound positioning drafts.

- [x] Establish a small explicit role taxonomy: `ai_transformation_leadership`, `engineering_leadership`, `product_leadership`, `ai_engineering`, `software_engineering`, `solutions_architecture`, `other`, `unknown`. Keep original titles and allow a reviewed correction. Multi-role jobs can have multiple tags; never rewrite the employer's title.
- [x] Extract capability requests separately from evidence about the candidate. Tag question origin as ATS boilerplate, employer-general, role-specific or unknown. Keep role/seniority/country/company type source and confidence; unknown company size or funding stays unknown.
- [x] Compute counts locally using distinct requisitions and distinct companies, not audit rows. Provide both denominators, observation window, coverage and applied-only versus discovered-job sample. Keep unanswered questions and partially observed forms in coverage reporting.
- [x] Join requested capabilities to approved experience references. Generate three separate outputs: already-supported experience to emphasize; information the user might supply; genuine skill/evidence gaps. Suggestions cannot add a qualification or imply a private experience is cleared for LinkedIn/public use.
- [x] Preserve supporting source spans and contradictory evidence. Model extraction can propose topics but a quote must exist in its cited source before an insight is displayed as evidence-backed. Do not fabricate numeric market percentages from model prose.
- [x] Test 100 repeated observations of one company's same requisition versus five distinct jobs, multiple role tags, sparse samples, an ATS boilerplate cluster, reclassified roles, and unsupported candidate metrics. Run `node --test auto/test/learning-role-intelligence.test.mjs`.

```js
const insights = deriveRoleInsights(ctx,{roleFamily:'ai_transformation_leadership',filters:{},asOf:fixedNow});
assert.equal(insights[0].data.distinctJobs,5);
assert.equal(insights[0].data.distinctCompanies,3);
assert.equal(insights[0].data.rawOccurrences,104);
assert.ok(insights[0].data.sourceIds.length>0);
```

These numbers belong to the synthetic cohort. Live displays must compute their own values and say “observed in your sampled roles,” not “required by the entire market.”

## T17. Implement an optional Lambda/Bedrock analysis backend

**Create:** `auto/learning/cloud-client.mjs`, `auto/learning/cloud/{package.json,package-lock.json,index.mjs,template.yaml}`, `auto/learning/cloud/test/handler.test.mjs`, `auto/test/learning-cloud-client.test.mjs`.
**Consumes/produces:** CONTRACTS H; D03 supplies actual deployment/model/pricing choices.

- [x] Read the official Converse, CountTokens, Lambda runtime and invocation-retry documents listed in CONTRACTS I. Record verified runtime/SDK versions and supported model capabilities. Do not assume the existing local Gemma model ID is a valid Bedrock ID.
- [x] Implement strict request/response schemas and redaction before transport. The cloud handler accepts only the four enumerated task types and bounded source excerpts. It cannot accept a command, arbitrary URL, local path, browser instruction or credential payload. Reject unsupported source IDs/claims when its reply returns locally.
- [x] Build an isolated Lambda package with pinned dependency versions and a lockfile. Use `npm ci --ignore-scripts --prefix auto/learning/cloud` after creating/reviewing the lockfile. Do not alter root dependencies or run root postinstall. Test the handler by injecting the Bedrock client rather than contacting AWS.
- [x] Use the selected Lambda runtime verified at deployment, `BedrockRuntimeClient({region:'us-east-1',maxAttempts:1})`, and `ConverseCommand`. The model is a deployment-approved environment value, never arbitrary request input. Set deterministic low-temperature analysis and an explicit output limit; parse and validate returned JSON without executing it.
- [x] Add a pricing-versioned local reservation before calling Lambda. Require an approved model, maximum input/output bounds and dollar/call limits. Prefer supported CountTokens to validate input; otherwise reserve the approved model's full input ceiling conservatively, or refuse if a defensible bound cannot be established. Unknown pricing means cloud disabled, not guessed cost.
- [x] Keep reservations for unknown outcomes. Use synchronous `RequestResponse`, one local in-flight review, `AWS_MAX_ATTEMPTS=1`, and no automatic retry after transport timeout. Reconcile the named request if possible; otherwise mark its cost/outcome unknown and do not reissue the same batch automatically.
- [x] Define least-privilege deployment: no public Function URL; one function/alias invokable by the local profile; Lambda may invoke only the approved Bedrock resources and write payload-free operational logs. No mailbox, browser, S3 data ingestion or application permission. Log retention, memory, timeout and concurrency are bounded in the template. Do not enable cross-region inference without approval.
- [x] Return actual model usage when provided. Token reservations are an analysis-budget control, not a guaranteed cap on the entire AWS bill: Lambda, logs and deployment artifact storage also have costs and require D03's resource approval.
- [x] Run `node --test auto/learning/cloud/test/*.test.mjs auto/test/learning-cloud-client.test.mjs`. Cover zero budget, unapproved model, oversized/private payload, prompt injection in a source, malformed JSON, unknown source citation, provider error and client timeout. Assert no transport call when disabled and no implicit second invocation.

Core handler pattern to implement with request/schema checks around it:

```js
const client = new BedrockRuntimeClient({region:'us-east-1',maxAttempts:1});
const response = await client.send(new ConverseCommand({
  modelId: approvedModelId,
  system: [{text: analysisInstructions}],
  messages: [{role:'user',content:[{text:JSON.stringify(minimizedEvidence)}]}],
  inferenceConfig: {maxTokens:1200,temperature:0}
}));
```

Local transport is `spawn`/`spawnSync` with an argument array, never a shell-concatenated command. An authorized invocation uses the installed AWS CLI, `--profile hk_dev --region us-east-1 lambda invoke --invocation-type RequestResponse`, a private temporary payload file and a private response file. CLI credentials stay local; Lambda uses its execution role.

Deployment is a separate gated step in T27. The executor must present the template/IAM diff, exact model, resource limits, expected pricing basis and artifact bucket for approval. Do not invent account IDs, ARNs, model IDs or bucket names to make a deployment command look complete.

## T18. Learn scoped procedures and evaluate them before promotion

**Create:** `auto/learning/procedures.mjs`, `auto/test/learning-procedures.test.mjs`, `auto/test/fixtures/learning/procedure-evaluation.json`.
**Produces:** `evaluateProcedure`, `promoteProcedure`; declarative procedure records.

- [x] Extract episodes containing the starting condition, allowed action, observed result, wait/active time, failures, source/policy versions and verified outcome. Include failures and contradictions, not only successful examples.
- [x] Generate candidate procedures scoped initially to an employer/ATS tenant and exact preconditions. Example step types: `open_existing_application`, `inspect_fields`, `wait_for_verification`, `recheck_session`, `resolve_known_question`, `request_human_help`. None may contain arbitrary code, a shell command, a secret, a new permission, or a generic final-submit action.
- [x] Assemble a frozen evaluation set containing representative successes, failures and near misses. Separate examples used to derive a candidate from held-out evaluation cases; record both source-ID lists. Include tenant mismatch, stale verification, changed options and unavailable tools.
- [x] Evaluate the candidate using a fixed trusted simulator/fixture driver. Require zero safety violations, no truthfulness/coverage regression and a measured improvement or equivalent behavior with fewer actions on the intended cases. Report sample size and failures. Do not run model-generated test code.
- [x] Persist the evaluation through `commitRecord` in `reviewRuns`, with the procedure version, fixture digest and held-out source IDs. Promotion must reload and verify this record; a missing/stale evaluation ID or caller-supplied `passed:true` cannot authorize promotion.
- [x] Default to `tested`, awaiting D04. Automatic promotion, if explicitly enabled later, applies only to allowlisted data-only procedures within existing wait/retry/tool limits. New permissions, source facts, submission rules, model budgets and code are never auto-promoted.
- [x] Track active version, last verification, contradictions and revocation. A changed employer flow can make a procedure stale. Keep in-flight attempts pinned to their version; new attempts use the next approved version only at a safe boundary.
- [x] Run `node --test auto/test/learning-procedures.test.mjs`. Assert that one tenant's success cannot promote a global rule and that rollback restores the previous procedure for new attempts without altering an active attempt.

```js
const evaluation = evaluateProcedure(ctx,{procedureId,fixtureSet:heldOutCases});
assert.equal(evaluation.safetyViolations,0);
assert.equal(evaluation.regressions,0);
await assert.rejects(promoteProcedure(ctx,{procedureId,evaluationId:evaluation.id,approval:null}));
```

## T19. Run a bounded incremental reviewer, not an unrestricted supervisor

**Create:** `auto/learning/reviewer.mjs`, `auto/test/learning-reviewer.test.mjs`.
**Modify:** `auto/learn.mjs`, existing panel timer integration and post-attempt local consolidation hook.
**Produces:** `runReview`, `reviewDue`, review-run records, candidate proposals.

- [x] Persist a high-water mark over settled source IDs/revisions, a reviewer lease, due time and one active run ID. Use deterministic source batches; do not rescan the whole history into every prompt. Failed/unsettled artifacts remain explicitly pending.
- [x] On each attempt completion, perform cheap validated capture. Consolidate new records when idle or through the local reviewer. Use a default six-hour review interval only after enabling it; missed intervals coalesce into one bounded catch-up run after sleep/restart.
- [x] Keep application-start scheduling separate. The existing panel may check whether review is due, but the reviewer cannot call `startCycle`, submit, change desired application-running state, or enable the disabled application launchd schedule.
- [x] For each batch, compute deterministic failure/reuse/cost summaries first; invoke optional analysis only if needed and permitted by the budget. Stop on configured batch/time limits and preserve the cursor for continuation. A malformed source must not block all unrelated records indefinitely.
- [x] Create evidence-linked proposals for answers, procedures, config, code, UI and positioning. Code/UI proposals are inert suggested diffs or implementation notes; they are never automatically executed. Testing an arbitrary generated code patch itself requires a reviewed, isolated maintenance workflow, not the production review loop.
- [x] Record why a proposal is useful, its baseline, expected scope, actual evaluation result and approval gate. Suppress duplicate proposals by affected component/source/version while retaining additional supporting evidence.
- [x] Test restart mid-batch, two panel processes, future/backward clock shift, sleep/catch-up, unknown cloud outcome, budget exhaustion and rejection of a proposal that attempts to grant itself authority. Run `node --test auto/test/learning-reviewer.test.mjs`.

```js
await runReview(ctx,{localOnly:true,limit:25,approvalId:null});
assert.equal(fakeApplicationStarter.calls,0);
assert.equal(fakeShell.calls,0);
assert.equal(fakeCloud.calls,0);
assert.ok(savedReview.cursor);
```

Implement CLI `node auto/learn.mjs review --once --local-only` as a local, feature-flagged run. A cloud-enabled variant requires a recorded D03 approval; the presence of an AWS credential profile is insufficient.

## T20. Measure operational savings and career outcomes honestly

**Extend:** `intelligence.mjs`, digest/analytics integration; **Create:** `auto/test/learning-metrics.test.mjs`.
**Produces:** `deriveLearningMetrics`.

- [x] Record reuse disposition, new-question rate, unsupported/conflicted answers, repeat missing-fact blocks, active browser time, email/queue wait time, action count, model usage/cost when available, attempt outcome and tracker synchronization separately. Unknown usage remains unknown, not zero.
- [x] Join verified application identity, resume/source version, policy/procedure cohort, posting age, reply/interview/offer/hiring outcome and observation window. Reuse the canonical tracker/outcome readers; do not infer rejection from a pending application.
- [x] Preserve existing advisory calibration constraints. Do not auto-edit global scoring rules, application threshold, resume facts or candidate preferences. Display rates only when the underlying existing calibration rules support them; do not recompute a more flattering rate.
- [x] Compare fixed fixture replays for mechanistic savings. For live before/after comparisons, expose changed role mix, ATS mix, date window and small samples; label associations rather than claiming a procedure caused an interview.
- [x] Test missing token usage, waiting versus active time, duplicate attempts, pending outcomes, later outcome corrections, altered resume versions and tiny cohorts. Run `node --test auto/test/learning-metrics.test.mjs`.

## Phase 4 review gate

- [x] Role insights cite actual source evidence and distinct denominators; candidate facts remain independent of market demand.
- [x] Cloud-disabled operation is useful and complete for capture/reuse/local metrics.
- [x] No unapproved model call, duplicate paid request, automatic application start or executable generated patch occurred.
- [x] Procedure promotion has a reproducible evaluation result and scope; model confidence alone is not acceptance.
- [x] Metrics separate saved time, wait time, cost uncertainty and actual career outcomes.
