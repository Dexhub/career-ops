# Phase 3: Freshness and recovery implementation plan

> **For agentic workers:** Execute T11–T15 using the versioned mutation path from T03. Keep browser execution disabled until its Neo/CDP capability checks pass. Do not interpret an implementation test as permission for an employer action.

**Goal:** Apply queue decisions using truthful date metadata, persist waits/decisions, and recover without duplicate accounts or submissions.
**Architecture:** The local graph retains its coarse stages while explicit execution phases and blockers determine safe next actions. Tracker synchronization is a separate retryable local outcome.
**Tech Stack:** Existing local orchestrator, canonical tracker helpers, pure comparator logic, injected browser/email/status adapters in tests.

## T11. Carry actual posting dates into the shared queue

**Create:** `auto/learning/freshness.mjs`, `auto/test/learning-freshness.test.mjs`.
**Modify:** `auto/eval-queue.mjs:parsePendingRows`, `auto/state.mjs:createJob/pickOrder`, local job summaries and queue callers.
**Produces:** `readJobDates`, `orderJobs`, CONTRACTS D4 dates.

- [x] Write fixtures for pipeline `posted:` labels, provider timestamps, first-seen-only records, unknown dates, future/invalid values, day versus timestamp precision, changed posting text, true repost evidence and distinct requisitions with similar titles.
- [x] Extend local parsing to retain labeled metadata without treating labels as role/location fields. Use `web/src/lib/pipeline-table.mjs:parseInbox` as a parity reference in tests, not a dependency on the running web app. Preserve the scanner's date instead of scraping it again.
- [x] Store publication date, precision and evidence separately from first discovery and last availability check. A provider's modification date is not automatically a publication date. Date-only values sort consistently by calendar date and are not displayed as exact-hour ages. Unknown timezone/precision stays explicit.
- [x] Implement comparator modes. All filter held/ineligible/exhausted jobs first and preserve explicit manual priority. `existing` preserves old ordering. `fit_then_freshness` sorts fit score descending, then verified posting date descending; `freshness_then_fit` sorts known date buckets (0–2, 3–7, 8–30, older, unknown), then fit descending, then posted date descending. Both end with first-seen ascending and stable URL identity for ties. Do not hard-discard unknown dates; show potential aging/starvation in the UI.
- [x] Add `pickOrder(jobs,maxAttempts,options)` as a compatible delegation to the pure comparator, with existing mode as default. Pass the same explicit options to panel, orchestrator and worker; no independent UI sort pretending to be execution order.
- [x] Produce a dry-run date-enrichment/rank-difference report for legacy jobs. Recheck job versions before committing metadata, preserve manual priority/held fields, and never start an application. Activation requires reviewing the visible ordering change.
- [x] Run `node --test auto/test/learning-freshness.test.mjs`. Assert UI/worker parity, deterministic ties, no reset from a recent state transition, and no relabeling first-seen as posted.

```js
const ranked = orderJobs([older,newer,unknown],{maxAttempts:2,mode:'freshness_then_fit',now:fixedNow});
assert.equal(ranked[0].urlKey,newer.urlKey);
assert.equal(readJobDates({pipelineLine:noPostedLabel,historyRow,now:fixedNow}).postedAt,null);
assert.deepEqual(panelOrder(ranked), workerOrder(ranked));
```

`panelOrder`/`workerOrder` are fixture adapters calling the same exported comparator, not two hand-coded matching algorithms.

## T12. Resolve and enforce one execution policy

**Modify:** `auto/lib/config.mjs`, `auto/run.mjs`, `auto/apply-worker.mjs`, `auto/panel.mjs`; **Create:** `auto/test/learning-policy.test.mjs`.
**Consumes:** existing score/ATS/retry/time settings and new learning config.

- [x] Add tests showing the current timeout-path and hardcoded-attempt bugs: changing `agent.timeout_minutes` and `max_attempts` must affect actual injected executor arguments and picking/finalization.
- [x] Resolve policy once per attempt, validate its schema/ranges, calculate a stable version digest, and persist the version before execution. Read timeout from `agent.timeout_minutes`; remove competing worker constants that ignore configurable limits.
- [x] Enforce the configured ATS allowlist, score threshold, fact-gated resume, daily cap, pause/hold state, source availability and browser capabilities in the actual dispatcher/worker path. Reject a changed or missing required source before spending browser time.
- [x] Preview how enforcement changes the existing backlog, including Workday jobs that may have historical authorization but are absent from the current config. Ask the operator to reconcile intent with config during activation. Do not silently expand the allowlist or claim those historical applications were unauthorized.
- [x] Pin settings for a running attempt. New limits take effect at safe boundaries; shrinking a limit must not silently terminate a potentially submitted operation and requeue it. Surface a pending policy change.
- [x] Run `node --test auto/test/learning-policy.test.mjs`. Expected: UI control, dispatcher, worker and recorded policy agree; invalid or unsupported values produce explicit refusal, not defaults that contradict the saved choice.

## T13. Persist answer blockers and account-verification waits

**Create:** `auto/learning/workflow.mjs`, `auto/test/learning-blockers.test.mjs`, `auto/test/learning-account-flow.test.mjs`.
**Modify:** worker/orchestrator completion and resume routing; consume T08 notifications.
**Produces:** `checkpointAttempt`, `resolveBlocker`, structured account and blocker records.

- [x] Write fake-browser/email scenarios: existing authorized account; new permitted account with immediate verification; delayed message; no message; stale/other-employer message; same ATS host with different tenant; existing unknown password; CAPTCHA; answer supplied while the browser is closed.
- [x] Key account memory by employer/ATS tenant/login identity, not just a shared vendor hostname. Store only a credential reference. The existing credential store may remain private during this project; never copy its plaintext into learning, cloud input, logs, or analytics. Report legacy credential-storage risks separately.
- [x] Capture the lifecycle as a checkpointed state. Creation/verification waiting cannot imply that another account should be created. A blocked record includes expected recipient/account reference, employer/tenant, request time, bounded check deadline and current safe resume point.
- [x] Implement matching verification retrieval only through the authorized Neo session and narrowly scoped mailbox search. Validate sender context, recipient, request timing, and expected destination before following a link. Do not read unrelated mail, store OTPs/links as lessons, bypass CAPTCHA, or accept optional marketing permissions as a side effect.
- [x] Check verification at bounded intervals; use the existing approximately 10-minute policy as a configurable ceiling, not an indefinite wait. If other form sections can safely proceed, continue them. Otherwise persist `nextCheckAt` and yield; on resume verify that account/application state still matches.
- [x] For a resolved answer blocker, load the approved source version, resume the same operation and reread the current field/options. If the session expired, reopen the same application after an outcome check; do not create a new application identity.
- [x] Run `node --test auto/test/learning-blockers.test.mjs auto/test/learning-account-flow.test.mjs`. Use injected clocks and transport responses, never real Gmail. Confirm that repeated delayed-verification resumes create exactly one fake account.

```js
await resumeWithDelayedVerification(fixture);
await resumeWithDelayedVerification(fixture);
assert.equal(fakeAccounts.created,1);
assert.equal(fakeMailbox.unrelatedReads,0);
assert.equal(currentJob.applicationId,originalApplicationId);
assert.equal(currentJob.execution.phase,'preparing');
```

The fixture helper drives the public checkpoint/blocker functions and a fake executor. The test's `preparing` state follows confirmed account verification, not employer submission.

## T14. Reconcile uncertain submissions before any retry

**Extend:** `workflow.mjs`; **Modify:** timeout, stale-applying, requeue and final-verdict paths; **Create:** `auto/test/learning-submission-recovery.test.mjs`.
**Produces:** `reconcileAttempt` and enforced unknown-outcome routing.

- [ ] Persist an attempt intent with job identity, allowed action, source/resume hashes and policy before launching a potentially submitting worker. Set `submissionPossible:true` before granting that capability, even when the executor cannot provide an exact click checkpoint.
- [ ] Add granular checkpoints when observed, but never let an untrusted worker clear the conservative side-effect flag. A process that never launched can be definitely-not-submitted; a timed-out process that might have acted cannot.
- [ ] Replace `timeout => failure => retry` and stale-attempt exhaustion with reconciliation. Read the available captures and structured result even after timeout, validate them against the exact job/attempt, and return `confirmed`, `definitely_not_submitted`, or `unknown`.
- [ ] Confirmation evidence must bind employer/requisition/account/attempt as available and retain its source. Mere file existence, an unrelated thank-you page, or the agent's success sentence is insufficient. If the evidence is incomplete or contradictory, preserve `unknown` and require scoped read-only portal review or human resolution.
- [ ] Make generic/bulk requeue refuse `submission_unknown`; only a reconciled non-submission can become eligible for another attempt. Retain original evidence and previous verdicts when recording a later reconciliation.
- [ ] Test crash before launch, after launch before capture, after submit click, after confirmation before local persistence, missing/mismatched evidence, an old capture reused under a new attempt, and process timeout after genuine confirmation. Run `node --test auto/test/learning-submission-recovery.test.mjs`.

```js
const result = await reconcileAttempt(ctx,{applicationId,attemptId,evidence:ambiguousEvidence});
assert.equal(result.status,'unknown');
await assert.rejects(requeueFixtureJob(), error=>error.code==='SUBMISSION_OUTCOME_UNKNOWN');
assert.equal(fakeBrowser.submitClicks,1);
```

Exactly-once external delivery is not promised for ATSs without an idempotency mechanism. Conservative unknown states are an intentional safety outcome, not a failed acceptance criterion.

## T15. Make canonical tracker synchronization independently retryable

**Extend:** `workflow.mjs`; **Modify:** `syncTrackerApplied`/finalization; **Create:** `auto/test/learning-tracker-sync.test.mjs`.
**Produces:** `syncSubmittedJobs` and `syncTasks` records.

- [ ] In the same committed job update that records confirmed submission, set `trackerSync.status='pending'` and a deterministic task ID. The task can be reconstructed from the job if its separate record was not written before a crash.
- [ ] Use existing `merge-tracker.mjs` and `set-status.mjs --report N Applied --json`. Resolve report identity from the report basename/link through verified helpers; do not extract an arbitrary first number from an absolute path or guess a row from employer name alone.
- [ ] If the row is missing, recreate only from verified job/report metadata through the sanctioned tracker-addition/merge flow. Confirm the resulting row identifies the same requisition before changing its state. Ambiguity becomes a reconciliation blocker.
- [ ] On failure, retain submitted state, task error, backoff and attempt count. On success, reread the canonical tracker and verify the exact row/link before marking sync complete. No sync retry may invoke the application worker.
- [ ] Do not regress later tracker outcomes. If the canonical row is already Interview, Offer or another later state, record synchronization as reconciled without forcing it back to Applied; use the existing canonical status vocabulary.
- [ ] Test locked/missing tracker, merge failure, ambiguous employer rows, report remapping, already-applied idempotency, later outcome preservation and crash after tracker write. Run `node --test auto/test/learning-tracker-sync.test.mjs`; inject a fake status executor for error cases.

## Phase 3 review gate

- [ ] Queue/date settings reach execution with an honest unknown-date policy.
- [ ] Saved answers and verification waits resume the same operation after restart.
- [ ] Unknown submissions cannot enter the ordinary retry queue.
- [ ] Tracker repair cannot produce another employer action or regress a later outcome.
- [ ] Policy changes and newly blocked backlog are visible before activation. No live submission was needed to pass these fixture tests.
