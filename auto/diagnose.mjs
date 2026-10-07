#!/usr/bin/env node
// auto/diagnose.mjs — sweep every apply-attempt audit dir and surface patterns.
//
// Answers "what went wrong, where, and is it happening elsewhere too?":
//   - every attempt with agent status vs orchestrator verdict (divergence = finding)
//   - parked/failed reasons aggregated across all jobs
//   - every `missing` field the agents reported, grouped (standing-answer candidates)
//   - every answer the agent had to generate (not from profile/standing/cv),
//     grouped by question — recurring ones belong in config/standing-answers.yml
//
// Usage:
//   node auto/diagnose.mjs             # print the report
//   node auto/diagnose.mjs --self-test

import './lib/sanitize-env.mjs';

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Collect every attempt dir under <scanRoot>/<app>/audit/attempt-*. */
export function collectAttempts(scanRoot) {
  const attempts = [];
  if (!existsSync(scanRoot)) return attempts;
  for (const app of readdirSync(scanRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const auditRoot = join(scanRoot, app.name, 'audit');
    if (!existsSync(auditRoot)) continue;
    for (const att of readdirSync(auditRoot, { withFileTypes: true })) {
      if (!att.isDirectory() || !att.name.startsWith('attempt-')) continue;
      const dir = join(auditRoot, att.name);
      attempts.push({
        app: app.name,
        attempt: att.name,
        dir,
        result: readJson(join(dir, 'result.json')),
        verdict: readJson(join(dir, 'verdict.json')),
        answers: readJson(join(dir, 'answers.json')),
        error: readJson(join(dir, 'error.json')),
      });
    }
  }
  return attempts;
}

export function buildReport(attempts) {
  const lines = [];
  const bump = (map, key, item) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };

  lines.push(`# Apply diagnostics — ${attempts.length} attempt(s) on disk`);
  lines.push('');
  lines.push('| App | Attempt | Agent said | Orchestrator verdict | Reason |');
  lines.push('|---|---|---|---|---|');
  const reasons = new Map();
  const missing = new Map();
  const generated = new Map();
  const divergent = [];

  for (const a of attempts.sort((x, y) => (x.app + x.attempt).localeCompare(y.app + y.attempt))) {
    const agentStatus = a.result?.status ?? '(no result.json)';
    const verdictStatus = a.verdict ? `${a.verdict.status}${a.verdict.ok ? '' : ' (rejected)'}` : '—';
    const reason = a.verdict?.reason || a.result?.reason || a.error?.note || '';
    lines.push(`| ${a.app} | ${a.attempt} | ${agentStatus} | ${verdictStatus} | ${reason} |`);

    if (a.verdict && a.result && a.verdict.status !== a.result.status) {
      divergent.push(`- **${a.app}/${a.attempt}**: agent claimed \`${a.result.status}\` but artifacts support \`${a.verdict.status}\` (${a.verdict.reason || 'see verdict.json'})`);
    }
    const term = a.verdict?.status ?? a.result?.status;
    if ((term === 'parked' || term === 'failed') && reason) {
      bump(reasons, `${term}: ${a.result?.parked_reason || reason}`, a.app);
    }
    for (const m of a.result?.missing ?? []) {
      bump(missing, m.label || JSON.stringify(m), `${a.app} (${m.needed || '?'})`);
    }
    for (const ans of a.answers ?? []) {
      if (ans.source === 'generated') bump(generated, ans.label, a.app);
    }
  }
  lines.push('');

  if (divergent.length) {
    lines.push('## Agent claims the artifacts do NOT support');
    lines.push('');
    lines.push(...divergent);
    lines.push('');
  }
  if (reasons.size) {
    lines.push('## Park/fail reasons across all jobs');
    lines.push('');
    for (const [reason, apps] of [...reasons].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`- **${reason}** ×${apps.length}: ${[...new Set(apps)].join(', ')}`);
    }
    lines.push('');
  }
  if (missing.size) {
    lines.push('## Missing answers (standing-answer candidates)');
    lines.push('');
    for (const [label, where] of [...missing].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`- **${label}** ×${where.length}: ${where.join('; ')}`);
    }
    lines.push('');
  }
  if (generated.size) {
    lines.push('## Generated answers (recurring ones belong in standing-answers.yml)');
    lines.push('');
    for (const [label, apps] of [...generated].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`- **${label}** ×${apps.length}: ${[...new Set(apps)].join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (cond) console.log(`ok - ${name}`);
    else { console.error(`FAIL - ${name}`); failures += 1; }
  };

  const attempts = [
    {
      app: 'a1', attempt: 'attempt-1', dir: '/x',
      result: { status: 'submitted', missing: [{ label: 'Visa type', needed: 'specific visa class' }] },
      verdict: { status: 'failed', ok: false, reason: 'no confirmation screenshot' },
      answers: [{ label: 'Why us?', source: 'generated' }, { label: 'Email', source: 'profile' }],
    },
    {
      app: 'a2', attempt: 'attempt-1', dir: '/y',
      result: { status: 'parked', reason: 'missing-fact: security clearance', parked_reason: 'missing-fact', missing: [{ label: 'Visa type', needed: 'visa class' }] },
      verdict: { status: 'parked', ok: true, reason: 'missing-fact: security clearance' },
      answers: [{ label: 'Why us?', source: 'generated' }],
    },
  ];
  const r = buildReport(attempts);
  check('divergence surfaced', r.includes('agent claimed `submitted` but artifacts support `failed`'));
  check('park reason aggregated', r.includes('parked: missing-fact'));
  check('missing grouped x2', r.includes('**Visa type** ×2'));
  check('generated grouped x2', r.includes('**Why us?** ×2'));
  check('profile-sourced answer not flagged', !r.includes('**Email**'));
  check('empty sweep renders', buildReport([]).includes('0 attempt(s)'));
  check('collectAttempts tolerates missing root', collectAttempts('/nonexistent-xyz').length === 0);

  if (failures > 0) { console.error(`self-test: ${failures} failure(s)`); process.exit(1); }
  console.log('self-test: all checks passed');
}

// ---------------------------------------------------------------------------
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, ['--self-test'], 'usage: node auto/diagnose.mjs [--self-test]');
  if (hasFlag(args, '--self-test')) selfTest();
  else {
    const attempts = collectAttempts(join(ROOT, 'output'));
    console.log(buildReport(attempts.map((a) => ({ ...a, app: relative(join(ROOT, 'output'), join(ROOT, 'output', a.app)) }))));
  }
}
