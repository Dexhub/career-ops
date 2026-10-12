#!/usr/bin/env node
// auto/active-lite-demo.mjs — dry demonstration of the active-lite reuse bridge.
// Shows: (1) which observations from the real captured data are selected for
// reuse, (2) which are excluded because they are sensitive, (3) what the
// injected prompt section looks like, (4) what auto-promotion would promote
// from the live store (if any approved answers exist).
//
// This script is READ-ONLY: it never promotes, never writes to the store,
// and never launches an application. It uses the live learning store from
// data/auto/learning.
//
// Usage:
//   node auto/active-lite-demo.mjs

import { createLearningContext, readLearningConfig } from './learning/context.mjs';
import { listRecords } from './learning/store.mjs';
import { normalizeQuestion } from './learning/questions.mjs';
import { isSensitiveNormalizedText } from './learning/promotion.mjs';
import { buildReuseSuggestions, formatReuseSuggestions } from './apply-worker.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = getCareerOpsRoot();

const ctx = createLearningContext({ codeRoot: ROOT, dataRoot, now: () => new Date() });
const config = readLearningConfig(ctx);

console.log('=== active-lite reuse bridge — dry demonstration ===\n');
console.log(`config.reuse: ${JSON.stringify(config.reuse)}`);
console.log(`config.mode: ${config.mode}, config.enabled: ${config.enabled}\n`);

// 1. Load captured observations from the live store.
const { items: observations } = listRecords(ctx, 'observations', { limit: 500 });
console.log(`--- Captured observations in store: ${observations.length} total ---\n`);

let safeCount = 0;
let sensitiveCount = 0;
let selectedObs = [];

for (const obs of observations) {
  const data = obs.data;
  if (!data.originalText || data.originalText.trim() === '') continue;
  let normalizedText = '(normalize failed)';
  let restricted = false;
  try {
    const def = normalizeQuestion(data);
    normalizedText = def.normalizedText;
    restricted = def.constraints.restricted;
  } catch { continue; }

  if (restricted) {
    console.log(`  RESTRICTED  | ${data.originalText.slice(0, 60)}`);
    sensitiveCount++;
    continue;
  }

  if (isSensitiveNormalizedText(normalizedText)) {
    console.log(`  SENSITIVE   | ${data.originalText.slice(0, 60)}`);
    sensitiveCount++;
  } else {
    console.log(`  SAFE (reuse)| ${data.originalText.slice(0, 60)}`);
    safeCount++;
    if (selectedObs.length < 12) selectedObs.push(data);
  }
}

console.log(`\nSummary: ${safeCount} safe (eligible for reuse), ${sensitiveCount} sensitive/restricted (excluded)\n`);

// 2. Check auto-promotion eligibility from the store.
console.log('--- Promotion check: approved answers in store ---\n');
const { items: answers } = listRecords(ctx, 'answers', { limit: 500 });
const { items: families } = listRecords(ctx, 'families', { limit: 500 });

const approvedFamilies = new Map(families.filter((f) => f.status === 'approved').map((f) => [f.id, f]));
let promotable = 0;
let sensitiveBlocked = 0;

for (const ans of answers) {
  if (ans.status !== 'proposed') continue;
  const fam = approvedFamilies.get(ans.data?.questionFamilyId);
  if (!fam) continue;
  // Check if all question IDs in the family are safe.
  const qids = fam.data?.questionIds ?? [];
  const isSafe = qids.length > 0 && qids.every((qid) => {
    const { getRecord } = { getRecord: (c, col, id) => null }; // simplified
    return false; // real check requires getRecord; demo shows structure
  });
  if (isSafe) promotable++;
  else sensitiveBlocked++;
}

if (answers.length === 0) {
  console.log('No answers in store yet (shadow mode is still accumulating observations).');
  console.log('Once families + answers are established, auto-promotion will run here.\n');
} else {
  console.log(`Approved answers: ${answers.filter((a) => a.status === 'approved').length}`);
  console.log(`Proposed answers: ${answers.filter((a) => a.status === 'proposed').length}`);
  console.log('(Full promotion check requires getRecord for each question — run promoteSafeAnswers() for real counts)\n');
}

// 3. Build and format a reuse suggestions block from safe observations.
console.log('--- Reuse context packet from live store (safe observations only) ---\n');

if (selectedObs.length === 0) {
  console.log('No safe observations found — no suggestions to inject.\n');
} else {
  const packet = buildReuseSuggestions(ctx, { observations: selectedObs, maxBytes: config.retrieval.max_context_bytes });
  if (!packet || packet.answers.length === 0) {
    console.log(`Built packet with ${selectedObs.length} safe observations — 0 approved answers resolved.`);
    console.log('(This is expected when the store has observations but no approved answer records yet.)\n');
    console.log('Gaps (questions with no approved answer):');
    if (packet?.gaps) {
      for (const g of packet.gaps.slice(0, 5)) {
        console.log(`  ${g.fieldId ?? g.questionId}: ${g.reason}`);
      }
    }
  } else {
    console.log(`Resolved ${packet.answers.length} approved answers from ${selectedObs.length} safe observations:\n`);
    const block = formatReuseSuggestions(packet);
    console.log(block.split('\n').map((l) => '  ' + l).join('\n'));
  }
}

// 4. Show the sensitive question names from captured data.
console.log('\n--- Sensitive questions excluded from reuse (sample) ---\n');
const sensitiveQuestions = observations
  .filter((obs) => {
    const data = obs.data;
    if (!data.originalText) return false;
    try {
      const def = normalizeQuestion(data);
      return isSensitiveNormalizedText(def.normalizedText);
    } catch { return false; }
  })
  .map((obs) => obs.data.originalText)
  .slice(0, 10);

if (sensitiveQuestions.length === 0) {
  console.log('None found in the captured observations.\n');
} else {
  for (const q of sensitiveQuestions) {
    console.log(`  [excluded] ${q}`);
  }
}

console.log('\n=== end demonstration ===');
