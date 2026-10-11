# Shared implementation contracts

This is the interface agreement for phases 01–06. Functions listed under **new** do not exist at handoff; the named task creates them. Do not call them before that task, invent alternate spellings, or silently change their shapes. All identifiers below are case-sensitive. APIs use `schemaVersion`; historical input aliases are handled only at ingestion.

## A. Existing APIs verified in the checkout

| Existing source | Exact reusable API / behavior |
|---|---|
| `path-resolver.mjs` | `getCareerOpsRoot()`; `resolveTrackerPathForWrite(root)`; data root may differ from code root. |
| `pipeline-lock.mjs` | `acquirePipelineLock(path, options)` returns a lock with `release()`; `withPipelineLock(path, asyncFn, options)` releases in `finally`. Locks have owner tokens and live-PID protection. |
| `url-key.mjs` | `normalizeUrl(raw)`; preserve requisition-bearing distinctions; do not deduplicate only by employer/title. |
| `application-answers.mjs` | `parseApplicationAnswersSection(text, {strict})`, `parseDraftAnswersBlockH(text)`, `normalizeApplicationAnswersSnapshot(snapshot)`. An absent section returns null. |
| `tracker-parse.mjs` | `resolveColumns(lines)`, `parseTrackerRow(line, colmap)`, `extractTrackerReportNumbers(reportCell, notesCell)`. |
| `application-artifacts.mjs` | `applicationArtifactPaths({reportNum, company, role, version, root})`, `ensureApplicationArtifactDirs(paths)`, `writeReuseDecision(paths, decision)`. |
| `calibrate.mjs` | `parseOutcomeJournal(text)`, `computeCalibration(rows, journals, opts)`, `loadTrackerRows(appsFile)`, `loadLedgerReached(workspaceRoot)`. Read implementations before adapting inputs. |
| `auto/state.mjs` | `createJob`, `loadJob`, `saveJob`, `transition`, `pickOrder`. T03 updates local callers consistently for optimistic concurrency. |
| `auto/apply-worker.mjs` | `verifyAudit(auditDir,{submit})`, `syncTrackerApplied(job,auditDir,log)`. Existing audit success is structural, not proof of external delivery. |
| `auto/panel.mjs` | `createPanelServer()`, queue/config helpers. Local panel is the integration surface; upstream `web/` remains unchanged. |

## B. Source layout: one responsibility per module

All are **new** unless marked existing. Exact exports are in section E.

```text
auto/learn.mjs                         CLI and main-module guard only
auto/learning/context.mjs             code/data roots, clock, feature configuration
auto/learning/contracts.mjs           schema validation, enums, public record limits
auto/learning/store.mjs               versioned local records, locks, indexes
auto/learning/evidence.mjs            audit/report import and secret exclusion
auto/learning/questions.mjs           occurrences, definitions, family matching
auto/learning/answers.mjs             authoritative lookup, proposals, invalidation
auto/learning/retrieval.mjs           bounded context packets and evidence stories
auto/learning/freshness.mjs           date metadata and shared queue ordering
auto/learning/workflow.mjs            checkpoints, blockers, reconciliation, sync tasks
auto/learning/procedures.mjs          scoped lessons and promotion evaluation
auto/learning/intelligence.mjs        role/capability cohorts and grounded insights
auto/learning/reviewer.mjs            incremental review, budgets, proposal lifecycle
auto/learning/cloud-client.mjs        approved Lambda invocation; no direct model fallback
auto/learning/api.mjs                 local routes, CSRF, pagination and approvals
auto/learning/cloud/                  isolated Lambda package, tests and template
auto/ui/learning/                     small shared client plus separate view modules/CSS
auto/test/learning-*.test.mjs          focused node:test suites
auto/test/fixtures/learning/           synthetic fixtures, never copied credentials/PII
config/learning.yml                   local feature flags, limits and approval-gated values
```

Modify only the relevant existing `auto/state.mjs`, `auto/run.mjs`, `auto/eval-queue.mjs`, `auto/resume-select.mjs`, `auto/apply-worker.mjs`, `auto/diagnose.mjs`, `auto/digest.mjs`, `auto/panel.mjs`, its prompt and the small UI mount in `auto/panel.html`. Changes to `config/auto.yml` fix its existing policy wiring, not its authorization scope. Register local paths through the documented local-path mechanism only if the repository's coverage check requires it; do not disable core validation.

## C. Local storage and identities

```text
data/auto/learning/
  identity.json                       local store UUID, schema/read compatibility
  records/<collection>/<id>/<rev>.json immutable versioned canonical learning records
  indexes/<generation>/               derived indexes, counts and retrieval terms
  indexes/current.json                atomic pointer to a completed generation
  captures/<attemptId>/               sanitized page/field observations
  quarantine/                         metadata-only rejected/import-gap reports
  reports/                            manifests, evaluation and activation evidence
  reviewer.json                       due time, durable cursor, lease, run/budget status
```

Allowed collections: `observations`, `questions`, `families`, `answers`, `sourceChanges`, `blockers`, `accounts`, `procedures`, `insights`, `proposals`, `syncTasks`, `reviewRuns`, `forgetRequests`. Credentials are not a collection. Existing candidate sources remain outside this ledger and are referenced, not reauthored as model memories.

- IDs are opaque hex hashes or UUIDs, never path fragments supplied by a model. Collections are an enum; reject traversal and unexpected filenames.
- `applicationId` is a durable local identity linked to normalized posting URL and verified requisition aliases. It is not the tracker row number, which may change during merge.
- `attemptId` is a UUID allocated once for an execution; retry count is independent. Audit directory is `output/<existing-application-key>/audit/attempt-<attemptId>/`, created exclusively. Legacy attempt directories remain untouched.
- An observation identity derives from attempt ID, page/step identity, field identity and revision, and source artifact digest. Re-importing an identical observation is idempotent. Repeated retries are separate occurrences but not separate jobs in market denominators.
- `revision` begins at 1. Under the existing per-entity lock idiom, compare expected revision and write a new complete version atomically. A crash cannot expose half a JSON file. A conflict returns a typed error, never a blind overwrite.
- The latest immutable version is authoritative for a learning entity; indexes and current pointers can be rebuilt. Index generations include input record IDs/revisions and a digest so stale snapshots are detectable. A pagination cursor names its generation; expired cursors return refresh-required, not silently mixed pages.
- Directories are owner-only and files are owner-readable/writable. Do not claim encryption from file permissions. Do not change permissions of unrelated historical files recursively.
- Do not let an append-only history defeat an approved privacy deletion. T08/T25 define invalidation and physical erasure accounting, including earlier versions and derived indexes.

### Common envelope

```js
{
  schemaVersion: 1,
  id: 'opaque-id',
  revision: 1,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  sourceIds: [],
  status: 'collection-specific-enum',
  data: {}
}
```

Validate unknown keys where they affect policy, reject non-finite numbers and prototype-related keys, cap text/arrays, and distinguish missing files from malformed/unreadable ones. Future schema versions require a migration/refusal path, not permissive parsing.

## D. Domain records

### D1. Question observation

```js
{
  applicationId, attemptId, questionId,
  companyId, employerName, atsVendor, atsTenant,
  roleTitle, roleFamily, country, locale,
  stepId, fieldId, fieldType,
  originalText, options: [{ value, label }],
  required: true, parentCondition: null,
  unit: null, currency: null, timeHorizon: null,
  observedAt, sourceArtifact: { relativePath, sha256 },
  captureMethod: 'live_structured',
  coverage: 'observed',
  answerDisposition: 'unanswered',
  answerRef: null
}
```

`captureMethod`: `live_structured|legacy_array|legacy_object|report_section|manual_review`.
`coverage`: `observed|partially_observed|not_reached|unknown`.
`answerDisposition`: `unanswered|reused|drafted|confirmed|declined|blocked`.
`fieldType`: `text|textarea|select|radio|checkbox|date|number|file|custom|unknown`.

Never manufacture `observed` from a generated draft question. Required state can be null when not captured. An unseen conditional step is a coverage gap, not an empty form. Preserve language, negation, units, options, and country context. Sensitive answer values use a source reference, not duplicate plaintext in an observation.

### D2. Question definition and family

A definition contains normalized text, original examples, field semantics/options, polarity, units/time horizon, locale, and occurrence references. A family groups semantically compatible definitions through an explicit alias record. Exact normalization may automatically group whitespace/case variants; embedding/model similarity only proposes a family link. Do not merge current work authorization with future sponsorship, base salary with total compensation, or employer-specific prior employment across companies.

Definition data keys are `normalizedText`, `originalExamples`, `fieldType`, `locale`, `optionsHash`, `polarity`, `unit`, `timeHorizon`, `constraints`, and `occurrenceIds`. A family uses `label`, `questionIds`, and `scope`; its approval state belongs in the common envelope. IDs and provenance remain in the envelope or its source references, not arbitrary nested alternatives.

### D3. Answer record

```js
{
  questionFamilyId,
  kind: 'source_reference',
  authority: 'user_confirmed',
  sourceRefs: [{ fileKey: 'standing', selector: 'custom.notice_period', sha256 }],
  scope: { employerId: null, country: null, roleFamily: null, locale: 'en' },
  validFrom, validUntil: null,
  dependencies: [],
  approvalRef,
  publicUse: 'applications_only',
  lastValidatedAt,
  template: null
}
```

`kind`: `source_reference|derived_rule|grounded_template|draft`.
`authority`: `canonical_source|user_confirmed|inferred|generated`.
Record status: `proposed|approved|stale|conflicted|revoked`.

Only approved, current, context-compatible records with valid authoritative sources qualify for deterministic reuse. `generated` or `inferred` cannot become a personal fact because the form accepted the answer. Store source references to profile/CV/standing answers; approved derivations must name their input facts and rule version. Recheck dynamic answers such as age/availability/employer history at use time. Optional sensitive questions remain governed by the user's explicit response policy.

`sourceSnapshot` has `{sources:[{fileKey,sha256,valuesBySelector,publicUse,confirmedAt}],capturedAt}`. It is a private in-process input, never a default API/cloud response. A legacy audit row merely labeling its source `profile` is not proof: the importer must match the actual authoritative selector/value/context or leave it unverified. A null expiry means source-bound validity, not permission to reuse a time-sensitive answer whose current applicability is unknown.

### D4. Application execution extension

Preserve existing coarse `stage` for compatibility. Add this versioned extension to jobs through T03's shared mutation path:

```js
{
  recordVersion: 1,
  applicationId,
  execution: {
    attemptId: null,
    phase: 'not_started',
    policyVersion: null,
    sourceVersion: null,
    procedureVersion: null,
    submissionPossible: false,
    confirmationRef: null,
    blockerId: null
  },
  trackerSync: { status: 'not_required', taskId: null },
  dates: {
    postedAt: null, postedPrecision: null, postedSource: null,
    firstSeenAt: null, lastCheckedAt: null, repostedAt: null
  }
}
```

Phases: `not_started|preparing|awaiting_answer|awaiting_verification|ready_to_submit|submission_possible|submission_unknown|confirmed|definitely_not_submitted`.

Before launching any worker with submission capability, persist `submissionPossible:true` and the exact job/policy intent. This conservative boundary remains necessary even if a finer pre-submit checkpoint is missing. A crash/timeout after that point cannot be automatically classified as non-submission by the worker's narrative. Unknown outcomes map to coarse `parked`, with a structured blocker; generic requeue must refuse them. A read-only reconciler can resolve them using job-bound evidence, or leave them for human review.

### D5. Blocker/account/procedure

- Blocker: `applicationId`, `attemptId`, `type`, exact question or expected verification, required resolution, authoritative source versions, `nextCheckAt`, deadline, status and resolution evidence. Types: `missing_answer|verification_pending|captcha|account_conflict|submission_unknown|source_conflict|policy|tool_unavailable`.
- Account memory: tenant/employer/login-identity reference, `credentialRef`, lifecycle state and timestamps. No password, OTP, token or verification URL. Existing plaintext credentials must not be copied into learning or analytics.
- Procedure: scope, preconditions, ordered allowlisted step types, expected observations, maximum retries/waits, last verified time, supporting and contradicting attempt IDs, evaluation version/result, status `candidate|tested|active|stale|revoked`. Steps are declarative, never shell/JavaScript strings.

### D6. Intelligence and change proposals

An insight records the role-family/cohort filter, observation interval, distinct job/company counts, capture coverage, supporting occurrence/JD references, computed statistics, contradictory evidence and source versions. A proposed resume/LinkedIn edit references exact approved experience and is `draft`; market demand never creates a qualification.

Insight data uses `roleFamily`, `filters`, `from`, `to`, `distinctJobs`, `distinctCompanies`, `rawOccurrences`, `coverage`, `statistics`, `sourceIds`, `contradictions`, and `recommendations`. These names are shared by derivation, tests, APIs and UI; no model-generated alternative shape bypasses validation.

A proposal records `kind: answer|procedure|config|code|ui|positioning`, evidence IDs, intended benefit, risk, baseline, evaluation result, affected sources, required approvals, status, rollback version, and optional reviewable diff. Code/UI diff content is inert text. The reviewer cannot execute it, start a shell, edit permissions, or invoke an application.

## E. New public interfaces

Every API accepts an explicit `ctx` where filesystem access occurs. `ctx = {codeRoot,dataRoot,now}`; `now()` returns a Date. Tests inject a fixed clock and temporary data root. Functions named `read`, `list`, `get`, `resolve`, `derive`, `order`, `evaluate` do not mutate unless the signature explicitly says commit/apply.

| Module / creator task | Signature and return |
|---|---|
| context / T01 | `createLearningContext({codeRoot,dataRoot,now}) -> ctx`; `readLearningConfig(ctx) -> validatedConfig` |
| store / T02 | `getRecord(ctx,collection,id) -> envelope|null`; `listRecords(ctx,collection,{cursor,limit,filters}) -> {items,nextCursor,generation}` |
| store / T02 | `commitRecord(ctx,collection,id,data,{expectedRevision,status,sourceIds}) -> envelope`; create uses expectedRevision 0; conflict code `REVISION_CONFLICT` |
| store / T02 | `rebuildIndexes(ctx,{apply}) -> {generation,counts,errors}`; false performs validation without swapping indexes |
| evidence / T04 | `normalizeAuditAnswers(input) -> {entries,rejected}`; entry `{fieldId,label,value,source,section}`; unknown shapes rejected, not recursively guessed |
| evidence / T05 | `captureAttempt(ctx,{attemptDir,apply}) -> {added,duplicate,rejected,coverage}`; `backfillHistory(ctx,{manifestPath,apply}) -> summary` |
| questions / T06 | `normalizeQuestion(observation) -> definition`; `findQuestionCandidates(ctx,observation,{limit}) -> candidates[]` |
| answers / T07 | `resolveAnswer(ctx,{observation,sourceSnapshot,policy}) -> {status,value,answerId,sourceRefs,reason}`; status `ready|needs_confirmation|draft|stale|blocked`; only `ready` returns a fillable value |
| answers / T08 | `proposeAnswer(ctx,input) -> proposal`; `approveAnswer(ctx,{proposalId,expectedRevision,approval}) -> {status,sourceHash}`; `invalidateSource(ctx,{fileKey,oldHash,newHash}) -> summary` |
| retrieval / T09 | `buildContextPacket(ctx,{applicationId,observations,maxBytes}) -> {answers,stories,procedures,gaps,versions,bytes}` |
| freshness / T11 | `readJobDates({pipelineLine,historyRow,providerEvidence,now}) -> dates`; `orderJobs(jobs,{maxAttempts,mode,now}) -> jobs[]` |
| workflow / T13 | `checkpointAttempt(ctx,{applicationId,attemptId,expectedVersion,phase,evidenceRefs}) -> job`; `resolveBlocker(ctx,{blockerId,resolution,approval}) -> result` |
| workflow / T14 | `reconcileAttempt(ctx,{applicationId,attemptId,evidence}) -> {status,evidenceRefs,reason}`; status `confirmed|definitely_not_submitted|unknown` |
| workflow / T15 | `syncSubmittedJobs(ctx,{limit,executeStatus}) -> summary`; injected executor calls sanctioned tracker scripts, never submits |
| intelligence / T16 | `deriveRoleInsights(ctx,{roleFamily,filters,asOf}) -> insights[]` |
| cloud-client / T17 | `requestAnalysis(ctx,{requestId,task,payload,approvalId}) -> analysisReply`; injected transport for tests; unknown timeout is not automatically retried |
| procedures / T18 | `evaluateProcedure(ctx,{procedureId,fixtureSet}) -> evaluation`; `promoteProcedure(ctx,{procedureId,evaluationId,approval}) -> record` |
| reviewer / T19 | `runReview(ctx,{localOnly,limit,approvalId}) -> runReport`; `reviewDue(state,now) -> boolean` |
| intelligence / T20 | `deriveLearningMetrics(ctx,{from,to,cohort}) -> metrics` |
| api / T21 | `handleLearningRequest(req,res,{ctx,session}) -> boolean` indicating whether a learning route handled the request |

`auto/state.mjs` gains `updateJob(urlKey,{expectedVersion,patch,transitionTo}) -> Promise<job>`. It reads the latest job under a per-job lock and refuses stale writes. Migrate every local caller; do not leave synchronous callers ignoring promises. Use one consistent revision property, `recordVersion`, and pin the worker's initial version only until its next fresh read; do not hold a job lock during a 25-minute browser session.

`buildContextPacket.versions` is `{sourceHashes,policyVersion,procedureVersions,questionRevisions}`. Procedure evaluations return `{id,procedureId,fixtureDigest,derivationSourceIds,heldOutSourceIds,safetyViolations,regressions,actionDelta,results}`. Evaluation is read-only; the coordinator persists its result in a `reviewRuns` record before promotion. `promoteProcedure` reloads that record and verifies its procedure/fixture version rather than trusting an arbitrary caller-provided success boolean.

## F. Defaults and runtime decisions

```yaml
schema_version: 1
enabled: false
mode: shadow
capture:
  max_artifact_bytes: 2097152
  max_fields_per_page: 100
retrieval:
  max_candidates: 12
  max_context_bytes: 24000
review:
  enabled: false
  interval_minutes: 360
  max_new_attempts: 25
  concurrency: 1
  auto_promote_procedures: false
queue:
  mode: existing
cloud:
  enabled: false
  region: us-east-1
  profile: hk_dev
  function_arn: null
  model_id: null
  daily_usd_cap: 0
  max_calls_per_day: 0
  max_output_tokens: 1200
  max_payload_bytes: 65536
```

Queue modes: `existing|fit_then_freshness|freshness_then_fit`. Fit/eligibility threshold and manual holds remain enforced in all modes. Cloud activation requires a validated approved model/pricing record and explicitly nonzero limits; never infer permission from a configured AWS profile.

## G. Local API and UI contracts

Prefix `/api/auto/learning`. GET routes: `/status`, `/questions`, `/question?id=`, `/answers`, `/blockers`, `/insights`, `/procedures`, `/proposals`, `/metrics`. Every list supports capped pagination and a stable generation. POST routes: `/answers/propose`, `/answers/approve`, `/blockers/resolve`, `/procedures/promote`, `/proposals/decision`, `/review`, `/privacy/preview`, `/privacy/apply`. Read-only routes never start a model or application.

POSTs require matching loopback Host and Origin, an issued CSRF token, JSON content type, a 64-KiB body cap, strict field schemas and an expected record revision. Return 409 for stale decisions, 403 for missing authority, 422 for invalid data, and a visible reason for unavailable features. No unrestricted file path, command, model ID, script or target URL may be supplied by the browser. Sensitive values are not included in default list/search payloads.

## H. Cloud analysis contract

Local caller sends `{schemaVersion:1,requestId,task,policyVersion,payload}`. Allowed tasks: `question_families|role_requirements|procedure_candidates|improvement_review`. Payload contains source IDs and explicitly allowlisted minimized text, never passwords, OTPs, mailbox bodies, full profiles, or raw prompt logs. Personal evidence needed for a positioning draft requires an explicit public-use/application-use scope; omit it by default.

Lambda returns `{schemaVersion:1,requestId,status,modelId,usage,candidates}`. `usage` contains input/output token counts when returned by Bedrock. Each candidate carries existing source IDs; unknown IDs and unsupported quoted claims are rejected locally. Cloud output cannot approve answers or procedures, change settings, call a browser, or mutate the store.

Use an approved Node Lambda runtime verified at deployment and vendor a locked AWS SDK dependency in the isolated package. The handler uses `BedrockRuntimeClient` and `ConverseCommand`; set `maxAttempts:1` so the SDK does not silently repeat an uncertain paid call. Use structured validation on both sides. Deployment remains gated by D03; no public Function URL is needed. IAM restricts the local caller to one function/alias and Lambda to approved model resources. Profile names are local credentials configuration, not Lambda execution-role credentials.

## I. Documentation discovery references

Verified primary documentation during planning; read fresh before cloud implementation/deployment:

- Bedrock Converse: `https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html`
- JavaScript v3 example: `https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html`
- CountTokens: `https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html`
- Lambda Node runtimes: `https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html`
- Lambda invocation retry semantics: `https://docs.aws.amazon.com/lambda/latest/dg/invocation-retries.html`
- LangGraph memory/persistence concepts: `https://docs.langchain.com/oss/javascript/concepts/memory` and `https://docs.langchain.com/oss/javascript/langgraph/persistence`.

The plan does not depend on adopting LangGraph/LangMem or their storage APIs. Do not invent tool SDK methods, assume model availability, use cross-region inference without approval, or confuse a checkpoint with an external transaction receipt.

## J. Worker-to-learning protocol

T10 must provide a concrete callable path, not merely add “remember everything” to a prompt. Implement these strict JSON-oriented subcommands in `auto/learn.mjs`, backed by the same functions used in tests:

```text
observe-page --attempt-id ID --input FILE --apply
resolve-page --attempt-id ID --input FILE
checkpoint --attempt-id ID --phase PHASE --input FILE
capture-attempt --attempt-id ID --apply
```

`ID`, `FILE` and `PHASE` are runtime arguments, not unknown design decisions. Input files must be owned captures beneath that active attempt's approved root, validated by resolved path and attempt identity. Observe input is `{stepId,pageIdentity,fields,evidenceRefs}` with each field conforming to D1. Resolve returns the bounded context-packet contract. Checkpoint input is `{evidenceRefs,blockerRequest}`; it cannot declare confirmed delivery, clear `submissionPossible`, approve answers, or change policy. The trusted parent owns final capture and outcome reconciliation.

The runtime must expose only the commands/capabilities needed by the worker through a verified restricted integration. If its CLI cannot provide that restriction, implement an allowlisted tool bridge using that runtime's documented tool interface, or leave live execution disabled; a prompt asking a broadly privileged shell not to touch files is not a technical fence. Do not invent an MCP SDK API without discovery. Browser capability remains Neo/CDP, not a new browser engine.

Save observations before advancing to another page. Large forms are chunked into multiple capped messages with stable field identities and an explicit expected field count; mark incomplete capture when a chunk is missing. Use scoped structured logs only. Neither raw credential input nor full candidate-source payloads belong in those logs.
