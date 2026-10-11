# T28 — Synthetic journey verification (fixture only)

Date: 2026-10-11 · Branch: `learning-system` · Scope: SYNTHETIC-FIXTURE checkboxes 1–2 only.
D06 real-case checkboxes: **pending-authorization** (not approved; not attempted).

`offline_verified: yes` · `live_journey_verified: false` (reason: D06 not approved)

## Setup

- Fixture root (mkdtemp, isolated): `/var/folders/2w/ldbyzqn12qv6_2zfwz7jtm2c0000gn/T/career-learning-t28-IWSYbC`
  with `CAREER_OPS_ROOT` + `CAREER_OPS_DB=<root>/career-ops-test.db`. Live panel :3001 never touched.
- Fixture panel: `node auto/panel.mjs --port 3014` under the fixture env.
- Side driver: `/var/folders/2w/ldbyzqn12qv6_2zfwz7jtm2c0000gn/T/kilo/t28-driver.mjs`
  (`seed|propose|resume|reuse|revoke`, state in `<root>/t28-state.json`). Synthetic values only.
- Browser: BrowserOS Neo session `kilo/t28-fixture-journey`, own tab on `http://127.0.0.1:3014/auto#learning`.

## Checkbox 1 — complete journey via Neo (PASS)

| Step | Evidence |
| --- | --- |
| Observe new question | Learning → Questions shows `what is your synthetic deployment window (weeks)` — text, 1×, status `proposed`, answer `unknown`, occurrence `occ-e17feef925fe56ccc838a50bde547a3b87f39465` (screenshot in session) |
| Propose (driver) | `prop-2c9441c6-3c96-462a-af26-8dc016a7ce55` rev 1, standing@`a8bf5261a6c0…`, scope `{locale:'en-US'}` |
| Approve via UI | Candidate knowledge → approve button → blocking `confirm()` dialog (shows target `standing → custom.t28_synthetic_window`, value `6 synthetic weeks`, source hash, affected app) → accepted. Committed re-read: proposal applied (rev 2), answer `ans-prop-2c9441c6-…` **approved**, source hash `e99cda8c6f4a` confirmed on the committed answer record, 0 open answer blockers |
| Reload persists | Full page reload → Candidate knowledge still shows confirmed `ans-prop-2c9441c6-…` · `standing@e99cda8c6f4a` · authority `user_confirmed` · family `fam-t28-window` |
| Resume same application | Driver `resume` (job1 `ea18704d2df0…`, new attempt `att-t28-1-resume`): same applicationId, stage `resume_ready`, occurrence deduplicated, resolution **ready** = `6 synthetic weeks`, reason `current approved source-bound answer`, bound to committed hash `e99cda8c6f4a…` |
| Reuse in another fixture application | Driver `reuse` (job2 `bc69b815f8bc…`, t28-beta-co): new occurrence, resolution **ready**, same answer id + committed hash |
| Revoke | Driver `revoke`: standing file deleted → `invalidateSource(standing, oldHash→null)` → revoked `[ans-prop-2c9441c6-…]`, sourceChange `srcchg-457dc7f2-…` |
| Reuse stops | Post-revoke resolution: **blocked**, value `null`, reason `missing_information: no approved source answers …` — never a guess. UI after reload: Confirmed knowledge (0), **Revoked (1)**, Blockers (0) (screenshot in session) |

## Checkbox 2 — restart/retry/tracker-repair guarantees (PASS, existing tests)

The wording is pinned by existing driver-based node tests in `auto/test/learning-acceptance.test.mjs`
(fake clock/mailbox/tracker drivers from `auto/test/helpers/learning-matrix.mjs`; no new test added):

- **A13** (line 296): saved account-verification wait survives two restarts; exactly one account; correct tenant; same application resumed.
- **A14** (line 331): wrong-tenant, stale, and marketing messages never verify; mailbox otherwise untouched; no link/body persisted.
- **A15** (line 359): uncertain fake submission → outcome `unknown`; requeue refused with `SUBMISSION_OUTCOME_UNKNOWN` (no second submit); operator resolution clears the blocker.
- **A17** (line 417): tracker write failure after confirmed submit → `submitted` stands, retry bookkeeping only; later sync repairs the row without another submit.

Full suite run after the journey: `node --test auto/test/learning-*.test.mjs auto/learning/cloud/test/*.test.mjs`
→ **409 pass, 0 fail**.

## Material finding (reported to coordinator, not fixed — verification-only scope)

An answer approved from a proposal **without an explicit scope** defaults to `scope.locale: 'en'`
(`auto/learning/answers.mjs:590`), and `resolveAnswer` scope matching is exact (`answers.mjs:112`).
Observations record BCP-47 locales such as `en-US`, and the production resolve path passes no policy
mappings (`auto/learn.mjs:348` — `resolvePage` → `buildContextPacket` with no `policy`). Consequently an
unscoped proposal's approved answer can never be reused for an `en-US` observation. Reproduced: first
fixture run (`career-learning-t28-DnYUof`) resolved `blocked/missing_information` after a UI-approved
answer; re-running with the proposal carrying `scope:{locale:'en-US'}` resolved `ready`. Follow-up
decision needed: derive default scope locale from the proposal's affected observations, or make locale
matching language-prefix aware.

Also noted: approval re-hashes the standing file at commit time — the committed answer binds the
post-write hash (`e99cda8c6f4a…`), not the pre-approval hash shown in the proposal (`a8bf5261a6c0…`).
This is correct behavior (A05 pins it) but revocation tooling must compute the current file hash, not
reuse the proposal's.

## D06-gated checkboxes (NOT attempted)

Checkboxes 3–6 of T28 require a D06-authorized real case. D06 is not approved, so they remain
unticked and annotated pending-authorization. Delivery against a real employer application remains
**unverified**; no real job, account, or submission was touched.

## Cleanup

Fixture panel :3014 stopped; fixture roots left on disk for audit
(`career-learning-t28-DnYUof` — first run with the blocked-reuse repro; `career-learning-t28-IWSYbC` —
final journey). Neo fixture tab closed; live panel and other agents' tabs untouched.
