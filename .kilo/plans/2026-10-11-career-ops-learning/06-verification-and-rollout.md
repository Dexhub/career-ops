# Phase 6: Verification, rollout and operations implementation plan

> **For agentic workers:** Execute T25–T29 only after the corresponding feature tasks are implemented. Build evidence for the actual user journey. Approval-gated activation and external tests remain visibly pending until authorized.

**Goal:** Prove safe reuse and recovery, migrate historical data without losing it, and hand over an operable system with truthful coverage.
**Architecture:** Fixture-first verification, dry-run manifests, reversible data/index changes, controlled local/cloud activation, and narrowly scoped real observation.
**Tech Stack:** Node tests and injected transports, local manifests/digests, Neo browser evidence, explicitly authorized AWS/launchd operations only.

## T25. Run the cross-component and adversarial matrix

**Create:** `auto/test/learning-acceptance.test.mjs`, `auto/test/learning-adversarial.test.mjs`; extend only affected local suites.

- [x] Build an end-to-end fixture driver that uses the real store, resolvers, checkpoints, API handlers and fake executor, not disconnected stubs that all return success. Instrument model/browser/account/tracker calls. *(T25a: `auto/test/helpers/learning-matrix.mjs`, exported for reuse by the A18–A34 half.)*
- [x] Pin this minimum matrix as independently named tests: *(T25a: A01–A17 in `auto/test/learning-acceptance.test.mjs`; T25b: A18–A34 in `auto/test/learning-adversarial.test.mjs`, 19 tests, all pass.)*

| ID | Scenario | Required outcome |
|---|---|---|
| A01 | Exact approved repeat question | Correct reuse with zero model calls. |
| A02 | Similar but different jurisdiction/time horizon/currency | Reuse refused or re-resolved from valid sources. |
| A03 | Changed source after cached answer | Cache invalidated before fill. |
| A04 | Generated prior answer on a successful submission | Does not become a personal fact. |
| A05 | Answer supplied → reload → resume | Same application consumes the committed source version. |
| A06 | User revokes an answer | All dependent active retrieval and drafts become stale/revoked. |
| A07 | One question repeated in snapshots/retries | Occurrences retained; requisition/company metrics not inflated. |
| A08 | Conditional step never reached | Coverage gap shown; no invented question. |
| A09 | Object-form legacy answers | Import, diagnostics and UI all agree; no crash. |
| A10 | Historical evidence missing/overwritten | Explicit gap, no manufactured confirmation. |
| A11 | Panel hold while worker finishes | Hold/priority preserved; no stale overwrite. |
| A12 | Requeue after prior attempt | New immutable attempt directory. |
| A13 | Delayed verification and restart | One account, correct recipient/tenant, same application resumes. |
| A14 | Wrong/stale verification message | Not used; unrelated mailbox data untouched. |
| A15 | Timeout after possible submit | Unknown outcome, no automatic second submit. |
| A16 | Confirmation belongs to another job/attempt | Not accepted as current confirmation. |
| A17 | Tracker write fails after confirmed submit | Submitted remains; retry only bookkeeping. |
| A18 | Tracker already at later outcome | No regression to Applied. |
| A19 | Actual posted date versus first-seen | Correct provenance and shared queue order. |
| A20 | Unknown/reposted date | No invented date or silent duplicate identity. |
| A21 | Saved timeout/attempt/ATS setting | Dispatcher, worker and UI enforce the same version. |
| A22 | Prompt injection in a JD/question/audit | Remains data; cannot grant permissions or execute code. |
| A23 | Secret-bearing historical files | Excluded from memory/search/cloud/export. |
| A24 | Reviewer crash/concurrent run/sleep | One bounded resumed batch, no application starts. |
| A25 | Cloud disabled/budget exhausted/unknown timeout | No unapproved call or implicit paid retry. |
| A26 | Procedure passes examples but fails a held-out case | No promotion. |
| A27 | Cross-origin or stale approval POST | Refused without a source change. |
| A28 | Tiny/biased outcome cohort | Counts/limitations shown; no unsupported rate or causal claim. |
| A29 | Corrupt/future-version index/source | Visible error or compatible rebuild; not silent empty data. |
| A30 | Forget/export request | Exact scope, invalidation, residual-original/backup accounting. |
| A31 | Missing Neo/CDP capability | No Playwright or unrestricted fallback. |
| A32 | Data-driven UI proposal contains script | Rendered inert or rejected; no execution. |
| A33 | Restricted assessment or unaided-work attestation | Policy/human-action blocker; no cached answer or false attestation. |
| A34 | Worker skips observe/resolve/checkpoint protocol | Incomplete capture is reported; final artifacts do not falsely establish full coverage. |

- [x] Run `node --test auto/test/learning-*.test.mjs` and `node --test auto/learning/cloud/test/*.test.mjs`. Store command/exit/result evidence. Run affected existing pure helper suites using `node test-all.mjs --only application-answers` and other exact known filters only after confirming they do not invoke prohibited browser/deployment paths. *(T25b: 398 tests pass, exit 0; `--only application-answers` inspected (pure parse/format, no browser/network/spawn) then run: 20 passed. Evidence in `reports/t25-matrix.md`.)*
- [x] Do not run a blanket full suite that launches Playwright, generates live PDFs, or touches real state. Clearly list broader suites skipped and why. A restricted test selection is not a claim that the entire upstream suite passed. *(T25b: no blanket run; skipped suites listed in `reports/t25-matrix.md`.)*
- [x] Reject vacuous success: the fixture driver must assert nonzero observations, at least one actual reuse, one prevented bad reuse, one pending-to-resolved blocker and one tracker repair. Save coverage counts, not just a green exit code. *(T25a: shared `cov` counters asserted by the A01–A17 summary test; counts at pass: observations 2, reuses 3, preventedReuses 4, blockersResolved 2, trackerRepairs 1, modelCalls 0.)*

## T26. Rehearse migration, backup, restore and version rollback

**Create:** `auto/test/learning-migration.test.mjs`, an operator section in `auto/README.md` or `auto/learning/README.md`.

- [x] Build a synthetic legacy data root containing old job versions, reused-attempt history, missing artifacts, malformed files, staged answers and a pending tracker update. Create a manifest before migration.
- [x] Back up only the approved data paths to an owner-protected destination and verify hashes. Do not copy credentials into an unprotected ZIP or commit backup data. A backup is not accepted until a restore to a second scratch root reproduces the expected records.
- [x] Rehearse migration preview, application, interruption and restart. Maintain an input/output schema/version manifest and a reader-compatibility marker. Reject running unsupported old writers against a new store.
- [x] Prove indexes can be discarded/rebuilt without losing authoritative records and that failed index generation leaves the previous generation usable.
- [x] Rehearse rollback: stop the reviewer/application writers at an approved safe boundary, keep unresolved external outcomes parked, disable new features, restore compatible code/config/data or a verified adapter, and recheck the canonical tracker. Never restore an old “queued” snapshot over a newly submitted job.
- [x] Document irreversible external effects: a rollback cannot unsend an application, delete an employer account, retract a message or undo a public-profile publication. Such actions are outside the local restore.
- [x] Run `node --test auto/test/learning-migration.test.mjs`; attach backup/restore and compatibility evidence. No live rollback is performed by this test.

## T27. Activate through explicit, narrow gates

**Changes:** approved live config/service state only; optional reviewed Lambda deployment; no code changes improvised during activation.

- [ ] Present a readiness report: actual changed files, tests, remaining risks, original-to-new queue differences, data migration manifest, historical coverage gaps, and D01–D07 decisions. Do not equate the prior 70 stored submitted records with verification of this implementation.
- [ ] Obtain D01. Use the existing panel's pause-after-current control, wait for the named cycle/worker to settle, and verify the lock/process state. Stop only owned, approved processes. A dead PID alone does not prove the last submission failed; reconcile its saved state before continuing.
- [ ] Apply the verified local migration/backfill manifest and rebuild indexes. Recheck source hashes because real files may have changed since preview. Preserve source ownership, unresolved outcomes, manual holds and confirmed decisions.
- [ ] Restart only the correct panel/service against the verified code/data roots. Inspect the installed service definition before using it; do not guess a launchd label or PID. Verify the served UI and APIs expose the new build and persistent data after reload.
- [ ] Enable local capture and shadow consolidation first. Keep application scheduling unchanged, cloud disabled and procedure auto-promotion off. Observe captured events from an already-authorized operation or synthetic fixture; show failures rather than hiding them.
- [ ] If D03 is approved, review/package/deploy the isolated Lambda template with the actual approved artifact bucket, runtime, IAM resources and model settings. Verify deployment status and invoke one minimized synthetic request within the approved budget. Do not treat a successful deploy as a successful model request.
- [ ] Enable periodic review only after a local-only run and, if applicable, one authorized cloud run produce valid proposals/usage records. Verify the timer cannot call `startCycle`, respects the pause control, and resumes its cursor after a panel restart.
- [ ] Enable question reuse/freshness mode after reviewing the behavior change. Any procedure auto-promotion requires D04; any code/UI source change requires D05. Record every activated flag/version and a tested rollback reference.

Required evidence states in `rollout.json`: `implemented`, `offline_verified`, `local_activated`, `cloud_deployed`, `cloud_invocation_verified`, `live_journey_verified`. Each is independent; use false with a reason when approval or evidence is absent.

## T28. Verify the complete journey under scoped authorization

- [ ] First run the complete journey in a synthetic fixture panel through Neo: observe a new question, propose/approve its synthetic answer, reload, resume the same fake application, reuse it in another fixture, revoke it, and confirm reuse stops.
- [ ] Prove a saved account-verification wait survives restart and uses only its matching fake message. Prove an uncertain fake submission cannot be retried and a tracker failure repairs without another fake submit.
- [ ] If D06 authorizes a real case, specify its exact job/account and permitted actions. Prefer an existing eligible operation rather than inventing an extra employer application for testing. Record baseline state before acting and keep evidence job-bound.
- [ ] Observe question capture, source-bound answer reuse, offered dropdown options and committed values, correct resume upload, account verification if needed, and the final allowed outcome. If actual submission is not authorized, stop before it and report that delivery remains unverified.
- [ ] After any authorized real submission, verify employer-side confirmation evidence and the corresponding canonical tracker record separately. A screenshot filename or agent message alone is insufficient. If uncertain, stop and reconcile, never retry to obtain a cleaner test result.
- [ ] Compare the actual source/memory/procedure versions consumed, capture coverage and model/action/time measurements. Do not claim a reduction in live cost/time from fixture-only measurements or a hiring improvement from one application.

## T29. Document operation, limitations and next-agent recovery

- [ ] Document startup, flags, roots, source precedence, question/answer approval, reviewer pause/resume, budget exhaustion, procedure rollback, privacy/export/forget, migration and recovery commands. Every command must correspond to an implemented CLI/API and include its side effects.
- [ ] Add a troubleshooting table: missing source, unreadable data, stale index, revoked answer, unmapped question, no Neo connection, pending verification, uncertain submission, tracker sync failure, cloud disabled, unknown paid-call outcome and denied proposal.
- [ ] Verify docs do not promise all possible employer questions, guaranteed accuracy, automatic code repair, universal ATS coverage, or zero cloud cost. State which procedure classes and role cohorts were actually evaluated.
- [ ] Rerun affected targeted tests after documentation/config examples are finalized, verify example schemas, and inspect git status. No user PII, live artifacts, credentials, AWS identifiers not intended for source, or backup files belong in the source diff.
- [ ] Produce the completion report using `EXECUTOR.md`. Include exact evidence paths, unresolved decisions and the first safe recovery action for an interrupted run. Mark task checkboxes only where the recorded evidence supports completion.

## Final acceptance

The software is not accepted merely because all modules exist. It must demonstrate capture → valid reuse → durable correction → safe resume → verified outcome/bookkeeping, plus source-backed intelligence and bounded review. If live/cloud gates remain unapproved, deliver the implemented and offline-verified system with those capabilities explicitly disabled and unverified rather than pretending they were exercised.
