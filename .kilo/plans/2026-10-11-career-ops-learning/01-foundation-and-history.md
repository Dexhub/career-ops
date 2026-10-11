# Phase 1: Evidence and history implementation plan

> **For agentic workers:** Execute T01–T05 sequentially with the executing-plans or subagent-driven-development skill. Read `README.md` and `CONTRACTS.md`. No live worker, migration, or cloud call is authorized by a test command.

**Goal:** Establish isolated execution, protected data contracts, non-overwriting attempts, and an honest historical corpus.
**Architecture:** Existing helpers remain unchanged; local modules own new learning data and normalize legacy inputs at their boundary.
**Tech Stack:** Node `.mjs`, `node:test`, existing lock/path helpers and JSON/YAML readers.

## T01. Establish test isolation and the baseline

**Create:** `auto/test/helpers/learning.mjs`, `auto/test/learning-context.test.mjs`, `auto/learning/context.mjs`, `config/learning.yml`.
**Modify:** local `auto/` path resolution only where code-root/data-root confusion prevents isolation.
**Consumes:** `getCareerOpsRoot()` and the config defaults in CONTRACTS F.
**Produces:** `createLearningContext`, `readLearningConfig`, and a fixture helper that returns `{codeRoot,dataRoot,cleanup}`.

- [ ] Record actual HEAD, dirty files, code/data roots, the current local services and their owners. Save only redacted metadata to the execution log. Do not kill a process based on a name match.
- [ ] Write a helper using `mkdtempSync(join(tmpdir(),'career-learning-'))`. Create synthetic `config`, `data/auto/jobs`, `output`, `reports` and `jds` beneath it. Set `CAREER_OPS_ROOT` in each child process before its first import. Cleanup removes only the helper-created root.
- [ ] Write tests proving source files/prompts resolve from `codeRoot`, private state resolves from `dataRoot`, missing config yields disabled defaults, and malformed config throws instead of overwriting it.
- [ ] Implement explicit roots and injected clock. Replace local hardcoded `ROOT` uses only as needed; no imported module may start a timer, model, application, or server merely by being imported. Use main-module guards for CLI entry points.
- [ ] Run `node --test auto/test/learning-context.test.mjs`. Expected: all tests pass, no network/subprocess application calls, no live root mtime changes. Store hashes of live config/job files before/after this suite as a safety check, not as acceptance for the whole feature.

Representative test:

```js
test('an isolated context never inherits the code checkout as its data root', () => {
  const ctx = createLearningContext({codeRoot:'/fixture/code',dataRoot:'/fixture/data',now:()=>new Date('2026-10-11T00:00:00Z')});
  assert.equal(ctx.dataRoot, '/fixture/data');
  assert.equal(ctx.codeRoot, '/fixture/code');
  assert.equal(ctx.now().toISOString(), '2026-10-11T00:00:00.000Z');
});
```

Do not use root `npm install`, any browser test that launches Playwright, or the existing `auto/run.mjs --self-test`/panel self-test until their data/process access is proven isolated.

## T02. Implement schemas, versioned storage and privacy boundaries

**Create:** `auto/learning/contracts.mjs`, `auto/learning/store.mjs`, `auto/test/learning-store.test.mjs`, `auto/test/learning-privacy.test.mjs`.
**Consumes:** CONTRACTS C/D; `withPipelineLock`.
**Produces:** `getRecord`, `listRecords`, `commitRecord`, `rebuildIndexes`.

- [ ] Write schemas for every collection before importing any history. Encode status enums, IDs, source references, maximum sizes, allowed fields and future-version refusal. Use strict deterministic validation; no LLM repairs policy-bearing input.
- [ ] Add tests for two writers with the same expected revision, corrupt JSON, read errors, duplicate identical revisions, traversal, symlink escape, prototype keys, oversized values, and future schema versions. At least one fixture must be nonempty so an empty-store pass cannot hide dropped records.
- [ ] Implement immutable revision files under a per-entity lock. Use temp-file creation with owner-only mode, complete write and fsync before rename, and sync directory metadata where supported. Validate latest revision under the lock; reject stale commits with `REVISION_CONFLICT`. Do not hold locks while invoking a model or browser.
- [ ] Implement batch index generation followed by an atomic current-pointer swap. Build indexes from explicit immutable input revisions; readers either see the old complete generation or the new complete generation. Return a refresh-required error for an obsolete pagination cursor. Verify that deleting indexes and rebuilding yields the same record counts and query results.
- [ ] Implement ingestion allowlists: question text/options, source references and workflow measurements are permitted; `credentials.json`, `prompt.md`, MCP configs, raw mailbox messages, tokens, passwords and verification links are excluded. Sensitive answer values remain protected references. Reject unknown nested payloads instead of recursively indexing them.
- [ ] Run `node --test auto/test/learning-store.test.mjs auto/test/learning-privacy.test.mjs`. Expected: concurrent commits preserve exactly one accepted revision, the rejected writer receives a conflict, and secrets never appear in default indexes, errors, logs or export payloads.

Representative conflict test after seeding a valid family fixture:

```js
const outcomes = await Promise.allSettled([
  commitRecord(ctx,'families','family-notice',{label:'Notice period',questionIds:[],scope:{}},{expectedRevision:1,status:'approved',sourceIds:[]}),
  commitRecord(ctx,'families','family-notice',{label:'Notice period revised',questionIds:[],scope:{}},{expectedRevision:1,status:'approved',sourceIds:[]})
]);
assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
assert.equal(outcomes.find(item=>item.status==='rejected').reason.code,'REVISION_CONFLICT');
```

## T03. Preserve attempts and concurrent job decisions

**Modify:** `auto/state.mjs`, every local caller in `auto/run.mjs`, `auto/eval-queue.mjs`, `auto/resume-select.mjs`, `auto/apply-worker.mjs`, `auto/panel.mjs`, and related local self-tests.
**Create:** `auto/test/learning-job-state.test.mjs`.
**Produces:** `updateJob(urlKey,{expectedVersion,patch,transitionTo})`; immutable attempt allocation and CONTRACTS D4.

- [ ] Enumerate all `saveJob`, `transition`, and `loadJob` callers with `rg`. Record this list in the task evidence; a new async mutation API is incomplete if one caller still ignores its promise.
- [ ] Write child-process contention tests: a panel hold/priority change while a worker finishes; a blocker resolution while the reviewer updates metadata; and two workers competing for the same attempt. Assert no lost decision and one execution owner.
- [ ] Add `recordVersion`, `applicationId` and execution metadata through an explicit migration function. Read version-zero legacy jobs compatibly; refuse unknown future versions. Preserve old timestamps/stages, attempts, audit paths, priorities and holds. A migration must not submit, requeue or downgrade a submitted record.
- [ ] Allocate a UUID attempt and exclusively create its directory. Keep the retry budget separately. Requeue must never reuse an old directory. Pin application ID and policy/source/procedure versions for the attempt.
- [ ] Implement compare-and-swap job updates under the existing lock idiom, applying narrow patches to the fresh record. Convert all local callers to await mutations; refresh state after a long-running worker before applying its final patch. Do not keep a job lock across browser execution.
- [ ] Run `node --test auto/test/learning-job-state.test.mjs`. Expected: old jobs round-trip with preserved fields, stale writes reject, and requeue creates a different audit directory without changing the earlier directory's hashes.

Required assertion:

```js
assert.notEqual(secondAttempt.attemptId, firstAttempt.attemptId);
assert.notEqual(secondAttempt.auditDir, firstAttempt.auditDir);
assert.equal(hashDirectory(firstAttempt.auditDir), originalAuditHash);
assert.equal((await loadCurrentJob()).held, true);
```

`hashDirectory` and `loadCurrentJob` are test-local helpers that operate only on fixture paths; define them in this suite. Do not infer an employer submission failed because an old audit directory is absent.

## T04. Normalize audit answers once and repair every consumer

**Create:** `auto/learning/evidence.mjs`, `auto/test/learning-audit-contract.test.mjs`, synthetic array/object/malformed fixtures.
**Modify:** `auto/apply-worker.mjs:verifyAudit`, `auto/diagnose.mjs:buildReport`, and relevant audit drill-down/digest readers.
**Produces:** `normalizeAuditAnswers(input) -> {entries,rejected}`.

- [ ] Inventory historical answer shapes without printing personal values. Support arrays of labeled answer rows, explicit section objects containing labeled/value rows, and the observed keyed section/value representation. Preserve section names and authoritative-source labels; reject ambiguous objects with a reason and source pointer.
- [ ] Create paired fixtures for every supported representation with identical logical fields. Include false, zero, an empty optional answer, a multiline response, missing source, an empty object, a malformed JSON file and a secret field. Define whether each is an observed question, reusable answer, or rejected import; these are different statuses.
- [ ] Implement normalization as a pure function. An unknown source becomes unverified, never `user_confirmed`. Do not parse a generic string object as a credential or approved personal fact. Secret entries must not leak through rejection messages.
- [ ] Replace independent iterations in diagnostics and capture with this function. Keep audit-shape validation and answer-reuse authorization separate. Keep existing PNG/PDF compatibility, while recording malformed or absent files as evidence gaps rather than declaring external failure.
- [ ] Run `node --test auto/test/learning-audit-contract.test.mjs`. Also run `node auto/apply-worker.mjs --self-test` and `node auto/diagnose.mjs --self-test` only after verifying their fixtures use temporary paths and cannot touch live controls. Expected: the object-form regression no longer crashes, and existing accepted inputs still render.

```js
const normalized = normalizeAuditAnswers({Contact:{Email:{value:'sample@example.invalid',source:'profile'}}});
assert.equal(normalized.entries.length,1);
assert.equal(normalized.entries[0].label,'Email');
assert.doesNotThrow(()=>buildReport([fixtureAttempt(normalized)]));
```

The suite defines `fixtureAttempt` using the normalized contract expected by the updated diagnostics consumer. Do not change the existing historical files merely to make a test pass.

## T05. Backfill history with a repeatable migration manifest

**Create:** `auto/learn.mjs`, backfill/capture functions in `evidence.mjs`, `auto/test/learning-backfill.test.mjs`.
**Consumes:** known application/audit paths, question parsers, normalized answers, protected store.
**Produces:** `captureAttempt`, `backfillHistory`; CLI `inspect`, `backfill`, `rebuild`.

- [x] Implement read-only discovery that enumerates actual audit directories, report sections and source metadata. Restrict resolved paths to approved roots, refuse symlink escapes, cap bytes, and skip an in-progress artifact until its write is settled. Do not reconstruct overwritten history from timestamps alone.
- [x] Produce a manifest with source relative path, bytes/hash, import adapter/version, linked job/attempt identity, settled status and coverage gaps. A dry run writes only an explicitly requested report artifact; it never writes the canonical learning store or invokes an LLM.
- [x] Implement `backfill --apply --manifest <path>` that verifies hashes/root identity and creates idempotent observations. Source changes since preview require a refreshed manifest. Keep every rejection/missing link visible in a summary; no silent skipping.
- [x] Reuse `parseApplicationAnswersSection` and `parseDraftAnswersBlockH` for recognizable reports. A missing section is absent data, not a parser success with assumed questions. Imported generated drafts are never observed employer questions unless separate source evidence establishes that.
- [x] Test crash after part of a batch, rerun, duplicate sources, one overwritten legacy directory, a missing audit, a live-changing file, an array/object mix, and a report with no answers. Assert resumed imports add only remaining records, do not duplicate company/job counts, and leave original artifacts unchanged.
- [x] Run `node --test auto/test/learning-backfill.test.mjs`; then preview a read-only real manifest if permitted. Do not run the apply command against live data before T27's activation gate.

CLI contract to implement:

```bash
node auto/learn.mjs inspect --json
node auto/learn.mjs backfill --dry-run --out "$SCRATCH_ROOT/backfill-preview.json"
node auto/learn.mjs backfill --apply --manifest "$SCRATCH_ROOT/backfill-preview.json"
node auto/learn.mjs rebuild --verify
```

All fixture commands set `CAREER_OPS_ROOT="$SCRATCH_ROOT"` before invocation. The suite must first assert the variable names the helper-created temporary directory, never the real checkout.

## Phase 1 review gate

- [ ] Nonempty source fixtures produce nonempty observations; the system distinguishes no data from unreadable data.
- [ ] Second import is idempotent and crash recovery preserves accepted records.
- [ ] Credentials and unknown sources cannot become approved memories.
- [ ] No audit overwrite, lost queue change, model call, browser action, or live data mutation occurred in testing.
- [ ] Record test commands, hashes/manifests, the caller-migration list, and remaining historical coverage gaps. Proceed to Phase 2 only after these checks pass.
