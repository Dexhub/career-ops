# Executor handoff

## Copy-ready instruction for the next agent

```text
Work only in /Users/jarvis/AI-Playground/career-ops/career-ops.

Read AGENTS.md and .kilo/plans/2026-10-11-career-ops-learning/README.md,
then CONTRACTS.md in that same plan directory. Execute phases 01 through 06
in order, task by task. This is a plan to implement, not a claim that the
features are already present.

Begin with T01. Verify the current repository and process state before
editing. Use isolated data roots and synthetic fixtures. Do not interrupt
another agent's active application cycle. Do not run the existing worker
while it injects Playwright; current browser interaction must use Neo/CDP.

Implement the complete requested learning system, not just an answer cache.
Preserve canonical profile/tracker sources, approved-answer authority,
immutable attempt history, uncertain-submission handling, and all acceptance
tests. Do not replace upstream Career Ops or patch its root scripts/web app.

Record progress and evidence in EXECUTION-LOG.md inside the plan directory.
For each task, record changed files, commands, results, known limitations,
and the next task. Mark checkboxes only after the associated checks pass.

Use the decision-register defaults. Missing approval blocks only cloud spend,
deployment, live service activation, personal-source changes, or the specific
external action, not independent local implementation. Do not invent consent.
No commits, branches, push, automatic public-profile edits, scheduled
applications, or self-applied code/UI changes without separate authorization.

If code has changed since 58ff2858, reconcile the plan with the actual shared
helpers and signatures, preserve the requirements, and document the deviation.
Do not silently drop a task because a convenient library lacks the capability.
```

## First commands: read-only

```bash
cd '/Users/jarvis/AI-Playground/career-ops/career-ops'
git status --short
git rev-parse HEAD
node --version
node --input-type=module -e "import {getCareerOpsRoot} from './path-resolver.mjs'; console.log(getCareerOpsRoot())"
rg -n '^export (async )?function' pipeline-lock.mjs application-answers.mjs auto/state.mjs
```

Inspect the relevant instructions and service/process metadata without printing credentials. Do not start `auto/run.mjs`, reset pause flags, call application actions, or run the panel's existing self-test against live data.

## Progress record

Create `EXECUTION-LOG.md` on execution, not by marking this plan completed. Start with the actual HEAD, code/data roots, instruction version, safe test root, and decision-register state.

For each task use:

```text
Task: T01
Status: not_started | in_progress | implemented | verified | blocked
Files changed:
Checks run and exit codes:
Observed result:
External actions: none, or exact approved operation and evidence reference
Decisions used:
Remaining uncertainty:
Next task:
```

Also maintain these generated execution artifacts under `data/auto/learning/reports/` in the appropriate scratch/live root: `baseline.json`, `migration-manifest.json`, `backfill-summary.json`, `acceptance.json`, `privacy-audit.json`, and `rollout.json`. They are private runtime artifacts, not source files to commit.

## Resume behavior

On a fresh agent session, read the execution log, check git status, inspect the last task's actual code and evidence, and resume the first incomplete task. Never assume an earlier agent's narrative proves its test or external action succeeded. Do not repeat a paid call or employer submission whose outcome is unknown.

## Parallel ownership, if multiple agents are available

- Coordinator owns `CONTRACTS.md`, `auto/state.mjs`, `auto/run.mjs`, `auto/apply-worker.mjs`, shared storage/config, integration tests, and activation.
- After T02 contracts pass, one agent may own the isolated Lambda package and its mocked tests.
- After API contracts freeze, separate agents may own the questions view, intelligence view, and operations/proposals view as separate files.
- Assign a single owner to `auto/panel.mjs` and the small `auto/panel.html` integration patch. Do not let parallel agents edit the same large HTML file.
- Review each result against the frozen contracts before integrating. No shared live browser session for parallel mutation.

## Completion report

Report four separate states: code implemented; offline checks passed; activated locally/cloud; live user journey verified. List disabled or approval-gated capabilities explicitly. Include the evidence paths and rollback status. Do not claim universal ATS coverage, exhaustive future questions, guaranteed hiring improvement, or external exactly-once submission.
