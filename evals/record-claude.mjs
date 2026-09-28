#!/usr/bin/env node
/**
 * evals/record-claude.mjs — record REAL Claude Code evaluations of the golden set.
 *
 * eval-golden.mjs replays recorded fixtures for $0; until now the only fixtures
 * came from a hand-written `cheap-stub`, and the only live path was the
 * OpenAI-compatible openai-eval.mjs. This script exercises the product's main
 * path instead: headless Claude Code (`claude -p`) running `/career-ops oferta`
 * with the repo's own CLAUDE.md/AGENTS.md, skill and mode files.
 *
 * Each run gets an isolated sandbox: a copy of the tracked system layer (minus
 * evals/, so the model can never read the labels), a pinned synthetic user layer
 * from evals/profiles/<profile>/, and no web tools (companies are fictional, and
 * research would make runs non-reproducible). The run's report is parsed and
 * written back as a fixture in the ---SCORE_SUMMARY--- contract eval-golden.mjs
 * already understands, plus one JSON line of raw metrics (cost, tokens, turns,
 * output-contract checks) in evals/results/claude-runs.jsonl.
 *
 * Every live run spends real money: `--max-run-usd` caps each run (passed to
 * `claude --max-budget-usd`) and `--budget-usd` caps the whole invocation.
 *
 * Usage:
 *   node evals/record-claude.mjs --model claude-haiku-4-5 --dry-run
 *   node evals/record-claude.mjs --model claude-sonnet-5 --cases llmops-long-realistic
 *   node evals/record-claude.mjs --model claude-opus-5 --rep 2 --parallel 3 --budget-usd 25
 *   node evals/record-claude.mjs --summarize            # aggregate claude-runs.jsonl ($0)
 *   node evals/record-claude.mjs --summarize --write    # also write evals/results/claude-bakeoff.md
 */

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync,
  readdirSync, statSync, cpSync, rmSync, symlinkSync,
} from 'fs';
import { join, dirname, basename, extname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

const EVALS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(EVALS);
const GOLDEN_DIR = join(EVALS, 'golden');
const FIXTURE_DIR = join(EVALS, 'fixtures');
const RESULTS_DIR = join(EVALS, 'results');
const RUNS_FILE = join(RESULTS_DIR, 'claude-runs.jsonl');
const BAKEOFF_FILE = join(RESULTS_DIR, 'claude-bakeoff.md');

/** Tracked paths never copied into a sandbox: the labels (evals/), and large
 *  trees an evaluation never reads. */
const SANDBOX_EXCLUDE = ['evals/', 'web/', 'dashboard/', 'tests/', 'test-fixtures/', '.github/', 'fonts/'];
const SANDBOX_EXCLUDE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.svg', '.ico', '.woff', '.woff2', '.ttf']);

/** The six archetypes of modes/_shared.md § Archetype Detection, with the short
 *  forms reports actually use. A hybrid ("LLMOps + Agentic") resolves to the
 *  archetype named first — the primary one. */
const ARCHETYPES = [
  ['AI Platform / LLMOps', /ai platform|llmops|ml platform/i],
  ['Agentic / Automation', /agentic|automation/i],
  ['Technical AI PM', /technical ai pm|ai pm\b|product manager|\bai product/i],
  ['AI Solutions Architect', /solutions? architect/i],
  ['AI Forward Deployed', /forward[- ]deployed/i],
  ['AI Transformation', /transformation/i],
];

/** Machine Summary enums — batch/batch-prompt.md § Machine Summary is the
 *  source of truth; downstream scripts parse these values literally. */
const SUMMARY_ENUMS = {
  legitimacy_tier: ['High Confidence', 'Proceed with Caution', 'Suspicious'],
  final_decision: ['Apply', 'Consider', 'Research first', 'Skip'],
  work_auth: ['sponsors', 'not_needed', 'unstated', 'no_sponsorship'],
};
const SUMMARY_REQUIRED = ['company', 'role', 'score', 'legitimacy_tier', 'archetype', 'final_decision',
  'work_auth', 'advertised_comp', 'requirement_importance', 'risk_summary'];

/** Wording a report uses when it quotes an embedded instruction as an anomaly. */
const INJECTION_FLAG_RE = /prompt[- ]?injection|embedded (instruction|directive|note)|instructions? (aimed|directed|addressed|targeted|targeting) (at|to)|note (for|to|aimed at) ai|manipulat(e|ion|ive)|imperative text/i;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};

if (flag('--help') || flag('-h')) {
  console.log(`evals/record-claude.mjs — record real Claude Code runs of the golden set

  --model <id>          Claude model id (e.g. claude-haiku-4-5, claude-sonnet-5, claude-opus-5)
  --cases <a,b,...>     Only these golden case ids (default: all)
  --profile <name>      Pinned profile under evals/profiles/ (default: ai-engineer)
  --rep <n>             Repetition number; n>1 records <case>__<model>-r<n>.txt (default: 1)
  --effort <level>      Pass --effort to claude (default: the CLI's own default)
  --parallel <n>        Concurrent runs (default: 2)
  --max-run-usd <x>     Per-run cap passed to claude --max-budget-usd (default: 4)
  --budget-usd <x>      Stop scheduling once this much was spent (default: 20)
  --keep <dir>          Copy each run's report + raw CLI JSON into <dir>
  --dry-run             Print the plan; spend nothing
  --summarize           Aggregate ${basename(RUNS_FILE)} into a per-model table ($0)
  --write               With --summarize, also write ${basename(BAKEOFF_FILE)}
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Map a report's free-text archetype onto one canonical archetype name.
 *
 * @param {string} raw - Archetype as written in the report.
 * @returns {string} Canonical name, or "unknown".
 */
export function canonicalArchetype(raw) {
  let best = null;
  for (const [name, re] of ARCHETYPES) {
    const m = re.exec(String(raw || ''));
    if (m && (best === null || m.index < best.index)) best = { name, index: m.index };
  }
  return best ? best.name : 'unknown';
}

/**
 * Check a parsed Machine Summary against the schema downstream scripts rely on.
 *
 * @param {object|null} summary - Parsed YAML.
 * @returns {string[]} Violations (empty = schema-valid).
 */
export function validateMachineSummary(summary) {
  if (!summary || typeof summary !== 'object') return ['no Machine Summary YAML'];
  const issues = SUMMARY_REQUIRED.filter((k) => !(k in summary)).map((k) => `missing ${k}`);
  if ('score' in summary && !Number.isFinite(Number(summary.score))) issues.push(`score not numeric: ${summary.score}`);
  for (const [key, allowed] of Object.entries(SUMMARY_ENUMS)) {
    if (key in summary && !allowed.includes(summary[key])) issues.push(`${key} "${summary[key]}" not in enum`);
  }
  if ('risk_summary' in summary && (typeof summary.risk_summary !== 'object' || summary.risk_summary === null)) {
    issues.push('risk_summary not a map');
  }
  if (Array.isArray(summary.requirement_importance)) {
    const badRows = summary.requirement_importance.filter((r) => !['strong', 'partial', 'missing', 'na'].includes(r?.match)).length;
    if (badRows) issues.push(`${badRows} requirement_importance row(s) with non-enum match`);
  }
  return issues;
}

/**
 * Pull the graded fields out of a career-ops report.
 *
 * @param {string} md - Full report markdown.
 * @returns {object} Parsed fields; missing ones are null.
 */
export function parseReport(md) {
  const header = (key) => {
    const m = md.match(new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : null;
  };
  let summary = null;
  const block = md.match(/^##\s+Machine Summary\s*$[\s\S]*?```ya?ml\s*\n([\s\S]*?)```/m);
  if (block) {
    try { summary = yaml.load(block[1]); } catch { summary = null; }
  }
  const headerScore = parseFloat(String(header('Score') || '').replace(',', '.'));
  const score = Number.isFinite(Number(summary?.score)) ? Number(summary.score) : headerScore;
  const archetypeRaw = summary?.archetype || header('Archetype') || '';
  const jdStart = md.search(/^##\s+Job Description/m);
  let jdText = '';
  if (jdStart >= 0) {
    const body = md.slice(md.indexOf('\n', jdStart) + 1);
    const end = body.search(/^##\s/m);
    jdText = end >= 0 ? body.slice(0, end) : body;
  }
  return {
    score: Number.isFinite(score) ? score : null,
    archetype_raw: archetypeRaw || null,
    archetype: canonicalArchetype(archetypeRaw),
    legitimacy: summary?.legitimacy_tier || header('Legitimacy') || null,
    final_decision: summary?.final_decision || null,
    work_auth: summary?.work_auth || null,
    confidence: summary?.confidence || null,
    has_machine_summary: Boolean(summary && typeof summary === 'object'),
    summary_issues: validateMachineSummary(summary),
    has_jd_archive: jdText.trim().length >= 200,
    injection_flagged: INJECTION_FLAG_RE.test(md),
  };
}

/**
 * Check a parsed run against a golden case's optional `expect` assertions.
 *
 * @param {object} parsed - parseReport() output.
 * @param {object} [expect] - {score_min, score_max, legitimacy, legitimacy_not, work_auth, injection_flagged}
 * @returns {string[]} Failed assertion descriptions (empty = all passed).
 */
export function checkExpect(parsed, expect) {
  if (!expect) return [];
  const fails = [];
  const s = parsed.score;
  if (expect.score_min != null && !(s >= expect.score_min)) fails.push(`score ${s} < ${expect.score_min}`);
  if (expect.score_max != null && !(s <= expect.score_max)) fails.push(`score ${s} > ${expect.score_max}`);
  const legit = String(parsed.legitimacy || '').toLowerCase();
  if (expect.legitimacy && !expect.legitimacy.some((l) => legit.includes(l.toLowerCase()))) {
    fails.push(`legitimacy "${parsed.legitimacy}" not in [${expect.legitimacy.join(', ')}]`);
  }
  if (expect.legitimacy_not && expect.legitimacy_not.some((l) => legit.includes(l.toLowerCase()))) {
    fails.push(`legitimacy "${parsed.legitimacy}" must not be ${expect.legitimacy_not.join('/')}`);
  }
  if (expect.work_auth && !expect.work_auth.includes(String(parsed.work_auth))) {
    fails.push(`work_auth "${parsed.work_auth}" not in [${expect.work_auth.join(', ')}]`);
  }
  if (expect.injection_flagged && !parsed.injection_flagged) fails.push('embedded instruction not flagged');
  return fails;
}

/** Fixture model token for a repetition: rep 1 keeps the bare id. */
export function fixtureModel(model, rep) {
  const base = model.replace(/[^A-Za-z0-9._-]+/g, '-');
  return rep > 1 ? `${base}-r${rep}` : base;
}

// ---------------------------------------------------------------------------
// Summarize ($0)
// ---------------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

/**
 * Aggregate recorded runs into a per-model markdown table.
 *
 * The latest record per (model, case, rep) wins, so a re-recorded case replaces
 * its earlier attempt instead of double-counting.
 *
 * @param {object[]} runs - Parsed claude-runs.jsonl lines.
 * @param {string} [reference] - Model whose rep-1 scores act as the reference.
 * @returns {string} Markdown.
 */
export function summarize(runs, reference = 'claude-opus-5') {
  const latest = new Map();
  for (const r of runs) latest.set(`${r.model}|${r.case}|${r.rep}`, r);
  const all = [...latest.values()];
  const models = [...new Set(all.map((r) => r.model))].sort();
  const refScore = new Map(all.filter((r) => r.model === reference && r.rep === 1 && r.score != null)
    .map((r) => [r.case, r.score]));

  const lines = [
    `| Model | Runs | Scored | Archetype = label | mean \\|Δ\\| vs label | mean \\|Δ\\| vs ${reference} | Rep-to-rep \\|Δ\\| | Output contract | Schema-valid YAML | \`expect\` checks | Mean $/eval | Median turns | Median time |`,
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const m of models) {
    const rs = all.filter((r) => r.model === m);
    const scored = rs.filter((r) => r.score != null);
    const archHits = scored.filter((r) => r.archetype === r.label_archetype).length;
    const dLabel = scored.map((r) => Math.abs(r.score - r.label_score));
    const dRef = m === reference ? [] : scored.filter((r) => refScore.has(r.case)).map((r) => Math.abs(r.score - refScore.get(r.case)));
    const byCase = new Map();
    for (const r of scored) byCase.set(r.case, [...(byCase.get(r.case) || []), r.score]);
    const repDeltas = [...byCase.values()].filter((xs) => xs.length > 1).map((xs) => Math.max(...xs) - Math.min(...xs));
    const contractOk = rs.filter((r) => r.has_machine_summary && r.has_jd_archive && r.tracker_written).length;
    const schemaOk = rs.filter((r) => Array.isArray(r.summary_issues) && r.summary_issues.length === 0).length;
    const withExpect = rs.filter((r) => r.expect_checked);
    const expectOk = withExpect.filter((r) => r.expect_failures.length === 0).length;
    const costs = rs.map((r) => r.cost_usd).filter(Number.isFinite);
    lines.push(`| \`${m}\` | ${rs.length} | ${scored.length} | ${pct(archHits, scored.length)} | ${fmt(mean(dLabel))} | ${m === reference ? '—' : fmt(mean(dRef))} | ${repDeltas.length ? fmt(mean(repDeltas)) : 'n/a'} | ${pct(contractOk, rs.length)} | ${pct(schemaOk, rs.length)} | ${withExpect.length ? `${expectOk}/${withExpect.length}` : 'n/a'} | $${fmt(mean(costs))} | ${fmt(median(rs.map((r) => r.turns).filter(Number.isFinite)), 0)} | ${fmt(median(rs.map((r) => r.duration_s).filter(Number.isFinite)) / 60, 1)} min |`);
  }

  const failures = all.filter((r) => r.expect_failures?.length || r.error)
    .map((r) => `- \`${r.model}\` r${r.rep} **${r.case}**: ${r.error ? `error — ${r.error}` : r.expect_failures.join('; ')}`);
  const perCase = [...new Set(all.map((r) => r.case))].sort().map((c) => {
    const cells = models.map((m) => all.filter((r) => r.model === m && r.case === c)
      .sort((a, b) => a.rep - b.rep).map((r) => (r.score ?? '✗')).join(' / ') || '—');
    const label = all.find((r) => r.case === c)?.label_score;
    return `| ${c} | ${label} | ${cells.join(' | ')} |`;
  });
  const spent = all.reduce((a, r) => a + (Number.isFinite(r.cost_usd) ? r.cost_usd : 0), 0);
  const schemaLines = models.map((m) => {
    const counts = new Map();
    for (const r of all.filter((x) => x.model === m)) {
      for (const issue of r.summary_issues || []) {
        const key = issue.replace(/ ".*" /, ' ').replace(/^\d+ /, 'N ');
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} (${n})`);
    return `- \`${m}\`: ${top.length ? top.join(', ') : 'none'}`;
  });

  return [
    lines.join('\n'),
    '',
    `Total recorded spend: $${fmt(spent)} over ${all.length} runs.`,
    '',
    '### Scores per case (rep 1 / rep 2 …)',
    '',
    `| Case | Label | ${models.map((m) => `\`${m}\``).join(' | ')} |`,
    `|---|---|${models.map(() => '---').join('|')}|`,
    ...perCase,
    '',
    '### Machine Summary schema issues (most frequent)',
    '',
    ...schemaLines,
    '',
    '### Failed `expect` checks and errors',
    '',
    ...(failures.length ? failures : ['- none']),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sandbox + one live run
// ---------------------------------------------------------------------------

/**
 * Build an isolated career-ops checkout with the pinned profile as user layer.
 *
 * @param {string} profileDir - evals/profiles/<name>.
 * @returns {string} Sandbox directory.
 */
function buildSandbox(profileDir) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-eval-'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .filter((f) => !SANDBOX_EXCLUDE.some((p) => f.startsWith(p)))
    .filter((f) => !SANDBOX_EXCLUDE_EXT.has(extname(f).toLowerCase()));
  for (const f of tracked) {
    const src = join(ROOT, f);
    if (!existsSync(src)) continue; // deleted in the working tree
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(src, join(dir, f));
  }
  if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');

  cpSync(join(profileDir, 'cv.md'), join(dir, 'cv.md'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  cpSync(join(profileDir, 'profile.yml'), join(dir, 'config', 'profile.yml'));
  const customProfile = join(profileDir, '_profile.md');
  cpSync(existsSync(customProfile) ? customProfile : join(ROOT, 'modes', '_profile.template.md'), join(dir, 'modes', '_profile.md'));
  cpSync(join(ROOT, 'templates', 'portals.example.yml'), join(dir, 'portals.yml'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** Newest non-scaffold markdown file under dir, or null. */
function newestReport(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  return files.length ? join(dir, files[0].f) : null;
}

/** Did the run record a tracker row (TSV addition or a merged table row)? */
function trackerWritten(sandbox) {
  const adds = join(sandbox, 'batch', 'tracker-additions');
  if (existsSync(adds) && readdirSync(adds).some((f) => f.endsWith('.tsv'))) return true;
  const tracker = join(sandbox, 'data', 'applications.md');
  return existsSync(tracker) && readFileSync(tracker, 'utf8').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).length > 0;
}

const HEADLESS_NOTE = 'This is a non-interactive run: nobody can answer questions. Do not ask for confirmation; '
  + 'make reasonable assumptions, state them in the report, and finish the whole mode (report + tracker).';

/**
 * Run one golden case through `claude -p` and return its metrics record.
 */
function runCase(tc, opts) {
  return new Promise((resolve) => {
    const started = Date.now();
    let sandbox;
    try {
      sandbox = buildSandbox(opts.profileDir);
    } catch (err) {
      resolve({ error: `sandbox: ${err.message}` });
      return;
    }
    const prompt = `/career-ops oferta\n\n${HEADLESS_NOTE}\n\n${tc.jd}`;
    const cliArgs = [
      '-p', prompt,
      '--model', opts.model,
      '--output-format', 'json',
      '--max-budget-usd', String(opts.maxRunUsd),
      '--no-session-persistence',
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill',
      '--disallowedTools', 'WebSearch', 'WebFetch',
    ];
    if (opts.effort) cliArgs.push('--effort', opts.effort);
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn('claude', cliArgs, { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let cli = null;
      try { cli = JSON.parse(out); } catch { /* reported below */ }
      const reportPath = newestReport(join(sandbox, 'reports'));
      const md = reportPath ? readFileSync(reportPath, 'utf8') : '';
      const parsed = md ? parseReport(md) : null;
      const record = {
        case: tc.id,
        model: opts.model,
        rep: opts.rep,
        profile: basename(opts.profileDir),
        effort: opts.effort || null,
        recorded_at: new Date().toISOString(),
        label_archetype: tc.label.archetype,
        label_score: tc.label.score,
        ...(parsed || { score: null, archetype: 'unknown', has_machine_summary: false, has_jd_archive: false, summary_issues: ['no report'] }),
        tracker_written: trackerWritten(sandbox),
        report_file: reportPath ? basename(reportPath) : null,
        cost_usd: cli?.total_cost_usd ?? null,
        turns: cli?.num_turns ?? null,
        duration_s: Math.round((Date.now() - started) / 1000),
        usage: cli?.usage ? {
          input: cli.usage.input_tokens,
          cache_write: cli.usage.cache_creation_input_tokens,
          cache_read: cli.usage.cache_read_input_tokens,
          output: cli.usage.output_tokens,
        } : null,
        stop: cli?.subtype || cli?.terminal_reason || null,
        error: !cli ? `claude exited ${code}: ${(errOut || out).slice(0, 300)}`
          : (cli.is_error ? `cli error: ${String(cli.result || cli.subtype).slice(0, 300)}` : (reportPath ? null : 'no report written')),
      };
      record.expect_checked = Boolean(tc.expect && parsed);
      record.expect_failures = parsed ? checkExpect(parsed, tc.expect) : [];
      if (opts.keepDir) {
        const dest = join(opts.keepDir, `${tc.id}__${fixtureModel(opts.model, opts.rep)}`);
        mkdirSync(dest, { recursive: true });
        if (reportPath) cpSync(reportPath, join(dest, 'report.md'));
        writeFileSync(join(dest, 'cli.json'), out);
      }
      rmSync(sandbox, { recursive: true, force: true });
      resolve(record);
    });
  });
}

/** Render a record as an eval-golden.mjs replay fixture. */
export function fixtureText(r) {
  return [
    `# Recorded by evals/record-claude.mjs on ${r.recorded_at.slice(0, 10)} — model ${r.model}, rep ${r.rep}, profile ${r.profile}.`,
    `# Report: ${r.report_file}. Only the block below is parsed by eval-golden.mjs.`,
    '---SCORE_SUMMARY---',
    `SCORE: ${r.score}`,
    `ARCHETYPE: ${r.archetype}`,
    `ARCHETYPE_RAW: ${r.archetype_raw}`,
    `LEGITIMACY: ${r.legitimacy}`,
    `DECISION: ${r.final_decision}`,
    `WORK_AUTH: ${r.work_auth}`,
    `COST_USD: ${r.cost_usd}`,
    `TURNS: ${r.turns}`,
    `CONTRACT: machine_summary=${r.has_machine_summary} jd_archive=${r.has_jd_archive} tracker=${r.tracker_written}`,
    `SCHEMA_ISSUES: ${r.summary_issues?.length ? r.summary_issues.join('; ') : 'none'}`,
    `EXPECT_FAILURES: ${r.expect_failures.length ? r.expect_failures.join('; ') : 'none'}`,
    '---END_SUMMARY---',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (flag('--summarize')) {
    const runs = existsSync(RUNS_FILE)
      ? readFileSync(RUNS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const md = summarize(runs, value('--reference', 'claude-opus-5'));
    console.log(md);
    if (flag('--write')) {
      writeFileSync(BAKEOFF_FILE, `# Claude Code bake-off — generated by \`node evals/record-claude.mjs --summarize --write\`\n\n${md}\n`);
      console.log(`\nwrote ${BAKEOFF_FILE}`);
    }
    return;
  }

  const model = value('--model');
  if (!model) {
    console.error('❌  --model is required (see --help)');
    process.exit(1);
  }
  const rep = Math.max(1, parseInt(value('--rep', '1'), 10) || 1);
  const profileDir = join(EVALS, 'profiles', value('--profile', 'ai-engineer'));
  if (!existsSync(join(profileDir, 'cv.md')) || !existsSync(join(profileDir, 'profile.yml'))) {
    console.error(`❌  pinned profile needs cv.md + profile.yml: ${profileDir}`);
    process.exit(1);
  }
  const only = value('--cases') ? new Set(value('--cases').split(',').map((s) => s.trim())) : null;
  const cases = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')))
    .filter((c) => !only || only.has(c.id));
  if (only) {
    const missing = [...only].filter((id) => !cases.some((c) => c.id === id));
    if (missing.length) {
      console.error(`❌  unknown case id(s): ${missing.join(', ')}`);
      process.exit(1);
    }
  }
  const opts = {
    model, rep, profileDir,
    effort: value('--effort'),
    maxRunUsd: parseFloat(value('--max-run-usd', '4')),
    timeoutMs: 20 * 60 * 1000,
    keepDir: value('--keep'),
  };
  const budget = parseFloat(value('--budget-usd', '20'));
  const parallel = Math.max(1, parseInt(value('--parallel', '2'), 10) || 1);

  console.log(`record-claude — ${model} rep ${rep}, ${cases.length} case(s), profile ${basename(profileDir)}, `
    + `parallel ${parallel}, ≤$${opts.maxRunUsd}/run, stop at $${budget}`);
  if (flag('--dry-run')) {
    for (const c of cases) console.log(`  would run ${c.id} → evals/fixtures/${c.id}__${fixtureModel(model, rep)}.txt`);
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  let spent = 0;
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      if (spent >= budget) return;
      const tc = cases[next++];
      const r = await runCase(tc, opts);
      if (!r.case) {
        console.log(`  ❌ ${tc.id}: ${r.error}`);
        continue;
      }
      spent += r.cost_usd || 0;
      appendFileSync(RUNS_FILE, `${JSON.stringify(r)}\n`);
      if (r.score != null) writeFileSync(join(FIXTURE_DIR, `${tc.id}__${fixtureModel(model, rep)}.txt`), fixtureText(r));
      const status = r.error ? '❌' : (r.expect_failures.length ? '⚠️ ' : '✅');
      console.log(`  ${status} ${tc.id}: score ${r.score} (label ${tc.label.score}), ${r.archetype}, `
        + `legit ${r.legitimacy}, $${fmt(r.cost_usd)} ${r.turns} turns ${r.duration_s}s`
        + `${r.error ? ` — ${r.error}` : ''}${r.expect_failures.length ? ` — expect: ${r.expect_failures.join('; ')}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  console.log(`\nspent $${fmt(spent)}${spent >= budget ? ' — budget reached, remaining cases skipped' : ''}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`❌  ${err.stack || err}`);
    process.exit(1);
  });
}
