#!/usr/bin/env node
/**
 * auto/eval-queue.mjs — unattended scan→eval bridge (Phase 1 of the auto layer).
 *
 * Reads pending rows from the pipeline_items table (data/career-ops.db,
 * section 'pending', unchecked), and for each row not yet known to
 * the auto state machine:
 *   1. blacklist gate (data/blacklist.md, opt-in; autonomous lane SKIPS on hit
 *      — there is no human to ask, and the user's own recorded decision wins)
 *   2. aggregator gate (LinkedIn/Indeed/... rows are UNCONFIRMED per
 *      AGENTS.md; the auto lane never applies through an aggregator → skip)
 *   3. liveness gate (zero-token ATS API check; expired → skipped)
 *   4. JD text via the ATS public API (fetchJdViaKnownApi)
 *   5. local eval via ollama-eval.mjs (report + tracker addition as usual)
 *   6. record score; promote score >= threshold → queued, else → skipped
 *
 * Idempotent: a job already past `discovered` is never re-evaluated; re-runs
 * only retry rows whose JD fetch previously failed.
 *
 * Usage:
 *   node auto/eval-queue.mjs [--limit N] [--dry-run]
 */

import './lib/sanitize-env.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { normalizeUrl, isAggregatorUrl } from '../url-key.mjs';
import { checkLivenessViaApi } from '../liveness-api.mjs';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { validateFlags, flagValue, safeIntFlag } from '../lib/cli-flags.mjs';
import { loadAutoConfig } from './lib/config.mjs';
import { agentEnabled } from './lib/agent-flags.mjs';
import { createJob, loadJob, updateJob } from './state.mjs';
import { readJobDates, LABELED_SEGMENT } from './learning/freshness.mjs';
import { listPipelineItems } from '../core/db.mjs';

const ROOT = getCareerOpsRoot();
const BLACKLIST_PATH = join(ROOT, 'data/blacklist.md');
const JD_TEXT_CAP = 20_000;
const JD_TIMEOUT_MS = 15_000;

/**
 * Parse pending rows in the legacy pipeline.md line format
 * (`- [ ] url | company | role | ...`), as preserved in pipeline_items.raw.
 * Labeled segments (`posted: 2026-10-08`, `trust: 70`) are recognized only
 * from overall cell index 3 on — the same rule as the web parser
 * (web/src/lib/pipeline-table.mjs) — so company/role stay purely positional
 * and a colon-y role is never misread as metadata. The raw line is retained
 * so date evidence can be read from it (T11).
 * @returns {{url: string, company: string, role: string,
 *            labels: Record<string,string>, raw: string}[]}
 */
export function parsePendingRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[ \] (https?:\/\/\S+)(.*)$/);
    if (!m) continue;
    // Cell 0 is the (empty) remainder next to the URL, keeping indexes aligned
    // with the web parser, where cell 0 is the URL itself.
    const cells = m[2].split('|').map((s) => s.trim());
    const labels = {};
    const positional = [];
    for (const [i, seg] of cells.entries()) {
      if (!seg) continue;
      const lm = i >= 3 ? seg.match(LABELED_SEGMENT) : null;
      if (lm) labels[lm[1].toLowerCase()] = lm[2].trim();
      else positional.push(seg);
    }
    rows.push({ url: m[1], company: positional[0] || '', role: positional[1] || '', labels, raw: line });
  }
  return rows;
}

/** Fold for the blacklist's case- and punctuation-insensitive company match. */
function foldCompany(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Blacklist rules from data/blacklist.md (markdown table, columns incl.
 * Company and optional Scope). Absent file → empty list → gate off.
 * @returns {{company: string, scope: string}[]}
 */
export function loadBlacklist(path = BLACKLIST_PATH) {
  if (!existsSync(path)) return [];
  const rules = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim()).filter((s, i, a) => !(i === 0 && !s) && !(i === a.length - 1 && !s));
    if (cells.length < 1) continue;
    const company = cells[0];
    if (!company || /^-+$/.test(company) || /^company$/i.test(company)) continue;
    const scope = (cells[1] || 'company').toLowerCase();
    rules.push({ company, scope: scope === 'domain' ? 'domain' : 'company' });
  }
  return rules;
}

/** @returns {string|null} matched rule description, or null. */
export function blacklistHit(rules, company, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* company rules still apply */ }
  for (const rule of rules) {
    if (rule.scope === 'domain') {
      const d = rule.company.toLowerCase().replace(/\.$/, '');
      if (host && (host === d || host.endsWith(`.${d}`))) return `domain:${d}`;
    } else if (foldCompany(rule.company) && foldCompany(rule.company) === foldCompany(company)) {
      return `company:${rule.company}`;
    }
  }
  return null;
}

/**
 * Strip `<think>...</think>` blocks (including multi-line) from text before
 * any score regex is applied. Eval models (e.g. gemma-4-e4b) emit think
 * blocks that contain lines like "Confidence Score: 5/5" which an unanchored
 * regex would match ahead of the real score.
 * @param {string} text
 * @returns {string}
 */
export function stripThinkBlocks(text) {
  // Non-greedy; 's' flag makes . match newlines.
  return text.replace(/<think>.*?<\/think>/gs, '');
}

/**
 * Parse the score from a saved report file body.
 *
 * Priority (F1 fix):
 *   1. yaml trailer: `score: X` (case-insensitive key, after stripping think
 *      blocks). The trailer is the canonical machine-readable rung.
 *   2. Body line: `**Score:** X/5` or `Score: X/5` at the START of a line
 *      (after stripping markdown emphasis ** and __); NOT mid-sentence
 *      "Confidence Score:" variants.
 *
 * Returns `{score: number|null, source: 'yaml'|'body'|null}`.
 * @param {string} body
 * @returns {{score: number|null, source: string|null}}
 */
export function parseReportScore(body) {
  const clean = stripThinkBlocks(body);

  // ── Rung 1: yaml trailer ────────────────────────────────────────────────
  // The trailer is a fenced yaml block near the end of the report, typically:
  //   ```yaml
  //   score: 3.8
  //   ```
  // Accept: `score:` key (case-insensitive), optional surrounding whitespace,
  // numeric value. Scan the LAST yaml fence block so embedded yaml examples
  // in the body do not win.
  const yamlFences = [...clean.matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)];
  for (let i = yamlFences.length - 1; i >= 0; i--) {
    const block = yamlFences[i][1];
    const m = block.match(/^score\s*:\s*([\d.]+)\s*$/im);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v >= 0 && v <= 5) return { score: v, source: 'yaml' };
    }
  }

  // ── Rung 2: body line ──────────────────────────────────────────────────
  // Match `**Score:** X/5` or `Score: X/5` (with or without markdown
  // emphasis) anchored at the BEGINNING of a line. Excludes mid-sentence
  // "Confidence Score: X/5" which would have a non-whitespace prefix.
  for (const line of clean.split('\n')) {
    // Strip markdown emphasis (**text** or __text__) then test line start.
    const stripped = line.replace(/\*\*|__/g, '').trim();
    const m = stripped.match(/^Score:\s*([\d.]+)\s*\/\s*5/i);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v >= 0 && v <= 5) return { score: v, source: 'body' };
    }
  }

  return { score: null, source: null };
}

/**
 * Run ollama-eval.mjs on JD text; parse score + report path from its output.
 * Score provenance (yaml | body | stdout) is returned in `scoreSource`.
 * @returns {{score: number|null, reportPath: string|null, scoreSource: string|null, ok: boolean, error?: string}}
 */
export function runOllamaEval({ jdText, url, model, baseUrl }) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-eval-'));
  const jdFile = join(dir, 'jd.txt');
  writeFileSync(jdFile, jdText, 'utf-8');
  try {
    // baseUrl set → OpenAI-compatible endpoint (e.g. LM Studio) via openai-eval.mjs;
    // otherwise local ollama via ollama-eval.mjs.
    const script = baseUrl ? 'openai-eval.mjs' : 'ollama-eval.mjs';
    const extraArgs = baseUrl ? ['--url', baseUrl] : [];
    const res = spawnSync(process.execPath, [
      join(ROOT, script),
      '--file', jdFile,
      '--model', model,
      '--posting-url', url,
      ...extraArgs,
    ], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 20 * 60 * 1000,
      // Both runners' own request timeout defaults to 300s — too tight for a
      // slow model on this machine (observed timeouts 2026-10-07/09). The
      // LM Studio path reads OPENAI_TIMEOUT_MS, not OLLAMA_TIMEOUT_MS.
      env: {
        ...process.env,
        OLLAMA_TIMEOUT_MS: process.env.OLLAMA_TIMEOUT_MS || '900000',
        OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS || '900000',
      },
    });
    const rawOut = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.status !== 0) {
      return { score: null, reportPath: null, scoreSource: null, ok: false, error: rawOut.trim().split('\n').slice(-3).join(' | ') };
    }

    const reportM = rawOut.match(/Report saved:\s*(reports\/\S+\.md)/);
    let score = null;
    let scoreSource = null;

    // ── Prefer the saved report body (yaml trailer → body line) ──────────
    // This is more reliable than the runner's stdout summary, which is (a)
    // unanchored and (b) printed BEFORE the model's think block is stripped.
    if (reportM) {
      try {
        const body = readFileSync(join(ROOT, reportM[1]), 'utf-8');
        const parsed = parseReportScore(body);
        if (parsed.score !== null) {
          score = parsed.score;
          scoreSource = parsed.source; // 'yaml' or 'body'
        }
      } catch { /* report unreadable — fall through to stdout */ }
    }

    // ── Fallback: stdout summary line (stripped of think blocks) ─────────
    // Only reached when no report was saved or the report had no parseable
    // score. Strip think blocks first so "Confidence Score: 5/5" in a
    // streamed think block cannot hijack the match. Leading whitespace is
    // allowed because both runners indent their summary ("  Score: X/5" —
    // ollama-eval.mjs/openai-eval.mjs); "Confidence Score:" is still excluded
    // by its non-whitespace prefix.
    if (!Number.isFinite(score)) {
      const cleanOut = stripThinkBlocks(rawOut);
      const scoreM = cleanOut.match(/^\s*Score:\s*([\d.]+)\s*\/\s*5/m);
      if (scoreM) {
        score = Number(scoreM[1]);
        scoreSource = 'stdout';
      }
    }

    return {
      score: Number.isFinite(score) ? score : null,
      reportPath: reportM ? reportM[1] : null,
      scoreSource: Number.isFinite(score) ? scoreSource : null,
      ok: Number.isFinite(score),
      error: Number.isFinite(score) ? undefined : 'no score in eval output',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One eval pass over the pipeline. Returns per-row outcomes for the caller
 * (orchestrator/digest) to summarize.
 */
export async function runEvalQueue({ limit, dryRun = false, log = console.log } = {}) {
  const cfg = loadAutoConfig();
  const max = limit ?? cfg.eval.limit_per_cycle;
  const threshold = cfg.score_threshold;
  const model = cfg.eval.model;
  const rules = loadBlacklist();
  const gateBudget = cfg.eval.gate_budget_per_cycle ?? Math.max(max * 10, 100);
  const outcomes = [];

  // Pending inbox rows; raw preserves the legacy `- [ ] url | company | role`
  // line, so company/role parse out of it when present.
  const rows = listPipelineItems({ section: 'pending', checked: 0 }).map((item) =>
    parsePendingRows(item.raw || '')[0]
      ?? { url: item.url, company: '', role: '', labels: {}, raw: item.raw || '' });
  log(`eval-queue: ${rows.length} pending pipeline rows, evaluating up to ${max} (model ${model}, threshold ${threshold})`);

  let processed = 0;
  let touched = 0; // rows that cost network work (liveness / JD fetch)
  for (const row of rows) {
    if (processed >= max || touched >= gateBudget) break;
    if (!agentEnabled('rank')) {
      log('eval-queue: ranking agent stopped from Mission Control — ending rank stage early');
      break;
    }
    const urlKey = normalizeUrl(row.url);
    if (!urlKey) continue;
    const existing = loadJob(urlKey);
    if (existing && existing.stage !== 'discovered') continue; // already handled

    // Gates that cost nothing:
    const hit = blacklistHit(rules, row.company, row.url);
    if (hit) {
      if (!dryRun) {
        const { job } = createJob({ url: row.url, company: row.company, role: row.role });
        if (job.stage === 'discovered') await updateJob(job.urlKey, { transitionTo: 'skipped', patch: { lastError: `blacklisted (${hit})` } });
      }
      outcomes.push({ ...row, outcome: 'skipped', reason: `blacklisted (${hit})` });
      continue;
    }
    if (isAggregatorUrl(row.url)) {
      if (!dryRun) {
        const { job } = createJob({ url: row.url, company: row.company, role: row.role });
        if (job.stage === 'discovered') await updateJob(job.urlKey, { transitionTo: 'skipped', patch: { lastError: 'aggregator-hosted URL (UNCONFIRMED; auto lane applies direct only)' } });
      }
      outcomes.push({ ...row, outcome: 'skipped', reason: 'aggregator URL' });
      continue;
    }

    // Liveness (zero-token API rung only; unknown ATS falls through to JD fetch).
    touched += 1;
    const liveness = await checkLivenessViaApi(row.url);
    if (liveness?.result === 'expired') {
      if (!dryRun) {
        const { job } = createJob({ url: row.url, company: row.company, role: row.role });
        if (job.stage === 'discovered') await updateJob(job.urlKey, { transitionTo: 'skipped', patch: { lastError: `dead posting: ${liveness.reason}` } });
      }
      outcomes.push({ ...row, outcome: 'skipped', reason: 'dead posting' });
      continue;
    }

    // JD text. A miss leaves the job at `discovered` so a later run can retry
    // (transient failure) — it costs nothing to re-check.
    const jd = await fetchJdViaKnownApi(row.url, JD_TEXT_CAP, JD_TIMEOUT_MS).catch(() => null);
    if (!jd?.text || jd.text.length < 200) {
      if (!dryRun) {
        const { job } = createJob({ url: row.url, company: row.company, role: row.role });
        const evalAttempts = (job.evalAttempts || 0) + 1;
        if (evalAttempts >= 3) {
          await updateJob(job.urlKey, { transitionTo: 'parked', patch: { evalAttempts, lastError: 'JD unavailable via API after 3 tries — needs manual/Neo eval' } });
        } else {
          await updateJob(job.urlKey, { patch: { evalAttempts, lastError: 'jd-fetch-failed (unknown ATS or thin content)' } });
        }
      }
      outcomes.push({ ...row, outcome: 'deferred', reason: 'no JD text via API' });
      continue;
    }

    processed += 1;
    if (dryRun) {
      outcomes.push({ ...row, outcome: 'would-eval', reason: `${jd.text.length} chars of JD` });
      continue;
    }

    // T11: carry the scanner's recorded publication evidence (`posted:` label
    // in the raw pipeline row) into the job record. The JD APIs expose no
    // publication timestamp (browser-extract returns {url,title,text,ats}
    // only), so there is no providerEvidence here; absent a label the
    // publication date stays an honest null and first-seen is recorded
    // separately by createJob.
    const { job } = createJob({
      url: row.url, company: row.company, role: row.role, ats: jd.ats || '',
      dates: readJobDates({ pipelineLine: row.raw }),
    });
    log(`eval-queue: evaluating ${row.company} — ${row.role}`);
    const evalRes = runOllamaEval({ jdText: `${jd.title ? jd.title + '\n\n' : ''}${jd.text}`, url: row.url, model, baseUrl: cfg.eval.base_url });
    if (!evalRes.ok) {
      const evalAttempts = (job.evalAttempts || 0) + 1;
      if (evalAttempts >= 3) {
        // Stop burning an eval slot on it every cycle; surface it instead.
        await updateJob(job.urlKey, { transitionTo: 'parked', patch: { evalAttempts, lastError: `eval failed 3× (last: ${evalRes.error}) — re-rank from Mission Control after fixing the model` } });
      } else {
        await updateJob(job.urlKey, { patch: { evalAttempts, lastError: `eval failed: ${evalRes.error}` } });
      }
      outcomes.push({ ...row, outcome: 'eval-failed', reason: evalRes.error });
      continue;
    }

    await updateJob(job.urlKey, { transitionTo: 'evaluated', patch: { score: evalRes.score, reportPath: evalRes.reportPath, scoreSource: evalRes.scoreSource, lastError: null } });
    if (evalRes.score >= threshold) {
      await updateJob(job.urlKey, { transitionTo: 'queued' });
      outcomes.push({ ...row, outcome: 'queued', score: evalRes.score });
      log(`eval-queue:   → ${evalRes.score}/5 QUEUED [source:${evalRes.scoreSource}]`);
    } else {
      await updateJob(job.urlKey, { transitionTo: 'skipped', patch: { lastError: `score ${evalRes.score} < ${threshold}` } });
      outcomes.push({ ...row, outcome: 'skipped', score: evalRes.score, reason: 'below threshold' });
      log(`eval-queue:   → ${evalRes.score}/5 below threshold [source:${evalRes.scoreSource}]`);
    }
  }
  log(`eval-queue: done — ${processed} evaluated, ${touched} rows gate-checked, ${outcomes.length} outcomes`);
  return outcomes;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = `auto/eval-queue.mjs — unattended liveness→eval→promote pass

  --limit N     Max evals this run (default: config/auto.yml eval.limit_per_cycle)
  --dry-run     Walk the gates and report, but write no state and run no evals
  --help        Show this help`;
  validateFlags(args, ['--limit', '--dry-run', '--help', '-h'], usage, { valueFlags: ['--limit'] });
  const limit = safeIntFlag(flagValue(args, '--limit'), undefined);
  await runEvalQueue({ limit, dryRun: args.includes('--dry-run') });
}
