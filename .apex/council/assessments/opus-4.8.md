# Assessor: Claude Opus 4.8 (council-assessor-opus, ses_ed2fca3c6ffegFF6vSOxu0Btzs)
Received 2026-10-11T22:13Z. Verbatim summary of ranked recommendations; full text in session transcript.

Scope note (self-declared): no shell access — all SQLite/status probes are unexecuted
runtime checks; pipeline counts taken from brief.

## Key findings
1. Core pipeline solid (CAS state machine, audit-gated transitions, model ladder).
2. Value leaks: parks are a dead end (diagnose.mjs aggregates standing-answer
   candidates at diagnose.mjs:132-147 but is manual-only, nothing feeds back);
   exact-phrasing parks never re-matched against existing standing answers;
   the whole learning subsystem is built but flag-off.
3. Proactivity: all analytics pull-only; digest = ephemeral osascript only
   (digest.mjs:77-82); watchdog restarts dead cycles but no liveness alarm for
   stuck-alive; no discovery-time dedup across Workday subdomains.
4. Teaching: deriveLearningMetrics (intelligence.mjs:704-1004), funnel-velocity,
   calibrate, upskill, salary-gap, per-ATS advance — all computed, never shown.
   knockout_risk recorded per application but never aggregated ("you keep
   applying into roles where you fail a hard requirement").
5. Blind spots: volume-vs-quality contradiction with AGENTS.md:422-427 (Director/
   Principal hiring is referral-driven; no outcome measurement of the 91 submits);
   derived-unverified claims auto-submitted at scale (standing-answers.yml:91-175,
   consistency liability); plaintext ATS passwords accumulating in
   data/auto/accounts.json (apply-worker.mjs:69-81); with learning OFF the legacy
   post-launch-timeout edge marks failed→requeueable (apply-worker.mjs:639-640) —
   the riotgames empty-confirmation case is this risk surface.

## Ranked recommendations (benefit/effort/risk/confidence)
1. Measure outcomes of submissions first (weekly report: funnel-velocity/calibrate/
   deriveLearningMetrics). S effort, high confidence capability-wise. THE gating metric.
2. Close the park→answer→requeue loop (diagnose.mjs after each cycle → auto-propose
   standing-answer candidates → one-tap approval → requeue; use dormant learning flow,
   local-only). M, high confidence.
3. Confront volume-vs-quality: targeting-health view (knockout-risk aggregation, fit
   distribution), throttle auto-apply, referral/outreach track (linkedin-join,
   contact-lookup, radar scheduled). M, med-high.
4. Semantic re-match of parked questions vs existing standing answers; auto-requeue. M, high.
5. Durable push channel (email/Telegram) for parked-needs-human/invites/rocket-ships. S-M, high.
6. Heartbeat liveness alarm for stuck-but-alive cycle. S, high (gap), med (cause).
7. Proactive consistency/provenance audit (story-provenance-check scheduled;
   flag derived-unverified at submission). S, high.
8. Credential-store hardening (count/age surfacing, encryption decision). S, high.
9. Discovery-time dedup across Workday subdomains (detect-reposts logic). M, med.
10. Teaching digest (upskill+salary-gap+per-ATS advance in weekly push). S, med-high.

Deferred: cloud Lambda deploy (deliberate zero-budget default), full 4-outcome
derived-unverified UX, privacy/apply flow, raising daily cap (anti-recommended).

Fact-vs-hypothesis: #2,4,5,6,7,8 from code read directly; #1,3,9,10 need runtime
reproduction queries first.
