# Apex Council — proactivity/blind-spot assessment (2026-10-11T22:08Z)

Objective: complete functionality analysis of career-ops; recommendations to make
the system more proactive (solve unasked, teach the user, expose blind spots);
compiled + prioritized list across five independent models.

Phase: ASSESSMENT (read-only, independent, in progress)

## Assessor sessions (background Task IDs)
| Model | Agent type | task_id | Status |
|---|---|---|---|
| GPT-6 Astra (US) | council-assessor-astra | ses_ed2fd0accffeMws3yY2cb21IkN | running (resumed; first launch rejected: data retention mode unavailable on unsuffixed Astra endpoint) |
| Fable 5 via Bedrock Mantle (bedrock-fable) | council-assessor-fable | ses_ed2fcd752ffelulb61mS3ZSQLd | running (Fable 5.1 unsuffixed/US/Global all rejected: data retention mode 'default' unavailable; fell back to latest reachable fable) |
| Claude Opus 4.8 | council-assessor-opus | ses_ed2fca3c6ffegFF6vSOxu0Btzs | running |
| GLM-5.3 (US) | council-assessor-fable (model override) | ses_ed2fc7047ffea3eQYlIXNZ0Vuv | complete (2026-10-11T22:25Z) |

All five assessments complete. Converged plan: PLAN.md (2026-10-11T22:30Z).
| Kimi K3 (US) | council-assessor-opus (model override) | ses_ed2fc37bcffepNWHjcb4odU4df | running |

All on amazon-bedrock. Same objective + factual repo map given to each; no peer
conclusions shared. Deliverable per assessor: functionality analysis, proactivity
gaps, teaching gaps, blind spots, ranked recommendations w/ benefit-effort-risk,
evidence, confidence, uncertainties; ends ASSESSMENT_COMPLETE.

## Next steps
1. On results: compare findings, cross-examine material disagreements with
   evidence (resume via task_id only for substantive challenge).
2. Converge → .apex/council/PLAN.md (ranked, evidence-backed, with deliberate
   non-fixes and unresolved disagreements).
3. Present compiled priority list to user.

## Context carried from coordinator session
- Live pipeline running (pid 64139); checkpoint 19 wakeup scheduled ~01:52Z.
- Learning plan: T27 activation + T28 live journey remain, user-gated (D01–D07).
- run.log stale; DB (data/career-ops.db) is monitoring source of truth.

## Delivery workers (wave 1, launched 2026-10-11T22:57Z)
| Worker | Scope | Task ID |
|---|---|---|
| A | T0.1+T2.5 eval gate fix + queue audit (eval-queue.mjs) | ses_ed2d0e809ffereb779uyCX1FDp |
| B | T0.2+T0.3 dispatch gate + retry guard (state/run/panel) | ses_ed2d08e08ffevXnsJkkUrGIrFK |
| D | T0.4+T2.4 credential redaction + cost telemetry (apply-worker) | ses_ed2d03aaeffe9hCXv02wq83a9A |
| E | T0.5 standing-answers fixes + lint | ses_ed2cfffadffexh9z1l5akm4jm3 |
| F | T1.1 outcome loop (seeding, reply-ingest, brief) | ses_ed2cf9c7dffe4fOM7FBC9eGaPM |

Wave 2 (after wave 1): Worker C — T1.2+T1.3+T2.2+T2.3 digest/notify/park-drain/monitoring.
Then: T2.1 learning shadow activation; council-reviewer; resume pipeline; commits.
Pipeline paused 22:55Z (pause-requested + desired-cycle running:false). In-flight fox apply draining.

## Wave 1 status (2026-10-12T06:30Z)
- A, E, F: completed with reports; coordinator-verified (E needed corrections — see PLAN notes).
- B, D: sessions WEDGED (busy ~7.5h, no final report/board post). Deliverables
  coordinator-verified directly from disk and ACCEPTED:
  - B: dispatch-gate.mjs wired (run.mjs:38/:308), state.mjs unknown-outcome guard,
    panel.mjs requeueJob force/warning (panel.mjs:233-292), 9/9 tests.
  - D: redactPromptForAudit in apply-worker, accounts.json 600, cost-report.mjs runs
    (0/158 attempts have usage data yet — forward-looking), scrub grep-zero 162/162 clean.
  Do NOT relaunch B/D tasks; treat as done. Their sessions may emit late reports — reconcile only if contradictory.
- 07:27Z: B's session errored out ("Network connection failed") — root cause of the wedge. Not resumed; work already verified. D likely wedged the same way; same policy.
- 08:08Z: confirmed — D's session errored the same way ("Network connection failed"). Not resumed; deliverables were verified from disk at 07:2xZ. Both wave-1 wedges were network failures, not work failures.

## Wave 2 (launched 2026-10-12T07:30Z)
| Worker | Scope | Task ID |
|---|---|---|
| C | T1.2+T1.3+T2.2+T2.3 digest/park-drain/monitoring + brief label fix | ses_ed0fc98deffemA3MF7eaut4EHD |

T2.1 learning shadow activation deliberately serialized AFTER C (both may touch run.mjs cycle-end). Then council-reviewer → resume pipeline → commits → RESULT.md.

- 07:45Z Worker C ACCEPTED with coordinator fix: C keyed the stale-activity alarm on
  run.log mtime, but run.log only moves under launchd (stdout redirect) — manually
  launched cycles never touch it → permanent false alarm post-resume. Coordinator
  added lastActivityIso() to panel.mjs (max of run.log mtime and freshest
  auto_jobs updatedAt) and rewired both payloads. Verified: 9/9 tests, live signal
  reads DB timestamp 23:01Z. Everything else verified as reported (9/9 + 23/23
  self-test, dry-run digest inspected, run.mjs wave-1 edits preserved).

## Wave 3 (launched 2026-10-12T07:40Z)
| Worker | Scope | Task ID |
|---|---|---|
| G (council-specialist) | T2.1 learning shadow activation | ses_ed0f1b83cffe7WagDl4EvzpwsO |

- 07:51Z Worker G COMPLETE + coordinator-verified (430/430 tests, run.mjs integrity,
  config inspected). Justified deviation: did NOT wire an executor into run.mjs —
  only test fakes exist, and an injected executor = active mode. Instead made the
  schema's `mode: shadow|active|off` real: config/learning.yml enabled:true
  mode:shadow; apply-worker resolveLearning() fail-closed (invalid config throws
  unless enabled:false parses); shadow capture after verdict.json, try/catch,
  never alters verdicts; run.mjs logs `run: learning mode=shadow`. mode:active
  stays user-gated (D01–D07). Known limits: interrupted-attempt capture is
  active-mode only; live panel on old code until restart; broken config now
  crash-loops the watchdog (quick, harmless — fix file or set enabled:false).
  Post-resume checklist is in G's report (shadow capture log lines, no
  tool_unavailable, records under data/auto/learning/, learn.mjs metrics).

## Review (launched 2026-10-12T07:55Z)
- council-reviewer ses_ed0e53b20ffeXlppCrZAQV43Ed reviewing full uncommitted
  delivery (read-only). Then: commit on learning-system → resume pipeline
  (desired running:true + bg `node auto/run.mjs --skip-scan`) → verify one
  shadow cycle → .apex/RESULT.md.
- 08:00Z REVIEW_FAIL: 3 P1 + 12 P2 findings. Triage:
  - FIXED by coordinator: #15 eval stdout fallback regex (`^\s*Score:`), 7/7 tests.
  - Worker H ses_ed0dddf99ffeFdztzwBb5vZ178 (safety): #1 unknown-outcome auto-retry
    (applying-stage reselection), #2 gate only loads status='Applied', #3 redaction
    fails open w/o accounts.json, #4 employer cap off-by-one. Owns state.mjs,
    dispatch-gate.mjs, apply-worker.mjs(redaction) + tests.
  - Worker I ses_ed0dd9ba6ffegU4C9pS4x94mFI (reporting/ingest): #5 reply schema
    compat, #6 dedup identity, #7 overwrite-on-corrupt, #8 outcome cohort join,
    #11 pipeline_items backlog, #12 fallback-shipped split, #13 verdictAt cost.
    Owns reply-ingest.mjs, outcome-brief.mjs, digest.mjs + tests.
  - DEFERRED (documented limitations, to RESULT.md): #9 follow-up actionability,
    #10 diagnose.mjs park-drain integration, #14 poll-dependent stale notification,
    plus undelivered plan tail (scheduled ingestion, weekly golden eval,
    archetype/ATS outcome rates, panel confirmation flow).
  - Re-review (delta) via reviewer task_id after fixes land. Resume pipeline only
    after P1s verified fixed.
- 08:07Z Worker H COMPLETE, coordinator-verified: F1 finalizeVerdict routes
  unknown-outcome → failed (regex synced w/ state.mjs guard); F2 gate loads all
  submitted-lifecycle statuses; F3 redaction fail-closed (fallback ^password:
  line scrub matches the only credential format, apply-worker.mjs:65); F4 cap
  >= 2 incl. candidate. 15/15 gate tests.
- 08:11Z Worker I COMPLETE, coordinator-verified: F5 legacy schema fields +
  stable pasted::<sha1-16> message_id; F6 content-hash dedup; F7 corrupt file
  throws + write-then-rename; F8 normalized-URL cohort join; F11 digest shows
  9 unranked + 2662 pipeline inbox; F12 fallback split 34 submitted / 22 not;
  F13 verdictAt in cost chain. Full suite 448/448 (430 + 18 pinning tests).
  Verified in actual /tmp/digest-2026-10-12.md output.
- 08:12Z Delta re-review launched (reviewer session resumed,
  ses_ed0e53b20ffeXlppCrZAQV43Ed).
- NOTE: a parallel DB-migration effort (board root "main") is converting
  auto/state.mjs, web/, trackers to DB in separate worktrees (career-ops-db,
  db-migration). Uncommitted there; this checkout unaffected. Integration/rebase
  risk at their cutover — our commits touch state.mjs/run.mjs/panel.mjs/apply-worker.mjs.

## 2026-10-12 08:25Z — Coordinator: delta-review round 2 fixes
Delta re-review #1 (ses_ed0e53b20ffeXlppCrZAQV43Ed) returned REVIEW_FAIL with 6
remaining findings (1 P1). Coordinator fixed all six directly:
- P1 redaction: structural `password:` line scrub now runs UNCONDITIONALLY in
  redactPromptForAudit (apply-worker.mjs) — a store with unrelated passwords no
  longer suppresses the fallback. Repro verified + new F3 pin test.
- P2 dryRunGate/parkViolations: default loader now uses the same
  SUBMITTED_TRACKER_STATUSES filter as loadGateData (dispatch-gate.mjs).
  Repro: Rejected row parks in both prod and dry-run.
- P2 scanTrackerRot: both branches now emit message_id/from/subject/body_snippet
  via trackerRotCompatFields() (reply-ingest.mjs). Repro: fields present+stable.
- P2 unmatched dedup: key uses message_id (content-derived) with body_snippet
  fallback, never evidenceSnippet. Repro: two same-sender rejections both kept.
- P2 outcome join: canonical normalizeUrl from url-key.mjs (preserves gh_jid),
  '' never matches '', raw fallback for hash-style keys (outcome-brief.mjs).
  Repro: ?gh_jid=111 vs 222 no longer conflate (1 submitted/1 matched/0 rej).
- P3 digest variant proposals: proposeResumeVariants(fbSubmitted) — parked-only
  fixtures no longer claim "shipped default" (digest.mjs).
Full suite: 449/449 (448 + 1 new P1 pin). Delta re-review #2 requested.

## 2026-10-12 09:40Z — Coordinator: round 3 fix + REVIEW_PASS + resume
- Delta re-review #2 returned REVIEW_FAIL with 1 remaining P2: tracker-rot
  proposals classified `Unknown` because classifyReply saw no rejection keywords
  in synthetic snippets. Fix: trackerRotCompatFields() now also emits
  signal:'rejection' (reply-ingest.mjs), which classifyReply honors ahead of
  keywords. Repro verified through real scanTrackerRot -> classifyReply path:
  propose branch -> Rejected, update branch -> Rejected. Suite 449/449.
- Delta re-review #3 (ses_ed0e53b20ffeXlppCrZAQV43Ed): REVIEW_PASS. Fix verified
  at reply-ingest.mjs:82 (shared by both branches); adjacent pasted-message
  behavior intact (signal stays null, Rejected/Interview/Auto-confirmation
  classification unchanged).
- All delivery work committed on learning-system: 63545fa5 (no push, per user
  directive).
- Pipeline resumed: desired-cycle.json running:true, cycle started in background
  (node auto/run.mjs --skip-scan). Early live evidence: `run: learning
  mode=shadow` logged; dispatch-gate parked fox (already-applied) — duplicate
  gate working live; toast Staff SWE GTM&AI submit attempt in flight.
- Next: verify one full shadow cycle per Worker G checklist, then .apex/RESULT.md.

## Follow-up delivery wave (2026-10-12, post-RESULT)
- Task A reuse bridge (council-builder): ses_ecfe80e80ffed5T7MSHiHGsNgr
- Task B mail-sync (council-builder): ses_ecfe7b5a1ffegQoGwzISJJCNEE
- Task C resume drafts (council-builder): ses_ecfe78427ffe5qYA2G3LGrNPLF
- Done directly: branch pushed; standing answers/facts in config; 8 parks requeued; Mon+Thu scan via io.career-ops.auto-scan.plist
