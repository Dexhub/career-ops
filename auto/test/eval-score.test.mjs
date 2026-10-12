// auto/test/eval-score.test.mjs — Regression tests for the F1 score-extraction
// fix in eval-queue.mjs. Exercises parseReportScore and stripThinkBlocks
// against report fixtures that triggered the defect.
//
// Run: node --test auto/test/eval-score.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReportScore, stripThinkBlocks } from '../eval-queue.mjs';

// ── Fixture A: Carrier report (job 2490) ────────────────────────────────────
// The eval model emitted a <think> block containing "Confidence Score: 5/5"
// before the real "**Score:** 3.8/5" line. The old unanchored regex matched 5.
const CARRIER_FIXTURE = `\
# Evaluation: unknown — unknown

**Date:** 2026-10-11
**Score:** ?/5
**URL:** https://carrier.wd5.myworkdayjobs.com/jobs/job/...

<think>

The user wants me to evaluate a Job Description (JD) against the candidate's CV.

**Constraint Checklist & Confidence Score:**
1. Access to WebSearch/Playwright: NO (Operating Rule 1).
2. Generate Blocks A-G in full: YES.

Confidence Score: 5/5 (All constraints understood and followed).

**Plan:**
1. Analyze Candidate Profile.
</think>

# Evaluation: Carrier Global Corporation — Principal Power Electronics Solutions Architect

**Date:** 2024-06-19
**Score:** 3.8/5
**Legitimacy:** Proceed with Caution

---

## Machine Summary
\`\`\`yaml
advertised_comp: "$117,500.00 - $234,500.00 annually"
score: 3.8
legitimacy: Proceed with Caution
\`\`\`
`;

// ── Fixture B: Well-formed yaml-trailer report ───────────────────────────────
// Standard report with a proper yaml fence block — the yaml rung should win.
const YAML_TRAILER_FIXTURE = `\
# Evaluation: Acme Corp — Senior Engineer

**Score:** 4.5/5
**Date:** 2026-10-01

---

Some analysis text here.

## Machine Summary
\`\`\`yaml
score: 4.5
legitimacy: Good
machine_summary_confidence: High
\`\`\`
`;

// ── Fixture C: Markdown emphasis form only (no yaml trailer) ─────────────────
// Report where the only parseable score is `**Score:** 4.2/5` in the body.
const MARKDOWN_BODY_FIXTURE = `\
# Evaluation: TechCorp — VP Engineering

**Date:** 2026-09-15

---

## Summary

**Score:** 4.2/5

The candidate is a strong match for the role.
`;

// ── Tests ────────────────────────────────────────────────────────────────────

test('stripThinkBlocks removes single-line think block', () => {
  const result = stripThinkBlocks('<think>Confidence Score: 5/5</think>\n**Score:** 3.8/5');
  assert.ok(!result.includes('Confidence Score'), 'think block content should be removed');
  assert.ok(result.includes('**Score:** 3.8/5'), 'real score line should survive');
});

test('stripThinkBlocks removes multi-line think block', () => {
  const result = stripThinkBlocks('<think>\nLine 1\nConfidence Score: 5/5\nLine 3\n</think>\nReal content');
  assert.ok(!result.includes('Confidence Score'), 'multi-line think block content should be removed');
  assert.ok(result.includes('Real content'), 'content after think block should survive');
});

test('(a) Carrier report: think-block hijack — parses 3.8 not 5.0', () => {
  const { score, source } = parseReportScore(CARRIER_FIXTURE);
  assert.strictEqual(score, 3.8, `expected 3.8 but got ${score} (defect: think-block "Confidence Score: 5/5" was matched)`);
  // yaml trailer wins (score: 3.8 is in the yaml block)
  assert.strictEqual(source, 'yaml', `expected source=yaml but got ${source}`);
});

test('(b) Yaml-trailer report: parses 4.5 from yaml rung', () => {
  const { score, source } = parseReportScore(YAML_TRAILER_FIXTURE);
  assert.strictEqual(score, 4.5, `expected 4.5 but got ${score}`);
  assert.strictEqual(source, 'yaml', `expected source=yaml but got ${source}`);
});

test('(c) Markdown-emphasis body: **Score:** 4.2/5 parses 4.2', () => {
  const { score, source } = parseReportScore(MARKDOWN_BODY_FIXTURE);
  assert.strictEqual(score, 4.2, `expected 4.2 but got ${score}`);
  assert.strictEqual(source, 'body', `expected source=body but got ${source}`);
});

test('parseReportScore returns null for report with no score', () => {
  const { score, source } = parseReportScore('# Evaluation\n\nNo score here.\n');
  assert.strictEqual(score, null);
  assert.strictEqual(source, null);
});

test('"Confidence Score: 5/5" in body (not think) is NOT matched as job score', () => {
  // A line mid-sentence or with a prefix should not match — only bare "Score:" at line start
  const body = 'All constraints followed.\nConfidence Score: 5/5 (very high)\n**Score:** 3.5/5\n';
  const { score } = parseReportScore(body);
  assert.strictEqual(score, 3.5, `expected 3.5 (real score) but got ${score} (was hijacked by Confidence Score line)`);
});
