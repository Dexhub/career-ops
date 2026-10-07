#!/usr/bin/env node
// auto/patches/apply-ethical-override.mjs — apply (or verify) the sanctioned
// local-only AGENTS.md Ethical Use override. See ethical-override.md.
//
// Usage:
//   node auto/patches/apply-ethical-override.mjs          # idempotent apply
//   node auto/patches/apply-ethical-override.mjs --check  # exit 1 if not applied

import '../lib/sanitize-env.mjs';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS = join(ROOT, 'AGENTS.md');

const OLD_BULLET =
  '- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply. The user makes the final call.';

const NEW_BULLET =
  `- **Interactive sessions: never submit without the user reviewing first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply in any interactive mode.
- **LOCAL AUTONOMOUS EXCEPTION (this checkout only, user-authorized 2026-10-07):** the autonomous pipeline worker (\`auto/apply-worker.mjs\`) IS authorized to click Submit unattended, for jobs that scored >= the configured threshold, use a fact-gated resume variant, and answer from \`config/profile.yml\` (facts) + \`config/standing-answers.yml\` (user-confirmed preferences). Every attempt writes a mandatory audit dir. See \`auto/patches/ethical-override.md\`. This exception never extends to interactive sessions, never fabricates eligibility facts, and must not be committed upstream.`;

const applied = () => readFileSync(AGENTS, 'utf8').includes('LOCAL AUTONOMOUS EXCEPTION');

function apply() {
  const text = readFileSync(AGENTS, 'utf8');
  if (text.includes('LOCAL AUTONOMOUS EXCEPTION')) {
    console.log('ethical-override: already applied');
    return;
  }
  if (!text.includes(OLD_BULLET)) {
    console.error('ethical-override: AGENTS.md target bullet not found — upstream text changed; update apply-ethical-override.mjs');
    process.exit(1);
  }
  const tmp = `${AGENTS}.tmp`;
  writeFileSync(tmp, text.replace(OLD_BULLET, NEW_BULLET));
  renameSync(tmp, AGENTS);
  console.log('ethical-override: applied to AGENTS.md');
}

const argv = process.argv.slice(2);
if (argv.includes('--check')) {
  if (applied()) {
    console.log('ethical-override: present');
  } else {
    console.error('ethical-override: MISSING — run node auto/patches/apply-ethical-override.mjs');
    process.exit(1);
  }
} else {
  apply();
}
