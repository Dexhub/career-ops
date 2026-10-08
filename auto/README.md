# auto/ — autonomous apply pipeline (local-only layer)

Unattended loop: scan → eval/promote → resume select → **real submissions** →
daily digest. Core career-ops scripts are never patched (one sanctioned
exception below); `npm run update` never touches this directory.

Authorized by the user 2026-10-07 (see `modes/_custom.md`, "Autonomous apply
pipeline authorization"). Facts come from `config/profile.yml`, preferences
from `config/standing-answers.yml`; the worker refuses to start unless that
file has `filled_in_by_user: true`.

## Layout

| File | Role |
|---|---|
| `run.mjs` | Orchestrator: one full cycle under a run lock. Started manually. |
| `eval-queue.mjs` | Pipeline rows → liveness gate → local-LLM eval → promote (score ≥ threshold → `queued`). |
| `resume-library.mjs` | Builds the fact-gated PDF variant library from `cv.md` (`data/auto/resume-library/`). |
| `resume-select.mjs` | Matches `queued` jobs to a variant → `resume_ready`. |
| `apply-worker.mjs` | Headless agent (claude → codex fallback) fills + submits one application via Playwright MCP; audit contract enforced here, not trusted from the agent. |
| `digest.mjs` | Daily `data/auto/digest-YYYY-MM-DD.md` + macOS notification. |
| `diagnose.mjs` | Sweeps every audit dir: agent-claim vs verdict divergences, park/fail reasons across jobs, missing answers, recurring generated answers (standing-answer candidates). |
| `state.mjs` | Job state machine (`data/auto/jobs/*.json`). `node auto/state.mjs --list` to inspect. |
| `prompts/apply-submit.md` | Prompt template for the apply agent (audit contract, ATS quirks, honesty rules). |
| `patches/` | The sanctioned AGENTS.md ethical-override patch. Re-apply after `npm run update`; `run.mjs` skips applies and warns if it's missing. |
| `launchd/io.career-ops.auto.plist` | Optional 6-hourly schedule — **currently disabled** (user runs cycles manually). Re-enable only on request: `cp auto/launchd/io.career-ops.auto.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/io.career-ops.auto.plist` |
| `launchd/io.career-ops.web-ui.plist` | Web UI as an always-on service (installed): `next start` on http://127.0.0.1:3003, KeepAlive + RunAtLoad, logs to `data/web-ui.log`. This never applies to jobs by itself. |
| `panel.mjs` + `panel.html` | **Mission Control — the single UI** at http://127.0.0.1:3001. `/auto` is tabbed: **Overview** (Start / Pause after current / Stop now, submitted-today vs daily limit, needs-attention triage, submitted list with evidence, per-job drill-down, digest), **Operator** (live orchestrator/ranker/apply-agent view with in-progress screenshots, polled from `/api/auto/operator`), **Queue** (exact worker pick order + funnel counts), **Errors** (failed/parked with multi-select bulk retry, ranker failures, skipped), **Log** (filterable activity log). Every other path reverse-proxies the upstream web UI on :3003 (`CAREER_OPS_WEB_PORT`; Host/Origin rewritten; "Mission Control" link injected into proxied pages) so one origin serves everything. Never applies by itself. |
| `launchd/io.career-ops.panel.plist` | Panel as an always-on service (installed), logs to `data/auto/panel.log`. Cycles started from the panel survive the browser/terminal closing. |

Config: `config/auto.yml` (threshold, daily soft limit, jitter, attempts,
eval model, ATS allowlist, resume variants).

## Stages

`discovered → evaluated → queued → resume_ready → applying → submitted`
with `parked` (needs a human), `failed` (exhausted attempts), `skipped`.
`parked → queued` and `failed → queued` are the requeue edges (panel
Requeue button, or multi-select bulk retry on the Errors tab; attempts
reset to 0).
Dry runs (`--no-submit`) never mutate state.

Pause: the panel's "Pause after current" writes `data/auto/pause-requested`;
`run.mjs` checks it between applies and stops gracefully after the in-flight
job finishes (the flag is cleared when a new cycle starts). "Stop now" kills
the cycle process immediately.

## Running by hand

```
node auto/run.mjs                 # full cycle (manual — scheduling disabled)
node auto/run.mjs --skip-scan     # skip the slow network scan
node auto/run.mjs --no-submit     # one dry-run apply, no state change
node auto/apply-worker.mjs --job <needle> [--no-submit]
node auto/digest.mjs
```

Every script has `--self-test`. Logs: `data/auto/run.log`.

## Parked jobs (the Neo/manual lane)

A job parks instead of failing when the agent hits something it must not
push through: `login-or-captcha`, `captcha-or-checkbox-required`,
`missing-fact`, `cover-letter-file-required`, `posting-closed`,
`role-mismatch`. The daily digest lists parked jobs with reason + URL.

To finish one: open the posting in BrowserOS Neo (interactive sessions keep
the Neo mandate), fill with the same facts (`config/profile.yml`,
`config/standing-answers.yml`), submit, then record it:
`parked → queued` is legal if you want the machine to retry instead.

## Audit trail

Every attempt writes `output/<reportNo>-<company>-<role>/audit/attempt-N/`:
`prompt.md`, `answers.json` (label/value/source per field), `resume.txt`
(variant + sha256), `01-form-filled.png`, `02-confirmation.png`,
`result.json` (incl. `parked_reason` + a `missing` list of every question
the agent could not answer from the data sources), `verdict.json` (the
orchestrator's own judgment — agent output is never trusted), page
snapshots, console logs, and the agent transcript. An agent claim of
"submitted" without a confirmation screenshot + text is treated as failed.

Diagnosing after the fact: `node auto/diagnose.mjs` aggregates all of the
above across every job — exact failing step per attempt (transcript +
snapshots in the audit dir), reasons grouped across jobs, and which
questions keep needing generated answers (add those to
`config/standing-answers.yml` so they become deterministic).
