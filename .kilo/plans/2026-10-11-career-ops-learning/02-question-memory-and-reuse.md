# Phase 2: Question memory and safe reuse implementation plan

> **For agentic workers:** Execute T06–T10 after Phase 1. Use the shared contracts and independent synthetic fixtures. The goal is less reasoning without weaker truthfulness or context checking.

**Goal:** Capture all encountered questions, retrieve current approved answers, retain useful experience examples, and incorporate memory into each attempt.
**Architecture:** Observations are evidence; question families organize them; answer records point to authoritative candidate sources. A model can propose grouping or prose but cannot confer approval.
**Tech Stack:** Local `.mjs` modules and indexes; existing profile/standing/CV sources; Neo/CDP-capable worker with restricted tools.

## T06. Build question definitions, occurrences and safe families

**Create:** `auto/learning/questions.mjs`, `auto/test/learning-questions.test.mjs`.
**Consumes:** normalized observations from T04/T05.
**Produces:** `normalizeQuestion`, `findQuestionCandidates`, definition/family records.

- [ ] Build a fixture matrix with exact duplicates, punctuation/case variation, negation, units, currency, current/future authorization, employer-specific employment, optional questions, repeated page controls, file uploads, languages and conditional branches.
- [ ] Normalize Unicode consistently, trim harmless whitespace, and retain the original text. Do not erase negation, time horizon, country, salary basis, required state, or option semantics. Stable definition IDs include the normalization version and semantic constraints.
- [ ] Store each occurrence independently from its family. Deduplicate repeated snapshots of the same unchanged field/step, while preserving changed options or question text as a new field revision. A different application attempt is evidence but not a new requisition in aggregate counts.
- [ ] Respect restricted assessments and attestations. A timed/confidential assessment or a statement requiring unaided work is not an ordinary reusable form answer; record only permitted metadata and route to a policy/human-action blocker. Do not misrepresent AI-assisted work as unaided or treat permission to apply as permission to bypass assessment rules.
- [ ] Implement exact and lexical candidate retrieval with hard filters and a configurable cap. Near matches remain candidates; a candidate link cannot authorize answer reuse. Unknown/ambiguous family links remain ungrouped and visible.
- [ ] Add merge/split correction records so a mistaken family can be corrected without rewriting raw observations. Invalidate answers and metrics affected by a split.
- [ ] Run `node --test auto/test/learning-questions.test.mjs`. Expected: harmless variants can share a family; deliberately dangerous pairs never become interchangeable; unknowns stay queryable rather than disappearing.

```js
assert.notEqual(normalizeQuestion(currentAuthorization).id, normalizeQuestion(futureSponsorship).id);
assert.notEqual(normalizeQuestion(baseSalaryUSD).id, normalizeQuestion(totalCompensationCAD).id);
assert.equal(normalizeQuestion(spacedDuplicate).normalizedText, normalizeQuestion(originalQuestion).normalizedText);
```

The named fixtures are full CONTRACTS D1 observations stored under `auto/test/fixtures/learning/`, with synthetic values and explicit differing constraints.

## T07. Resolve answers by authority, context and freshness

**Create:** `auto/learning/answers.mjs`, `auto/test/learning-answer-resolution.test.mjs`.
**Produces:** `resolveAnswer` with the exact status union in CONTRACTS E.

- [ ] Create a read-only source adapter registry: `profile`, `standing`, `cv`, and explicitly mapped user-confirmed profile notes. Register exact selectors, source hashes and allowed use scopes; do not treat every prose line in a memory file as an approved eligibility fact.
- [ ] Implement the resolution order: current authoritative source mapping; current approved source-bound answer; approved derivation from valid inputs; grounded draft requiring review; otherwise missing-information blocker. If sources conflict, return `blocked` with the conflicting reference IDs.
- [ ] Check employer, jurisdiction, role, locale, options, units, validity dates and source hashes before returning `ready`. Never copy an option label if the current menu does not offer it. Sensitive optional questions obey the user's existing disclosure policy, including an explicitly approved decline choice.
- [ ] Handle dynamic facts as rules, not cached strings: current date/availability and company-specific employment/application history must use approved inputs and verified identity. Do not infer nationality or eligibility from location.
- [ ] Write negative tests for expired preferences, modified CV/profile, salary basis/currency, unknown source, an accepted but generated old answer, a new employer, and two plausible conflicting memories. Include a spy model client and assert zero model calls for an exact approved repeat.
- [ ] Run `node --test auto/test/learning-answer-resolution.test.mjs`. Expected: only `ready` results contain a fillable value; all other statuses identify the reason without inventing an answer.

```js
const result = resolveAnswer(ctx,{observation:noticeQuestion,sourceSnapshot:approvedSources,policy});
assert.equal(result.status,'ready');
assert.equal(result.value,'4 weeks');
assert.equal(modelCalls,0);
const changed = resolveAnswer(ctx,{observation:noticeQuestion,sourceSnapshot:changedSources,policy});
assert.notEqual(changed.status,'ready');
```

This sample value exists only in synthetic fixtures. No real notice period or employment fact is supplied by this plan.

## T08. Make approval, corrections, withdrawal and resume durable

**Extend:** `answers.mjs`; **Create:** `auto/test/learning-answer-approval.test.mjs`, `auto/test/learning-invalidation.test.mjs`.
**Produces:** `proposeAnswer`, `approveAnswer`, `invalidateSource`; source-change records and affected-blocker notifications.

- [ ] Implement proposal creation without changing candidate sources. Store question/context, the proposed value or source reference, exact source hash, intended selector, affected applications and use scope. Hide sensitive values from default lists.
- [ ] Implement a source-patch preview that preserves unrelated YAML/comments/Markdown. For new recurring preferences, add an explicitly quoted scalar/array under an approved `standing.custom` key; validate parsed before/after structures and ensure only the approved path changed. Complex or conflicting profile/CV edits require a separate reviewed source patch, not an override hidden in the answer bank.
- [ ] Apply a user-approved proposal under a source lock with an expected hash. Persist an approval intent, atomically write the approved source change, and record its committed hash. On crash, compare intended before/after hashes to reconcile the pending transaction; never blindly apply twice or treat a pending intent as an approved usable fact.
- [ ] Notify only the affected blockers. A source update does not automatically requeue an unknown submission or create a new application. T13 resumes the same safe operation with the new source version and rechecks the form.
- [ ] Implement correction/expiry/revocation invalidation across answer caches, stories, procedures dependent on personal facts, and positioning drafts. Provide a forget preview listing canonical learning versions, derived indexes, exports and still-existing original audits. Only explicitly approved deletion removes originals; never claim complete erasure when they remain.
- [ ] Test stale approval conflicts, repeated approval idempotency, crash before/after source write, reload, conflicting profile facts, source deletion, revoked answer retrieval, and selective blocker wake-up. Run `node --test auto/test/learning-answer-approval.test.mjs auto/test/learning-invalidation.test.mjs`.

```js
await assert.rejects(
  approveAnswer(ctx,{proposalId,expectedRevision:oldRevision,approval:userApproval}),
  error=>error.code==='REVISION_CONFLICT'
);
assert.equal(hashFile(standingPath), hashAfterIndependentEdit);
```

The user-approval test fixture is passed by the test harness. Production model outputs or agent-supplied `actor:'user'` values never create that authority.

## T09. Build small, source-bound answer and experience packets

**Create:** `auto/learning/retrieval.mjs`, `auto/test/learning-context-packet.test.mjs`.
**Produces:** `buildContextPacket`.

- [x] Extract reusable experience references from already approved CV/profile material. Maintain source spans, hashes, role/capability tags and public-use restrictions. A story can point to experience; it cannot synthesize a metric or accomplishment absent from its source.
- [x] Retrieve only answers relevant to currently observed questions, up to 12 candidates and the configured byte cap. Reserve space for blockers, provenance and the most relevant procedures before optional examples.
- [x] When a role-specific free-text answer needs generation, supply a bounded evidence packet and identify which claims may be used. Store output as a draft with source references and validation findings; do not promote its phrasing into a new personal fact.
- [x] Cache packets by job/JD revision, question/option fingerprint, source hashes, policy/procedure versions and locale. Invalidate on any relevant change. Do not cache employer-specific prose solely by role title.
- [x] Test a large history with one relevant answer, changed source invalidation, insufficient facts, unsupported metrics, country/employer separation and oversized material. Run `node --test auto/test/learning-context-packet.test.mjs`; record packet bytes and model-call counts for cold and warm repeats. (8/8 pass; cold 1894 B / 1 model call, warm 1894 B / 0 calls; single-question packet 707 B.)

```js
const packet = buildContextPacket(ctx,{applicationId,observations:[noticeQuestion],maxBytes:24000});
assert.ok(packet.bytes<=24000);
assert.equal(packet.answers.length,1);
assert.ok(packet.versions.sourceHashes.includes(standingHash));
assert.equal(JSON.stringify(packet).includes('fixture-secret-password'),false);
```

## T10. Integrate continuous capture and retrieval into the worker

**Modify:** `auto/apply-worker.mjs`, `auto/prompts/apply-submit.md`, `auto/run.mjs`.
**Extend:** evidence/retrieval CLI operations; **Create:** `auto/test/learning-worker-integration.test.mjs`.
**Consumes:** question/answer APIs and immutable attempts. **Produces:** an attempt that consumes memory and emits structured page observations, even if it parks or fails.

- [ ] Add an executor preflight. Verify that the chosen runtime has the intended Neo/CDP tools, respects the permitted capability boundary, and uses task-owned tabs. Remove the local Playwright injection from this execution path. Do not invent CLI flags or fall back to an unrestricted executor when the runtime cannot enforce the required boundary. Mark `tool_unavailable` visibly instead.
- [ ] Add fake/injected executor support to the worker for tests. The fake returns scripted page observations and outcomes, not a real browser. Separate code-root prompts from data-root output and keep long-running child cleanup scoped to its own process/session.
- [ ] Before filling each newly observed page, capture labeled controls, options, required states and visible conditions. Include unanswered optional fields. For dropdowns, inspect actual offered options and verify committed selection; a historic option or uncommitted typed value is not success.
- [ ] Implement and fixture-test the worker-to-learning subcommands in CONTRACTS J. Verify a scripted executor actually calls observe/resolve/checkpoint in the expected order. Reject a completed-looking run that never emitted promised captures by marking coverage incomplete; do not hide a missing integration behind a final-audit import.
- [ ] Resolve known answers and attach a small packet to the next worker step. Persist the consumed memory/source versions and a reuse reason. A missing fact creates a structured blocker instead of asking the model to infer it. Do not wait until final submission to save all questions.
- [ ] Treat captures from the worker as untrusted structured input. Validate attempt/job identity, root/path containment and source IDs. If only final legacy artifacts are available, ingest them but label coverage partial; do not claim complete question capture.
- [ ] On completed, parked, failed or interrupted runs, finalize the available evidence and enqueue local consolidation. Capture failure must be visible and must not manufacture submission status. Ensure this code never calls the background reviewer as a reason to start an application.
- [ ] Run `node --test auto/test/learning-worker-integration.test.mjs`. Required scenarios: same question reused on the second fake application with zero model calls; new question blocked; partial form retained after failure; different options revalidated; wrong job identity rejected; no Neo tools means no application executor launch.

## Phase 2 review gate

- [ ] A question encountered once is searchable with provenance and reused correctly in a second fixture run.
- [ ] A changed/withdrawn answer immediately stops reuse and survives reload.
- [ ] Unanswered fields and incomplete coverage are visible, not silently lost.
- [ ] No generated text became approved personal truth, and no private history was dumped into a growing prompt.
- [ ] Capture/retrieval does not use Playwright or bypass a missing capability fence. Continue offline work if a live executor connection still needs an approved human setup step.
