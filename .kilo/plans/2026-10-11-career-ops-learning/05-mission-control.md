# Phase 5: Mission Control learning UI implementation plan

> **For agentic workers:** Execute T21–T24 using frozen API contracts. This is an extension of the current local panel, not a replacement dashboard or upstream web-app patch. Browser verification uses BrowserOS Neo only.

**Goal:** Give the user one place to inspect questions, approved knowledge, role intelligence, blockers, learned procedures and improvement proposals.
**Architecture:** Small local API handlers expose versioned records. Separate UI modules render allowlisted data types and call specific reviewed mutations. Learned data never becomes executable UI code.
**Tech Stack:** Existing local HTTP server, native JavaScript modules, existing CSS variables/layout conventions, Node handler tests and Neo browser checks.

## T21. Add narrow local APIs and static asset serving

**Create:** `auto/learning/api.mjs`, `auto/test/learning-api.test.mjs`.
**Modify:** `auto/panel.mjs` route dispatch and a small asset manifest only.
**Produces:** `handleLearningRequest` and CONTRACTS G endpoints.

- [x] Write route tests using mocked requests/responses or an isolated loopback test server with synthetic data. Cover wrong Host/Origin, absent CSRF token, invalid content type, oversized body, traversal, unknown IDs, malformed queries, stale revisions and disabled features.
- [x] Implement the GET routes as read-only views over current indexes/records. Default limits are bounded, sensitive values are masked/omitted, and every list response includes generation/cursor. A GET must never launch a reviewer, model call, account operation or application.
- [x] Implement POST routes with strict request schemas, same-origin validation, CSRF, expected revision and operation identity. Bind approval provenance to the trusted local UI/session action; do not honor an arbitrary `actor:'user'` field from a model payload. A duplicate identical approval must not apply twice; conflicting repeats return 409.
- [x] Expose answer/source changes as preview then commit. Return committed source/record versions for success; if persistence fails, the UI must not display success. Code/UI proposal decisions change review status only and do not apply the suggested diff.
- [x] Serve `/auto/assets/learning/` from a fixed filename manifest beneath `auto/ui/learning/`. No user-selected file paths, no wildcard filesystem exposure, and correct JavaScript/CSS content types with nosniff. Do not link excluded prompt/credential artifacts from the learning evidence viewer.
- [x] Keep localhost binding and existing application controls intact. Preserve reverse-proxy behavior without granting the upstream UI new submission capabilities. Run `node --test auto/test/learning-api.test.mjs`.

Response example:

```js
{
  items: [],
  nextCursor: null,
  generation: 'index-generation-id',
  coverage: {observed:0,partial:0,unknown:0},
  feature: {enabled:false,reason:'learning_not_activated'}
}
```

An empty result is legitimate only when the underlying data really is empty. A corrupt index is a visible error/rebuild condition, not the same empty payload.

## T22. Build questions, candidate knowledge and freshness views

**Create:** `auto/ui/learning/{client.mjs,index.mjs,questions.mjs,profile.mjs,learning.css}`, `auto/test/learning-ui-data.test.mjs`.
**Modify:** a small mount and module include in `auto/panel.html`, navigation links in the panel.

- [x] Add a shared client for paginated GETs, CSRF-protected POSTs, request cancellation, typed error states and stale-generation refresh. It must not silently retry a consequential POST with an unknown result.
- [x] Build Questions: search, role/company/date/type filters, original wording, observed options, required/optional/unknown state, occurrence history, source links, coverage, approved answer status and unresolved questions. Family grouping must be inspectable and correctable through an explicit review flow.
- [x] Build Candidate Knowledge: confirmed source-bound facts/preferences, pending proposals, conflicts, expiry/revocation, source/version provenance and dependent applications. Keep proposed/inferred statements visibly distinct from confirmed ones; revealing sensitive values requires an explicit user action.
- [x] Add the approval preview and committed-state readback. On approval, reread the server record, source version and affected blockers. Verify reload restores the decision; do not rely on a local optimistic toggle as proof.
- [x] Extend the existing queue with posted/first-seen/last-checked labels, unknown-date state, a previewable ordering mode and “why this rank” explanations derived from the shared comparator. Do not change live order on page load. (Required a minimal read-only `panel.mjs` extension: `dates` on job summaries and `GET /api/auto/queue-preview` over the shared comparator — logged in EXECUTION-LOG.)
- [x] Use separate files and existing UI conventions. Render source text with `textContent` or an equivalent escaping path. Do not inject source Markdown/HTML unsanitized. Large tables use pagination, not rendering the entire corpus.
- [x] Run `node --test auto/test/learning-ui-data.test.mjs` for pure view-model behavior, then use Neo against an isolated fixture panel for approve → reload → resumed-blocker visibility. Follow the user's dropdown preference: open, inspect actual options, select and verify.

For parallel work, one agent owns `questions.mjs`, another `profile.mjs`; only the coordinator edits `index.mjs`, the shared client, the panel mount and API contracts.

## T23. Build intelligence, operations and proposal views

**Create:** `auto/ui/learning/{intelligence.mjs,operations.mjs,proposals.mjs}`; extend pure view-model tests.

- [x] Build Role Intelligence: role family and cohort controls, observed capabilities, distinct job/company counts, denominators, evidence window, capture gaps, source references, contradictory evidence and grounded positioning drafts. Below supported sample sizes, show counts/limitations rather than a confident conclusion.
- [x] Build Operations: memory reuse/new-question rates, active versus waiting time, capture failures, blockers, account-verification state, procedure version/scope/staleness, reviewer cursor/next due time, budget reservations and unknown costs. Missing usage is labeled unknown.
- [x] Build Proposals: why the change was suggested, affected source/component, evidence, baseline, evaluation cases/results, risk, approval requirement, previous version and rollback status. Differentiate an answer approval from permission to modify code or publish LinkedIn content.
- [x] Make observed knowledge automatically populate fixed insight cards. Supported card types are question trend, role capability, unresolved information, operational friction, procedure candidate and outcome summary. Unsupported generated card/code types are refused and shown as a proposal requiring implementation review.
- [x] Add explicit controls to pause the learner independently of applications, run a local-only review, inspect cloud-disabled reasons and preview a privacy/export action. A reviewer button must never start an application cycle.
- [x] Test source strings containing HTML/script, tiny cohorts, missing dates, long multilingual questions, malformed analytics values and revoked procedures. Use Neo to confirm navigation preserves unrelated queue/control behavior.

## T24. Verify accessibility, usability and scale before activation

**Create:** `auto/test/learning-ui-acceptance.test.mjs` for pure state/formatting contracts; store browser evidence in the scratch reports directory.

- [x] Exercise keyboard navigation, accessible names, focus after dialogs, error announcements, reduced motion, readable contrast in existing themes and responsive layouts. Do not restore withdrawn designer/color preferences or introduce a new aesthetic.
- [x] Check loading, empty, partial-data, stale, disabled, conflict and failure states for every view. Confirm an unavailable cloud lane does not hide useful local knowledge or misrepresent it as complete.
- [x] Generate a synthetic 10,000-question corpus with real variation and measure pagination/search latency and returned bytes. Record hardware/runtime and measured p50/p95; optimize indexes if the UI blocks or returns unbounded data. Do not assert a performance target passed without measuring. (Measured: page p50 10.5 ms / p95 12.2 ms, mount 1,205 ms over 10k; evidence in `reports/t24-acceptance.md`.)
- [x] Inspect console errors, failed requests and stale UI after approval/revocation/reload through Neo. Keep useful evidence tabs task-owned and do not interact with another agent's employer tabs. (Found and fixed a real stale-UI defect: lists never refreshed their index generation after mutating POSTs.)
- [x] Run all local learning UI/API suites and attach the browser journey evidence. Verify no source-only UI change is called deployed until the correct panel service is restarted during T27. (360/360 pass; nothing deployed — live panel still runs old code until T27.)

## Phase 5 review gate

- [x] The user can answer “What has it learned about me?”, “Where did that come from?”, “What do these roles ask?”, and “What changed?” from the same UI.
- [x] Approval survives reload and the server consumes it in the correct operation. (Failed before the T24 index-refresh fix in `api.mjs`; verified passing after, via Neo round-trip + regression test.)
- [x] Data-driven insight growth does not execute generated code or silently publish personal content.
- [x] Sensitive data, stale source versions and incomplete evidence are represented honestly.
- [x] Existing Mission Control and upstream proxy flows remain usable; no live application action was triggered by UI testing. (Fixture panel only; live :3001 never contacted.)
