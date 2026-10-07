#!/usr/bin/env node
// auto/digest.mjs — daily human-readable digest of the autonomous pipeline.
//
// Writes data/auto/digest-YYYY-MM-DD.md with a table of every job that moved
// to submitted/parked/failed, plus queue counts, and posts a macOS
// notification when anything needs a human (parked jobs).
//
// Usage:
//   node auto/digest.mjs             # write today's digest + notify
//   node auto/digest.mjs --quiet     # no notification
//   node auto/digest.mjs --self-test

import './lib/sanitize-env.mjs';

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { listJobs } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function lastAt(job, stage) {
  const t = [...(job.timestamps || [])].reverse().find((x) => x.stage === stage);
  return t ? t.at : null;
}

export function buildDigest(jobs, day) {
  const terminal = ['submitted', 'parked', 'failed'];
  const movedToday = jobs.filter((j) =>
    terminal.includes(j.stage) && (lastAt(j, j.stage) || '').startsWith(day));

  const counts = {};
  for (const j of jobs) counts[j.stage] = (counts[j.stage] || 0) + 1;

  const lines = [];
  lines.push(`# Auto-pipeline digest — ${day}`);
  lines.push('');
  lines.push(`Queue: ${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(' · ') || 'empty'}`);
  lines.push('');
  if (movedToday.length === 0) {
    lines.push('_No submissions, parks, or failures today._');
  } else {
    lines.push('| Stage | Company | Role | Score | Detail | Audit |');
    lines.push('|---|---|---|---|---|---|');
    for (const j of movedToday) {
      const audit = j.auditDir ? relative(ROOT, j.auditDir) : '—';
      const detail = j.stage === 'submitted' ? (lastAt(j, 'submitted') || '').slice(11, 16) + ' UTC'
        : (j.lastError || '—');
      lines.push(`| ${j.stage} | ${j.company} | ${j.role} | ${j.score ?? '—'} | ${detail} | ${audit} |`);
    }
  }
  const parked = movedToday.filter((j) => j.stage === 'parked');
  if (parked.length > 0) {
    lines.push('');
    lines.push('## Needs a human (parked)');
    lines.push('');
    for (const j of parked) {
      lines.push(`- **${j.company} — ${j.role}**: ${j.lastError || 'see audit'}. Finish via Neo/manual, then \`node auto/state.mjs\` shows it; park reasons in auto/README.md.`);
      lines.push(`  ${j.url}`);
    }
  }
  lines.push('');
  return { text: lines.join('\n'), movedToday, parkedCount: parked.length };
}

export function writeDigest({ day = new Date().toISOString().slice(0, 10), quiet = false, log = console.log } = {}) {
  const { text, movedToday, parkedCount } = buildDigest(listJobs(), day);
  const outDir = join(ROOT, 'data', 'auto');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `digest-${day}.md`);
  writeFileSync(outPath, text);
  log(`digest: ${movedToday.length} job(s) moved today -> ${outPath}`);
  if (!quiet && movedToday.length > 0) {
    const msg = `${movedToday.length} application(s) moved today` +
      (parkedCount > 0 ? ` — ${parkedCount} parked, needs you` : '');
    spawnSync('osascript', ['-e',
      `display notification ${JSON.stringify(msg)} with title "career-ops auto"`]);
  }
  return outPath;
}

// ---------------------------------------------------------------------------
function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (cond) console.log(`ok - ${name}`);
    else { console.error(`FAIL - ${name}`); failures += 1; }
  };

  const day = '2026-10-07';
  const jobs = [
    { stage: 'submitted', company: 'a', role: 'r', score: 4.5, auditDir: join(ROOT, 'output/x/audit/attempt-1'),
      timestamps: [{ stage: 'submitted', at: '2026-10-07T18:31:00Z' }] },
    { stage: 'parked', company: 'b', role: 'r2', score: null, lastError: 'login-or-captcha', url: 'https://x.test/b',
      timestamps: [{ stage: 'parked', at: '2026-10-07T01:00:00Z' }] },
    { stage: 'submitted', company: 'old', role: 'r3', score: 4,
      timestamps: [{ stage: 'submitted', at: '2026-10-06T10:00:00Z' }] },
    { stage: 'queued', company: 'q', role: 'r4', timestamps: [] },
  ];
  const { text, movedToday, parkedCount } = buildDigest(jobs, day);
  check('two jobs moved today', movedToday.length === 2);
  check('yesterday submission excluded', !text.includes('| old |'));
  check('parked section present', parkedCount === 1 && text.includes('Needs a human'));
  check('audit path relative', text.includes('output/x/audit/attempt-1'));
  check('queue counts line', text.includes('queued 1'));

  const empty = buildDigest([], day);
  check('empty digest renders', empty.text.includes('No submissions'));

  if (failures > 0) { console.error(`self-test: ${failures} failure(s)`); process.exit(1); }
  console.log('self-test: all checks passed');
}

// ---------------------------------------------------------------------------
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, ['--quiet', '--self-test'],
    'usage: node auto/digest.mjs [--quiet] [--self-test]');
  if (hasFlag(args, '--self-test')) selfTest();
  else writeDigest({ quiet: hasFlag(args, '--quiet') });
}
