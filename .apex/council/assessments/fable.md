# Assessor: Fable 5 via Bedrock Mantle (council-assessor-fable, ses_ed2fcd752ffelulb61mS3ZSQLd)
Received 2026-10-11T22:16Z. Summary; full text in session transcript.

## Value leaks (file-cited)
- ~70 parks whose answers mostly already exist (exact-first custom-answer matching;
  resolveAnswer 5-level precedence built but flag-off).
- Real submissions scored as failures → retried: verifyAudit fails empty
  confirmation_text (apply-worker.mjs:254-256); reconciliation gated on learning
  (apply-worker.mjs:419, run.mjs:181); legacy jobs lack submissionPossible so
  state.mjs:263-267 guard never fires. riotgames "failed twice" may be TWO real
  submissions.
- Answer-store defects submitted verbatim: hardcoded stale date "2026-10-05"
  (standing-answers.yml:150); "Yes" answer to free-text pace question (:173);
  "Senior individual contributor" job level undercutting Director positioning (:165).
- Experience discarded every attempt (learning off = no capture).
- NO cost telemetry despite <10¢/apply target (zero cost fields in panel.mjs).
- Monitoring gap root cause: agent output goes to audit-dir fd, not run.log
  (apply-worker.mjs:323-335); panel live-task classifier reads run.log (panel.mjs:465).

## Proactivity gaps
Parked→queued manual-only; replies never read (gmail plugin invoke-only, paste-reply
manual); follow-ups never fire (91 submissions, zero follow-up pipeline); radar
pull-only though it generates outreach_angle per company; parked jobs age without
liveness recheck; facts learned one-at-a-time instead of batch pre-ask.

## Teaching gaps
Park-reason clusters, score distribution, time-per-apply in panel.mjs:371-410 —
pull-only. Full BI suite (funnel-velocity, salary-gap, upskill, analyze-patterns,
repost detection, rejection-latency) invoke-only; user likely unaware most exist.
Digest teaches nothing (moved-today table). Calibration starved because outcomes
not ingested.

## Blind spots
- Duplicate-application exposure (legacy no-confirmation retry).
- URL-key dedup only → Workday cross-subdomain duplicates burn attempts.
- Plaintext ATS passwords (accounts.json).
- Prompt-injection surface: sandbox-bypassed agent w/ PII + creds + submit authority
  reads arbitrary employer pages; AGENTS.md rules are prompt policy, not enforcement.
- STRATEGIC: cold ATS applications likely lowest-yield channel for Director/Principal;
  100% of effort there; contacto/linkedin-join/contact-lookup/radar angles unwired.
- Targeting breadth CSM→VP Eng (profile.yml:20-50, 18 resume variants) dilutes narrative.
- $200K base may be BELOW SF Director/Principal market — salary-gap.mjs never run.
- 31/day vs 100 cap with 18 queued → constraint is discovery/eval supply, not cap.
- gemma-4-e4b sole gatekeeper for paid 25-min agent runs, no outcome validation.

## Ranked recommendations
R1. Activate learning subsystem shadow-first (T27 + D01-D07). S effort, high conf.
R2. Automated reply/outcome ingestion per cycle (suggest-only status queue). M, high.
R3. Proactive push intelligence brief (park clusters + "answer 5, unpark 23" +
    funnel/ATS/variant rates + radar + salary-gap + cost/day; email/Telegram). M, high.
R4. One-shot answer-harvest session over parked backlog (interim script, works with
    learning off; cheapest unlock of ~70 jobs). S, high.
R5. Warm-channel lane, draft-only outreach from radar angles. M, medium.
R6. Fix standing-answer defects + answers lint (stale dates, type mismatches). S, high.
R7. Cost + verification telemetry ($/apply vs 10¢ target; weak-confirmation alerts). S-M.
R8. Liveness heartbeat + degraded-cycle alert. S, high.
R9. Cross-tenant dedup fingerprint at createJob. M, medium.
R10. Scheduled score calibration after R2 data. S, medium.

Deferred: cloud Lambda, raising cap/more scanners, duplicate migration work,
broker layer, panel auth (loopback verified).

Unexecuted checks proposed: park-reason distribution query, status probe,
learn.mjs inspect + test re-run, salary-gap + calibrate runs, gmail auth status.
