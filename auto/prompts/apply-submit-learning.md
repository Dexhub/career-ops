## Learning capture protocol (this run only)

Continuous learning capture is enabled for this attempt. Attempt ID: {{ATTEMPT_ID}}.
Every capture file lives under {{AUDIT_DIR}}/learning/ — never anywhere else.

For EVERY distinct form page, BEFORE filling it:

1. Inspect the page and write {{AUDIT_DIR}}/learning/input-<stepId>.json:
   `{"stepId": "<stepId>", "pageIdentity": {"employerName": ..., "atsVendor": ..., "roleTitle": ..., "country": ..., "locale": ...}, "expectedFieldCount": <total labeled controls on this page>, "fields": [...]}`.
   One entry per labeled control, INCLUDING optional fields you leave
   unanswered: `fieldId`, `fieldType` (text|textarea|select|radio|checkbox|date|number|file|custom|unknown),
   `originalText` (the exact visible label), `options` (the ACTUAL options the
   control offers right now, as `[{"value": ..., "label": ...}]` — open the
   dropdown and read them; never recall options from memory), `required`,
   `parentCondition` (label of the controlling field, or null).
2. Record it: `node auto/learn.mjs observe-page --attempt-id {{ATTEMPT_ID}} --input {{AUDIT_DIR}}/learning/input-<stepId>.json --apply`
3. Resolve known answers: `node auto/learn.mjs resolve-page --attempt-id {{ATTEMPT_ID}} --input {{AUDIT_DIR}}/learning/input-<stepId>.json`
   The returned packet's `answers` are user-approved values with provenance —
   use them VERBATIM for their fields instead of inferring. Each `gaps` entry
   is a missing fact: do NOT guess or infer it; it has been recorded as a
   structured blocker. Answer gaps only from the profile/standing material in
   this prompt, and leave truly unknown required facts for status "parked".
4. For every dropdown/select, verify the committed value after choosing: the
   control must display the chosen option. A typed-but-uncommitted value, or
   an option remembered from an earlier form version, is NOT success.
5. After the page is filled and saved, checkpoint it: write
   {{AUDIT_DIR}}/learning/ck-<stepId>.json containing
   `{"evidenceRefs": ["learning/input-<stepId>.json"]}` and run
   `node auto/learn.mjs checkpoint --attempt-id {{ATTEMPT_ID}} --phase filled --input {{AUDIT_DIR}}/learning/ck-<stepId>.json`.

Save observations BEFORE advancing to the next page — a crash must never lose
an observed page. A very large page may be split across several observe-page
calls with stable fieldIds, as long as `expectedFieldCount` states the real
total. Never put passwords, tokens, one-time codes, or full copies of the
profile/CV into capture files or command output.
