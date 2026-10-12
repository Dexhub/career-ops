# Assessor: GLM-5.3 (US) (council-assessor-fable override, ses_ed2fc7047ffea3eQYlIXNZ0Vuv)
Received 2026-10-11T22:25Z. Summary; full text in session transcript.

## Key findings (artifact-cited)
- Park taxonomy quantified from digest 10-11: "JD unavailable via API after 3 tries"
  is the LARGEST park category (13/20 park events that day) — a data-acquisition
  failure, not a human-decision failure (eval-queue.mjs:244-257 API-only, 3 strikes).
- remitly credentials rejected on 10-10 AND 10-11 — two jobs burned attempts on the
  same known-bad password; no per-host credential-failure elevation.
- Zero follow-up seeds, zero replies, zero interviews: followup-seed.mjs called
  nowhere in auto/; reply-candidates.json absent; interview-prep/sessions/ empty;
  workflow.mjs:938 writes Applied only.
- Requeue button = double-application risk TODAY: failed→queued legal (state.mjs:56),
  SUBMISSION_OUTCOME_UNKNOWN guard keys on execution.submissionPossible which only
  learning sets (state.mjs:263-267); apply-worker.mjs:246-247 comment records real
  jci/gilead submissions marked failed on empty confirmation.
- dnb same req R-19848 parked twice from two Lever URLs; URL-based identity.
- desired-cycle.json has skipScan:true permanently — discovery frozen; launchd
  cadence deliberately disabled; system depends on coordinator wakeups.
- lastActivityAt computed (panel.mjs:527-539) but never judged — no stale alarm.
- resumeNote fallback recorded but surfaced nowhere (digest.mjs:47-54 omits);
  riotgames Principal ML / gdit CTO / ngc flight-software shipped with
  "Head of AI Strategy & Adoption" CV.
- Eval silent-fallback score parsing (eval-queue.mjs:157-166) = invisible gate
  drift; eval-golden.mjs never scheduled.
- 2,400+ archived reports with advertised_comp — market brief computable, never run.
- Uncommitted learning work on live checkout = crash/checkout-switch hazard.

## Ranked recommendations
R1. Activate learning layer (T27, shadow first) — fixes requeue double-apply guard,
    blocker-resume, verification waits, question/approval UI. S effort claimed,
    BUT notes live executor connection deferred to T27 (budget debugging window).
R2. Outcome loop: followup-seed on auto-submit + scheduled reply ingestion
    (paste-reply ok; Gmail = owner privacy call) + weekly outcome brief. M.
R3. One-touch park-drain via diagnose.mjs → digest/panel proposals + 4 explicit
    policy prompts (EEO-no-decline, quirky questions, non-USD OTE, attestations). S-M.
R4. Pre-submit duplicate/identity fingerprint (company+role+req across boards). M.
R5. Self-scheduling cadence + stale-activity alarm (>2h silence while running). S.
R6. JD-fetch browser fallback rung for the biggest park cluster (policy line for
    owner to confirm). M.
R7. Per-attempt cost telemetry into verdict.json + analytics. S-M.
R8. Resume-variant honesty: resumeNote in digest + below-floor alerts. S.
R9. Weekly market/positioning brief (salary-gap, funnel-velocity, analyze-patterns,
    per-ATS rates). S-M.
R10. Threshold calibration loop after R2 + schedule eval-golden. S.

Deferred: cloud Lambda, privacy/apply, deterministic fillers, full Gmail automation
(privacy line), more test suites.

Bottom line: "excellent submission machine throttled by four cheap gates" (learning
dark, outcome loop missing, per-job asks instead of once, browser-solvable parks).
Most dangerous current behavior: the Requeue button on possibly-submitted jobs.
