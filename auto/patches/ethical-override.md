# Patch: Ethical Use override — autonomous submit authorization

**What this changes:** the single bullet in `AGENTS.md` (## Ethical Use)
that forbids submitting without per-application user review.

**Why it is sanctioned:** the repository owner explicitly authorized the
local autonomous apply pipeline (`auto/apply-worker.mjs`) to submit
applications unattended (plan `.kilo/plans/1791387517768-autonomous-apply-pipeline.md`,
approved 2026-10-07; "don't keep anything manual" directive 2026-10-07).
This is a **local-only** deviation from upstream — never commit it upstream
or copy it to another checkout.

**Scope limits (unchanged by this patch):**
- Only `auto/apply-worker.mjs` submits unattended, and only for jobs that
  scored ≥ `score_threshold`, passed the fact gate, and have standing
  answers (`config/standing-answers.yml`, ported user-confirmed data).
- Interactive sessions still stop before Submit.
- Eligibility facts come verbatim from `config/profile.yml` — never fabricated.
- Every attempt writes the full audit dir (`output/<app-key>/audit/`).

**Re-apply after upstream updates:**

```
node auto/patches/apply-ethical-override.mjs          # idempotent apply
node auto/patches/apply-ethical-override.mjs --check  # exit 1 if missing
```

The exact old/new strings live in `apply-ethical-override.mjs` so the apply
is deterministic and checkable.
