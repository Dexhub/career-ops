#!/usr/bin/env node
// auto/scrub-prompt-credentials.mjs — T0.4(c): redact ATS password values from
// existing output/*/prompt.md files.
//
// Builds the password list from data/auto/accounts.json at runtime — no
// secrets are hardcoded here. Skips the directory of the currently-running
// apply (identified via the API). Deletes no temp files because none are
// created. Prints a grep-zero verification pass at the end.
//
// Usage:
//   node auto/scrub-prompt-credentials.mjs [--dry-run]
//   node auto/scrub-prompt-credentials.mjs --skip-dir <path>  # override active-job skip

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNTS_FILE = join(ROOT, 'data', 'auto', 'accounts.json');
const OUTPUT_DIR = join(ROOT, 'output');
const STATUS_API = 'http://127.0.0.1:3001/api/auto/status';

const isDryRun = process.argv.includes('--dry-run');
const skipDirOverride = (() => {
  const idx = process.argv.indexOf('--skip-dir');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ---------------------------------------------------------------------------
// Load passwords from accounts.json (never hardcode)
function loadPasswords() {
  try {
    const accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    return Object.values(accounts)
      .map(a => a?.password)
      .filter(pw => typeof pw === 'string' && pw.length > 0);
  } catch (err) {
    console.error(`scrub: cannot read accounts.json — ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Identify the active-apply output dir (skip it to avoid racing a live write).
async function resolveActiveOutputDir() {
  if (skipDirOverride) return skipDirOverride;
  try {
    // Fetch with a short timeout — if the API is unreachable we skip nothing
    // and warn instead of aborting the scrub.
    const { default: fetch } = await import('node:http').then(m => Promise.resolve(m));
    return await new Promise((resolve) => {
      const req = fetch.get(STATUS_API, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            // workingOn is a display name; map it to an output subdir by
            // scanning output/ for a dir whose name contains the company slug.
            const wo = data?.workingOn;
            if (!wo) return resolve(null);
            // normalise: lowercase, collapse non-alnum to '-'
            const slug = wo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const dirs = readdirSync(OUTPUT_DIR);
            const match = dirs.find(d => d.includes(slug));
            resolve(match ? join(OUTPUT_DIR, match) : null);
          } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Redact passwords in a single string
function redact(content, passwords) {
  let out = content;
  for (const pw of passwords) {
    out = out.split(pw).join('[REDACTED]');
  }
  return out;
}

// ---------------------------------------------------------------------------
async function main() {
  const passwords = loadPasswords();
  if (passwords.length === 0) {
    console.log('scrub: no passwords in accounts.json — nothing to redact');
    process.exit(0);
  }

  const activeDir = await resolveActiveOutputDir();
  if (activeDir) {
    console.log(`scrub: active-apply dir identified — SKIP: ${activeDir}`);
  } else {
    console.log('scrub: no active apply detected (API unreachable or cycle idle)');
  }

  // Collect all prompt.md files
  const promptFiles = [];
  const topDirs = readdirSync(OUTPUT_DIR, { withFileTypes: true });
  for (const entry of topDirs) {
    if (!entry.isDirectory()) continue;
    const jobDir = join(OUTPUT_DIR, entry.name);

    // Skip the active-apply directory
    if (activeDir && jobDir === activeDir) {
      console.log(`scrub: skipping active dir ${entry.name} (flag for later pass)`);
      continue;
    }

    // Walk audit subdirs
    const auditDir = join(jobDir, 'audit');
    if (!existsSync(auditDir)) {
      // Legacy layout: prompt.md directly under jobDir
      const legacyPrompt = join(jobDir, 'prompt.md');
      if (existsSync(legacyPrompt)) promptFiles.push(legacyPrompt);
      continue;
    }
    const auditEntries = readdirSync(auditDir, { withFileTypes: true });
    for (const ae of auditEntries) {
      if (!ae.isDirectory()) continue;
      const attemptDir = join(auditDir, ae.name);
      const pf = join(attemptDir, 'prompt.md');
      if (existsSync(pf)) promptFiles.push(pf);
    }
    // Also check legacy attempt-1/attempt-2 flat dirs at jobDir level
    for (const ae of readdirSync(jobDir, { withFileTypes: true })) {
      if (!ae.isDirectory() || ae.name === 'audit') continue;
      const pf = join(jobDir, ae.name, 'prompt.md');
      if (existsSync(pf)) promptFiles.push(pf);
    }
  }

  console.log(`scrub: found ${promptFiles.length} prompt.md files`);

  let beforeCount = 0;
  let redactedCount = 0;
  let unchangedCount = 0;
  let errorCount = 0;

  for (const fp of promptFiles) {
    try {
      const original = readFileSync(fp, 'utf8');
      let hasAny = false;
      for (const pw of passwords) {
        if (original.includes(pw)) { hasAny = true; break; }
      }
      if (hasAny) beforeCount++;

      const redacted = redact(original, passwords);
      if (redacted === original) {
        unchangedCount++;
        continue;
      }
      if (isDryRun) {
        console.log(`[DRY-RUN] would redact: ${fp}`);
      } else {
        writeFileSync(fp, redacted, 'utf8');
      }
      redactedCount++;
    } catch (err) {
      console.error(`scrub: ERROR on ${fp}: ${err.message}`);
      errorCount++;
    }
  }

  console.log(`\nscrub summary:`);
  console.log(`  prompt.md files scanned : ${promptFiles.length}`);
  console.log(`  files with passwords    : ${beforeCount} (before)`);
  console.log(`  files redacted          : ${redactedCount}${isDryRun ? ' (dry-run, not written)' : ''}`);
  console.log(`  files already clean     : ${unchangedCount}`);
  console.log(`  errors                  : ${errorCount}`);

  if (isDryRun) {
    console.log('\n[DRY-RUN] no files were modified');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Verification pass: grep for any remaining password value across output/
  console.log('\nscrub: verification pass — checking for remaining password values...');
  let remainingExposures = 0;
  const allPromptFiles = [];
  for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobDir = join(OUTPUT_DIR, entry.name);
    const auditDir = join(jobDir, 'audit');

    if (existsSync(auditDir)) {
      for (const ae of readdirSync(auditDir, { withFileTypes: true })) {
        if (!ae.isDirectory()) continue;
        const pf = join(auditDir, ae.name, 'prompt.md');
        if (existsSync(pf)) allPromptFiles.push(pf);
      }
    }
    // Legacy layouts
    const legacyPrompt = join(jobDir, 'prompt.md');
    if (existsSync(legacyPrompt)) allPromptFiles.push(legacyPrompt);
    for (const ae of readdirSync(jobDir, { withFileTypes: true })) {
      if (!ae.isDirectory() || ae.name === 'audit') continue;
      const pf = join(jobDir, ae.name, 'prompt.md');
      if (existsSync(pf)) allPromptFiles.push(pf);
    }
  }

  const skippedPaths = activeDir ? [activeDir] : [];
  for (const fp of allPromptFiles) {
    const isInSkipped = skippedPaths.some(s => fp.startsWith(s));
    if (isInSkipped) continue;
    try {
      const content = readFileSync(fp, 'utf8');
      for (const pw of passwords) {
        if (content.includes(pw)) {
          remainingExposures++;
          console.error(`  STILL EXPOSED: ${fp}`);
          break;
        }
      }
    } catch { /* skip unreadable */ }
  }

  if (remainingExposures === 0) {
    console.log(`  PASS: zero password values remain in output/ prompt.md files (skipped dirs: ${skippedPaths.length})`);
  } else {
    console.error(`  FAIL: ${remainingExposures} file(s) still contain password values — inspect above`);
    process.exit(1);
  }

  if (errorCount > 0) {
    console.error(`scrub: completed with ${errorCount} error(s)`);
    process.exit(1);
  }
}

main().catch(err => { console.error('scrub: fatal:', err.message); process.exit(1); });
