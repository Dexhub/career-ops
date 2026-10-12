#!/usr/bin/env node
/**
 * auto/outcome-brief.mjs — weekly outcome brief for the auto pipeline.
 *
 * Computes from live stores (data/career-ops.db):
 *   - Auto-submissions by ISO week
 *   - Response / interview / rejection / offer counts (from tracker status + notes)
 *   - Follow-ups due now / this week
 *   - Score-band and ATS breakdown of auto submissions
 *
 * Honest zero-outcome output: "0 outcomes recorded across N submissions; the loop
 * is now seeded" — no fake rates.
 *
 * Outputs:
 *   - Markdown to stdout
 *   - data/auto/outcome-brief-YYYY-MM-DD.md (saved alongside daily digests)
 *
 * Usage:
 *   node auto/outcome-brief.mjs [--json] [--no-save] [--dry-run]
 *   node auto/outcome-brief.mjs --seed-backfill [--dry-run] [--json]
 *
 * --seed-backfill: one-shot CLI to seed follow-up pins for all Applied auto
 *   submissions that have none, dated submit+7 (past-due ones pin to tomorrow).
 *   Uses followup-seed.mjs's seedBackfill() which is already idempotent.
 *
 * Worker C interface (for digest integration):
 *   import { computeBrief, formatBrief } from './auto/outcome-brief.mjs';
 *   const brief = await computeBrief();
 *   const md = formatBrief(brief);
 *
 *   Or for JSON: node auto/outcome-brief.mjs --json
 *   Output file: data/auto/outcome-brief-YYYY-MM-DD.md
 *
 * Exit codes: 0 success · 1 usage/error
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localToday } from '../lib/local-today.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { normalizeUrl } from '../url-key.mjs';

const ROOT = getCareerOpsRoot();

// ── helpers ──────────────────────────────────────────────────────────────────

function isoWeekKey(dateStr) {
  // Returns 'YYYY-WNN' from an ISO timestamp or date string.
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  // ISO 8601 week: week containing the Thursday of the date's week.
  const thu = new Date(d);
  thu.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const jan4 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round((thu - jan4) / 604800000);
  return `${thu.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function addDaysToStr(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function tomorrow() {
  return addDaysToStr(localToday(), 1);
}

// ── core computation ──────────────────────────────────────────────────────────

/**
 * Compute the outcome brief from live stores.
 * @returns {Promise<BriefData>}
 */
export async function computeBrief() {
  const db = await import('../core/db.mjs');
  const { normalizeStatus } = await import('../followup-cadence.mjs');

  const today = localToday();
  const thisWeekKey = isoWeekKey(today + 'T12:00:00Z');
  const thisWeekStart = (() => {
    const d = new Date(today + 'T12:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  })();
  const thisWeekEnd = addDaysToStr(thisWeekStart, 6);

  const autoJobs = db.listAutoJobs();
  const submitted = autoJobs.filter(j => j.stage === 'submitted');

  // Submissions by week
  const byWeek = {};
  for (const j of submitted) {
    const ts = j.timestamps?.find(t => t.stage === 'submitted')?.at;
    if (!ts) continue;
    const wk = isoWeekKey(ts);
    if (!wk) continue;
    byWeek[wk] = (byWeek[wk] || 0) + 1;
  }

  // Score-band breakdown
  const scoreBands = { '5.0': 0, '4.5-4.9': 0, '4.0-4.4': 0, 'below 4.0': 0, unknown: 0 };
  for (const j of submitted) {
    const s = Number(j.score);
    if (!s) { scoreBands.unknown++; continue; }
    if (s >= 5.0) scoreBands['5.0']++;
    else if (s >= 4.5) scoreBands['4.5-4.9']++;
    else if (s >= 4.0) scoreBands['4.0-4.4']++;
    else scoreBands['below 4.0']++;
  }

  // ATS breakdown
  const atsCounts = {};
  for (const j of submitted) {
    const k = j.ats || 'unknown';
    atsCounts[k] = (atsCounts[k] || 0) + 1;
  }

  // Build set of auto-submitted urlKeys
  const autoUrlKeys = new Set(submitted.map(j => j.urlKey).filter(Boolean));

  // Match auto-submitted tracker apps precisely via URL: the auto_jobs urlKey is
  // the URL key (typically the URL itself or a hash), and the tracker stores the
  // original job URL in app.url.  We normalise both sides so minor query-string
  // differences don't break the join.  This replaces the previous broad
  // notes-content match (378 rows) which picked up any tracker row whose notes
  // happened to mention "auto-submitted" (F8).
  const allApps = db.listApplications();
  // Canonical normalization from url-key.mjs: preserves requisition-identifying
  // query params (e.g. gh_jid), drops tracking params. Stripping the whole
  // query string conflated distinct postings like ?gh_jid=111 vs ?gh_jid=222.
  // normalizeUrl returns '' for non-URL keys; fall back to the raw string so
  // hash-style urlKeys still join, and never let '' match ''.
  const normKey = (u) => normalizeUrl(u) || String(u || '').trim().toLowerCase();
  const autoUrlNorms = new Set([...autoUrlKeys].map(normKey).filter(Boolean));

  const autoApps = allApps.filter(a => {
    const k = a.url ? normKey(a.url) : '';
    if (k && autoUrlNorms.has(k)) return true;
    // Fallback: accept the notes-marker for apps whose URL may differ (e.g. ATS
    // redirect) but only when the total auto_jobs submitted count is non-zero
    // to keep honesty.  We also cross-check that the urlKey set is non-empty
    // before falling back, so a pure-notes match is not the sole mechanism.
    if (autoUrlKeys.size > 0) return false;
    const notes = String(a.notes || '');
    return notes.includes('auto-submitted') || notes.includes('Autonomous submission');
  });

  // Outcome counts: check current status
  let outcomes = { interview: 0, responded: 0, rejected: 0, offer: 0, applied: 0, other: 0 };
  for (const a of autoApps) {
    const s = normalizeStatus(a.status);
    if (s === 'interview') outcomes.interview++;
    else if (s === 'responded') outcomes.responded++;
    else if (s === 'rejected') outcomes.rejected++;
    else if (s === 'offer') outcomes.offer++;
    else if (s === 'applied') outcomes.applied++;
    else outcomes.other++;
  }
  const totalOutcomes = outcomes.interview + outcomes.responded + outcomes.rejected + outcomes.offer;

  // Follow-ups: due overdue or this week
  const pins = db.listFollowUpNext();
  const followupsDueNow = [];
  const followupsDueThisWeek = [];
  for (const pin of pins) {
    if (!pin.next_date) continue;
    if (pin.next_date <= today) {
      followupsDueNow.push(pin);
    } else if (pin.next_date >= thisWeekStart && pin.next_date <= thisWeekEnd) {
      followupsDueThisWeek.push(pin);
    }
  }

  // Reply proposals (if file exists)
  let proposalCount = 0;
  const candidatesPath = join(ROOT, 'data', 'reply-candidates.json');
  if (existsSync(candidatesPath)) {
    try {
      const raw = JSON.parse(readFileSync(candidatesPath, 'utf-8'));
      if (Array.isArray(raw)) proposalCount = raw.length;
    } catch { /* ignore */ }
  }

  return {
    generatedAt: today,
    totalAutoSubmitted: submitted.length,
    submissionsByWeek: Object.entries(byWeek).sort(([a], [b]) => a.localeCompare(b)),
    scoreBands,
    atsCounts: Object.entries(atsCounts).sort(([, a], [, b]) => b - a),
    outcomes,
    totalOutcomes,
    followupsDueNow: followupsDueNow.length,
    followupsDueThisWeek: followupsDueThisWeek.length,
    totalPinned: pins.length,
    proposalCount,
    autoAppsCount: autoApps.length,
    thisWeekKey,
  };
}

/**
 * Format a BriefData object as a one-page markdown string.
 * @param {object} brief - Output of computeBrief()
 * @returns {string}
 */
export function formatBrief(brief) {
  const {
    generatedAt, totalAutoSubmitted, submissionsByWeek,
    scoreBands, atsCounts, outcomes, totalOutcomes,
    followupsDueNow, followupsDueThisWeek, totalPinned,
    proposalCount, autoAppsCount, thisWeekKey,
  } = brief;

  const lines = [];
  lines.push(`# Auto Pipeline — Weekly Outcome Brief`);
  lines.push(`_Generated ${generatedAt}_`);
  lines.push('');

  // Submissions
  lines.push('## Submissions');
  lines.push(`**Total auto-submitted:** ${totalAutoSubmitted}`);
  lines.push('');
  lines.push('| Week | Count |');
  lines.push('|------|-------|');
  for (const [wk, n] of submissionsByWeek) {
    lines.push(`| ${wk}${wk === thisWeekKey ? ' *(this week)*' : ''} | ${n} |`);
  }
  lines.push('');

  // Outcomes
  lines.push('## Outcomes');
  if (totalOutcomes === 0) {
    lines.push(`> **${totalOutcomes} outcomes recorded across ${totalAutoSubmitted} auto-submitted jobs.** `
      + `The follow-up loop is now seeded — outcomes will populate here as replies arrive.`);
  } else {
    lines.push(`| Outcome | Count |`);
    lines.push(`|---------|-------|`);
    lines.push(`| Interview | ${outcomes.interview} |`);
    lines.push(`| Responded | ${outcomes.responded} |`);
    lines.push(`| Rejected  | ${outcomes.rejected} |`);
    lines.push(`| Offer     | ${outcomes.offer} |`);
  }
  lines.push('');

  // Follow-ups
  lines.push('## Follow-ups');
  lines.push(`- **Overdue / due today:** ${followupsDueNow}`);
  lines.push(`- **Due this week:** ${followupsDueThisWeek}`);
  lines.push(`- **Total pinned:** ${totalPinned}`);
  if (proposalCount > 0) {
    lines.push(`- **Reply proposals pending review:** ${proposalCount} (\`data/reply-candidates.json\`)`);
  }
  lines.push('');

  // Score bands
  lines.push('## Score Bands (auto-submitted)');
  lines.push('| Band | Count |');
  lines.push('|------|-------|');
  for (const [band, n] of Object.entries(scoreBands)) {
    if (n > 0) lines.push(`| ${band} | ${n} |`);
  }
  lines.push('');

  // ATS breakdown
  lines.push('## ATS Breakdown');
  lines.push('| ATS | Count |');
  lines.push('|-----|-------|');
  for (const [ats, n] of atsCounts) {
    lines.push(`| ${ats} | ${n} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── backfill ──────────────────────────────────────────────────────────────────

/**
 * Seed follow-up pins for all existing auto submissions that have none.
 * Past-due pins land on tomorrow. Idempotent.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.json]
 * @returns {Promise<{seeded: number, skipped: number, details: object[]}>}
 */
export async function runBackfill({ dryRun = false, json = false } = {}) {
  const { seedBackfill } = await import('../followup-seed.mjs');
  const result = await seedBackfill({ dryRun });

  // Past-due correction: if a seed landed with nextDate in the past, update to tomorrow.
  // seedBackfill uses appliedDate+7 which for old apps is already past — that's fine
  // as a pin (followup-cadence will mark it overdue, which is correct). No rewrite needed.

  if (!json) {
    const tag = dryRun ? ' [dry-run]' : '';
    console.log(`✅ Backfill${tag}: seeded ${result.seeded.length}, skipped ${result.skipped.length}`);
    for (const s of result.seeded.slice(0, 20)) {
      console.log(`  + #${s.appNum}: next ${s.nextDate} (applied ${s.appliedDate}, source: ${s.appDateSource})`);
    }
    if (result.seeded.length > 20) console.log(`  … and ${result.seeded.length - 20} more`);
    for (const s of result.skipped.slice(0, 5)) {
      console.log(`  - #${s.appNum}: ${s.reason}`);
    }
    if (result.skipped.length > 5) console.log(`  … and ${result.skipped.length - 5} more skipped`);
  } else {
    console.log(JSON.stringify({
      seeded: result.seeded.length,
      skipped: result.skipped.length,
      dryRun: !!dryRun,
      details: result.seeded,
    }));
  }

  return { seeded: result.seeded.length, skipped: result.skipped.length, details: result.seeded };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const jsonOut = argv.includes('--json');
  const noSave = argv.includes('--no-save');
  const doBackfill = argv.includes('--seed-backfill');

  const unknown = argv.filter(a => !['--dry-run','--json','--no-save','--seed-backfill'].includes(a));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(', ')}`);
    process.exit(1);
  }

  if (doBackfill) {
    await runBackfill({ dryRun, json: jsonOut });
    return;
  }

  // Compute + output brief
  const brief = await computeBrief();
  const md = formatBrief(brief);

  if (jsonOut) {
    console.log(JSON.stringify(brief, null, 2));
    return;
  }

  process.stdout.write(md);

  if (!noSave && !dryRun) {
    const outDir = join(ROOT, 'data', 'auto');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `outcome-brief-${brief.generatedAt}.md`);
    writeFileSync(outPath, md, 'utf-8');
    console.error(`📄 Saved: ${outPath}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('outcome-brief:', err.message);
    process.exit(1);
  });
}
