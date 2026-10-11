# T25 acceptance-matrix evidence (A01–A34)

Date: 2026-10-11 · Branch: `learning-system` · Runner: node:test only, no new deps.

## Commands and results

| Command | Result |
|---|---|
| `node --test auto/test/learning-adversarial.test.mjs` | 19 tests, 19 pass, exit 0 |
| `node --test auto/test/learning-*.test.mjs auto/learning/cloud/test/*.test.mjs` | **398 tests, 398 pass, 0 fail, exit 0** (379 prior + 19 new) |
| `node test-all.mjs --only application-answers` | 20 passed, 0 failed (inspected first: pure parse/format round-trip tests, no browser/network/spawn paths) |

## Matrix coverage

- **A01–A17** (T25a): `auto/test/learning-acceptance.test.mjs` — coverage counters at pass: observations 2, reuses 3, preventedReuses 4, blockersResolved 2, trackerRepairs 1, model calls 0.
- **A18–A34** (T25b): `auto/test/learning-adversarial.test.mjs`, sharing the T25a driver `auto/test/helpers/learning-matrix.mjs` (real store/resolvers/checkpoints/workflow/API handler; instrumented fake model/mailbox/accounts/tracker with call counters; injected advancing clock; mkdtemp isolation asserted by A00).

Per-row verdicts (all PASS):

| Row | Verified outcome |
|---|---|
| A18 | Tracker row already at `Interview`: job marked `reconciled`, zero `set-status` calls, canonical row and pipeline stage untouched — no regression to Applied. |
| A19 | `provider_published` wins; `firstSeenAt` kept separate, never relabeled; `modifiedAt` never promoted; `fit_then_freshness` orders newest verified posting first, unknown after known, deterministically. |
| A20 | Unknown and future dates stay null (`bucket unknown`, age null); repost requires provider evidence postdating discovery; re-registering the same URL returns the existing identity (`created:false`), never a silent duplicate. |
| A21 | `resolveExecutionPolicy` digest is deterministic (`p1-<16hex>`), changes with values, refuses out-of-range (`POLICY_INVALID`); `previewPolicyEnforcement` carries the identical version; the attempt record pins its allocation-time version. |
| A22 | Injection text persisted verbatim as data; resolution never `ready`; `run_shell` step refused (`INVALID_PROCEDURE`); proposals with `execute`/pre-approved status refused; zero model calls. |
| A23 | Secret-shaped audit keys rejected with value withheld (absent from serialized output); `.env`/credentials/mailbox not ingestible; cloud refuses secret excerpts before the transport (0 transport calls). |
| A24 | Review with `limit:1` stops early; a fresh run resumes from the persisted cursor; batches disjoint (nothing processed twice); `startCycle` never called; `cloud: null` on localOnly. |
| A25 | No config → `CLOUD_DISABLED`; tiny cap → `CLOUD_BUDGET_EXCEEDED` before transport; timeout → `CLOUD_OUTCOME_UNKNOWN` with the reservation held, second call `CLOUD_IN_FLIGHT`, reconcile `unknown` → `aborted`; exactly one paid transport call ever. |
| A26 | Unsafe procedure fails held-out evaluation (safety violations, `passed:false`, failures listed); persistEvaluation leaves it `candidate` (never `tested`/`active`); `promoteProcedure` rejects. |
| A27 | Cross-origin POST, forged-CSRF POST and foreign-Origin GET all 403; standing-source hash unchanged; no `forgetRequests` record created. |
| A28 | Live cohorts: `claimType: association` with role-mix/small-sample/unknown-time caveats; unknown deltas stay null, not zero; even `fixture_replay` loses the mechanistic claim when mixes changed. |
| A29 | Malformed revision file → `CORRUPT_RECORD` thrown (never null); `schemaVersion: 999` → `UNSUPPORTED_SCHEMA_VERSION`; `rebuildIndexes` reports the errors; stale cursor → `REFRESH_REQUIRED`. |
| A30 | `privacy/preview` lists canonical versions, `claimsCompleteErasure:false`, deletes nothing (record intact at revision 1); `privacy/apply` → 403 `NOT_AVAILABLE` with the honest "approved deletion" message. |
| A31 | Null/missing-tools/unrestricted/shared-tabs executors all `tool_unavailable` with explicit no-fallback reasons; only the restricted Neo/CDP capability set passes preflight. |
| A32 | `execute:true` UI proposal refused (`PROPOSAL_SELF_AUTHORITY`); clean proposal stored `proposed` with a `user` approval gate and the script-bearing diff held as an inert string. |
| A33 | Restricted-assessment text yields `restricted:true` + blocker `human_action_restricted_assessment`; `resolveAnswer` returns `blocked` with the `restricted_assessment` reason, value null. |
| A34 | Audit dir without `answers.json` → `missing_answers` gap, 0 added; unsettled `answers.json` → `UNSETTLED` rejection, 0 added — no fabricated coverage. |
| Summary | observations ≥ 2, preventedReuses ≥ 2 from these rows; model calls 0; accounts created 0; unscoped mailbox reads 0. |

## Broader suites skipped, and why

- `node test-all.mjs` (full, no filter): runs inline checks plus provider/live-path suites; out of T25 scope and risks touching live state while the pipeline is running. Only the inspected-safe `--only application-answers` filter was run. A green filtered run is **not** a claim that the full upstream suite passed.
- Any suite launching Playwright/BrowserOS, generating live PDFs, calling models, or starting cycles/applications: prohibited by the task; none were started.
- `panel.mjs --self-test`: explicitly excluded by the task instructions.

## Defects found

None requiring fixes: every A18–A34 behavior was already implemented correctly; the suite pinned them without modifying any production file. No `run.mjs`/`apply-worker.mjs`/`state.mjs` findings.
