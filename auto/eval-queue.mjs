#!/usr/bin/env node
/**
 * auto/eval-queue.mjs — unattended scan→eval bridge (Phase 1 of the auto layer).
 *
 * Reads pending rows from data/pipeline.md, and for each row not yet known to
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
import { createJob, loadJob, saveJob, transition } from './state.mjs';

const ROOT = getCareerOpsRoot();
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const BLACKLIST_PATH = join(ROOT, 'data/blacklist.md');
const JD_TEXT_CAP = 20_000;
const JD_TIMEOUT_MS = 15_000;

/**
 * Pending rows from data/pipeline.md: `- [ ] url | company | role | ...`.
 * @returns {{url: string, company: string, role: string}[]}
 */
export function parsePendingRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[ \] (https?:\/\/\S+)(.*)$/);
    if (!m) continue;
    const rest = m[2].split('|').map((s) => s.trim()).filter(Boolean);
    rows.push({ url: m[1], company: rest[0] || '', role: rest[1] || '' });
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
 * Run ollama-eval.mjs on JD text; parse score + report path from its output.
 * @returns {{score: number|null, reportPath: string|null, ok: boolean, error?: string}}
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
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.status !== 0) {
      return { score: null, reportPath: null, ok: false, error: out.trim().split('\n').slice(-3).join(' | ') };
    }
    const scoreM = out.match(/Score:\s*([\d.]+)\s*\/\s*5/);
    const reportM = out.match(/Report saved:\s*(reports\/\S+\.md)/);
    let score = scoreM ? Number(scoreM[1]) : null;
    // Fallback: some models (observed: gemma-4-e4b via LM Studio) skip the
    // machine-readable SCORE_SUMMARY trailer, so the runner prints "?/5" even
    // though the saved report body contains the score. Parse it from there.
    if (!Number.isFinite(score) && reportM) {
      try {
        const body = readFileSync(join(ROOT, reportM[1]), 'utf-8');
        const m = body.match(/\*\*Score:\*\*\s*([\d.]+)\s*\/\s*5/) || body.match(/^score:\s*([\d.]+)\s*$/m);
        if (m) score = Number(m[1]);
      } catch { /* report unreadable — keep score null */ }
    }
    return {
      score: Number.isFinite(score) ? score : null,
      reportPath: reportM ? reportM[1] : null,
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

  if (!existsSync(PIPELINE_PATH)) {
    log('eval-queue: no data/pipeline.md — nothing to do');
    return outcomes;
  }
  const rows = parsePendingRows(readFileSync(PIPELINE_PATH, 'utf-8'));
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
        if (job.stage === 'discovered') transition(job, 'skipped', { lastError: `blacklisted (${hit})` });
      }
      outcomes.push({ ...row, outcome: 'skipped', reason: `blacklisted (${hit})` });
      continue;
    }
    if (isAggregatorUrl(row.url)) {
      if (!dryRun) {
        const { job } = createJob({ url: row.url, company: row.company, role: row.role });
        if (job.stage === 'discovered') transition(job, 'skipped', { lastError: 'aggregator-hosted URL (UNCONFIRMED; auto lane applies direct only)' });
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
        if (job.stage === 'discovered') transition(job, 'skipped', { lastError: `dead posting: ${liveness.reason}` });
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
        job.lastError = 'jd-fetch-failed (unknown ATS or thin content)';
        job.evalAttempts = (job.evalAttempts || 0) + 1;
        if (job.evalAttempts >= 3) {
          transition(job, 'parked', { lastError: 'JD unavailable via API after 3 tries — needs manual/Neo eval' });
        } else {
          saveJob(job);
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

    const { job } = createJob({ url: row.url, company: row.company, role: row.role, ats: jd.ats || '' });
    log(`eval-queue: evaluating ${row.company} — ${row.role}`);
    const evalRes = runOllamaEval({ jdText: `${jd.title ? jd.title + '\n\n' : ''}${jd.text}`, url: row.url, model, baseUrl: cfg.eval.base_url });
    if (!evalRes.ok) {
      job.lastError = `eval failed: ${evalRes.error}`;
      job.evalAttempts = (job.evalAttempts || 0) + 1;
      if (job.evalAttempts >= 3) {
        // Stop burning an eval slot on it every cycle; surface it instead.
        transition(job, 'parked', { lastError: `eval failed 3× (last: ${evalRes.error}) — re-rank from Mission Control after fixing the model` });
      } else {
        saveJob(job);
      }
      outcomes.push({ ...row, outcome: 'eval-failed', reason: evalRes.error });
      continue;
    }

    let updated = transition(job, 'evaluated', { score: evalRes.score, reportPath: evalRes.reportPath, lastError: null });
    if (evalRes.score >= threshold) {
      updated = transition(updated, 'queued');
      outcomes.push({ ...row, outcome: 'queued', score: evalRes.score });
      log(`eval-queue:   → ${evalRes.score}/5 QUEUED`);
    } else {
      transition(updated, 'skipped', { lastError: `score ${evalRes.score} < ${threshold}` });
      outcomes.push({ ...row, outcome: 'skipped', score: evalRes.score, reason: 'below threshold' });
      log(`eval-queue:   → ${evalRes.score}/5 below threshold`);
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
