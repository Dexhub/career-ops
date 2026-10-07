# Autonomous Job-Apply Pipeline on career-ops (fresh checkout)

Repo: `/Users/jarvis/AI-Playground/career-ops/career-ops` (upstream `career-ops-hq/career-ops`, main @ 882004e0)
Old broken system (reference only, port NO code): `/Users/jarvis/AI-Playground/jobs/career-ops`

## 0. Findings: existing PRs / branches / code

**Open PRs & branches: nothing to merge for this.** All ~50 open PRs are small fixes (scan providers, dashboard, i18n, PDF templates). No PR or branch implements auto-submit, an autonomous loop, or a state machine — and none ever will upstream, because `AGENTS.md:432` ("NEVER submit an application without the user reviewing it first") is a core project rule. This feature is a deliberate local-only deviation.

**What main already ships (reuse as-is, zero new code):**
| Stage | Existing asset |
|---|---|
| Discover | `scan.mjs` (+121 providers), `scan-ats-full.mjs`, dedup, `check-liveness.mjs`; cron/launchd recipes in `docs/AUTOMATION.md` |
| Rank (cheap) | `rank-pipeline.mjs` — annotates `data/pipeline.md` rows with `rank: X/5 — reason` via headless CLI agent |
| Evaluate (local model) | `ollama-eval.mjs` — full A–G eval + report + tracker TSV, local Ollama |
| Resume build | `cv-templates.mjs`, `build-cv-html.mjs`, `generate-pdf.mjs`, `openai-tailor.mjs`/`batch-tailor.mjs` (OpenAI-compatible API) |
| Apply (fill, no submit) | `modes/apply.md` + `docs/APPLY_AUTOFILL.md` — field-tested Playwright fill for Ashby/Greenhouse/Lever/Workable incl. react-select & SPA quirks |
| Artifacts | `application-artifacts.mjs` — stable per-application dir (JD, CV versions, decisions) |
| Tracker/state files | `tracker.mjs`, `set-status.mjs`, `pipeline-lock.mjs` (concurrency lock) |

**Old repo verdict:** died of overengineering (~150 files in `automation/`: submission-guard → guard-broker → guard-canary chains, HMAC'd receipts, per-ATS `*-control-state.mjs` modules). Salvage three *ideas* only: (1) per-job state machine stage names, (2) resume-library-by-archetype, (3) the lesson that **deterministic per-ATS fillers are the maintenance trap** — LLM-driven semantic filling survives form changes; hardcoded selectors don't.

## 1. Decisions (confirmed with user)

1. **Auto-submit everything scoring ≥ 4.0** (inclusive — a job scoring exactly 4.0 applies; threshold lives in `config/auto.yml: score_threshold`, user-editable). No per-job approval. Daily digest is the only human checkpoint. Knock-out mismatches submit anyway (honest answers, flagged `knockout-risk` in digest). Only captcha/login-wall/hard form failures park to the `needs-you` lane (Neo fallback) — physics, not policy. **Hard line: answers are always truthful** — preferences (salary, notice, relocation) come verbatim from user-authored `config/standing-answers.yml`; eligibility facts from `config/profile.yml`; the system never fabricates either.
2. **Executor: headless agent (claude -p / codex exec) driving Playwright** with a persistent real-Chrome profile. **BrowserOS Neo = fallback lane** for parked jobs (captchas, Workday, weird portals) — Neo has the logged-in profile and human-help escalation. Rationale: deterministic cost, reuses upstream's field-tested apply mode, resilient to form drift; pure-Neo burns tokens on every apply and adds a 24/7 moving part.
3. **ATS scope phase 1: Greenhouse, Lever, Ashby, Workable.** Workday and oddballs park to Neo/manual.
4. **Eval engine: local Ollama.** Installed; models present are `coder`, `qwen2.5vl`, `qwen3.8-coder` — **no suitable 32K general instruct model; must pull one** (e.g. `qwen2.5:14b`/`qwen2.5:32b` or `llama3.3`, sized to RAM). Verify with `eval-golden.mjs`.
5. **Rate limit: soft limit 100 submissions/day**, user-editable in `config/auto.yml`; minute-level jitter between applies; sequential, never parallel.

## 2. Architecture

**Prime directive: never patch core files.** All new code lives in a new `auto/` directory + `config/auto.yml` + `data/auto/`. Upstream `npm run update` keeps working. Two sanctioned exceptions:
- `modes/_custom.md` (user layer, update-safe by design) gets the auto-submit authorization rule.
- `AGENTS.md:428-435` Ethical Use block needs one local edit (delete/override the never-submit line) or the headless agent will refuse to click Submit. Keep this edit as a documented patch in `auto/patches/ethical-override.md` so it can be re-applied after upstream updates. This is the one accepted merge-friction point.

### Per-job state machine
One JSON file per job: `data/auto/jobs/<url-key>.json` (use existing `url-key.mjs` for the key). Flat file, atomic write (tmp+rename), no DB, no locks beyond the existing `pipeline-lock.mjs` for shared files.

```
discovered → evaluated → queued → resume_ready → applying → submitted
                 ↓          ↓           ↓            ↓    ↘ parked (captcha/login-wall/odd-ATS → Neo lane)
              skipped   (score<4.0)              failed (2 attempts exhausted)
```

Fields: `stage, url, company, role, ats, score, reportPath, resumeVariant, resumePdf, attempts, lastError, timestamps[], auditDir`.

### Orchestrator
`auto/run.mjs` — single sequential entry point invoked by launchd. One cycle:
1. `scan.mjs` (zero-token discovery → `data/pipeline.md`)
2. For new pending rows: liveness gate (`check-liveness.mjs`) → `ollama-eval.mjs` → record score, stage=`evaluated`
3. Promote score ≥ 4.0 → `queued` (threshold in `config/auto.yml`)
4. Resume selection (library match → `resume_ready`; else tailor on demand)
5. Apply worker, one job at a time with jitter, until queue empty or soft limit hit
6. Append to daily digest

Cadence: launchd every 6h (4 cycles/day spreads submissions naturally; `config/auto.yml: cycle_interval_hours`). Cover letters: when a form requires one, generate via existing `generate-cover-letter.mjs` pointed at the local model; saved into the audit dir like any other answer.

Crash-safe: every stage transition is persisted before the action's side effect is relied on; re-running `auto/run.mjs` resumes from each job's recorded stage. A run-level lockfile prevents overlapping cycles.

### Resume handling
- `data/auto/resume-library/<role-slug>/cv.pdf` — pre-built variants, one per entry in `config/auto.yml: resume_variants` (seeded from `target_roles.primary` ~11 titles **plus** Solutions Architect, Software Engineer, Senior Software Engineer, Staff Engineer, Principal Engineer, AI Engineer — user-editable list, ~15–18 total), generated via the existing CV pipeline (`build-cv-html.mjs` → `generate-pdf.mjs`). Library regenerates a variant when `cv.md` or its title entry changes (hash check).
- **Fact gate:** every generated variant must pass `verify-cv-facts.mjs` — all claims trace to `cv.md`; variants differ in emphasis/ordering, never in invented facts.
- Matching: reuse `role-matcher.mjs` / `title-keywords.mjs` to map a job title → closest variant title.
- No match: on-demand tailor. Point `openai-tailor.mjs` at Ollama's OpenAI-compatible endpoint (`OPENAI_BASE_URL=http://localhost:11434/v1`) — verify compatibility at implementation; fallback is a headless `claude -p` invocation of the existing `pdf` mode. Tailored output lands in the standard `application-artifacts.mjs` dir.

### Apply worker
`auto/apply-worker.mjs` spawns one headless agent session per job:
- `claude -p` (fallback `codex exec`) with Playwright MCP, browser launched with persistent profile `data/auto/chrome-profile` on real Chrome channel (anti-bot: real fingerprint, persistent cookies).
- Prompt = upstream `modes/apply.md` fill flow + the local submit authorization + a mandatory **audit contract** (below).
- **Answer policy (user-decided, with a hard line):**
  - `config/standing-answers.yml` (new, user-authored): salary expectation, notice period, relocation/remote willingness, start date, "how did you hear" — preference questions filled verbatim from this file; the user sets these as aggressively as they like.
  - Experience questions: most-favorable **truthful** count derived from `cv.md`/profile; open-text answers use the repo's "I'm choosing you" tone rules.
  - Factual eligibility (visa/work authorization, degrees, certifications): filled verbatim from `config/profile.yml`. **The worker never fabricates eligibility facts** — that is a hard constraint of this design (rescinded offers / background-check / legal exposure), not an upstream leftover.
  - Knock-out questions do NOT park: the job submits anyway with honest answers, and the digest flags it `knockout-risk` so rejection clusters are explainable. Full autonomy preserved.
- Exit protocol: worker writes a result JSON (`submitted | parked:<reason> | failed:<reason>`); orchestrator transitions state. Agent output is untrusted — the orchestrator verifies the audit dir contains the required artifacts before accepting `submitted`.

### Audit trail (per attempt, mandatory)
`output/<app-key>/audit/<attempt-N>/`:
- `answers.json` — every field label + value filled
- `resume.txt` — variant/tailored path + sha256 of the exact PDF uploaded
- `01-form-filled.png`, `02-confirmation.png` — screenshots before submit and after
- `result.json` — final URL, confirmation text snippet, timestamps, agent transcript path
- `error.png` + `error.json` on any failure (last URL, DOM state summary)
Daily digest `output/auto-digest-YYYY-MM-DD.md` links every row to its audit dir.

### Failure recovery & anti-detection
- Mid-apply page change / crash: attempt recorded, state stays `applying` with `attempts++`; next cycle retries once with a fresh page; 2 failures → `failed` (or `parked` if reason is captcha/login-wall) with full error artifacts.
- Jitter: 2–10 min randomized sleep between applies; max ~1 submission in flight ever; soft daily limit 100 (`config/auto.yml: daily_soft_limit`), per-domain spacing optional later.
- Dead postings never reach apply: liveness gate runs at eval time and again immediately before apply.

### Neo fallback lane (parked jobs)
Digest lists parked jobs with reasons. User (or an interactive agent session with BrowserOS Neo, which has the logged-in profile and `request_human_help` for captchas) clears them manually. No automation code in phase 1 — it's a lane, not a subsystem.

## 3. Phased rollout (each independently testable)

**Phase 0 — Baseline doctor.**
`npm install`, `node doctor.mjs`, Playwright Chromium present, fill `config/profile.yml` + `cv.md` (migrate from old repo's `cv-master.md`/`config` if current), pull a 32K instruct Ollama model, run `node eval-golden.mjs` against it.
*Verify:* one manual `node scan.mjs` adds rows; one manual `node ollama-eval.mjs --file <jd>` produces a sane scored report.

**Phase 1 — Unattended scan + eval.**
Build `auto/eval-queue.mjs`: pending pipeline rows → liveness → ollama-eval → write score to job state JSONs (`data/auto/jobs/`). launchd plist for scan+eval every 6h.
*Verify:* 24h unattended; reports + state files accumulate; no duplicate evals on re-run (idempotency).

**Phase 2 — State machine + promotion.**
`auto/state.mjs` (load/transition/atomic save + validation of legal transitions), promotion rule score ≥ 4.0 → `queued`. `config/auto.yml` with `score_threshold: 4.0` (inclusive comparison), `daily_soft_limit: 100`.
*Verify:* targeted unit test on transitions + one real promoted job visible in state dir.

**Phase 3 — Resume library.**
Generate one variant per `resume_variants` entry (~15–18, incl. Solutions Architect / SWE / Staff / Principal / AI Engineer) via existing CV pipeline, each gated by `verify-cv-facts.mjs`; `auto/resume-select.mjs` maps queued jobs → variant or triggers on-demand tailor (Ollama endpoint). Stage → `resume_ready`.
*Verify:* every queued job gets a concrete PDF path; **user reviews all generated variants once by eye** before any goes live (they will be submitted unattended afterwards).

**Phase 4 — Apply worker (the risky one).**
`auto/apply-worker.mjs` + `auto/prompts/apply-submit.md` + ethical-override patch + `modes/_custom.md` rule + `config/standing-answers.yml` (user fills it in this phase — worker refuses to start without it). Persistent Chrome profile. Audit contract enforced by orchestrator-side verification.
*Verify first in dry-run:* `--no-submit` flag fills everything, captures audit, stops before Submit — review 3 real runs by hand. Then one real submission to a low-stakes posting; confirm the ATS confirmation email arrives and the audit dir is complete. Only then enable for the queue.

**Phase 5 — Orchestrator + scheduler.**
`auto/run.mjs` wiring phases 1–4 sequentially with jitter, soft limit, run lock; launchd plist every 6h. Remove the separate phase-1 schedule in favor of this single entry.
*Verify:* full cycle end-to-end on a seeded queue of 2–3 jobs; kill -9 mid-apply and confirm clean resume on next run.

**Phase 6 — Digest + Neo lane.**
`auto/digest.mjs`: submitted/parked/failed table with audit links, written daily + macOS notification (pattern from `scripts/followup-sweep.sh`). Parked-job workflow documented in `auto/README.md`.
*Verify:* digest after a real day reads coherently; a parked captcha job can be finished via Neo/manual in <5 min.

**Post-rollout:** update repo `AGENTS.md` (local) with a short `auto/` layer section so future agents know the layout and the never-patch-core rule.

## 4. Explicit non-goals (lessons from the corpse)
- No submission-guard/broker/canary abstraction chain — the state JSON + audit dir IS the guard.
- No per-ATS deterministic filler modules — the LLM agent + upstream apply-mode quirk notes handle form drift.
- No Workday automation in v1. No parallel applies. No new database. No Gmail monitoring (upstream `reply-watch`/`followup` already exist if wanted later).

## 5. Risks / open items
- **Headless agent may balk at submitting** even with the AGENTS.md patch (model-level caution). Mitigation: explicit authorization language in the worker prompt + `modes/_custom.md`; if claude refuses, `codex exec` is the installed alternative; worst case the worker degrades to fill-and-park (system still works, just not fire-and-forget) — surface this in phase 4 verification.
- **`openai-tailor.mjs` ↔ Ollama endpoint compatibility** unverified; fallback path defined (headless pdf mode).
- **Account-gated ATS** (some Workable/Greenhouse boards require login): first occurrence parks; decide later whether to pre-create accounts in the persistent profile.
- **Upstream updates vs. AGENTS.md patch**: re-apply from `auto/patches/` after each `npm run update`; `doctor`-style check in `auto/run.mjs` warns if the override is missing.
