# Assessor: Kimi K3 (US) (council-assessor-opus override, ses_ed2fc37bcffepNWHjcb4odU4df)
Received 2026-10-11T22:17Z. Summary; full text in session transcript.

## Unique observed findings (artifact-cited)
- **Re-applied to employers who already DECLINED him**: 1password + apartmentiq
  declined 09-07/09-08, re-submitted by auto pipeline 10-11
  (data/migrated-archive-2026-10-11/applications.md:15,66). auto_jobs never joins
  tracker outcomes; eval re-scored them 4.5/5 and 5/5.
- **bedrock-robotics: failed attempt DID submit** — attempt-2 hit employer
  "must wait at least 3 months between applications" (run.log:1158,1230).
  Proof of the no-confirmation double-submit class + burned cooldown.
- **Plaintext passwords in EVERY audit dir's prompt.md** for saved-credential
  hosts (apply-worker.mjs:286 writes prompt verbatim; SAVED_CREDENTIALS block).
  Worse than accounts.json: per-job, proliferating, unlisted. 37 employer accounts.
- **2,669 pending pipeline rows, constant across 5 days** (run.log), eval drains
  20/cycle — supply bottleneck invisible; apply side saturates at ~31/day vs 100 cap.
- **Score instability**: same job re-scored 2→4.8 (pivotal), 4.7→4 (bmo),
  4.5→5 (roblox). Gate at exactly 4.0 → noise converts to random apply/skip.
- **~40-50% resume DEFAULT fallback** ("CTO" and "Distinguished Cloud Architect"
  roles get "Head of AI Strategy & Adoption" PDF).
- **Zero interviews in tracker across 91 submissions**; Gmail-verified rejections
  sit in notes with status still "Applied" (rows 11,23,66,88,90).
- BJAK time-boxed CTO assessment (60-min limit) rotting in tracker notes (row 90).
- Weak verifyAudit: any non-empty confirmation_text accepted; never checks
  employer/role named in confirmation.
- Learning backfill ingestion risk: historical answers.json could carry
  injection-era content as "observed" evidence (evidence.mjs normalizes shape,
  not content trust).
- Digest files missing for 10-08/10-09 despite run.log digest lines.
- Queue default mode ignores posting freshness; posted_at mostly null.

## Ranked recommendations
R1. Mailbox outcome watcher + auto status sync (propose-only first week). M, high.
R2. Parked-drain: diagnose.mjs at cycle end → "answer N questions, unblock M jobs"
    → EEO/CAD-OTE answers alone unblock ≥4 jobs ≥4.2. S-M, high.
R3. Anti-duplicate/employer-cooldown gate pre-dispatch (tracker join, max-open-per-
    employer cap default 2, learned cooldown table). M, high.
R4. Credential remediation FIRST chronologically (S effort): stop writing creds to
    prompt.md; keychain or verified 0600; rotate 37 passwords if output/ exposed.
R5. Activate T14 reconciliation via T27, gated on R4 + shadow week + locale fix.
R6. Score-stability probe + outcome calibration before any scale-up (re-eval 30-job
    sample twice; record eval model on jobs; calibrate.mjs in digest weekly). M.
R7. Backlog economics tile (2,669 pending; days-to-clear; liveness sweep of
    backlog before eval spend). S.
R8. Freshness-aware queue + posting-date backfill (preview route exists). S-M.
R9. Resume-variant coverage from fallback clusters (add CTO, AI Transformation
    Leader, Distinguished Architect variants). M.
R10. Weekly "state of the search" auto-report (all sources exist; join + render). M.
R11. Interview-trigger prep packs + assessment countdowns. M.
R12. Panel honesty fixes (self-test pause-flag bug, log-staleness tile,
     tracker-sync orphans on Errors tab). S.

Deferred: cloud reviewer, embedding matcher, more scanners (backlog 2,669 deep),
full historical backfill (injection risk; capture-forward instead), auto-promote
procedures (keep false permanently), multi-market, Hired Wall.

Bottom line: "a very good submission machine attached to almost no sensing" —
holds rejection evidence, zero interviews, keeps optimizing submissions.
Order: R4 first (S, standing liability), then R1, R2, R3, R6.
