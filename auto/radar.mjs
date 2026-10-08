#!/usr/bin/env node
/**
 * auto/radar.mjs — startup intel for the Radar tab.
 *
 * Walks the companies already in the pipeline (jobs with a real score or any
 * traction past discovery), reads the JD-evaluation report we saved for them,
 * and asks the local eval model to judge growth/rocket-ship potential from
 * the evidence in the JD: funding stage, team size, growth language, product
 * momentum, role seniority. Results merge into data/auto/radar.json — user
 * fields (status, notes) are never overwritten.
 *
 *   node auto/radar.mjs                # assess companies not yet assessed
 *   node auto/radar.mjs --refresh      # re-assess everything
 *   node auto/radar.mjs --limit 10
 *   node auto/radar.mjs --self-test
 */

import './lib/sanitize-env.mjs';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { loadAutoConfig } from './lib/config.mjs';
import { listJobs } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RADAR_FILE = join(ROOT, 'data', 'auto', 'radar.json');

const VERDICTS = ['rocket_ship', 'promising', 'pass'];

// ---------------------------------------------------------------------------
// Data shape + pure helpers (self-tested)

export function loadRadar(path = RADAR_FILE) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { companies: [] }; }
}

export function saveRadar(radar, path = RADAR_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(radar, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export function companyId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Pure: group job records into radar candidates — one entry per company that
 * earned a score or moved past discovery.
 */
export function candidatesFromJobs(jobs) {
  const byCompany = new Map();
  for (const j of jobs) {
    if (!j.company) continue;
    const interesting = (j.score ?? 0) > 0 || !['discovered', 'skipped'].includes(j.stage);
    if (!interesting) continue;
    const id = companyId(j.company);
    if (!id) continue;
    const c = byCompany.get(id) ?? { id, company: j.company, roles: [], bestScore: null };
    c.roles.push({ role: j.role, url: j.url, score: j.score, stage: j.stage, reportPath: j.reportPath ?? null });
    if (j.score != null && (c.bestScore == null || j.score > c.bestScore)) c.bestScore = j.score;
    byCompany.set(id, c);
  }
  return [...byCompany.values()].sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0));
}

/**
 * Pure: merge fresh candidates + assessments into the stored radar without
 * clobbering user-owned fields (status, notes) or manual entries.
 */
export function mergeRadar(stored, candidates, assessments = new Map()) {
  const out = { companies: [...stored.companies] };
  const idx = new Map(out.companies.map((c, i) => [c.id, i]));
  for (const cand of candidates) {
    const assessment = assessments.get(cand.id);
    if (idx.has(cand.id)) {
      const cur = out.companies[idx.get(cand.id)];
      cur.company = cand.company;
      cur.roles = cand.roles;
      cur.bestScore = cand.bestScore;
      if (assessment) cur.assessment = assessment;
    } else {
      out.companies.push({
        id: cand.id, company: cand.company, source: 'pipeline',
        status: 'watching', notes: '',
        addedAt: new Date().toISOString(),
        roles: cand.roles, bestScore: cand.bestScore,
        assessment: assessment ?? null,
      });
    }
  }
  const rank = { rocket_ship: 0, promising: 1, pass: 2 };
  out.companies.sort((a, b) =>
    (rank[a.assessment?.verdict] ?? 3) - (rank[b.assessment?.verdict] ?? 3)
    || (b.bestScore ?? 0) - (a.bestScore ?? 0));
  return out;
}

/** Pure: pull the first JSON object out of a model reply (handles ```json fences). */
export function parseAssessment(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!VERDICTS.includes(o.verdict)) return null;
    return {
      verdict: o.verdict,
      reasons: String(o.reasons ?? '').slice(0, 600),
      signals: Array.isArray(o.signals) ? o.signals.slice(0, 8).map((s) => String(s).slice(0, 120)) : [],
      outreach_angle: String(o.outreach_angle ?? '').slice(0, 300),
    };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// LLM assessment via the same OpenAI-compatible endpoint the ranker uses

function jdExcerpt(cand) {
  for (const r of cand.roles) {
    if (r.reportPath && existsSync(join(ROOT, r.reportPath))) {
      return readFileSync(join(ROOT, r.reportPath), 'utf8').slice(0, 4000);
    }
  }
  return '';
}

async function assessCompany(cand, { model, baseUrl }) {
  const prompt = `You are a startup analyst helping a senior engineering leader decide which companies to keep on a personal radar (reach out, network, watch for roles).

Company: ${cand.company}
Open roles seen (with our 0-5 fit scores): ${cand.roles.map((r) => `${r.role} (score ${r.score ?? '?'})`).join('; ')}

Evidence — our evaluation report / JD excerpt (may mention funding stage, team size, customers, growth):
---
${jdExcerpt(cand) || '(no report available — judge from the company name and roles only, be conservative)'}
---

Judge ONLY from the evidence above. Reply with a single JSON object, nothing else:
{"verdict": "rocket_ship" | "promising" | "pass",
 "signals": ["concrete growth signals found in the evidence, e.g. 'Series B 2025', 'hiring 3 senior eng leaders'"],
 "reasons": "2-3 sentences: why this verdict",
 "outreach_angle": "one sentence: the strongest personal angle for reaching out"}

rocket_ship = strong evidence of fast growth worth joining early. promising = some signals, keep watching. pass = no meaningful growth evidence.`;

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS) || 900_000),
  });
  if (!res.ok) throw new Error(`eval endpoint ${res.status}`);
  const data = await res.json();
  const parsed = parseAssessment(data.choices?.[0]?.message?.content ?? '');
  if (!parsed) throw new Error('model reply had no valid JSON assessment');
  return { ...parsed, generatedAt: new Date().toISOString(), model };
}

export async function runRadarScan({ limit = 15, refresh = false, log = console.log } = {}) {
  const cfg = loadAutoConfig();
  const baseUrl = cfg.eval?.base_url;
  if (!baseUrl) throw new Error('radar: config/auto.yml eval.base_url is required (OpenAI-compatible endpoint)');
  const model = cfg.eval?.model;

  const stored = loadRadar();
  const candidates = candidatesFromJobs(listJobs());
  const have = new Map(stored.companies.map((c) => [c.id, c]));
  const todo = candidates.filter((c) => refresh || !have.get(c.id)?.assessment).slice(0, limit);
  log(`radar: ${candidates.length} companies in pipeline, assessing ${todo.length} (model ${model})`);

  const assessments = new Map();
  for (const cand of todo) {
    try {
      log(`radar: assessing ${cand.company}…`);
      const a = await assessCompany(cand, { model, baseUrl });
      assessments.set(cand.id, a);
      log(`radar:   → ${a.verdict}${a.signals.length ? ` (${a.signals[0]})` : ''}`);
    } catch (err) {
      log(`radar:   ✗ ${cand.company}: ${err.message}`);
    }
  }
  saveRadar(mergeRadar(stored, candidates, assessments));
  log(`radar: done — ${assessments.size}/${todo.length} assessed, radar.json updated`);
}

// ---------------------------------------------------------------------------
async function selfTest() {
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`); if (!ok) failed++; };

  const jobs = [
    { company: 'Acme AI', role: 'VP Eng', url: 'u1', score: 5, stage: 'submitted', reportPath: null, timestamps: [] },
    { company: 'Acme AI', role: 'CTO', url: 'u2', score: 4, stage: 'queued', reportPath: null, timestamps: [] },
    { company: 'Boring Co', role: 'Dev', url: 'u3', score: null, stage: 'discovered', reportPath: null, timestamps: [] },
    { company: '', role: 'Ghost', url: 'u4', score: 5, stage: 'queued', timestamps: [] },
  ];
  const cands = candidatesFromJobs(jobs);
  check('candidates: groups by company, drops uninteresting + unnamed',
    cands.length === 1 && cands[0].id === 'acme-ai' && cands[0].roles.length === 2 && cands[0].bestScore === 5);

  const assess = new Map([['acme-ai', { verdict: 'rocket_ship', reasons: 'r', signals: ['s'], outreach_angle: 'o', generatedAt: 'now' }]]);
  const merged = mergeRadar({ companies: [] }, cands, assess);
  check('merge: new entry gets watching status + assessment',
    merged.companies[0].status === 'watching' && merged.companies[0].assessment.verdict === 'rocket_ship');

  const userEdited = { companies: [{ ...merged.companies[0], status: 'contacted', notes: 'met the CTO' }] };
  const remerged = mergeRadar(userEdited, cands, new Map());
  check('merge: user status/notes survive a re-scan',
    remerged.companies[0].status === 'contacted' && remerged.companies[0].notes === 'met the CTO'
    && remerged.companies[0].assessment.verdict === 'rocket_ship');

  check('parseAssessment: fenced json + verdict gate',
    parseAssessment('```json\n{"verdict":"promising","reasons":"x","signals":["a"],"outreach_angle":"y"}\n```')?.verdict === 'promising'
    && parseAssessment('{"verdict":"nonsense"}') === null && parseAssessment('no json here') === null);

  check('companyId slugs safely', companyId('Acme, Inc. (US)') === 'acme-inc-us');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = `auto/radar.mjs — assess pipeline companies for rocket-ship potential

  --limit N      Max companies to assess this run (default 15)
  --refresh      Re-assess companies that already have an assessment
  --self-test    Run built-in tests (no network, no real files)
  --help`;
  validateFlags(args, ['--limit', '--refresh', '--self-test', '--help', '-h'], usage, { valueFlags: ['--limit'] });
  if (args.includes('--self-test')) await selfTest();
  else if (args.includes('--help') || args.includes('-h')) console.log(usage);
  else await runRadarScan({ limit: Number(flagValue(args, '--limit')) || 15, refresh: hasFlag(args, '--refresh') });
}
