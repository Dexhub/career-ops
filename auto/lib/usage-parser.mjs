// auto/lib/usage-parser.mjs — T2.4: parse per-attempt cost/token telemetry
// from agent output files. Never invents prices. Never throws (always returns
// a partial object so the caller can merge into verdict.json safely).
//
// Exported:
//   parseAgentUsage(auditDir, agent) → UsageResult
//   parseClaudeUsageLine(line)       → ClaudeUsage | null  (testable unit)
//   parseCodexUsageSection(text)     → CodexUsage | null   (testable unit)

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {{ tokensTotal?: number, inputTokens?: number, outputTokens?: number,
 *   cacheReadTokens?: number, cacheCreationTokens?: number,
 *   costUsd?: number, model?: string, durationMs?: number, agent: string,
 *   source: 'claude-json' | 'codex-summary' | 'none' }} UsageResult
 */

// ---------------------------------------------------------------------------
// Claude: the LAST line of claude-output.txt is a JSON object (type: "result")
// with usage, modelUsage, total_cost_usd, duration_ms.

/**
 * Parse a single Claude result-JSON line.
 * @param {string} line
 * @returns {object|null}
 */
export function parseClaudeUsageLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return null; }
  if (obj.type !== 'result') return null;

  const usage = obj.usage ?? {};
  const durationMs = typeof obj.duration_ms === 'number' ? obj.duration_ms : null;
  const costUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;

  // Pick the primary model from modelUsage (first key) or from a nested field
  let model = null;
  const modelUsage = obj.modelUsage ?? {};
  const modelKeys = Object.keys(modelUsage);
  if (modelKeys.length > 0) model = modelUsage[modelKeys[0]]?.canonicalModel ?? modelKeys[0];

  const result = { source: 'claude-json', agent: 'claude' };
  if (typeof usage.input_tokens === 'number') result.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') result.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') result.cacheReadTokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') result.cacheCreationTokens = usage.cache_creation_input_tokens;
  if (costUsd !== null) result.costUsd = costUsd;
  if (durationMs !== null) result.durationMs = durationMs;
  if (model) result.model = model;

  return result;
}

// ---------------------------------------------------------------------------
// Codex: output ends with the literal text:
//   tokens used\n<NUMBER>\n
// where <NUMBER> is the total token count (comma-formatted, e.g. "666,496").
// No cost data is available from codex output.

/**
 * Parse the codex token summary section from the full output text.
 * @param {string} text
 * @returns {object|null}
 */
export function parseCodexUsageSection(text) {
  // Pattern: "tokens used" on its own line, followed by a number line
  const match = text.match(/tokens used\s*\n\s*([\d,]+)/i);
  if (!match) return null;
  const raw = match[1].replace(/,/g, '');
  const total = parseInt(raw, 10);
  if (!Number.isFinite(total) || total <= 0) return null;
  return { source: 'codex-summary', agent: 'codex', tokensTotal: total };
}

// ---------------------------------------------------------------------------
// Top-level: pick the right parser based on agent, return a safe partial

/**
 * Read and parse usage telemetry from an agent's output file in auditDir.
 * @param {string} auditDir
 * @param {string} agent  'claude' | 'codex'
 * @returns {UsageResult}
 */
export function parseAgentUsage(auditDir, agent) {
  const base = { agent, source: 'none' };
  try {
    if (agent === 'claude') {
      const fp = join(auditDir, 'claude-output.txt');
      if (!existsSync(fp)) return base;
      const text = readFileSync(fp, 'utf8');
      // The result JSON is the last non-empty line
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseClaudeUsageLine(lines[i]);
        if (parsed) return { ...base, ...parsed };
      }
      return base;
    }

    if (agent === 'codex') {
      const fp = join(auditDir, 'codex-output.txt');
      if (!existsSync(fp)) return base;
      const text = readFileSync(fp, 'utf8');
      const parsed = parseCodexUsageSection(text);
      if (parsed) return { ...base, ...parsed };
      return base;
    }

    return base;
  } catch {
    return base;
  }
}
