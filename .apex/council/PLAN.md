# Apex Council — Converged Plan (2026-10-11)

Objective: assess career-ops for proactivity, teaching, and blind spots; compile and
prioritize recommendations across five independent models.

Council: Opus 4.8, GPT-6 Astra, Fable 5.1, GLM-5.3, Kimi K3 (all amazon-bedrock,
independent read-only sessions; IDs in SESSIONS.md; summaries in assessments/).
Coordinator verification of material claims in VERIFICATION.md (V1–V4 all confirmed).

Consensus method: findings ranked by (a) cross-model agreement, (b) coordinator-verified
evidence, (c) benefit vs effort vs risk against the user's stated goals (proactive,
teaching, blind spots). Agreement never treated as proof — every Tier 0/1 item below is
anchored to verified artifacts, not model consensus alone.

---

## Converged findings (what all/most models independently found)

| # | Finding | Models | Evidence class |
|---|---------|--------|----------------|
| F1 | Eval score-extraction defect: unanchored regex hijacked by model think-block "Confidence Score: 5/5"; real scores (markdown `**Score:**`, yaml lowercase) never match. 43 reports mis-queued at 5/5; 17 real-score <4.0; **9 SUBMITTED** (2.5–3.8 real) | Astra (unique find) | VERIFIED (VERIFICATION.md V1; eval-queue.mjs:154; reports/2490; run.log:1508-1582) |
| F2 | No outcome loop: 91 submissions, zero follow-up seeds, zero reply ingestion, zero interviews/rejections recorded; Gmail rejections rot in notes with status still "Applied"; all analytics (calibrate/funnel/salary-gap) run on outcome-less data | ALL 5 | Verified structure (workflow.mjs:938 Applied-only; followup-seed unused in auto/; reply-candidates.json absent) |
| F3 | No duplicate/decline/cooldown gate: re-applied after human decline (1password, apartmentiq); ~14 queued moniepoint rows for 2 roles; bedrock-robotics burned 3-month cooldown via blind retry; dnb same req parked twice from 2 URLs | ALL 5 | VERIFIED (V2, V3) |
| F4 | Unknown-outcome retry = double-application risk TODAY: real submissions marked failed on empty confirmation (jci/gilead, apply-worker.mjs:246-247); failed→queued legal; T14 guard keys on execution.submissionPossible which only the dark learning layer sets; panel Requeue button has no warning | ALL 5 | Verified structure (state.mjs:56,263-267) |
| F5 | Plaintext credential exposure: accounts.json + full SAVED_CREDENTIALS block persisted in every audit dir's prompt.md (~37 employer accounts across ~90+ dirs) | 4/5 (Astra, Fable, Kimi, Opus) | Verified (apply-worker.mjs:286; output/*/prompt.md) |
| F6 | Parked backlog (~70) never feeds back: diagnose.mjs computes exactly the right "standing-answer candidates" aggregation but is manual-only, surfaced nowhere; same facts park job after job; biggest single park category is "JD unavailable via API" (13/20 on 10-11) — a data-acquisition failure, not a human-decision failure | ALL 5 | Verified (diagnose.mjs:68-155; digest-2026-10-11.md) |
| F7 | Learning subsystem (29 tasks, 409 tests — the literal implementation of anticipate/learn/resume) built but dark; activation is NOT a flag flip: production runApply caller supplies no executor (run.mjs:300 vs apply-worker.mjs:395,482-489); malformed config silently downgrades to disabled | ALL 5 (caution: Astra, GLM) | Verified structure |
| F8 | Answer-store defects: standing-answers.yml:150 hardcoded stale date "2026-10-05" (submitted on 10-06..10-11 apps); :173 pace-of-work → "Yes"; :165 job level "Senior individual contributor" vs Director/Head positioning | Fable (unique find) | VERIFIED (V4) |
| F9 | No durable push channel: digest = file + ephemeral macOS osascript toast; parked jobs never re-surface after day 1; user absent by design | ALL 5 | Verified (digest.mjs:77-82) |
| F10 | Monitoring gaps: run.log stale while cycle alive (user hit this); lastActivityAt computed but never judged (panel.mjs:527-539); watchdog checks PID only; discovery frozen (desired-cycle skipScan:true permanent); launchd cadence disabled | ALL 5 | Verified |
| F11 | Resume-variant fallback silent: ~40-50% of applies ship the default "Head of AI Strategy & Adoption" CV (incl. Principal ML Engineer, CTO roles); resumeNote recorded but surfaced nowhere; variants differ mainly in headline | 3/5 (Astra, Kimi, GLM) | Verified (run.log:1525-1561; digest.mjs:47-54) |
| F12 | No cost telemetry despite <10¢/apply directive: verdict.json has no token/cost fields; target unverifiable; Sonnet fallback attempts are the expensive unmeasured tail | 4/5 | Verified |
| F13 | Backlog economics: 2,669 pending pipeline rows vs 20 evals/cycle — supply bottleneck, not the 100/day apply cap (~31/day actual) | 2/5 (Kimi, GLM) | Verified (run.log:37) |
| F14 | Strategic volume-vs-quality contradiction: Director/Principal search run as volume funnel; profile targets span Head-of-AI down to Account Manager; same-company multi-role sprays; referral/outreach machinery (contact-lookup, linkedin-join, radar outreach_angle) built but unwired; zero interview-prep sessions | ALL 5 | Verified structure + strategy hypothesis |
| F15 | Eval gate fragility beyond F1: single local model (gemma-4-e4b) gates 100% of submissions; silent fallback body-parsing (eval-queue.mjs:157-166); score instability on re-eval (pivotal 2→4.8, bmo 4.7→4); eval-golden.mjs calibration never scheduled | 3/5 (Astra, Kimi, GLM) | Verified + examples |

---

## Ranked delivery plan

Effort: S < 0.5 day, M = 0.5–2 days, L > 2 days. All code changes to live pipeline files
(run.mjs, apply-worker.mjs, state.mjs, eval-queue.mjs, panel.mjs) require the durable
pause protocol first (pause-requested + desired-cycle running:false; resume after).

### TIER 0 — verified live defects (correctness & safety; do first)

**T0.1 Fix eval score extraction + audit mis-scored queue** (F1) — builder, S
- Files: auto/eval-queue.mjs (:150-172). Prefer yaml trailer (case-insensitive, anchored);
  accept markdown `**Score:**`; strip think blocks before regex; log score provenance.
- Also: one-shot audit script re-deriving real scores for all stored-5/5 jobs still in
  queued/parked; park any real-score <4.0 with reason `score-correction`.
- Acceptance: reports/2490-class fixture parses 3.8 not 5.0; existing correct reports
  unchanged; queue audit report produced. Verification: targeted regression test with the
  Carrier report body + 2 correct-format bodies; re-run parse over all 43 affected reports.

**T0.2 Pre-dispatch identity gate: duplicates, declines, cooldowns, employer caps** (F3) — builder, M
- Join auto_jobs + applications (DB) before dispatch: park as `already-applied` /
  `declined-cooldown` / `employer-cap` instead of applying. Fingerprint =
  company + normalized role (+ req ID when extractable), not URL.
- Acceptance: apartmentiq/1password class blocked; moniepoint cluster collapses to ≤2;
  bedrock-robotics class (cooldown) parked pre-dispatch. Verification: dry-run over
  current queue shows expected parks; one targeted test per rule.

**T0.3 Unknown-outcome = non-retryable for legacy jobs + Requeue warning** (F4) — builder, S
- Treat empty/failed confirmation as submissionPossible for ALL jobs (not just
  learning-written ones); panel Requeue on such jobs requires explicit confirm.
- Acceptance: riotgames/jci/gilead-class jobs cannot silently requeue. Verification:
  state transition test + manual panel check.

**T0.4 Credential exposure remediation** (F5) — builder, S + user decision
- Stop persisting SAVED_CREDENTIALS into audit prompt.md (redact at write); chmod 600
  accounts.json; scrub existing output/*/prompt.md copies.
- USER DECISION: rotate the ~37 ATS passwords (recommended; they are duplicated across
  ~90 world-readable files on disk).
- Verification: grep output/ for password strings → zero; new apply writes redacted prompt.

**T0.5 Answer-store corrections + lint** (F8) — mechanic, S
- Fix :150 (compute date at fill time or remove), :173 (real pace answer — ask user),
  :165 (align level with Director/Head positioning — ask user); add a lint that flags
  yes/no answers bound to free-text questions and hardcoded dates.
- Verification: lint passes; user confirms the two fact answers.

### TIER 1 — the sensing loop (highest strategic value; the "proactive + teaching" core)

**T1.1 Outcome ingestion + follow-up seeding + weekly calibration** (F2) — builder, M
- Seed follow_up_next on every auto-submit (reuse followup-seed core from
  executeTrackerSync); scheduled reply ingestion propose-only (paste-reply now;
  mailbox automation = explicit USER DECISION on privacy scope); weekly outcome brief:
  response rate by archetype/ATS/score band, follow-ups due.
- This unlocks calibrate.mjs/threshold tuning (F15) — without outcomes the search is
  unmeasurable and every other improvement unprovable.

**T1.2 Park-drain loop: surface diagnose.mjs + standing policy decisions** (F6) — builder, S-M
- Run diagnose aggregation at cycle end; digest/panel section "Answer these N questions
  to unlock M parked jobs" with proposed custom.* YAML (approval-gated; restricted
  questions excluded). Include the four deferred policy prompts: EEO-when-no-decline,
  quirky culture questions, non-USD OTE, attestations.

**T1.3 Durable push channel + teaching digest** (F9, F11, F12, F13) — builder, M
- One channel (email or Telegram — USER DECISION); digest extended with: park Pareto,
  resume-fallback list, per-ATS success/park rates, backlog economics line, cost/day,
  score-correction audits, parked-job aging (re-surface, don't rot).

### TIER 2 — activation & quality

**T2.1 Learning activation as a bounded integration task** (F7) — specialist, M (NOT S)
- Consensus rank #1 for Fable/GLM; Astra/GLM evidence shows it is an integration task:
  wire executor into production runApply call path, make malformed-config fail-closed,
  Neo/CDP preflight debugging window, backfill, panel restart (D01 pause protocol),
  shadow mode ≥1 full cycle before active. Gated on T0.4 (don't widen a credential-
  leaking pipeline) and user approvals D01–D07.
- Activating T14's guard also permanently fixes F4 beyond the T0.3 stopgap.

**T2.2 Resume-variant coverage + honesty** (F11) — builder, S
- resumeNote in digest; "below-floor match" daily line; propose 2-3 new variants for
  recurring unmatched families (Principal IC, public-sector/CTO) — content = USER review.

**T2.3 Self-monitoring + cadence** (F10) — mechanic, S
- Stale-activity alarm (lastActivityAt > 2h while running → notify via T1.3 channel);
  explicit scan cadence decision (skipScan currently permanent — USER DECISION);
  heartbeat line in status.

**T2.4 Cost telemetry** (F12) — mechanic, S-M
- Parse usage from codex-output.txt per attempt into verdict.json; aggregate in
  analytics; digest cost line. Validates the <10¢ directive.

**T2.5 Eval robustness** (F15) — mechanic, S
- Schedule eval-golden.mjs weekly; log score provenance (which parse rung fired);
  flag re-eval deltas >1.5 for human eyes. Threshold recalibration only after T1.1
  produces outcomes.

### TIER 3 — strategy (user decisions, system support)

**T3.1 Targeting reconciliation** (F14) — USER DECISION, council-supported
- Present per-company application counts + level spread; recommend: trim profile.yml
  target list to the actual Director/Head thesis, same-company cap (≤2 live), and
  re-weight effort toward the built-but-unwired referral lane (contact-lookup +
  radar outreach_angle drafts, propose-only). Volume is cheap but at this level
  likely counterproductive — flagged by all five models; it remains a strategy
  call, not a defect.

**T3.2 JD-unavailable browser-fetch rung** (F6 biggest cluster) — builder, M, USER POLICY
- Add browser-backed JD fetch (worker Playwright or Neo task) after 3 API strikes
  instead of parking. Requires user confirmation that eval-time browser fetch is
  within browser policy. Drains the largest park category.

**T3.3 Backlog economics** (F13) — defer until T0.1 lands
- Do NOT raise eval throughput while the gate mis-scores (would amplify F1). After
  T0.1 + T2.5: consider limit_per_cycle 20→50 + parked-liveness sweep. Surface the
  2,669-row backlog number in the digest either way.

---

## Deliberately NOT doing (consensus)
- Cloud Lambda/Bedrock reviewer activation (local deterministic review sufficient; also
  blocked by npm cert issue). Revisit only if local reviewer under-produces.
- Raising the 100/day apply cap (volume is not the constraint; quality is).
- Full Gmail mailbox automation without explicit opt-in (privacy line — paste-reply +
  propose-only ingestion first).
- Deterministic per-ATS form fillers (correctly rejected by original plan).
- Embedding-based resume matcher (Jaccard + more variants is proportionate).
- Broad new test suites (user directive: lean testing; 409 learning tests exceed bar).
- Privacy/erasure automation (preview-only is the right state).
- Panel auth hardening (localhost-only, single-user machine — Kimi raised, council
  deprioritized as not value-bearing now).

## Unresolved disagreements (recorded honestly)
1. **Learning activation effort**: Fable/GLM scored S ("flip + restart"); Astra's code
   evidence (missing executor wiring, fail-open config) says M. Converged to M; the S
   estimate is contradicted by run.mjs:300 call-path inspection.
2. **Mailbox ingestion**: Kimi/Fable favor automated Gmail reading; GLM calls it a
   privacy line requiring deliberate opt-in. Converged: propose-only + user decision.
3. **Throughput**: Kimi recommends raising evals/cycle now; Opus/Astra warn against
   volume. Converged: sequence it behind the eval-gate fix (T3.3).
4. **Kimi claim not reproduced**: that riotgames parked on a question standing-answers
   already covers (:57). Not verified; folded into T1.2's matcher review rather than
   asserted as fact.

## Static-review limits
This was a static assessment plus targeted runtime verification (V1–V4). Not executed:
full parked-reason DB distribution, per-company application counts, codex usage-line
feasibility for T2.4, panel process age. These are first delivery tasks where relevant.
No claim is made that every behavior was inspected.
