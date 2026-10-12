# Apex Council delivery result — career-ops

Date: 2026-10-12 · Branch: `learning-system` · Commits: `63545fa5` (delivery), `759f3b32` (session log) — **not pushed** (per user directive).

## Verdict

Delivered and live-verified. Independent council-reviewer **REVIEW_PASS** after 3 delta rounds (15 original findings → all fixed or explicitly deferred below). Test suite 449/449. Pipeline resumed and one live cycle verified end-to-end, including learning shadow capture.

## Delivered (verified)

### Tier 0 — defect fixes
- **T0.1 eval score bug + queue audit**: 0.0-score parse bug fixed; indented `Score:` fallback regex; `auto/eval-score-audit.mjs` audit tool. Pinned in `auto/test/eval-score.test.mjs`.
- **T0.2+T0.3 dispatch gate** (`auto/dispatch-gate.mjs`, new): duplicate / decline / cooldown / employer-cap (≥2) pre-dispatch gate across `auto_jobs` + full submitted-lifecycle tracker statuses. Dry-run and parkViolations use the identical snapshot loader. **Live evidence**: gate parked fox (already-applied, stage=submitted) on the first resumed cycle.
- **T0.x unknown-outcome retry guard** (`auto/apply-worker.mjs` + `auto/state.mjs`): unknown-outcome verdicts route to `failed` — no silent auto-retry that could double-submit.
- **T0.4 credential redaction + cost telemetry**: `redactPromptForAudit` fails closed; structural `password:` line scrub runs unconditionally (stale credentials scrubbed even when the store has only unrelated passwords). `auto/lib/usage-parser.mjs` + `auto/cost-report.mjs`; `verdictAt` anchors the daily-cost chain. `auto/scrub-prompt-credentials.mjs` retro-scrubs existing audits.
- **T0.5 answer-store fixes**: `auto/answers-lint.mjs` + store corrections (145 keys); user-confirmed phrasing variants committed earlier (73ff1c2a).

### Tier 1 — outcome loop
- **`auto/outcome-brief.mjs`** (new): weekly outcome brief joined to the auto-submitted cohort via canonical `normalizeUrl` from `url-key.mjs` (preserves `gh_jid`; `''` never matches `''`; raw fallback for hash-style keys).
- **`auto/reply-ingest.mjs`** (new): pasted-email ingestion + tracker-rot rejection proposals with stable content-derived `message_id`s, `signal:'rejection'` for correct classification, content-hash dedup, corrupt-file refusal, write-then-rename.

### Wave 2 — teaching digest / park-drain / monitoring
- **`auto/digest.mjs`**: honest backlog (9 unranked auto_jobs + 2662 pipeline inbox, no conflation), submitted vs not-submitted fallback split (34/22), variant proposals computed from submitted-only cohort, park-drain section, decisions-needed section.
- **`auto/panel.mjs`**: stale-activity alarm uses `max(run.log mtime, freshest job updatedAt)` — manual background runs no longer trip false alarms. Panel restarted under launchd; new code live on :3001 (serves `learningReview` status field).

### T2.1 — learning shadow activation
- `config/learning.yml`: `enabled:true mode:shadow`. Mode schema (shadow|active|off) is real: fail-closed config (invalid config throws at cycle start), `mode:active` refuses jobs, rollback = `enabled:false`.
- **Live evidence (toast attempt 08ae5ca8, 2026-10-12 09:51Z)**: codex submitted ok → `learning shadow capture — coverage=incomplete answers+17 dup=0 rejected=0` → tracker synced → stage=submitted. Capture ran strictly after `verdict.json`; verdict untouched. Store: 11+ observation records, 1 syncTask, `capture-summary.json` per attempt; `learn.mjs metrics` reports 17 drafted questions; `learn.mjs rebuild --verify` → `verified:true, errors:[]`.

## Deferred (explicit, not silently dropped)

| Item | Why deferred |
|---|---|
| #9 follow-up actionability filtering | Scope — follow-up cadence owned by parallel DB-migration effort |
| #10 diagnose.mjs park-drain integration | Low value until park-drain patterns stabilize |
| #14 poll-dependent stale notification | Needs push channel decision (user) |
| Plan tail: scheduled reply ingestion, weekly golden eval, archetype/ATS/score-band outcome rates, panel confirmation flow | Wave 3; outcome loop must accumulate data first |
| T2.1 **active** mode (D01–D07) | **User-gated** — do not activate without explicit approval |
| F4 counting basis | Known limitation, documented in code comment |
| Backfill `--apply` | Dry-run manifest only (150 entries/134 jobs); expect `coverage=incomplete` until run |

## Known limitations
- Interrupted-attempt capture is active-mode-only; broken learning config crash-loops the watchdog (harmless, visible).
- `data/auto/run.log` is launchd stdout only; manual background runs never write it — query `data/career-ops.db` (`auto_jobs`) for truth.
- Cloud deploy blocked by `npm ci` cert failure (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) — pre-existing, out of scope.
- riotgames failed ×2 (`confirmation_text empty`) — terminal by design; panel force-requeue is the only re-entry.

## Integration risk
A parallel DB-migration effort (worktrees `career-ops-db`, `db-migration`, uncommitted) converts `state.mjs`/web/trackers to DB. Our commits touch `state.mjs`, `run.mjs`, `panel.mjs`, `apply-worker.mjs` — **rebase/merge carefully at their cutover**; their re-migration must happen after our commits land in their base.

## Learnings
1. **Review rounds converge when fixes are repro-verified**: every round-2/3 fix was reproduced failing first, then fixed, then re-run — 3 rounds to PASS with zero regressions (449/449 throughout).
2. **Fail-open redaction was the sharpest finding**: a redaction path gated on "did we already redact something" silently leaked stale credentials. Redaction fallbacks must be unconditional.
3. **Dry-run/prod gate parity matters**: the dry-run gate using a different data loader than prod produced false confidence; both now delegate to one snapshot loader.
4. **Synthetic compat records need explicit signals**: tracker-rot proposals without rejection keywords classified as Unknown; `signal:'rejection'` beats keyword inference for records we fabricate ourselves.
5. **Test invocation**: `node --test auto/test/*.test.mjs` (explicit glob) — bare directory invocation fails spuriously.
6. **Never run `node auto/panel.mjs --self-test`** against a live deployment — it consumes the live pause flag.
7. Panel is launchd-managed (`io.career-ops.panel`); `launchctl kickstart -k gui/$UID/io.career-ops.panel` restarts it cleanly to pick up code changes.

## Outstanding user decisions (from digest "Decisions needed")
Push channel, scan cadence, 4 standing-answer prompts, resume variants (Principal IC ×26, CTO/VPE ×9), password rotation (39 hosts), mailbox automation scope, full learning activation (D01–D07).
