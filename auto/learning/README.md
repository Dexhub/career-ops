# Learning layer — operator guide: migration, backup, restore, rollback

This README covers the operator procedures rehearsed by
`auto/test/learning-migration.test.mjs` (T26). The helpers live in
`auto/learning/migrate.mjs` and are reused by the T27 activation gate.
Everything here operates on explicit roots; nothing runs at import time.

## Migration (preview → apply → restart)

1. **Preview** (read-only): `node auto/learn.mjs backfill --dry-run --out <manifest.json>`
   builds the backfill manifest (`buildBackfillManifest`) — entry hashes,
   adapter versions, settled flags and coverage gaps. Preview never writes
   learning records.
2. **Pre-migration manifest**: before applying, snapshot the data root with
   `buildDataManifest(root)` (every file, size, sha256). Keep it with the run.
3. **Apply**: `node auto/learn.mjs backfill --apply --manifest <manifest.json>`.
   Sources are re-hashed at apply time; changed/missing/malformed/unsettled
   sources are rejected per entry, never silently fixed.
4. **Interrupt/restart**: apply is idempotent. If interrupted, re-run with the
   same manifest; already-committed observations are counted as duplicates and
   never re-added or overwritten.
5. **Store meta / compatibility marker**: after a successful apply, write
   `store-meta.json` via `writeStoreMeta(ctx, { inputManifest })`. It records
   the input manifest identity, output store schema version, adapter versions
   and the reader/writer compatibility floors. Before any writer touches a
   store, call `assertWriterCompatible(ctx, { writerSchemaVersion })` — an
   unsupported old writer is refused with `WRITER_INCOMPATIBLE`.

## Backup

- Back up **only approved data paths** with
  `backupDataPaths({ sourceRoot, destRoot, approvedPaths })`. The destination
  is created owner-only (`0700`); each copy is hash-verified against the
  source; a `backup-manifest.json` (names + hashes only, never values) is
  written inside the backup.
- **Credentials never enter a backup**: approving a credential-named path
  throws; a credential-named file found under an approved prefix is refused
  and recorded in the manifest's `refused` list. Do not commit backup data or
  place it in an unprotected archive.
- **A backup is not accepted until restored**: run
  `restoreBackup({ backupRoot, destRoot })` against a *separate scratch root*
  and verify the expected records reproduce (hashes are re-checked file by
  file). Only then treat the backup as valid.

## Index rebuild

Index generations are derivative. They can be discarded entirely
(`rm -r data/auto/learning/indexes`) without losing authoritative revision
files — reads fall back to a deterministic unindexed scan — and rebuilt with
`rebuildIndexes(ctx, { apply: true })`. A failed generation build never swaps
`current.json`, so the previous generation stays usable.

## Rollback procedure

1. Stop the reviewer and application writers at an approved safe boundary
   (between attempts; use the panel's pause-after-current control — never kill
   mid-submission).
2. Keep unresolved external outcomes **parked**: an attempt with an unknown
   submission outcome stays `unknown` until reconciled; rollback must not
   resolve, delete or retry it.
3. Disable new features (`config/learning.yml` → `enabled: false`) before
   restarting anything.
4. Restore compatible code/config/data from a hash-verified backup (or use a
   verified adapter for cross-version data). Verify the restore as above.
5. Recheck the canonical tracker against the restored jobs before resuming.
   **Never restore an old "queued" snapshot over a newly submitted job** —
   `guardSnapshotRestore` refuses this with `ROLLBACK_UNSAFE`.

## Irreversible external effects — a rollback CANNOT undo these

A local restore only rewinds local state. It **cannot unsend** an application
that was already submitted to an employer, **cannot delete** an
employer account created on an external ATS, **cannot retract** a message sent
to a recruiter or employer, and **cannot undo** a public-profile publication.
Treat every external side effect as permanent: park it, reconcile it, and
record it in the canonical tracker — do not pretend the rollback erased it.

---

# Operations guide (T29): startup, flags, flows, troubleshooting

Everything below describes only implemented commands and routes, verified
against `auto/learn.mjs`, `auto/learning/api.mjs` and `auto/learning/*.mjs`
on branch `learning-system`. **Current status: NOT activated.** T27 has not
run; `config/learning.yml` ships `enabled: false`, and the live panel process
still runs pre-learning code until an operator restart (pending T27).

## Startup and flags

- The learning API has no standalone server. It is mounted inside the panel
  (`node auto/panel.mjs`): `handleLearningRequest` serves `GET`/`POST` under
  `/api/auto/learning/*` plus a fixed-name asset manifest under the learning
  asset base (only exact names under `auto/ui/learning/` resolve — no user
  paths, no wildcards). Side effect of starting the panel: the usual panel
  behavior only; learning routes refuse consequential actions while disabled.
- `config/learning.yml` (schema_version 1) is the single feature switch:
  - `enabled` (currently `false`) gates the whole layer; `mode` is one of
    `shadow | active | off` (currently `shadow`).
  - `review.enabled` (false) gates the reviewer; `review.interval_minutes`,
    `max_new_attempts`, `concurrency`, `auto_promote_procedures` bound it.
  - `cloud.enabled` (false) plus `daily_usd_cap: 0` / `max_calls_per_day: 0`:
    a zero budget disables cloud with reason `zero_budget` even if someone
    flips `cloud.enabled` — spend requires an explicit nonzero budget (D03).
  - Defaults are frozen in `auto/learning/context.mjs`
    (`LEARNING_CONFIG_DEFAULTS`); malformed/unsupported config fails visibly
    (`CONFIG_MALFORMED` / `CONFIG_UNSUPPORTED_VERSION` → HTTP 500).

## Roots

- `createLearningContext({ codeRoot, dataRoot, now })` requires explicit
  **absolute** paths and throws `INVALID_CONTEXT` otherwise; nothing executes
  at import time. The learning store lives at
  `<dataRoot>/data/auto/learning` (`learningDataRoot`). Source files resolve
  from the code root; `config/standing-answers.yml` resolves under the data
  root. The CLI (`auto/learn.mjs`) builds its context from
  `getCareerOpsRoot()`; tests always use mkdtemp scratch roots.

## Source precedence (answer resolution)

`resolveAnswer` (`auto/learning/answers.mjs`) is synchronous, read-only, and
never calls a model for a deterministic resolution. Order:

1. current authoritative source mapping (policy mapping to a source field);
2. current approved source-bound answer (bound to source content hashes);
3. approved derivation from valid inputs;
4. grounded draft requiring review;
5. missing-information blocker (never a guess).

Source files are `profile`, `standing`, `cv`, `notes` (`SOURCE_FILE_KEYS`).
A changed source hash invalidates bound answers (they go stale rather than
silently reusing). Restricted assessments resolve `blocked`, never reused.

## Question/answer approval flow

- Propose: `POST /api/auto/learning/answers/propose` (CSRF token from
  `GET …/status` required on all POSTs). Side effect: commits a proposal
  record and rebuilds list indexes.
- Approve: `POST /api/auto/learning/answers/approve`. Side effects: for a
  standing-source patch, writes **only** an explicitly quoted scalar/array
  under an approved `custom.*` key in `config/standing-answers.yml`,
  re-hashes the file at commit, and binds the answer to the **post-write**
  hash; commits the approved answer; rebuilds indexes. Refuses when the
  standing file changed since the proposal captured its hash
  (`CONFLICTING_SOURCE_EDIT`, 409).
- Revoke/invalidate: `invalidateSource` (used by the T28 journey) marks
  bound answers stale; reuse stops (`blocked/missing_information`).
- All mutating POSTs: `answers/propose`, `answers/approve`,
  `blockers/resolve`, `procedures/promote`, `proposals/decision`, `review`,
  `learner/pause`, `privacy/preview`, `privacy/apply`. Each successful
  mutation awaits `rebuildIndexes(apply: true)` before responding
  (~1.1 s at 10k records — budget for this when measuring POST latency).
- Reads: `GET …/status`, `…/question`, `…/metrics`, and list routes
  `questions, answers, blockers, insights, procedures, proposals, accounts`
  (accounts expose lifecycle/verification state only; refs are masked).

## Reviewer pause/resume and bounded review

- Pause/resume: `POST /api/auto/learning/learner/pause` with
  `{ opId, paused: true|false }`. Side effect: writes/removes a sentinel in
  the **learning data root only** — never `data/auto/pause-requested`, never
  any cycle or worker state. `GET …/status` reports `learner.paused`.
- One bounded pass: `node auto/learn.mjs review --once --local-only
  [--limit N]`. Side effects: consumes a persisted cursor, screens
  candidates, commits review-run records; never consults a model, never
  starts a cycle/submission. Refuses while `config/learning.yml` disables
  learning or review.
- Cloud variant: `node auto/learn.mjs review --once --approval-id ID`
  requires a **recorded D03 approval id** — an AWS credential profile is
  insufficient. Same via `POST …/review` with `approvalId`.

## Budget exhaustion (cloud)

`auto/learning/cloud-client.mjs` reserves budget before every call:
reservations are `reviewRuns` records with
`data.budget.kind === 'cloud_reservation'`. When `max_calls_per_day` is
reached or the estimated cost would exceed `daily_usd_cap`, the call is
refused with `CLOUD_BUDGET_EXCEEDED` — work queues locally; nothing silently
retries a paid call (`maxAttempts: 1`). An in-flight reservation with an
unknown outcome stays `running` until reconciled; do not re-issue it.

## Procedure rollback

Procedures (`auto/learning/procedures.mjs`) track active version,
`lastVerifiedAt` and evaluation version. Rollback is **approval-gated** and
restores the prior digest-distinct revision **as a new revision**; pinned
in-flight attempts keep their recorded `procedureVersion` untouched.
Promotion never trusts caller-supplied `passed: true`; `SCOPE_TOO_BROAD`
blocks a single tenant's success from becoming a global rule. For data
rollback, see the T26 rollback procedure above (unchanged).

## Privacy: preview, export, forget

- Preview: `POST /api/auto/learning/privacy/preview` with
  `{ opId, targets: [{collection,id},…], scope }` → lists what a forget
  operation **would** touch (`previewForget`). Preview never deletes.
- **Apply is NOT AVAILABLE.** `POST …/privacy/apply` always refuses with
  `403 NOT_AVAILABLE`: "privacy apply requires an explicitly approved
  deletion flow, which this build does not provide". There is no implemented
  deletion or redacted-export command in this build; sensitive export or
  erasure remains gated by D07 and must not be improvised. Do not hand-edit
  revision files to simulate a forget — that corrupts hash chains.

## Migration and recovery commands (summary)

See the T26 sections above for full procedures. Implemented commands:

| Command | Side effects |
| --- | --- |
| `node auto/learn.mjs inspect --json` | none (read-only summary of history/coverage) |
| `node auto/learn.mjs backfill --dry-run --out <path>` | writes manifest JSON to `--out` only; no learning records |
| `node auto/learn.mjs backfill --apply --manifest <path>` | commits observations idempotently; rejects changed/missing/malformed/unsettled sources per entry |
| `node auto/learn.mjs rebuild --verify` | rebuilds index generation then re-derives to verify counts; exit 1 on mismatch; reports `store: absent` honestly without creating one |
| `node auto/learn.mjs review --once --local-only [--limit N]` | bounded reviewer pass (see above) |
| `node auto/learn.mjs metrics [--from ISO] [--to ISO]` | none (read-only; never edits scoring rules/threshold/resume facts) |
| `node auto/learn.mjs observe-page --attempt-id ID --input FILE --apply` | commits a page observation for the attempt (CONTRACTS J; strict JSON on stdout) |
| `node auto/learn.mjs resolve-page --attempt-id ID --input FILE` | read-only resolution for the executor; no records committed |
| `node auto/learn.mjs checkpoint --attempt-id ID --phase PHASE --input FILE` | commits an attempt checkpoint |
| `node auto/learn.mjs capture-attempt --attempt-id ID --apply` | commits settled attempt evidence |

First safe recovery action for an interrupted run: **read-only inspect** —
`git status --short`, read `EXECUTION-LOG.md`, then
`node auto/learn.mjs inspect --json` and `node auto/learn.mjs rebuild
--verify`. Never re-run a paid call or employer submission whose outcome is
unknown; park it and reconcile first.

## Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| Missing source file | `FORBIDDEN_SOURCE`/resolution blocks; bound answers go stale | Restore the source file; do not fake content. Re-approval binds the new hash |
| Unreadable/corrupt data | `CORRUPT_RECORD`/`READ_ERROR` (visible 500, never silent) | Restore the revision file from a hash-verified backup; indexes are disposable |
| Stale index | reads show pre-commit state | `node auto/learn.mjs rebuild --verify` (or `rm -r data/auto/learning/indexes` then rebuild); reads fall back to an unindexed scan meanwhile |
| Revoked answer | reuse stops with `blocked/missing_information` | Expected. Re-propose and re-approve against current source content |
| Unmapped question | resolution ends in a missing-information blocker | Answer via the approval flow; never guessed. Check locale: unscoped proposals default to `scope.locale:'en'` and exact-match against e.g. `en-US` observations (T28 finding, unresolved) |
| No Neo connection | browser-dependent steps cannot run | Start BrowserOS Neo; the learning layer itself never launches a browser |
| Pending account verification | attempt parked in a verification wait | Wait/resolve the account state; waits survive restarts (A13) |
| Uncertain submission | outcome `unknown` | **Never retry.** Park, reconcile against mailbox/tracker evidence first (A15) |
| Tracker sync failure | sync task failed independently of the attempt | Re-run tracker sync (independently retryable, T15); repair never re-submits (A17) |
| Cloud disabled | `zero_budget` or `cloud.enabled: false` | Expected default. Enabling spend requires D03 approval + nonzero budget |
| Unknown paid-call outcome | reservation stuck `running` | Do not re-issue. Reconcile the reservation (`reviewRuns`, `data.budget.requestId`) before any new spend |
| Denied proposal | `proposals/decision` rejected it | Final for that revision; propose anew with better evidence. Denial never deletes evidence |

## What was actually evaluated — and what is NOT promised

Evaluated scope (honest limits):

- **Procedure classes (T18):** only the fixed step allowlist
  `open_existing_application, inspect_fields, wait_for_verification,
  recheck_session, resolve_known_question, request_human_help`, evaluated
  against the frozen held-out fixture
  (`auto/test/fixtures/learning/procedure-evaluation.json`): plain/second
  success, tenant mismatch, stale verification, changed options, tool
  unavailable, near-miss unknown answer. Steps that run code/shell, touch
  secrets, request new permissions, or perform a generic final submit are
  rejected by construction.
- **Role cohorts (T16):** the `ROLE_FAMILIES` taxonomy —
  `ai_transformation_leadership, engineering_leadership, product_leadership,
  ai_engineering, software_engineering, solutions_architecture, other` —
  derived from the user's own sampled applications. Displays say "observed
  in your sampled roles", never "required by the entire market".

This system does **not** promise: coverage of all possible employer
questions; guaranteed answer accuracy; automatic code repair (code/UI change
proposals are metadata only, D05); universal ATS coverage (only the
tenants/flows actually observed); or zero cloud cost once cloud is enabled
(spend is bounded by the configured budget, not eliminated). Metrics never
zero out unknowns and never infer a rejection from a pending outcome.
