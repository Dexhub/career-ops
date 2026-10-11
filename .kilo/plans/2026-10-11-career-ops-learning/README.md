# Career Ops Learning System Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for sequential execution, or `superpowers:subagent-driven-development` when available. Read `CONTRACTS.md` and the relevant phase completely before editing. Checkboxes track execution, not planning. No implementation checkbox is complete at handoff.

**Goal:** Make Career Ops capture experience from every application attempt, safely reuse approved knowledge, expose role-market intelligence, prioritize fresh opportunities, and evaluate improvements without losing facts, evidence, or control of consequential actions.

**Architecture:** Extend the existing local `auto/` system rather than replace Career Ops. Keep raw application evidence, candidate source files, and the canonical tracker local; add a versioned learning ledger, derived query indexes, a resumable application lifecycle, and a bounded background reviewer. New hosted analysis uses AWS Lambda with Bedrock; it returns untrusted proposals and never controls browsers or edits local files.

**Tech Stack:** Existing Node.js `.mjs`, built-in `node:test`, existing `js-yaml`, the existing Mission Control HTTP server, small JavaScript/CSS UI modules, BrowserOS Neo/CDP for browser interaction, AWS CLI for authorized Lambda invocation, and Bedrock Converse inside Lambda. No graph database, primary SQL migration, mandatory embeddings, or replacement web application.

**Planning baseline:** October 11, 2026; code root `/Users/jarvis/AI-Playground/career-ops/career-ops`; inspected HEAD `58ff2858`; working tree clean before these planning files. Recheck at execution time. A different agent was operating the live pipeline during research. Counts and process state are historical observations, not execution preconditions.

## Global constraints

- Work exclusively on Career Ops. Do not integrate other projects or copy their private records.
- Read applicable `AGENTS.md` files. Local customization belongs in `auto/`, its configuration/data, and these local plans. Do not patch upstream root scripts or `web/` to serve the local layer.
- Keep `data/applications.md`, `cv.md`, `config/profile.yml`, `config/standing-answers.yml`, and their existing consumers authoritative. The learning index is not another candidate profile or application tracker.
- Browser interaction must use BrowserOS Neo/CDP. Do not execute Playwright, its wrappers, or a separate headless browser. Historical local instructions sanctioning Playwright do not override current instructions.
- New AI analysis uses Bedrock in `us-east-1`; local AWS identity is `hk_dev`. New hosted backend work uses Lambda. Existing worker/provider choices are not silently migrated by this project.
- No cloud deployment, model invocation, paid generation, account action, employer submission, message, or public-profile edit is authorized merely by this plan.
- No unrestricted self-modification. Candidate answers, policy changes, code changes, and UI source changes remain review-gated by default. A narrow data-only procedure-promotion policy can be explicitly enabled later.
- Do not change an active worker's inputs or restart another agent's services. Build and test against an isolated data root; obtain a controlled activation window for live changes.
- Do not run root `npm install`: its postinstall installs Playwright. Use existing local dependencies; isolate any new Lambda dependencies under `auto/learning/cloud/` and install with lifecycle scripts disabled.
- No commits, branches, push, publishing, or destructive cleanup unless separately authorized. Save diffs and test evidence at task boundaries instead of assuming permission to commit.
- Do not reuse withdrawn design preferences. Extend current UI components and accessibility patterns without a visual redesign.

## Start here

1. Read this document and `CONTRACTS.md`.
2. Execute `01-foundation-and-history.md` before any other phase.
3. Execute the remaining phases in table order. Parallelism below is optional and file ownership must be exclusive.
4. Maintain a local execution log using the format in `EXECUTOR.md`.
5. Stop only the affected permission-gated step when approval is missing. Continue independent offline implementation and tests.
6. Do not mark the system complete until the evidence matrix in Phase 6 distinguishes implemented, tested, activated, and externally verified capabilities.

| Order | Phase document | Tasks | Independently reviewable result |
|---|---|---|---|
| 1 | `01-foundation-and-history.md` | T01–T05 | Isolated fixtures, protected storage, immutable attempts, historical backfill, answer-contract repair. |
| 2 | `02-question-memory-and-reuse.md` | T06–T10 | Observed question library, source-bound answer resolution, approval/invalidation, worker retrieval and coverage capture. |
| 3 | `03-workflow-dates-and-recovery.md` | T11–T15 | Real posting-date priority, enforced config, resumable blockers/accounts, uncertain-submit reconciliation, tracker outbox. |
| 4 | `04-intelligence-and-reviewer.md` | T16–T20 | Role intelligence, optional Lambda/Bedrock analysis, procedural learning, bounded reviewer and honest outcome metrics. |
| 5 | `05-mission-control.md` | T21–T24 | Safe local APIs, modular knowledge/insight views, review controls, accessibility and operational visibility. |
| 6 | `06-verification-and-rollout.md` | T25–T29 | Adversarial validation, migration/rollback rehearsal, controlled activation, real-journey evidence, operator handoff. |

Dependencies: T06 requires T02/T05; T07–T10 require T06; T11 can proceed after T03; T13 requires T08/T10/T12; T14 requires T03/T12/T13; T16 requires T06/T10/T11; T17 can be built offline after T02; T18/T19 require T14/T16/T17; T20 requires T15/T16; T21 requires the shared contracts; T22/T23 require T06–T20; T25–T29 cover all phases. After contracts stabilize, separate agents can implement isolated cloud analysis and UI sections in parallel; neither may change shared contracts unilaterally.

## Requirements and explicit completion criteria

| Requirement | Implemented by | Evidence needed |
|---|---|---|
| Preserve learning from successful, parked, failed, and interrupted attempts | T03–T05/T10 | Capture includes partial attempts; retries do not multiply observations; raw provenance retained. |
| Catalog every encountered question, not just filled fields | T06/T10 | Seen/unseen/not-reached coverage is explicit; conditional branches retain context. |
| Reuse approved answers with less reasoning | T07–T09 | Exact eligible repeats require zero model calls; wrong-context and stale answers are refused. |
| One place to inspect what is known about the candidate | T08/T21/T22 | UI reads authoritative sources and versioned references; corrections survive reload. |
| Understand role/company expectations and improve positioning | T16/T20/T23 | Distinct job/company counts, source quotes, denominators, sample limits, and grounded draft recommendations. |
| Prioritize by actual posting date | T11/T22 | Scanner date survives into the execution queue; discovered date is never relabeled posted. |
| Anticipate account verification and continue the same application | T13/T14 | Bounded verification wait, tenant/account binding, checkpoint resume, no duplicate account/submission. |
| Periodically learn procedures and propose improvements | T18/T19 | Incremental cursor, budget, held-out evaluation, versioned promotion, rollback, no new application starts. |
| UI grows as knowledge grows | T21–T24 | Data-driven views and allowlisted insight types; proposed UI source changes are reviewable, not executed from data. |
| Recovery does not lose decisions or duplicate side effects | T03/T08/T14/T15 | Crash-injection, concurrent edit, answer resume, and tracker repair tests. |
| Privacy, deletion, provenance, and limited external transmission | T02/T05/T08/T17/T25 | Secret exclusion, invalidation propagation, export/forget reports, cloud payload inspection. |
| Improvement is measured rather than asserted | T19/T20/T28 | Fixed evaluation set, honest cost/time/coverage metrics, observed outcomes separated from inferred benefit. |

## Decision register: safe defaults, not implied consent

The previous discussion did not explicitly approve autonomous code/UI changes or cloud spend. The executor must preserve these defaults. Record a user's later decision with timestamp, exact scope, and the applicable configuration/version; never fabricate an approval identifier.

| ID | Decision | Default that permits offline work | Gate for activation |
|---|---|---|---|
| D01 | Live maintenance window | Scratch root only; leave live cycle alone. | User/operator confirms safe pause and named process/service ownership. |
| D02 | Automatic learning scope | Capture and consolidation designed; runtime feature flags off until controlled rollout. | Enable local capture/shadow review explicitly; no automatic new personal facts. |
| D03 | AWS deployment/model/budget | Mock Lambda client; cloud disabled; daily dollar cap zero. | Approved account, artifact bucket, model/inference profile, pricing version, region, request limits and budget. |
| D04 | Procedure promotion | Propose/evaluate only. | Explicit policy allowing specified data-only procedure classes and limits. |
| D05 | Code/UI evolution | Create reviewable proposal metadata/diffs; do not apply or deploy them. | Separate per-change approval or subsequently agreed bounded maintenance policy. |
| D06 | External acceptance test | Synthetic fixtures and read-only real evidence. | Exact application/account/browser/mailbox scope and permission for any new external action. |
| D07 | Sensitive export or erasure | Redacted exports; no deletion of original evidence. | Exact requested fields/assets and explicit confirmation of the deletion/export scope. |

No unknown value is a guessed default: an absent Bedrock model or unverified AWS deployment is a disabled capability with a visible reason. These gates are not excuses to stop ordinary implementation.

## Design choices already settled for the executor

1. Extend the existing state machine. A graph framework does not supply answer validity, provenance, or submission reconciliation.
2. Store raw observations separately from beliefs, approved answer references, and procedural proposals. Similarity is not authority.
3. Use one local versioned learning ledger under `data/auto/learning/`, plus disposable indexes. Do not create a second writable profile or tracker.
4. Keep the worker's retrieval context small. Never append the entire growing history to its prompt.
5. Preserve the core fact gate and manual application-start behavior. Background learning must never enable scheduled applications.
6. Treat every potentially submitted operation with an unknown outcome conservatively. An employer may have received it even when the local process failed.
7. Prioritize exact structured lookup; add model-assisted grouping/drafting only where needed. Embeddings are not required for completion.
8. Keep the UI data-driven. Learning can automatically populate new insight cards within a fixed schema; it cannot inject HTML/JavaScript or rewrite its own permissions.

## Important corrections to earlier assumptions

- Upstream scanner/pipeline formats already carry posting dates. The local pending-row parser and job schema lose them. Reuse extraction rather than rescraping every employer.
- The upstream question-section parser exists, but the sampled 1,591 local reports yielded no captured-answer sections and no parsed draft answers. Audit artifacts are therefore the initial backfill source; report parsing must tolerate genuinely absent sections.
- Current resume variants principally change a headline, not the experience narrative. Market recommendations must be grounded drafts, not claims that extensive role tailoring already exists.
- The current audit validator accepts object-form answers, while diagnostics iterates arrays. Fix that consumer contract before relying on diagnostic learning.
- Some audit folders can be reused after attempt counters reset. Old overwritten evidence cannot be reconstructed with certainty; explicitly mark historical coverage gaps.
- The current worker can inject Playwright and broad CLI bypass flags. Do not execute that path under current instructions. T10 includes a Neo/CDP capability preflight and refusal path; inability to technically restrict an executor must not be hidden behind a prompt promise.

## Risk register and coverage

| Risk / overlooked case | Required treatment |
|---|---|
| Past generated answer becomes a false candidate fact | Authority lattice, source binding, approval, negative reuse tests; T07/T08. |
| Work authorization, salary units, employer history, location, or notice changes | Jurisdiction/employer/time predicates, source hashes, explicit expiry; T07/T08. |
| Optional, repeated, translated, conditional, or custom-widget questions disappear | Question occurrences and coverage status independent of filled values; T06/T10. |
| One failed or successful ATS run teaches a universal rule | Employer/tenant-scoped procedures, evidence counts, held-out tests; T18. |
| ATS boilerplate or repeated retries dominate market insights | Separate ATS boilerplate from role questions; distinct requisition/company denominators; T16. |
| An accepted form is mistaken for hiring success | Distinguish confirmation, response, interview, offer, and hiring; pending is not rejection; T20. |
| Memory poisoned by webpage instructions or malicious historical artifacts | Treat all source text as data, strict schemas, no code execution, source IDs validated; T02/T17/T25. |
| Concurrent worker/panel/reviewer loses an answer or queue decision | Version checks, lock ownership, narrow patches, immutable attempts; T03/T08/T21. |
| Credentials leak through prompt/audit ingestion or screenshots | Do not ingest prompt/credential files; minimize sensitive references; visible privacy gaps; T02/T05/T13. |
| Profile correction does not invalidate old answers/resume drafts | Dependency graph and stale status; T08/T09/T16. |
| Token costs increase faster than savings | Incremental batches, retrieval limits, reservations, no unapproved retries, usage reporting; T17/T19. |
| Laptop sleep, clock changes, or crash causes duplicate reviewer runs | Persistent due/cursor/lease state; coalesce missed runs; T19. |
| A provider's updated timestamp masquerades as a new posting | Date provenance/precision and repost identity; T11. |
| API/UI approval can be forged cross-origin | Loopback plus exact Origin/Host checks, CSRF token, content-type/body limits; T21. |
| Rollback code cannot interpret newly written state | Reader-version compatibility, stop writers, reconcile first, restore rehearsal; T26/T27. |
| Privacy deletion removes source but leaves searchable derivatives | Invalidation/tombstones, rebuild, export/backup accounting; T08/T25. |
| Learning changes selection so later performance samples are incomparable | Pin cohort/policy versions and show confounders; T20. |
| Restricted assessment content or unaided-work attestation treated as a cached answer | Preserve applicable restrictions; capture only permitted metadata; route to human/policy review; T06/T10. |
| Prompt promises question capture but the executor never calls the capture path | Explicit observe/resolve/checkpoint protocol and non-vacuous integration tests; T10. |

## Scope boundary for self-changing code

This plan implements automatic memory consolidation, bounded review, evaluated procedural proposals, and data-driven UI growth. It also prepares reviewable code/UI improvement proposals. It does **not** silently give the production learner an unrestricted shell or the power to deploy its own patches. Once a code/UI proposal is approved, an existing coding agent executes that reviewed change in an isolated maintenance workflow with the same tests and rollout gates. Unattended source-code deployment is a separate D05 policy decision, not a capability to claim merely because proposals exist.

## What success looks like

A second application reuses a previously confirmed answer with no model call; a changed preference invalidates that reuse; a verification wait resumes the original account/application; an uncertain submission is reconciled instead of repeated; a failed tracker write is repaired independently; and the UI shows what was learned and why. Role intelligence cites observed evidence and its limits. The reviewer can demonstrate a safe improvement against fixed cases rather than merely writing a retrospective.

Read `EXECUTOR.md` for the exact first steps and progress-report format. Do not execute from this summary alone.
