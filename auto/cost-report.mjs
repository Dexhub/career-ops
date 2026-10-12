#!/usr/bin/env node
// auto/cost-report.mjs — T2.4(c): per-attempt cost telemetry aggregator.
//
// Reads all verdict.json files in output/ and aggregates usage telemetry.
// Honest about missing data coverage ("cost known for N of M applies").
//
// Usage:
//   node auto/cost-report.mjs
//   node auto/cost-report.mjs --json           # machine-readable output
//   node auto/cost-report.mjs --output <dir>   # override output dir

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const jsonFlag = process.argv.includes('--json');
const outputOverrideIdx = process.argv.indexOf('--output');
const OUTPUT_DIR = outputOverrideIdx !== -1
  ? process.argv[outputOverrideIdx + 1]
  : join(ROOT, 'output');

// ---------------------------------------------------------------------------

function collectVerdicts(outputDir) {
  const verdicts = [];
  if (!existsSync(outputDir)) return verdicts;

  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobDir = join(outputDir, entry.name);
    const auditDir = join(jobDir, 'audit');

    // New layout: audit/<attempt-id>/verdict.json
    if (existsSync(auditDir)) {
      for (const ae of readdirSync(auditDir, { withFileTypes: true })) {
        if (!ae.isDirectory()) continue;
        const vp = join(auditDir, ae.name, 'verdict.json');
        if (existsSync(vp)) {
          const v = tryParse(vp);
          if (v) verdicts.push({ path: vp, verdict: v });
        }
      }
    }

    // Legacy layout: attempt-1/verdict.json or attempt-2/verdict.json at jobDir level
    for (const ae of readdirSync(jobDir, { withFileTypes: true })) {
      if (!ae.isDirectory() || ae.name === 'audit') continue;
      const vp = join(jobDir, ae.name, 'verdict.json');
      if (existsSync(vp)) {
        const v = tryParse(vp);
        if (v) verdicts.push({ path: vp, verdict: v });
      }
    }
  }

  return verdicts;
}

function tryParse(fp) {
  try { return JSON.parse(readFileSync(fp, 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------

function aggregate(verdicts) {
  let total = 0;
  let withCost = 0;
  let withTokens = 0;
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokensTotal = 0; // codex-style single count
  let byAgent = {};
  let byStatus = {};
  let byModel = {};

  for (const { verdict: v } of verdicts) {
    total++;
    const agent = v.agent || 'unknown';
    const status = v.status || 'unknown';
    const model = v.model || 'unknown';

    byAgent[agent] = (byAgent[agent] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    byModel[model] = (byModel[model] || 0) + 1;

    const u = v.usage;
    if (!u || u.source === 'none') continue;

    if (typeof u.costUsd === 'number') {
      withCost++;
      totalCostUsd += u.costUsd;
    }
    if (typeof u.inputTokens === 'number' || typeof u.tokensTotal === 'number') {
      withTokens++;
      if (typeof u.inputTokens === 'number') totalInputTokens += u.inputTokens;
      if (typeof u.outputTokens === 'number') totalOutputTokens += u.outputTokens;
      if (typeof u.tokensTotal === 'number') totalTokensTotal += u.tokensTotal;
    }
  }

  return {
    totalAttempts: total,
    withCostData: withCost,
    withTokenData: withTokens,
    totalCostUsd: round2(totalCostUsd),
    avgCostUsdPerApply: withCost > 0 ? round2(totalCostUsd / withCost) : null,
    totalInputTokens,
    totalOutputTokens,
    totalTokensTotal,
    coveragePct: total > 0 ? Math.round((withTokens / total) * 100) : 0,
    byAgent,
    byStatus,
    byModel,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------------

const verdicts = collectVerdicts(OUTPUT_DIR);
const stats = aggregate(verdicts);

if (jsonFlag) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

console.log('career-ops cost report');
console.log('======================');
console.log(`Output dir    : ${OUTPUT_DIR}`);
console.log(`Total attempts: ${stats.totalAttempts}`);
console.log(`Cost known    : ${stats.withCostData} of ${stats.totalAttempts} attempts` +
  ` (${Math.round((stats.withCostData / Math.max(stats.totalAttempts, 1)) * 100)}%)`);
console.log(`Token data    : ${stats.withTokenData} of ${stats.totalAttempts} attempts` +
  ` (${stats.coveragePct}%)`);
console.log('');
if (stats.withCostData > 0) {
  console.log(`Total cost    : $${stats.totalCostUsd.toFixed(2)}`);
  console.log(`Avg cost/apply: $${(stats.avgCostUsdPerApply ?? 0).toFixed(3)} (claude-only; codex cost not reported by CLI)`);
} else {
  console.log('Total cost    : unknown (no claude-output.txt usage JSON found yet — run a claude attempt first)');
}
if (stats.totalInputTokens > 0) {
  console.log(`Input tokens  : ${stats.totalInputTokens.toLocaleString()}`);
  console.log(`Output tokens : ${stats.totalOutputTokens.toLocaleString()}`);
}
if (stats.totalTokensTotal > 0) {
  console.log(`Codex tokens  : ${stats.totalTokensTotal.toLocaleString()} (total, no split)`);
}
console.log('');
console.log('By agent:');
for (const [k, v] of Object.entries(stats.byAgent).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)}: ${v}`);
}
console.log('');
console.log('By status:');
for (const [k, v] of Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)}: ${v}`);
}
console.log('');
console.log('Note: cost data is available only for claude attempts (claude-output.txt JSON).');
console.log('      Codex reports a total token count only; per-token pricing not applied.');
