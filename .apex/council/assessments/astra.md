# Assessor: GPT-6 Astra (US) (council-assessor-astra, ses_ed2fd0accffeMws3yY2cb21IkN)
Received 2026-10-11T22:13Z. Summary; full text in session transcript.

## Headline
Autonomous at submitting, not at improving the search. Two correctness problems to
fix BEFORE more autonomy:
1. **Score-extraction defect (observed, evidence chain)**: eval-queue.mjs:150-170
   takes first unanchored "Score: …/5" from evaluator stdout; reports/2490 (Carrier)
   contains "Confidence Score: 5/5" while the actual evaluation is 3.8/5 with a
   domain mismatch (lines 49/58/75-77); run.log:1508-1515 shows queued at 5/5;
   verdict.json shows submitted. A parsing defect bypasses the fit threshold.
2. **Unknown-outcome retry loophole**: audit failure ≠ employer received nothing;
   legacy path (apply-worker.mjs:620-654, 775-781) and one learning path
   (workflow.mjs:632-657) can turn missing evidence into permission to retry.

## Proactivity gaps
- Missing info discovered too late (in expensive browser session) — diagnose.mjs
  aggregation never part of runCycle.
- Digest reports work instead of reducing it (digest.mjs:56-81, osascript-only);
  should rank decisions by opportunities unblocked; old blockers must persist.
- Learning review cadence never executes (panel.mjs:541-550 reports due, won't run).
- Acquisition loop disconnected from relationship loop (reply-watch, followup-cadence,
  contact-lookup, interview prep never orchestrated).

## Teaching gaps + hazards
- Calibration (do high scores produce interviews?), resume-selection rationale,
  JD-vs-evidence gaps, existing contacts/company history, sample-bias caveats,
  attempt cost/time — all computable, never delivered.
- HAZARD: intelligence.mjs:238-282 labels zero token overlap as genuine_gap —
  "no supporting text" taught as "no experience" (false limitation).
- HAZARD: radar.mjs:121-147 judges companies from name alone when report absent.

## Blind spots
- profile.yml:20-62 still targets Account Manager / CSM roles — stored goal broader
  than stated Director/Principal objective; needs explicit reconciliation.
- "Tailored resume" = headline substitution only (resume-library.mjs:186-201).
  Observed: "Head of AI Strategy & Adoption" resume selected for a Principal ML
  Engineer role (run.log:1540-1541).
- Learning activation is NOT a flag flip: production runApply caller supplies no
  executor (run.mjs:300 vs apply-worker.mjs:395,482-489); malformed learning config
  silently downgrades to legacy worker (apply-worker.mjs:121-129).
- Credentials duplicated into account store + audit artifacts + rendered prompts
  (apply-worker.mjs:58-103, 283-286).
- URL identity ≠ requisition identity (state.mjs:135-138; url-key.mjs:300-338) —
  cross-host duplicates need evidence-backed aliases.
- Watchdog monitors process existence, not progress (panel.mjs:154-162).

## Ranked recommendations
1. Repair score→action contract (validated machine-readable eval result; audit
   already-queued records). S-M, high confidence.
2. Universal non-retryable "unknown external outcome" state, learning flag
   independent; affirmative evidence before retry. M, high.
3. Persistent goal-ranked decision inbox + push brief (3 queues: system-resolvable /
   owner-decides / external-wait), ranked by opportunities unblocked. M, high.
4. Constrained production learning integration (real restricted executor, fail-closed
   config, approval gates) — not blanket activation. M, high risk/benefit.
5. Close reply→follow-up→interview→outcome loop (ingest, match, prep packets;
   never infer rejection from silence). M, high benefit.
6. Align campaign + resume evidence with actual target (explicit decision on broad
   profile; two principal evidence packs: leadership vs Principal IC). M.
7. Weekly "what you learned" brief w/ evidence + counter-evidence; replace
   genuine_gap with "not evidenced". M.
8. Relationship-first pursuit lane (draft-only pursuit cards for top companies). S-M.
9. Monitor progress, not process existence (structured stage progress, version
   exposure, escalate unknown outcomes). S-M.
10. Full cost per useful outcome (unknown ≠ zero; fallbacks in denominator). S-M.

Deferred: higher limits/parallelism, second learning architecture, cloud summaries,
autonomous code repair, per-application resume rewriting, auto score tuning, UI
redesign.

Sequence: fix scoring + unknown-outcome first; then decision inbox; then constrained
learning + outcome management. Success = fewer interruptions, more qualified
conversations.
