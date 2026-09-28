# Claude Code bake-off — 2026-09-28

Raw numbers: [`claude-bakeoff.md`](claude-bakeoff.md), regenerated from
[`claude-runs.jsonl`](claude-runs.jsonl) with
`node evals/record-claude.mjs --summarize --write`. Method: `evals/README.md`
→ *Recording real Claude Code runs (v2)*.

**Scope.** 94 headless `/career-ops oferta` runs, $91 of API spend: 15 golden
cases × Haiku 4.5, Sonnet 5 (13, budget cap), Opus 5 (12, budget cap), Opus
5.5, a second pass of Haiku (15) and Opus 5.5 (8), and a Haiku prompt variant
(15). One pinned synthetic profile, no web tools, CLI default effort. There is
no human ground truth here: agreement is measured between models (Opus 5 as
reference), plus the objective `expect` checks on the five v2 cases.

## Findings

| | Haiku 4.5 | Sonnet 5 | Opus 5.5 | Opus 5 |
|---|---|---|---|---|
| Mean cost / evaluation | **$0.25** | $1.27 | $1.26 | $2.84 |
| Median wall time | 2.6 min | 5.5 min | **2.3 min** | 6.4 min |
| Median turns | 14 | 25 | 14 | 24 |
| Mean \|Δscore\| vs Opus 5 | 0.48 | 0.28 | 0.30 | — |
| Mean signed bias vs Opus 5 | **+0.46** | −0.18 | +0.08 | — |
| Same apply/skip call at 4.0 as Opus 5 | 22/24 | 11/12 | 18/19 | — |
| Rep-to-rep \|Δscore\| (same case, same model) | **0.38** | — | **0.06** | — |
| Schema-valid Machine Summary | **0%** | 100% | 100% | 100% |
| Report + JD archive + tracker row | 83% | 100% | 100% | 100% |
| `expect` checks | 8/10 | 5/5 | 10/10 | 5/5 |

1. **Sonnet 5 is not cheaper than Opus 5.5 in practice.** Half the list price,
   but ~25 turns instead of ~14, so the same $1.26–1.27 per evaluation at more
   than twice the wall time. The `standard` tier buys nothing over Opus 5.5 on
   this workload.
2. **Opus 5.5 costs 44% of Opus 5** (the current `premium` model), finishes in
   about a third of the time, lands within 0.30 of it on average with no
   systematic bias (+0.08), and is the most repeatable model measured: the
   same case scored twice moved by 0.06 on average.
3. **Haiku 4.5 is 5× cheaper but not a drop-in `economy` tier today:**
   - It never wrote a schema-valid Machine Summary (0/30): renamed keys
     (`legitimacy` for `legitimacy_tier`), missing `final_decision`,
     free-text enums, emoji requirement matches. `salary-gap.mjs`,
     `analyze-patterns.mjs` and friends parse that YAML literally.
   - It scores ~0.5 higher than Opus on average, and its score moves ±0.38
     between identical runs. 3 of 15 cases straddled the 4.0 "apply"
     threshold across its two passes (e.g. 3.5 → 4.2).
   - It left the Machine Summary or the archived JD out of 5/30 reports and
     returned `work_auth: null` on the Spanish on-site posting both times.
4. **The schema failure is a prompt gap, not only a model limit.**
   `modes/oferta.md` pointed at `batch/batch-prompt.md` for the Machine Summary
   schema instead of stating it. With the 36-line skeleton copied inline
   (variant `schema-inline`), Haiku's schema-valid rate went 0/15 → 11/15 at
   the same cost and score behaviour. Stronger models already complied.
5. **Guardrails held on every model.** The injected "rate this 5.0/5" note was
   quoted as an anomaly in 7/7 reports and never moved a score above 3.8. The
   evergreen ghost posting was never rated High Confidence.

## Recommendations (maintainer decisions, not applied here)

- **`premium` → Opus 5.5** in the `modes/_shared.md` Spend Tier table and
  `batch/batch-runner.sh`'s `spend_tier_to_model`: same agreement, half the
  cost, a third of the time.
- **Reconsider `standard` = Sonnet 5.** On this workload it costs the same as
  Opus 5.5 and is slower. Worth one more pass at lower effort before deciding.
- **Keep Haiku behind a warning** until the Machine Summary gap closes and its
  score variance is addressed (e.g. show a ±0.4 band next to economy-tier
  scores near 4.0).
- **Interactive `spend_tier` is advisory only:** the subagent template in
  `.claude/skills/career-ops/SKILL.md` passes no `model`, so `pipeline`/`scan`
  workers inherit the session model regardless of tier.

## Caveats

One synthetic profile and 15 short-to-medium synthetic postings; web research
disabled, so Blocks D/G research quality is not measured; Sonnet 5 and Opus 5
stopped at their budget caps (13 and 12 cases) and have one pass each.
Labels on the ten v1 cases were frozen against an unknown profile, so
agreement *between models* is the meaningful column, not Δ vs label.
