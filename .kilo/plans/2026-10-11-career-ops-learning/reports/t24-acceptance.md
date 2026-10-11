# T24 acceptance evidence — learning UI accessibility, usability, scale

Date: 2026-10-11 · Branch: `learning-system` · Fixture only (panel :3013, scratch root under tmpdir); live panel :3001 never touched.

## Environment
- Hardware/runtime: Apple Silicon (arm64) macOS, Node v26.7.0
- Fixture: `career-learning-t24-*` mkdtemp root, `config/learning.yml` enabled, panel started with `CAREER_OPS_ROOT=<scratch> node auto/panel.mjs --port 3013`
- Corpus: 10,000 synthetic questions (5 field types, 5 role families, 5 companies, 10 wording stems; 1/7 proposed, rest approved) + 2 synthetic answer proposals

## Measured performance (never asserted without measuring)
API (loopback, fixture panel, 10k questions):

| metric | n | p50 | p95 | max |
|---|---|---|---|---|
| GET /questions page (limit=200) | 50 | 10.5 ms | 12.2 ms | 40.3 ms |
| page payload bytes | 50 | 87,881 | 87,881 | 87,881 |
| first page (limit=200) | 30 | 7.3 ms | 7.9 ms | 8.2 ms |
| GET /question?id= | 30 | 0.48 ms | 0.60 ms | 0.83 ms |
| GET /status | 20 | 0.40 ms | 0.51 ms | 0.77 ms |

- Full 50-page walk (10,000 records): 569 ms total.
- Browser: Learning tab mount over the corpus (client walks 50×100-record pages = 5,000 records): **1,205 ms** to first rendered table. Search filtering over the fetched set: 4.9–25.1 ms. Sub-tab switch: 2.6 ms.
- `rebuildIndexes` on the 10k corpus: 1,204/1,084/1,072 ms (3 runs) — basis for the api.mjs post-write refresh fix.
- No unbounded responses: API caps limit at 200; client caps at 50 pages; table render capped at 500 rows (new `MAX_RENDERED_ROWS`). All caps are announced in the UI, never silent.

## Defects found and fixed (surgical, in allowed scope)
1. **Stale lists after every consequential POST (real data-loss-appearance bug, `auto/learning/api.mjs`).** Commits write immutable revision files, but list routes serve a pinned index generation and **nothing in production ever refreshed it** (`rebuildIndexes` had zero production callers). With an index generation present (any seeded store), an approval committed rev 2 while `/proposals` kept returning rev 1 "proposed": the UI's mandatory post-approval re-read honestly displayed the stale server state, and approvals did not survive reload. Repro: Neo on the 10k fixture; `proposals/decision` → list unchanged. Fix: every successful mutating POST route (`answers/propose`, `answers/approve`, `blockers/resolve`, `procedures/promote`, `proposals/decision`, `review`) now awaits `rebuildIndexes(apply:true)` before responding (~1.1 s at 10k, human-speed actions). Regression test: `learning-ui-acceptance.test.mjs` "no stale index". Post-fix Neo re-run: readback shows `now "approved" (revision 2)`, approval survives reload.
2. **Failed first load was silent (`auto/ui/learning/index.mjs`).** With no data yet, a load failure rendered as muted text with no `role=alert` and no retry control. Now: alert + focusable error + reload button.
3. **Unlabeled controls (`questions/profile/intelligence/index`).** Search input, 5 filter selects, date inputs, insights role select, queue preview select, reload (icon-only), per-record reveal/approve/resolve/decide buttons had no accessible names; identical "reveal"/"approve" texts were indistinguishable. Now aria-labels, disambiguated per record id.
4. **No announcements / lost focus.** Errors now `role=alert`, committed-state readbacks `role=status`, both focusable; after every dialog-driven action focus moves to the outcome (`focusFeedback`), verified in-browser (`document.activeElement` lands on the readback). Sub-tabs now expose `aria-pressed` (verified tracking the active tab live).
5. **Unbounded table render (`questions.mjs`).** 10k rows would render without limit; now capped at 500 with an honest "showing first N of M" line, plus a client-cap truncation banner driven by a new honest `truncated` flag from `client.listAll` (previously a cap-exhausted walk was indistinguishable from a complete one).

## State matrix and honesty (unit + browser)
- Loading, failed-load, disabled-feature (all views refuse controls, state the reason), cloud-lane-disabled (local metrics still shown; below-5-sample floor labeled, no fabricated rate), truncation, empty, readback states covered in `auto/test/learning-ui-acceptance.test.mjs` (13 tests).
- Approval/decision round-trip through Neo: confirm dialog (scope-limited wording), POST, server re-read readback, focus on readback, persistence across reload — all verified post-fix.
- Console: zero errors/warnings across the whole journey (mount over 10k, search, tab switches, approval, reloads).

## Accessibility spot checks (browser)
- Keyboard: all controls are native button/select/input elements (snapshot roles confirm); tab order is document order.
- Reduced motion: `learning.css` contains zero animations/transitions — nothing to suppress.
- Contrast (computed): light theme text 15.6:1, muted ≈6.4:1; dark theme text ≈19:1, muted ≈9:1, badge ≈11:1 — AA passes in both existing themes. No new aesthetic introduced; existing tokens untouched.
- Responsive at 390×844: no horizontal page overflow on Questions or Proposals views.

## Phase 5 gate verdicts
1. "Learned about me / where from / what roles ask / what changed" — all four answerable from the Learning pane tabs (verified live with corpus + proposals). PASS
2. Approval survives reload, server consumes it in the correct operation — **failed before the index fix; PASS after** (evidence above; decision route validates id/revision/state server-side).
3. Insight growth executes no generated code — `SUPPORTED_CARD_TYPES` allowlist + `CODE_PAYLOAD_KEYS` refusal path (unit-tested); refused cards surface as implementation-review proposals. PASS
4. Sensitive/stale/incomplete honesty — `[redacted-sensitive]` masking with per-record reveal, truncation banners, below-floor sample labels, stale-generation 409s surfaced as refresh errors. PASS
5. Mission Control + proxy flows usable, no live application action — fixture-only; Start cycle control untouched and disabled; live :3001 never contacted; employer tabs untouched. PASS

## Deployment note
All UI/API changes here are source-only. **Nothing is deployed**: the live panel on :3001 still runs the old code until the T27 panel restart.
