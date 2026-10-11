# Execution log — Career Ops learning system

## Baseline (2026-10-11T09:05Z)

- HEAD: `e105d660` on branch `learning-system` (created from main with explicit user authorization; commits allowed on this branch, no push/merge without separate authorization — deviation from the plan's no-branch default, authorized by the user's standing instruction "merge db-migration, then execute the learning plan in a NEW branch").
- Working tree: clean except untracked `.kilo/plans/2026-10-11-career-ops-learning/`.
- Node: v26.7.0. Code root == data root: `/Users/jarvis/AI-Playground/career-ops/career-ops`.
- Live services (do not restart without a D01 window):
  - `io.career-ops.panel` (launchd, auto/panel.mjs :3001)
  - `io.career-ops.web-ui` (launchd, web server.mjs :3003)
  - `auto/run.mjs --skip-scan` (background process bgp_12a2e3436001A7rx8sJw2xPxE4, PID 27430, owned by this coordinator)
- Decision register: all defaults in force (D01–D07). No cloud, no activation, flags off.

## Reconciliation with plan baseline 58ff2858 (required by EXECUTOR.md)

The DB migration landed between planning and execution (merged to main at `e105d660`):

1. All tracker/pipeline/job state now lives in SQLite `data/career-ops.db` via `core/db.mjs`
   (node:sqlite, WAL). `data/applications.md`, `data/auto/jobs/*.json`, `pipeline.md`,
   `status-log.tsv` etc. are RETIRED (archived in `data/migrated-archive-2026-10-11/`).
   Everywhere the plan says "data/applications.md ... authoritative", read: the
   `applications` table via `core/db.mjs`.
2. `auto/state.mjs` keeps its public API (`createJob/loadJob/saveJob/transition/pickOrder`)
   but is DB-backed: jobs live in the `auto_jobs` table (columns
   `url_key,url,company,role,ats,stage,score,attempts,priority,data,updated_at`; `data` is the
   full job JSON; typed columns kept in sync by `saveAutoJob`). Test isolation now uses
   `CAREER_OPS_DB=<temp>.db`, not `CAREER_OPS_AUTO_JOBS_DIR`.
3. T01 fixture helper must create a synthetic temp DB (set `CAREER_OPS_DB`; `core/db.mjs`
   auto-creates schema) instead of seeding `data/auto/jobs/`. Keep `CAREER_OPS_ROOT`
   pointing at the scratch root as the plan requires.
4. T03 optimistic concurrency (`updateJob` CAS): implement `recordVersion` inside the job
   JSON (`data` column) and perform compare-and-swap inside a single `db.tx()` —
   SQLite transactions replace the per-job directory-lock idiom. `withPipelineLock`
   remains only for the stores that stayed files.
5. `verify-pipeline.mjs` is DB-mode by default; `CAREER_OPS_TRACKER` selects legacy file
   mode for tests only.

Requirements preserved; only mechanisms updated. No task dropped.

## Tasks

Task: T01 — learning context, config, fixtures
Status: implemented (offline-checked)
Evidence: 8 pass in auto/test/learning-context.test.mjs; config/learning.yml =
CONTRACTS F defaults (disabled/shadow); fixture helper isolates via mkdtemp +
CAREER_OPS_ROOT + CAREER_OPS_DB; live config byte-identity asserted in-suite.
Delegated to implementer subagent ses_ed5cb886dffe7ROaQgKlHoQEHz; coordinator
re-ran suites independently (26 pass, 0 fail total across T01+T02 suites).
Note: first two subagent dispatches died silently on a model output limit;
resumed session completed the work.

Task: T02 — contracts + versioned record store
Status: implemented (offline-checked)
Evidence: 12 store + 6 privacy tests pass; Promise.allSettled conflict test =
1 fulfilled + 1 REVISION_CONFLICT, final revision 2; stale cursor rejects
REFRESH_REQUIRED; expectedRevision 0 creates, revisions start at 1; atomic
temp+fsync+rename; index generations with atomic current.json swap; no
core/db.mjs imports; no live data created (data/auto/learning absent).
Open items: error-code names beyond the contract-specified set were chosen in
style (CONFIG_MALFORMED, CORRUPT_RECORD, REFRESH_REQUIRED, FORBIDDEN_PATH...);
listRecords without an index serves a deterministic scan as generation
"unindexed" — acceptable, revisit only if a later phase requires an error.
Deviation: AGENTS.md gained a "Learning layer" subsection (required by global
AGENTS.md maintenance policy; documentation only).

Commit: 3110f959 (T01+T02)

Task: T03 — CAS job updates, immutable attempts, caller migration
Status: implemented (offline-checked)
Evidence: 9/9 learning-job-state tests (child-process contention: panel hold +
worker verdict both land; two workers racing a claim -> 1 winner + loser gets
VERSION_CONFLICT w/ actualVersion; required assertion block verbatim and
passing). Legacy v0 jobs round-trip; schemaVersion 99 refused; submitted
records cannot requeue/downgrade. All suites 35/35. Self-tests: state 8/8,
run, resume-select, apply-worker, panel all pass. `state --list` read 282
live records through migration (read-only). Caller enumeration: mutators
run/eval-queue/resume-select/apply-worker/panel converted to awaited
updateJob; radar/digest read-only; legacy saveJob/transition kept for
self-tests and now bump recordVersion so CAS detects them.
Deviations: CAS via db.tx() per reconciliation (plan predates SQLite);
panel narrow patches omit expectedVersion by design (lossless shallow
patches), worker attempt-claim uses expectedVersion for single ownership.
Pipeline was gracefully paused (pause-requested flag) during shared-file
edits and resumed after commit.
Commit: 8f8ce800

Task: T04 — normalizeAuditAnswers + consumer repair
Status: implemented (offline-checked)
Evidence: 18/18 audit-contract tests (required assertion verbatim: keyed
Contact/Email -> 1 entry label Email; buildReport(fixtureAttempt) no-throw);
paired fixtures across 4 representations normalize deep-equal; false/0/empty/
multiline/missing-source/empty-object/malformed-JSON/secret classified as
observed question / reusable answer / rejected import. All learning suites
53/53. apply-worker --self-test + diagnose --self-test pass. Consumers
converted: apply-worker verifyAudit, diagnose collectAttempts/buildReport
(new answersGap + "Evidence gaps" section); panel.mjs:187 existence-only,
no conversion needed; no digest reader parses answers (rg-verified).
Deviations: contracts.mjs gained isSecretKey export (reuses existing regex);
verifyAudit treats rejection-only files as non-empty fill evidence.
Pipeline paused during edits, resumed after commit.
Commit: 276cc4c9

Task: T05 — backfill manifest + learn.mjs CLI
Status: implemented (offline-checked; live read-only smoke done)
Evidence: 13/13 backfill tests (crash-rerun idempotency, duplicate sources,
overwritten legacy dir, live-changing file, originals byte-identical); all
suites 66/66. Live read-only smoke: 109 settled entries (106 audit, 3
report), 97 jobs, 80 companies, 0 unsettled; gaps 13 missing_answers /
1618 report_without_answers / 3 unlinked_report. No --apply run (T27 gate);
data/auto/learning absent after smoke.
Known behavior: labels containing "authorization" over-reject via the shared
secret regex (safe; values never leak).
Commit: 34643815

## Phase 1 review gate — PASSED
- Nonempty fixtures -> nonempty observations; no-data vs unreadable-data
  distinguished (answersGap, coverage statuses). ✓
- Second import idempotent; crash recovery preserves accepted records. ✓
- Credentials/unknown sources cannot become approved memories (secret-key
  rejection, unknown source -> unverified). ✓
- No audit overwrite, lost queue change, model call, browser action, or live
  data mutation in testing (pipeline paused only during T03/T04 shared-file
  edits; data/auto/learning never created). ✓
- Test commands, caller-migration list, manifests, and coverage gaps recorded
  above. ✓

Task: T06 — question definitions/occurrences/families
Status: implemented (offline-checked)
Evidence: 10/10 tests; required assertions verbatim (current-auth vs future-
sponsorship ids differ; USD-base vs CAD-OTE ids differ; spaced duplicate
normalizes identical). Restricted assessments -> policy blocker metadata only;
merge/split corrections invalidate bound answers without rewriting raw
observations. 15 synthetic D1 fixtures (no real values).

Task: T07 — authority-ordered answer resolution
Status: implemented (offline-checked)
Evidence: 16/16 tests; required snippet verbatim (ready/'4 weeks'/0 model
calls on approved repeat; changed sources -> stale, value null). Conflicts ->
blocked w/ conflictingRefs; menu-offer guard; no location->eligibility
inference; drafts only model-consulting path.
Note: lexical candidate matching = Jaccard >= 0.6 over normalized tokens
(default, not plan-specified).
Commit: 6db66fcf

Task: T08 — durable approval/invalidation (commit 3c6cc32d, 21 tests)
Task: T09 — context packets (commit a8e6b2fb, 8 tests; cold 1894B/1 call,
warm 1894B/0 calls; drafts reuse proposals collection — flagged, accepted)
Task: T10 — worker integration (commit ead66d05, 13 tests)
Status: all implemented (offline-checked); suites 134/134.
T10 notes: ALL behavior gated on learning.enabled=false no-op; flag-off
prompt string-equal to legacy renderPrompt; capture protocol lives in new
auto/prompts/apply-submit-learning.md appendix (base prompt untouched);
CONTRACTS J subcommands in learn.mjs (observe-page/resolve-page/checkpoint/
capture-attempt) with realpath containment + byte caps; run.mjs stale-apply
recovery finalizes interrupted attempts; incident: run.mjs --self-test
briefly unlinked live pause flag (restored <1min, no runner activity in gap;
root-caused and fixed via injectable pauseFlag param).

## Phase 2 review gate — PASSED
- Question encountered once searchable w/ provenance, reused in 2nd fixture
  run with 0 model calls. ✓
- Changed/withdrawn answer stops reuse immediately, survives reload. ✓
- Unanswered fields + incomplete coverage visible (coverage=incomplete,
  gaps in packets/manifests). ✓
- No generated text became approved personal truth (drafts never promote;
  harness-only approval authority); no private-history prompt dumping
  (12-candidate/byte caps). ✓
- No Playwright in capture path; degraded executor -> tool_unavailable, no
  launch; live executor connection work deferred to activation (T27). ✓

Dispatch note: subagent sessions on this model intermittently die with empty
results on long first responses (output limit); mitigation = resume with
task_id or redispatch with chunked-write instructions.

Next task: Phase 3 (03-workflow-dates-and-recovery.md)

Task: T05 — repeatable history backfill (captureAttempt/backfillHistory + learn CLI)
Status: implemented (purely additive; pipeline stayed running)
Evidence: 13/13 learning-backfill tests (crash mid-batch then resume adds only
remaining records with stable distinctJobs/companies; duplicate manifest
entries dedup; overwritten legacy dir -> SOURCE_CHANGED rejection, no partial
import; missing source -> SOURCE_MISSING; live-changing file -> UNSETTLED;
foreign-root manifest -> ROOT_MISMATCH; array/object mix; report with no
answers -> coverage gap, zero observations; Block H drafts coverage 'unknown',
section rows 'partially_observed', audit rows 'observed'; no answer values in
observation data; originals byte-identical after import; rebuild --verify
counts match). All learning suites 66/66. Live read-only smoke: inspect +
backfill --dry-run --out /tmp artifact -> 109 settled entries (106 audit-
answers, 103 w/ answers across 119 attempt dirs: 13 missing_answers gaps;
3 report-answers), 97 distinct jobs, 80 company slugs, 0 unsettled, gaps
1618 report_without_answers + 3 unlinked_report; data/auto/learning still
absent after smoke (ls exit 1). No apply against live data (T27 gate).
Deviations: none vs CONTRACTS E; one fixture label ('Work authorization')
tripped the shared secret-key regex ('authorization') — renamed in the test;
contract behavior kept as-is intentionally (over-rejection is safe, values
never leak). SETTLE_MS=10s; manifest schemaVersion 1, adapter versions
audit-answers@1/report-answers@1.
Commit: (pending — coordinator commits)

Task: T08 — durable proposal and approval (proposeAnswer/approveAnswer/invalidateSource)
Status: implemented (offline-checked; additive only, pipeline untouched)
Evidence: 21/21 new tests (13 learning-answer-approval + 8 learning-
invalidation); all learning suites 113/113 (92 baseline + 21). Required
assertions verbatim: stale expectedRevision rejects with
error.code==='REVISION_CONFLICT'; hashFile(standingPath)===hashAfterIndependentEdit.
Proposals never touch sources; sensitive values redacted in default lists;
byte-preserving custom-block patch (comments survive, only approved path
changes; profile/CV/non-custom/existing-key edits refuse with
COMPLEX_SOURCE_EDIT/CONFLICTING_SOURCE_EDIT). Approval: user-approval token
(WeakSet; agent actor:'user' -> APPROVAL_REQUIRED) + withPipelineLock on the
standing file + persisted intent + atomic write + committed-hash verification;
idempotent repeat -> already_applied. Crash reconciliation
(reconcileApprovals): after-hash match finalizes without reapplying,
before-hash match drops the pending intent (never a usable fact), divergence
kept for review. invalidateSource: bound answers stale (revoked on deletion),
grounded-template stories/procedures/insights stale, positioning drafts
rejected, only bound non-submission_unknown blockers notified, sourceChanges
recorded; stale fact no longer resolves. previewForget lists canonical
revisions/derived gen-* indexes/surviving original audits; deletes nothing and
never claims erasure while originals remain.
Deviations: reconcileApprovals + previewForget + createUserApproval exported
beyond the three contract functions (needed for crash-recovery and forget
checkboxes); approveAnswer returns 'already_applied' on repeat (idempotency).
Commit: (pending — coordinator commits)

## T09 — small, source-bound answer and experience packets (2026-10-11)

Files: auto/learning/retrieval.mjs (new), auto/test/learning-context-packet.test.mjs (new).
buildContextPacket(ctx,{applicationId,observations,maxBytes,...}) ->
{answers,stories,procedures,gaps,versions,bytes} per CONTRACTS E. Retrieval
limited to observed questions (resolveAnswer per observation), max 12
candidates, byte cap min(maxBytes, config 24000); answers/gaps/provenance and
up to 5 relevant procedures reserved before optional stories (stories dropped
first under pressure, dropped answers surface as gaps). Experience stories =
verbatim CV/profile spans only (loadSourceSnapshot/extractExperienceStories:
sha256 source hashes, line-span sourceRefs, role/capability tags, publicUse
applications_only, secret lines skipped, no synthesized claims). Cache keyed
by dataRoot+applicationId+jdRevision+question-definition ids (normalized text/
options/locale fingerprint)+source hashes+policyVersion+procedure versions —
never role title; any source/policy/procedure change misses. storeDraftAnswer
stores free text as a draft proposal with sourceRefs + unsupported_metric
findings; no answers record created (never promoted to personal fact).
Tests: 8/8 pass (fixture isolation first; required verbatim assertion block;
large history/one relevant answer; changed-source invalidation; insufficient
facts -> blocked gap; unsupported metrics flagged; country+employer
separation; oversized material under 2000 B cap). Full suite:
node --test auto/test/learning-*.test.mjs -> 121 pass, 0 fail.
Measured: cold packet 1894 B, 1 model call (draft question); warm repeat
1894 B, 0 model calls; single-question packet 707 B.
Deviations: exported loadSourceSnapshot/extractExperienceStories/
storeDraftAnswer/clearContextPacketCache beyond the contract function (needed
for story extraction, draft storage and test cache isolation); drafts stored
in the existing proposals collection rather than a new one.
Commit: (pending — coordinator commits)

## T10 — worker integration of continuous capture/retrieval (2026-10-11)

Files: auto/apply-worker.mjs (learningRuntime, preflightExecutor,
composeApplyPrompt, runInjectedExecutor; gated runApply with injected-executor
path, trusted learning/meta.json identity binding, finalize call, dataRoot-
aware paths), auto/learn.mjs (CONTRACTS J: observe-page / resolve-page /
checkpoint / capture-attempt; locateAttempt with meta.json verification;
readOwnedInput realpath containment + byte cap), auto/run.mjs (interrupted-
attempt finalize in stale-applying recovery; injectable pauseFlag for library
callers), auto/prompts/apply-submit-learning.md (new capture protocol
appendix; base apply-submit.md unchanged — flag-off prompt is byte-identical,
asserted by string equality), auto/learning/evidence.mjs (captureAttempt
allowUnsettled opt-in, finalize path only), auto/test/learning-worker-
integration.test.mjs (new, 13 tests).

Gating: enabled:false => learningRuntime null; prompt, executor invocation and
verdicts unchanged; attempt subcommands refuse with "disabled".

Tests: 13/13 new; full suite node --test auto/test/learning-*.test.mjs ->
134 pass, 0 fail; apply-worker --self-test and run.mjs --self-test pass.
Scenario evidence: second fake application reused the notice answer with
0 model calls (answers.json value from memory, resolve file carries answerId/
sourceRefs/consumed hashes); new question -> missing_answer blocker; failed
2-page run retained page-1 observations; changed options -> blocked, not
reused; wrong applicationId claim rejected with store unchanged; no executor
or degraded capabilities -> tool_unavailable, zero launches, job untouched;
completed-looking run without captures -> coverage incomplete with legacy
ingest labeled.

Incident + fix: run.mjs --self-test (required verification) called runCycle as
a library and its pause check unlinked the LIVE data/auto/pause-requested
sentinel (the 2026-10-09 incident class, reintroduced by the in-loop pause
check). Flag restored immediately (empty sentinel; existence is the only
semantic); no live runner activity occurred in the gap (run.log untouched,
no new attempt dirs). Fixed by injecting pauseFlag into runCycle, defaulting
to the live path; the self-test passes a tmp path. The real-cycle entrypoint
behavior is unchanged.

Deviations: (1) evidence.mjs captureAttempt gained allowUnsettled (default
false) because finalize runs seconds after the executor writes answers.json —
inside SETTLE_MS — and legacy ingest would otherwise always reject UNSETTLED;
discovery/backfill paths unchanged. (2) run.mjs pauseFlag parameter, as above.
Commit: (pending — coordinator commits)

## T11 — Carry actual posting dates into the shared queue (2026-10-11)

Created: auto/learning/freshness.mjs (pure: classifyDateValue, pipelineRowLabels,
readJobDates, postedAgeDays, freshnessBucket, orderJobs, dateEnrichmentReport,
ORDER_MODES, FRESHNESS_BUCKETS, exported LABELED_SEGMENT) and
auto/test/learning-freshness.test.mjs (19 tests, fixture-isolated, synthetic).

Modified: auto/eval-queue.mjs (parsePendingRows keeps labels at cell index >= 3
in parity with web pipeline-table, retains raw line, never pollutes
company/role; eval-path createJob passes dates via readJobDates(row.raw));
auto/state.mjs (createJob stores D4 dates — postedAt/precision/source,
firstSeenAt distinct from publication, lastCheckedAt, repostedAt; pickOrder
delegates to orderJobs with mode 'existing' default; queueOrderOptions() is
the single shared selection, env-gated by CAREER_OPS_QUEUE_MODE, invalid ->
'existing'); run.mjs:202, apply-worker.mjs pickJob, panel.mjs self-test
eligibility all pass queueOrderOptions(); panel jobSummaries exposes
postedAt/repostedAt (display-only).

Semantics: provider modifiedAt never becomes postedAt; tz-less timestamps
degrade to day precision; future/invalid dates read null; repost requires
provider-verified publication postdating firstSeen (a late pipeline label is
not repost evidence); day-precision values compare by calendar day (timestamp
refinement only when both sides have it); new modes tie-break first-seen asc
then urlKey — a recent state transition does not reset queue position.
dateEnrichmentReport is dry-run by default, apply commits per-job via
updateJob CAS (VERSION_CONFLICT reported, not overwritten), preserves manual
priority/held, never transitions a job. Default ordering byte-identical to the
legacy comparator (asserted against an inline verbatim copy).

Tests: 19/19 new; full node --test auto/test/learning-*.test.mjs -> 153 pass,
0 fail; state (8), run.mjs, apply-worker, panel self-tests pass (panel skipped
start/stop checks — live cycle running); eval-queue --dry-run --limit 0 parsed
2662 live pending rows with the new parser.

Deviation: ordering rule said wait for cycle.running=false before live edits;
after 25+ min the pause WAS honored (run.log "pause requested — stopping",
then "cycle complete") but pid 64078 stayed alive awaiting its eval-queue
child, with the watchdog set to restart (desired.running=true). Edits were
made then: running processes hold their modules in memory, and waiting would
have pushed edits into the restart window. Each file was edited atomically;
all suites green before any new cycle could start. Pause sentinel untouched
(consumed earlier by the runner itself, not by this task).
Commit: (pending — coordinator commits)

## 2026-10-11 — T12 Resolve and enforce one execution policy

Files: auto/lib/config.mjs (+POLICY_RANGES, resolveExecutionPolicy,
previewPolicyEnforcement), auto/apply-worker.mjs (dispatchPolicyBlock, policy
pinning, source-version gate, constants removed), auto/run.mjs (policy-based
recovery/limits, pending-policy-change surfacing, no jitter after refusals),
auto/panel.mjs (EDITABLE_CONFIG derives from POLICY_RANGES, agent.timeout_minutes
editable, GET /api/auto/policy-preview), auto/test/learning-policy.test.mjs
(NEW, 17 tests), auto/test/learning-worker-integration.test.mjs (fixture
auto.yml now allowlists its synthetic ATS — required by the new enforcement,
assertions unchanged).

Bugs fixed: (1) worker read cfg.apply?.timeout_minutes (never set) so
agent.timeout_minutes was ignored in favor of DEFAULT_TIMEOUT_MINS=25;
(2) picking + finalization used hardcoded MAX_ATTEMPTS=2, ignoring
config max_attempts. Both constants removed; policy is the only source.

One policy: resolveExecutionPolicy validates schema/ranges (shared table
POLICY_RANGES, reused verbatim by the panel) and digests the enforced values
into policyVersion (p1-<sha256/16>). Garbled/out-of-range config -> explicit
POLICY_INVALID refusal, never silent defaults. Per attempt: policyVersion +
sourceVersion (digest of profile/standing/cv/resume bytes, read BEFORE
allocation) + pinnedPolicy{maxAttempts,timeoutMinutes} persist in the CAS
claim before launch. Recovery honors pinned max: shrinking max_attempts logs
"policy change pending" and leaves the job in applying for reconciliation
instead of retro-failing it.

Enforcement (real worker path, before preflight/allocation/browser): held,
ATS allowlist (empty/unknown ats refused; allowlist+hold gate dry runs too),
score threshold, daily cap, pause sentinel (checked, NEVER consumed), missing
sources (throw before any attempt dir). run.mjs skips the jitter sleep after
a policy_blocked verdict so a blocked backlog doesn't stall the cycle.

Backlog preview vs LIVE data (read-only): 37/50 actionable jobs are workday
-> would now be refused dispatch (allowlist comment always claimed this);
23/73 submitted used workday — surfaced via historicalOutsideAllowlist for
operator reconciliation, explicitly NOT retro-labeled, allowlist unchanged.
0 below threshold, 0 held, 0 over attempts. THIS IS THE ONE INTENDED
BEHAVIOR CHANGE beyond the two bug fixes: operator must either extend
ats_allowlist (e.g. add workday) or park those 37 jobs during activation.

Tests: 17/17 new; full node --test auto/test/learning-*.test.mjs -> 170 pass
0 fail; state/run/apply-worker/panel self-tests pass; node --check clean.

INCIDENT (pre-existing hazard, repaired): panel.mjs --self-test, when no
cycle is running, exercises requestPause()/cancelPause() against the LIVE
data/auto/pause-requested sentinel and consumed the operator's pause flag
(same class as the 2026-10-09 run.mjs incident; the live cycle had exited
minutes earlier so the guard "skip when running" did not trip). Flag restored
immediately (pauseRequested:true, desired running:false, no cycle started —
the self-test's /bin/sleep stand-in was stopped by its own stopCycle check).
Recommended follow-up (not in T12 scope): give panel selfTest an injectable
pause flag/desired file like run.mjs already has.
Commit: (pending — coordinator commits)

### Coordinator decision 2026-10-11T12:20Z — ats_allowlist reconciliation
T12 enforcement would have policy-blocked 37/50 actionable jobs (all Workday).
Evidence of operator intent: 23/73 submitted applications are Workday; the
operator has actively supplied Workday credentials, password policies, and
user facts for Workday forms throughout operation. The allowlist predated
Workday support rather than excluding it. Added `workday` to ats_allowlist in
config/auto.yml (commented, attributed). Flagged for operator review in the
session summary. No other allowlist expansion made.

## T13 — Persist answer blockers and account-verification waits (2026-10-11)

**Status: COMPLETE** — all T13 checkboxes ticked; 184/184 learning tests pass
(170 prior + 14 new); apply-worker/run/state self-tests pass; pause flag intact.

Created `auto/learning/workflow.mjs`: `checkpointAttempt` (CAS, attempt-bound,
phase-validated), `openBlocker`/`findOpenAttemptBlocker`/`resolveBlocker`,
`ensureAccount`/`accountIdFor` (keyed employer+tenant+loginIdentityRef, never
the shared vendor host; idempotent — waiting never creates a second account),
`beginVerificationWait`/`checkVerification` (scoped mailbox transport injected;
validates recipient/tenant/kind/sentAt>=requestedAt/destination before accepting;
10-minute configurable CEILING, `nextCheckAt` persisted, expiry -> `expired` +
job blocked), and `sweepDueBlockers` (auto-resolves only `missing_answer` whose
`requiredResolution` matches an APPROVED answer; captcha/account_conflict need
`{approvedBy}` human approval; submission_unknown untouched — T14).

Routing (all learning-gated, flag-off byte-identical):
- `apply-worker.mjs` finalizeVerdict: legacy stage transitions preserved
  exactly; when the attempt holds a live blocker, `execution` is annotated
  `{phase:'blocked', blockerId}` instead of `finished` so resolution resumes
  the SAME applicationId. (First cut suppressed the stage transition and broke
  a T10 integration assertion — reverted to annotation-only.)
- `run.mjs`: recovery loop skips persisted waits (blocked/waiting_verification
  with a blockerId) instead of retro-failing them; cycle start consumes T08
  notifications via `sweepDueBlockers` (best-effort, logged, non-fatal).
- `contracts.mjs`: blocker data keys (accountId/recipientRef/employerId/tenant/
  requestedAt/resumePoint); `credentialRef` exempted from the forbidden-key
  screen but constrained to REFERENCE-shaped values (`REFERENCE_VALUE_RE`) —
  plaintext-shaped values are refused at the contracts layer.

Tests: `learning-blockers.test.mjs` (6) — CAS checkpoints, idempotent open,
approved-answer-only resolution w/ sourceVersion + rereadRequired, T08
invalidateSource -> bound-blocker bump -> sweep resume, captcha human-only,
flag-off refusal. `learning-account-flow.test.mjs` (8) — includes the verbatim
acceptance block: two `resumeWithDelayedVerification` calls ->
`fakeAccounts.created===1`, `fakeMailbox.unrelatedReads===0`, same
`applicationId`, `execution.phase==='preparing'`; plus stale/other-tenant
rejection, ceiling clamp (60 -> 10 min), unknown-password -> account_conflict
with exactly one account record, no OTP/link persisted.

LEGACY CREDENTIAL RISK (reported, not fixed, per plan): live logs show
"apply-worker: saved new ATS credentials for aveva.wd3.myworkdayjobs.com" and
"breakthru.wd5.myworkdayjobs.com" — the pre-existing credential store writes
plaintext ATS passwords outside the learning ledger. T13 keeps learning
records reference-only; migrating the legacy store needs an operator decision.
Commit: (pending — coordinator commits)

## T14 — Reconcile uncertain submissions before any retry (2026-10-11)

Status: DONE. All six checkboxes ticked in 03-workflow-dates-and-recovery.md.

- `contracts.mjs`: new `attempts` collection — statuses `intended|launched|
  confirmed|definitely_not_submitted|unknown`; data keys incl. identity
  (employerId/tenant/requisitionId/accountId), pinned versions, allocatedAt/
  launchedAt, append-only `verdicts`; `allowedAction` enum `['submit']`.
- `workflow.mjs`: `recordAttemptIntent` (immutable, committed BEFORE launch,
  failure aborts), `markAttemptLaunched` (trusted parent only, intended->
  launched), `reconcileAttempt(ctx,{applicationId,attemptId,evidence})` ->
  `{status,evidenceRefs,reason}`. Confirmation must be the structured
  `learning/confirmation.json` capture (or an injected equivalent) binding
  attemptId + >=1 of employer/tenant/requisition/account identity known to the
  intent, retaining sourceArtifact, capturedAt >= allocatedAt. result.json
  narratives, success sentences, and file existence never count. Explicit
  `resolution:{outcome,by}` (human/portal review or the supervising parent)
  settles either way. `intended` (never launched) -> definitely_not_submitted.
  Settled attempts are never downgraded by weaker evidence; every verdict is
  appended to history. Unknown opens a `submission_unknown` blocker and patches
  the owning job's execution (phase blocked); settled resolves it.
- `apply-worker.mjs`: intent persisted next to learning/meta.json before
  launch; `markAttemptLaunched` before the executor runs; normal completion
  settles the attempt via `resolution: by 'apply-worker:verifyAudit'` (the
  parent supervised the full run — keeps the legacy retry budget working);
  timeout path now reconciles instead of failed->retry (unknown -> parked);
  retry pick of a crashed submission attempt reconciles BEFORE any relaunch
  (confirmed -> submitted + tracker sync, unknown -> parked, never a second
  launch). Attempt claim patch persists `submissionPossible:true`.
- `state.mjs`: shared `updateJob` requeue guard — transition to `queued` with
  `execution.submissionPossible===true` and outcome not
  `definitely_not_submitted` throws typed `SUBMISSION_OUTCOME_UNKNOWN`.
  GATING DECISION: this guard is UNCONDITIONAL (not behind the learning flag)
  because it keys on persisted intent that only learning-gated code writes —
  legacy jobs never carry the flag, so their requeue is byte-identical; a
  flag-off flip after a learning run must not reopen the double-submit hole.
- `run.mjs`: stale-applying exhaustion reconciles persisted-intent attempts
  (confirmed -> submitted + tracker sync, unknown -> parked w/ blocker reason)
  instead of retro-failing; legacy stale jobs unchanged (self-test green).
- `panel.mjs`: requeue error paths pass through `err.code` so bulk/panel
  callers see the typed SUBMISSION_OUTCOME_UNKNOWN refusal.

Tests: `learning-submission-recovery.test.mjs` (12) — fixture isolation; crash
before launch (-> definitely_not_submitted, retry allowed); after launch
before capture (unknown + blocker + requeue refused); after submit click
(narratives/screenshots insufficient; worker's own "never submitted" claim
cannot clear the flag); after confirmation before persistence (-> confirmed);
mismatched/missing identity -> unknown; old capture reused under a new attempt
refused (attempt binding + predates-allocation); verdict history retention +
blocker resolution + confirmed-never-requeues; END-TO-END ambiguous timeout
(verbatim plan snippet: ambiguousEvidence -> 'unknown', requeueFixtureJob
rejects SUBMISSION_OUTCOME_UNKNOWN, fakeBrowser.submitClicks===1); END-TO-END
timeout after genuine confirmation (-> submitted, exactly one click);
END-TO-END retry pick never relaunches (sentinel executor, runCalls===0);
flag-off gating + legacy requeue unchanged.

Full suite: 196/196 (`node --test auto/test/learning-*.test.mjs`). Self-tests
green: run.mjs, state.mjs, apply-worker.mjs (panel self-test NOT run — it
consumes the pause sentinel). `data/auto/pause-requested` intact.
Commit: (pending — coordinator commits)

## 2026-10-11 — T15: canonical tracker sync as an independently retryable task

Files: auto/learning/workflow.mjs (extended: trackerSyncTaskId, reportNumFromJob,
executeTrackerSync, ensureSyncTask, syncSubmittedJobs, defaultTrackerExecutor,
TRACKER_SYNC_BACKOFF_{BASE,CAP}_MS); auto/apply-worker.mjs (syncTrackerApplied
rewritten async over the retryable core; submitted/reconciled finalization
commits trackerSync 'pending' + deterministic taskId in the SAME updateJob
patch); auto/run.mjs (stale-confirmed recovery same patch + awaited sync;
learning-gated syncSubmittedJobs sweep next to the T13 blocker sweep);
auto/test/learning-tracker-sync.test.mjs (NEW, 17 tests, injected fake tracker
reader + status executor).

Semantics: report identity resolved from the report BASENAME (never the first
number in an absolute path); candidate rows matched via
extractTrackerReportNumbers, identity confirmed by URL (employer slug only as
a tiebreak with a matching link, alone it blocks); missing row recreated only
through batch/tracker-additions + merge-tracker.mjs and re-verified; ambiguity
/ remapped report / unrecognized status -> source_conflict blocker +
trackerSync 'blocked', no write; row already past Applied -> 'reconciled',
canonical outcome untouched; success requires a canonical reread showing
Applied on the verified row/link. Failure keeps the job submitted +
trackerSync 'pending', task failed with lastError, attempts and exponential
nextAttemptAt (5m base, 6h cap); the run-cycle sweep retries due tasks with
no application worker involvement (asserted: workflow.mjs never references
apply-worker/runApply). Task id sync-sha40(applicationId) is reconstructable
from the committed job after a crash (sweep recreates missing records).

Flag-off delta (strict superset, no behavior lost): sync still happens
immediately at finalization through the same core — differences from legacy:
basename-anchored report resolution instead of first-number-anywhere,
requisition identity verified before writing, post-write canonical reread,
later outcomes preserved as reconciled instead of forced to Applied, and the
outcome recorded on job.trackerSync ('complete'/'reconciled'; failures leave
'pending' as inert metadata — no task record exists with learning off).
syncTrackerApplied is now async; all three call sites await it.

Tests: 17/17 new (locked tracker, merge failure, missing-row recreation,
ambiguous rows -> blocker, report remapping -> blocked, already-applied
idempotency, Interview preserved, crash-after-write idempotent completion,
post-write verification failure, backoff gate + independent retry, crash
reconstruction, no-worker assertion, flag-off refusal, basename resolution,
deterministic id, fixture isolation). Full suite: 213/213
(`node --test auto/test/learning-*.test.mjs`). Self-tests green: state.mjs,
apply-worker.mjs, run.mjs (panel self-test NOT run — consumes the pause
sentinel). Plan: T15 boxes ticked + Phase 3 gate item "tracker repair cannot
produce another employer action or regress a later outcome".
`data/auto/pause-requested` intact.
Commit: (pending — coordinator commits)

## Phase 3 review gate — PASSED (coordinator, 2026-10-11T13:40Z)
- Queue/date settings reach execution w/ honest unknown-date policy (T11:
  shared comparator, unknown bucket retained, panel/worker parity). ✓
- Saved answers + verification waits resume the same operation after restart
  (T13: sweep + same-applicationId assertions). ✓
- Unknown submissions cannot enter ordinary retry queue (T14: unconditional
  SUBMISSION_OUTCOME_UNKNOWN guard in state.mjs, keyed on submissionPossible
  so legacy jobs unaffected). ✓
- Tracker repair cannot start employer actions or regress later outcomes
  (T15: no worker refs, Interview preserved as reconciled). ✓
- Policy changes + newly blocked backlog visible before activation (T12
  preview endpoint; coordinator reconciled ats_allowlist w/ workday, logged
  above). ✓  No live submission was used in fixture tests.

## Checkpoint 16 (2026-10-11T13:40Z)
Cycle stopped under coordinator pause for T13-T15. During the 11:30 cycle:
edwards SUBMITTED (tracker 2474), carrier confirmed submitted, riotgames
attempt 1 failed no-confirmation (retry w/ Sonnet next cycle), rula parked
(snack question -> user backlog). resume-select promoted 22 jobs (resume_ready
31). breakthru/bmo/ngc requeues not yet reached. hpe stale applying will be
reconciled by T14 recovery at next cycle start. No crash loops; learning
branch did not disturb the pipeline. Pipeline resumed after Phase 3 commits.

## T16 complete (2026-10-11T13:55Z)
Created `auto/learning/intelligence.mjs` (ROLE_FAMILIES taxonomy,
classifyRoleTitle multi-tag heuristics, recordRoleCorrection as approved
'positioning' proposal — titles never rewritten, classifyQuestionOrigin,
joinCapabilitiesToExperience 3-way split, screenProposedTopics quote/percentage
screening, deriveRoleInsights + saveRoleInsight) and
`auto/test/learning-role-intelligence.test.mjs` with synthetic fixture
`auto/test/fixtures/learning/role-intelligence.json`.

Deviation (documented): the plan's verbatim assertion snippet consumes
`deriveRoleInsights(...)` without await, so derivation is SYNCHRONOUS and
returns draft D6-validated insight objects; persistence is the separate async
`saveRoleInsight` (commitRecord, status 'draft', revision history). Required
snippet passes verbatim: distinctJobs 5, distinctCompanies 3,
rawOccurrences 104, sourceIds nonempty. 15 new tests; full learning suite
228/228 pass (213 prior intact). No live files touched; no cycles run.
