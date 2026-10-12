# Coordinator verification of material assessor claims (2026-10-11T22:20Z)

## V1. Astra's score-extraction defect — CONFIRMED, quantified
Claim: eval-queue.mjs:154 unanchored /Score:\s*([\d.]+)\s*\/\s*5/ matches the
gemma think-block line "Confidence Score: 5/5" before any real score; markdown
"**Score:** 3.8/5" (asterisks) and yaml "score: 3.8" (lowercase) never match
the stdout regex.

Verification (executed, read-only):
- reports/2490-unknown-2026-10-11.md:23 "Confidence Score: 5/5" (think block);
  :49 real "**Score:** 3.8/5"; :59 yaml "score: 3.8".
- run.log:1508/1515: carrier Principal Power Electronics "→ 5/5 QUEUED".
- run.log:1577-1582: submitted, tracker Applied (report 2490).
- Regex behavior confirmed by inspection of eval-queue.mjs:150-172.

Blast radius (grep over reports/ for the hijack pattern + real-score compare):
- 43 reports contain "Confidence Score: N/5" in think block, all parsed-as 5/5.
- 17 of 43 have REAL score < 4.0 threshold (range 2.0-3.8).
- Of those 17: 9 SUBMITTED (graphcore 3.8, medispend 3.5, flextronics
  head-of-eng 3.2, alteryx 3.8, edwards 3.8, carrier 3.8, flextronics
  dir-ops 2.5, stitchfix 3.8, pluribusdigital 3.8), 5 parked, 3 failed.
- Worst queued: mckesson "Innovation Strategy Intern Summer 2027" real 2.0/5
  queued at 5/5 (parked before submission — an INTERN role for a Director
  candidate).
- Current queue check (sqlite, read-only): jobs now queued/applying with
  stored score 5 (fox 2511, toast 2538, moniepoint 2544/2548/2549) all have
  REAL report scores >= 4.0, so no sub-threshold submission is imminent.
  Urgency = fix soon, not emergency-pause.

## V2. Employer-duplicate exposure — CONFIRMED from live queue
sqlite query of queued jobs shows ~14 moniepoint entries for essentially 2
roles (Head of Engineering Field Verification x8, Sales & Marketing Tools x6),
all distinct greenhouse job IDs. Without an employer-level cap the system will
submit up to 14 applications to one employer. Validates Kimi R3 / Astra #2 /
Opus #9 dedup-gate recommendations with live data.

## V3. Kimi's re-applied-after-decline claim — CONFIRMED (coordinator re-read)
- applications.md row 88 (apartmentiq, Head of Product AI BI): "Gmail decision
  verified 2026-09-09: ApartmentIQ declined ... on 2026-09-08" AND, same row,
  "Re-eval 2026-10-11 (4.8→5): auto pipeline; auto-submitted" with greenhouse
  confirmation URL. Unambiguous: re-submitted to the SAME role that declined him,
  decline evidence sitting in the same tracker row.
- Row 11 (1password Field CTO): declined 2026-09-07 (Gmail-verified), re-eval
  10-11 auto-submitted. NUANCE: row title says "North America West" while the
  10-11 audit dir says "...north-america-east" — may be a sibling regional
  requisition rather than the identical req. Either way, auto pipeline never
  consulted the decline evidence in its own tracker.
- Row 1015 (1password Director Analytics Engineering) also auto-submitted 10-11 —
  third 1password application; no per-employer cap.

## V4. Fable's answer-store defects — CONFIRMED (file read)
- standing-answers.yml:150 "please add today's date": "2026-10-05" (stale literal,
  submitted on later dates).
- :173 "what pace do you do your best work at?": "Yes" (nonsense for free-text).
- :165 "what is your current job level": "Senior individual contributor" —
  contradicts Director/Principal positioning and resume headline.
