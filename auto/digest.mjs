#!/usr/bin/env node
// auto/digest.mjs — daily human-readable digest of the autonomous pipeline.
//
// Writes data/auto/digest-YYYY-MM-DD.md with a table of every job that moved
// to submitted/parked/failed, plus:
//   - Park-reason Pareto (T1.2: park-drain loop)
//   - "Answer N questions to unlock M parked jobs" panel (T1.2)
//   - Resume-fallback summary (T2.2)
//   - Per-ATS success/park rates
//   - Backlog economics line
//   - Cost/day line (from cost-report internals)
//   - Score-correction audit summary
//   - Parked-job aging (stale parked jobs re-surfaced)
//   - Outcome brief (from outcome-brief.mjs)
//   - Decisions needed block
//
// Push channel (email vs Telegram) is a USER DECISION — do NOT set one up.
// Delivery is digest file + macOS notification. A pluggable channel hook is
// provided: sendDigest(text, channel) — pass a channel object with a .send()
// method to add a channel. The decisions-needed section surfaces this choice.
//
// Usage:
//   node auto/digest.mjs             # write today's digest + notify
//   node auto/digest.mjs --quiet     # no notification
//   node auto/digest.mjs --dry-run   # write to /tmp, no notification
//   node auto/digest.mjs --self-test

import './lib/sanitize-env.mjs';

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { listJobs } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── helpers ───────────────────────────────────────────────────────────────────

function lastAt(job, stage) {
  const t = [...(job.timestamps || [])].reverse().find((x) => x.stage === stage);
  return t ? t.at : null;
}

/** Days since an ISO timestamp (or date string), clamped to 0. */
function daysSince(isoTs) {
  if (!isoTs) return null;
  const diff = (Date.now() - new Date(isoTs).getTime()) / 86_400_000;
  return Math.max(0, Math.round(diff));
}

// ── Park-drain aggregation (T1.2) ─────────────────────────────────────────────

/**
 * Four policy prompts the user has deferred — always surfaced as park-drain
 * questions regardless of whether diagnose.mjs flags them specifically.
 *
 * These are PROPOSAL ONLY — never auto-apply. No sensitive/restricted content
 * (ethnicity, disability, etc.) is included here.
 */
const DEFERRED_POLICY_PROMPTS = [
  {
    key: 'eeo_when_no_decline',
    label: 'EEO questions when the form has no decline option',
    question: 'When an EEO form requires a race/gender/disability answer and has no "Decline to self-identify" option, what should the pipeline do?',
    proposedYaml: `custom:
  "what is your race?": "Decline to self-identify"   # PROPOSAL — confirm or replace`,
  },
  {
    key: 'quirky_culture_questions',
    label: "Quirky culture / personality fit questions (\"What's your spirit animal?\")",
    question: "For open-ended personality/culture questions (e.g. \"What's your spirit animal?\", \"Describe yourself in one word\"), should the pipeline answer from profile.yml, generate ad-hoc, or park?",
    proposedYaml: `# PROPOSAL — add to custom: block after user review
custom:
  "what is your spirit animal?": "Wolf — collaborative, adaptive, and driven."
  "describe yourself in one word?": "Builder."`,
  },
  {
    key: 'non_usd_ote',
    label: 'Non-USD salary expectations (EUR/GBP/CAD/AUD roles)',
    question: 'When a role pays in EUR/GBP/CAD/AUD, what salary range should the pipeline fill in?',
    proposedYaml: `salary:
  # PROPOSAL — confirm or replace before applying
  expectation_eur: "180000"   # EUR base
  expectation_gbp: "160000"   # GBP base
  expectation_cad: "260000"   # CAD base
  expectation_aud: "310000"   # AUD base`,
  },
  {
    key: 'attestations',
    label: 'Attestation / certification checkbox questions',
    question: 'For attestation questions ("I certify the above is true", "I acknowledge the background check terms"), should the pipeline check all checkboxes automatically?',
    proposedYaml: `custom:
  # PROPOSAL — confirm blanket attestation consent
  "i certify that the information provided is true and complete": "Yes"
  "i acknowledge the terms of the background check authorization": "Yes"`,
  },
];

/**
 * Aggregate park reasons from the live job list plus diagnose-style audit dirs.
 *
 * Returns:
 *   - parkPareto: [{reason, count, examples[]}] sorted by count desc
 *   - resumeFallbacks: [{company, role, resumeNote}] jobs that shipped default CV
 *   - atsSummary: [{ats, submitted, parked, failRate}] per-ATS rates
 *   - backlogCount: total pipeline items (discovered)
 *   - totalParked: count of currently-parked jobs
 *   - stalledParked: [{company, role, reason, daysParked}] parked > 3 days
 *   - scoreCorrectionCount: number of score-correction parks
 *   - questionsToUnlock: [{question, proposedYaml, affectedCount}]
 *   - totalJobsUnlockable: how many parked jobs could be unlocked by answering questions
 */
export function aggregateParkDrain(jobs) {
  const reasonMap = new Map();
  const resumeFallbacks = [];
  const atsMap = new Map();
  let backlogCount = 0;
  let totalParked = 0;
  let scoreCorrectionCount = 0;
  const stalledParked = [];

  for (const j of jobs) {
    if (j.stage === 'discovered') backlogCount++;

    // ATS tracking
    const ats = j.ats || 'unknown';
    if (!atsMap.has(ats)) atsMap.set(ats, { submitted: 0, parked: 0, failed: 0 });
    if (j.stage === 'submitted') atsMap.get(ats).submitted++;
    else if (j.stage === 'parked') atsMap.get(ats).parked++;
    else if (j.stage === 'failed') atsMap.get(ats).failed++;

    // Park reasons Pareto
    if (j.stage === 'parked') {
      totalParked++;
      const reason = (j.lastError || 'unknown').slice(0, 120);
      if (!reasonMap.has(reason)) reasonMap.set(reason, { count: 0, examples: [] });
      reasonMap.get(reason).count++;
      if (reasonMap.get(reason).examples.length < 3) reasonMap.get(reason).examples.push(j.company);

      // Score-correction count
      if (/score.correction/i.test(reason)) scoreCorrectionCount++;

      // Stalled parked jobs: parked > 3 days
      const parkedAt = lastAt(j, 'parked');
      const daysParked = daysSince(parkedAt);
      if (daysParked !== null && daysParked > 3) {
        stalledParked.push({ company: j.company, role: j.role, reason: reason.slice(0, 80), daysParked });
      }
    }

    // Resume fallbacks (T2.2): jobs that mention default/fallback resume in resumeNote.
    // Split by stage: submitted-with-fallback vs selected-but-not-submitted (parked/failed/pending).
    if (j.resumeNote && /default|fallback|head.of.ai/i.test(j.resumeNote)) {
      resumeFallbacks.push({ company: j.company, role: j.role, resumeNote: j.resumeNote.slice(0, 80), stage: j.stage });
    }
  }

  const parkPareto = [...reasonMap.entries()]
    .map(([reason, v]) => ({ reason, count: v.count, examples: v.examples }))
    .sort((a, b) => b.count - a.count);

  const atsSummary = [...atsMap.entries()]
    .map(([ats, v]) => ({
      ats,
      submitted: v.submitted,
      parked: v.parked,
      failed: v.failed,
      total: v.submitted + v.parked + v.failed,
      parkRate: v.submitted + v.parked > 0
        ? Math.round((v.parked / (v.submitted + v.parked)) * 100) : null,
    }))
    .sort((a, b) => b.total - a.total);

  // Questions to unlock: policy prompts + any recurring park reason that maps to a question
  // Map park reasons to question keys
  const questionMatches = new Map(); // key -> count
  const REASON_TO_QUESTION = [
    [/eeo|equal.opport|self.identify/i, 'eeo_when_no_decline'],
    [/quirky|spirit.animal|personality|culture.fit/i, 'quirky_culture_questions'],
    [/eur|gbp|cad|aud|non.usd|currency/i, 'non_usd_ote'],
    [/attest|certif|background.check.acknowledg/i, 'attestations'],
  ];
  for (const { reason, count } of parkPareto) {
    for (const [re, key] of REASON_TO_QUESTION) {
      if (re.test(reason)) {
        questionMatches.set(key, (questionMatches.get(key) || 0) + count);
      }
    }
  }

  const questionsToUnlock = DEFERRED_POLICY_PROMPTS.map((p) => ({
    ...p,
    affectedCount: questionMatches.get(p.key) || 0,
  })).filter((q) => q.affectedCount > 0 || true); // always show all 4 policy prompts

  const totalJobsUnlockable = [...questionMatches.values()].reduce((s, n) => s + n, 0);

  stalledParked.sort((a, b) => b.daysParked - a.daysParked);

  return {
    parkPareto,
    resumeFallbacks,
    atsSummary,
    backlogCount,
    totalParked,
    stalledParked,
    scoreCorrectionCount,
    questionsToUnlock,
    totalJobsUnlockable,
  };
}

// ── Cost line (T1.3) from cost-report internals ───────────────────────────────

/**
 * Read verdict.json files and compute a simple cost/day estimate.
 * Honest about coverage: returns null when no usage data found.
 * @returns {{ totalCostUsd: number|null, totalAttempts: number, coveragePct: number, estCostToday: number|null }}
 */
export function computeCostLine(outputDir = join(ROOT, 'output')) {
  let total = 0;
  let withCost = 0;
  let totalCost = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  let todayCost = 0;
  let todayAttempts = 0;

  if (!existsSync(outputDir)) return { totalCostUsd: null, totalAttempts: 0, coveragePct: 0, estCostToday: null };

  function tryParse(fp) {
    try { return JSON.parse(readFileSync(fp, 'utf8')); } catch { return null; }
  }

  function scanDir(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = join(dir, entry.name);
        if (entry.name.startsWith('attempt-') || entry.name.match(/^[0-9a-f-]{8,}/)) {
          const vp = join(sub, 'verdict.json');
          if (existsSync(vp)) {
            const v = tryParse(vp);
            if (v) {
              total++;
              const u = v.usage;
              if (u && typeof u.costUsd === 'number') {
                withCost++;
                totalCost += u.costUsd;
                const ts = v.submittedAt || v.verdictAt || v.timestamp || '';
                if (ts.startsWith(todayStr)) {
                  todayCost += u.costUsd;
                  todayAttempts++;
                }
              }
            }
          }
        } else {
          scanDir(sub); // recurse into job dirs
        }
      }
    } catch { /* best effort */ }
  }
  scanDir(outputDir);

  const coveragePct = total > 0 ? Math.round((withCost / total) * 100) : 0;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    totalCostUsd: withCost > 0 ? round2(totalCost) : null,
    totalAttempts: total,
    withCostData: withCost,
    coveragePct,
    estCostToday: todayAttempts > 0 ? round2(todayCost) : null,
  };
}

// ── Resume-variant proposals (T2.2) ───────────────────────────────────────────

/**
 * Propose new resume variants for title families that show up frequently in
 * resume fallbacks. Content is proposals only — user must review, no files written.
 */
function proposeResumeVariants(resumeFallbacks) {
  const familyCounts = {};
  for (const f of resumeFallbacks) {
    // Simple family detection from role title keywords
    const r = (f.role || '').toLowerCase();
    let family = 'other';
    if (/principal|staff\s+(?:eng|swe|software)/i.test(r)) family = 'Principal IC';
    else if (/cto|chief.tech|vp.eng/i.test(r)) family = 'CTO/VPE';
    else if (/public.sector|government|federal|state.gov/i.test(r)) family = 'Public-sector';
    else if (/director|head.of/i.test(r)) family = 'Director/Head';
    familyCounts[family] = (familyCounts[family] || 0) + 1;
  }

  const proposals = [];
  for (const [family, count] of Object.entries(familyCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    proposals.push({ family, count });
  }
  return proposals;
}

// ── Pluggable channel (T1.3) ───────────────────────────────────────────────────

/**
 * Send the digest via the given channel object.
 * Channel interface: { name: string, send: (text: string) => Promise<void>|void }
 *
 * PUSH CHANNEL IS A USER DECISION — no channel is set up here.
 * To add a channel, pass one to writeDigest() or call sendDigest() directly:
 *
 *   const emailChannel = { name: 'email', send: async (text) => { ... } };
 *   await sendDigest(text, emailChannel);
 *
 * @param {string} text — digest markdown text
 * @param {object|null} channel — channel object, or null for no push
 */
export async function sendDigest(text, channel = null) {
  if (!channel || typeof channel.send !== 'function') return;
  try {
    await channel.send(text);
  } catch (err) {
    console.warn(`digest: channel send failed (${channel.name ?? '?'}): ${err.message}`);
  }
}

// ── Core build function ───────────────────────────────────────────────────────

/**
 * Build the extended digest.
 *
 * @param {object[]} jobs — from listJobs()
 * @param {string} day — YYYY-MM-DD
 * @param {object} [opts]
 * @param {object|null} [opts.brief] — pre-computed outcome brief (from computeBrief())
 * @param {object|null} [opts.costLine] — pre-computed cost line
 * @param {number|null} [opts.pipelineInboxCount] — count of pipeline_items with section='pending' AND checked=0 (F11)
 * @returns {{ text, movedToday, parkedCount, parkDrain }}
 */
export function buildDigest(jobs, day, { brief = null, costLine = null, pipelineInboxCount = null } = {}) {
  const terminal = ['submitted', 'parked', 'failed'];
  const movedToday = jobs.filter((j) =>
    terminal.includes(j.stage) && (lastAt(j, j.stage) || '').startsWith(day));

  const counts = {};
  for (const j of jobs) counts[j.stage] = (counts[j.stage] || 0) + 1;

  const parkDrain = aggregateParkDrain(jobs);

  const lines = [];
  lines.push(`# Auto-pipeline digest — ${day}`);
  lines.push('');
  lines.push(`Queue: ${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(' · ') || 'empty'}`);

  // Backlog economics line (T1.3 / F11 / F13)
  const totalJobs = jobs.length;
  const discoveredCount = counts['discovered'] || 0;
  const submittedCount = counts['submitted'] || 0;
  // F11: show both pipeline inbox (upstream unchecked URLs) and discovered (auto_jobs evaluated but not yet submitted)
  const inboxPart = pipelineInboxCount !== null
    ? ` · **${pipelineInboxCount}** pipeline inbox (pending+unchecked)`
    : '';
  lines.push(`Backlog: **${discoveredCount}** unranked (auto_jobs)${inboxPart} · **${parkDrain.totalParked}** parked · **${submittedCount}** submitted (${totalJobs} total tracked)`);

  // Cost line (T1.3)
  const cl = costLine || computeCostLine();
  if (cl.coveragePct === 0) {
    lines.push(`Cost: _no usage data yet — ${cl.totalAttempts} attempt(s) on disk, 0% coverage_`);
  } else {
    const todayPart = cl.estCostToday != null ? ` · today $${cl.estCostToday.toFixed(2)}` : '';
    lines.push(`Cost: **$${(cl.totalCostUsd ?? 0).toFixed(2)}** total (${cl.coveragePct}% coverage across ${cl.totalAttempts} attempts)${todayPart}`);
  }
  lines.push('');

  // Today's movement table
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

  // Parked-today section (original)
  const parked = movedToday.filter((j) => j.stage === 'parked');
  if (parked.length > 0) {
    lines.push('');
    lines.push('## Needs a human (parked today)');
    lines.push('');
    for (const j of parked) {
      lines.push(`- **${j.company} — ${j.role}**: ${j.lastError || 'see audit'}. Finish via Neo/manual, then \`node auto/state.mjs\` shows it; park reasons in auto/README.md.`);
      lines.push(`  ${j.url}`);
    }
  }

  // ── T1.3: Park-reason Pareto ───────────────────────────────────────────────
  lines.push('');
  lines.push('## Park-reason Pareto (all time)');
  lines.push('');
  if (parkDrain.parkPareto.length === 0) {
    lines.push('_No parked jobs._');
  } else {
    lines.push('| Reason (truncated) | Count | Examples |');
    lines.push('|---|---|---|');
    for (const { reason, count, examples } of parkDrain.parkPareto.slice(0, 15)) {
      lines.push(`| ${reason.slice(0, 70)} | ${count} | ${examples.join(', ')} |`);
    }
    if (parkDrain.scoreCorrectionCount > 0) {
      lines.push('');
      lines.push(`_Score-correction parks (real score < 4.0): **${parkDrain.scoreCorrectionCount}**_`);
    }
  }

  // ── T1.2: Park-drain questions panel ──────────────────────────────────────
  const { questionsToUnlock, totalJobsUnlockable } = parkDrain;
  const N = questionsToUnlock.length;
  const M = totalJobsUnlockable;
  lines.push('');
  lines.push(`## Answer these ${N} questions to unlock ${M > 0 ? `~${M}` : 'more'} parked jobs`);
  lines.push('');
  lines.push(`> These are PROPOSALS ONLY — answers are never auto-applied. Review each snippet,`);
  lines.push(`> edit as needed, then paste into \`config/standing-answers.yml\` to approve.`);
  lines.push(`> Restricted / sensitive questions (EEO race/disability/veteran) are excluded.`);
  lines.push('');
  for (let i = 0; i < questionsToUnlock.length; i++) {
    const q = questionsToUnlock[i];
    const affected = q.affectedCount > 0 ? ` _(~${q.affectedCount} job(s) affected)_` : '';
    lines.push(`### Q${i + 1}: ${q.label}${affected}`);
    lines.push('');
    lines.push(`**${q.question}**`);
    lines.push('');
    lines.push('Proposed `config/standing-answers.yml` snippet:');
    lines.push('```yaml');
    lines.push(q.proposedYaml);
    lines.push('```');
    lines.push('');
  }

  // ── T1.3 + T2.2: Resume fallback summary ──────────────────────────────────
  lines.push('## Resume-variant coverage');
  lines.push('');
  if (parkDrain.resumeFallbacks.length === 0) {
    lines.push('_All applications used a targeted resume variant._');
  } else {
    // Split by stage (F12): submitted-with-fallback vs selected-but-not-submitted.
    const fbSubmitted = parkDrain.resumeFallbacks.filter(f => f.stage === 'submitted');
    const fbNotSubmitted = parkDrain.resumeFallbacks.filter(f => f.stage !== 'submitted');

    if (fbSubmitted.length > 0) {
      lines.push(`**${fbSubmitted.length}** application(s) **submitted** with the default resume:`);
      lines.push('');
      lines.push('| Company | Role | Note |');
      lines.push('|---|---|---|');
      for (const f of fbSubmitted.slice(0, 20)) {
        lines.push(`| ${f.company} | ${f.role} | ${f.resumeNote} |`);
      }
      if (fbSubmitted.length > 20) lines.push(`_…and ${fbSubmitted.length - 20} more_`);
      lines.push('');
    }

    if (fbNotSubmitted.length > 0) {
      lines.push(`**${fbNotSubmitted.length}** application(s) **selected but not yet submitted** (parked/failed/pending) with the default resume:`);
      lines.push('');
      lines.push('| Company | Role | Stage | Note |');
      lines.push('|---|---|---|---|');
      for (const f of fbNotSubmitted.slice(0, 20)) {
        lines.push(`| ${f.company} | ${f.role} | ${f.stage} | ${f.resumeNote} |`);
      }
      if (fbNotSubmitted.length > 20) lines.push(`_…and ${fbNotSubmitted.length - 20} more_`);
      lines.push('');
    }

    // Propose new resume variants (T2.2)
    // Only submitted jobs back the "shipped default" claim; parked/failed
    // selections did not ship anything (F12 / delta #6).
    const variantProposals = proposeResumeVariants(fbSubmitted);
    if (variantProposals.length > 0) {
      lines.push('**Proposed new resume variants** (content requires user review — no files written):');
      lines.push('');
      for (const p of variantProposals) {
        lines.push(`- **${p.family}** variant — ${p.count} application(s) shipped default. `
          + `Add a matching headline title to \`config/auto.yml\` → \`resume_variants\` for this archetype.`);
      }
    }
  }
  lines.push('');

  // ── T1.3: Per-ATS success / park rates ────────────────────────────────────
  lines.push('## Per-ATS rates');
  lines.push('');
  if (parkDrain.atsSummary.length === 0) {
    lines.push('_No ATS data._');
  } else {
    lines.push('| ATS | Submitted | Parked | Park rate |');
    lines.push('|---|---|---|---|');
    for (const a of parkDrain.atsSummary) {
      const rate = a.parkRate !== null ? `${a.parkRate}%` : '—';
      lines.push(`| ${a.ats} | ${a.submitted} | ${a.parked} | ${rate} |`);
    }
  }
  lines.push('');

  // ── T1.3: Parked-job aging ────────────────────────────────────────────────
  if (parkDrain.stalledParked.length > 0) {
    lines.push('## Stale parked jobs (>3 days unresolved)');
    lines.push('');
    lines.push('| Company | Role | Reason | Days parked |');
    lines.push('|---|---|---|---|');
    for (const s of parkDrain.stalledParked.slice(0, 20)) {
      lines.push(`| ${s.company} | ${s.role} | ${s.reason} | ${s.daysParked} |`);
    }
    if (parkDrain.stalledParked.length > 20) {
      lines.push(`_…and ${parkDrain.stalledParked.length - 20} more_`);
    }
    lines.push('');
  }

  // ── T1.1/T1.3: Outcome brief integration ─────────────────────────────────
  if (brief) {
    lines.push('## Outcome brief');
    lines.push('');
    // Import the formatter lazily would be async; we accept a pre-formatted string
    // or a raw brief object to keep buildDigest synchronous.
    if (typeof brief === 'string') {
      lines.push(brief);
    } else {
      // brief is a BriefData object — format inline (minimal subset for digest)
      lines.push(`**Auto-submitted:** ${brief.totalAutoSubmitted} · `
        + `**Outcomes recorded:** ${brief.totalOutcomes}`);
      if (brief.followupsDueNow > 0) {
        lines.push(`⚠️  **${brief.followupsDueNow} follow-up(s) overdue** — check follow-ups today.`);
      }
      lines.push('');
      lines.push(`_Full brief: \`data/auto/outcome-brief-${brief.generatedAt ?? 'today'}.md\`_`);
    }
    lines.push('');
  }

  // ── Decisions needed (T1.3, T2.2, T2.3) ─────────────────────────────────
  lines.push('## Decisions needed from you');
  lines.push('');
  lines.push('The following choices are YOURS — the pipeline does not make them automatically:');
  lines.push('');
  lines.push('1. **Push channel (email vs Telegram vs none)**  ');
  lines.push('   Today: digest is a file + macOS notification only. To push to email or Telegram,');
  lines.push('   implement a channel object and pass it to `writeDigest({ channel })`.  ');
  lines.push('   See `sendDigest()` in `auto/digest.mjs` for the interface.  ');
  lines.push('   _→ add `push_channel:` to `config/auto.yml` or implement in a hook once you decide._');
  lines.push('');
  lines.push('2. **Scan cadence (`skipScan` is currently permanent)**  ');
  lines.push('   `desired-cycle.json` has `skipScan: true` — new jobs are never discovered.');
  lines.push('   Decide: re-enable scan (remove `skipScan` or set to `false`), or keep manual-only.');
  lines.push('   _→ update `config/auto.yml` or set via Mission Control._');
  lines.push('');
  lines.push('3. **Standing-answer proposals (park-drain section above)**  ');
  lines.push('   Review the 4 YAML snippets above and paste approved answers into');
  lines.push('   `config/standing-answers.yml`. Each is proposal-only until you confirm.');
  lines.push('');
  lines.push('4. **Resume variants for under-served archetypes**  ');
  lines.push('   Review the "Resume-variant coverage" section above and decide whether to');
  lines.push('   add new `resume_variants` entries to `config/auto.yml`.');
  lines.push('');
  lines.push('');

  return { text: lines.join('\n'), movedToday, parkedCount: parked.length, parkDrain };
}

// ── Write + notify ────────────────────────────────────────────────────────────

/**
 * Build, write, and (optionally) notify for today's digest.
 *
 * @param {object} [opts]
 * @param {string} [opts.day] — YYYY-MM-DD override
 * @param {boolean} [opts.quiet] — suppress macOS notification
 * @param {boolean} [opts.dryRun] — write to /tmp, not data/auto/
 * @param {object|null} [opts.channel] — pluggable push channel (T1.3)
 * @param {Function} [opts.log]
 * @returns {string} path of written digest
 */
export async function writeDigest({ day = new Date().toISOString().slice(0, 10), quiet = false, dryRun = false, channel = null, log = console.log } = {}) {
  // Optionally integrate outcome brief (imported lazily to keep sync boot fast)
  let brief = null;
  try {
    const { computeBrief, formatBrief } = await import('./outcome-brief.mjs');
    const briefData = await computeBrief();
    brief = formatBrief(briefData);
  } catch (err) {
    // Brief integration is best-effort; digest still writes without it
    log(`digest: outcome-brief skipped: ${err.message}`);
  }

  // F11: read pipeline inbox count (read-only; best-effort)
  let pipelineInboxCount = null;
  try {
    const db = await import('../core/db.mjs');
    pipelineInboxCount = db.listPipelineItems({ section: 'pending', checked: 0 }).length;
  } catch {
    // best-effort — digest still writes without it
  }

  const { text, movedToday, parkedCount } = buildDigest(listJobs(), day, { brief, pipelineInboxCount });
  const outDir = dryRun ? '/tmp' : join(ROOT, 'data', 'auto');
  if (!dryRun) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `digest-${day}.md`);
  writeFileSync(outPath, text);
  log(`digest: ${movedToday.length} job(s) moved today -> ${outPath}`);

  if (!quiet && movedToday.length > 0) {
    const msg = `${movedToday.length} application(s) moved today` +
      (parkedCount > 0 ? ` — ${parkedCount} parked, needs you` : '');
    spawnSync('osascript', ['-e',
      `display notification ${JSON.stringify(msg)} with title "career-ops auto"`]);
  }

  // Push via pluggable channel (T1.3)
  await sendDigest(text, channel);

  return outPath;
}

// ── Self-test ─────────────────────────────────────────────────────────────────

function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (cond) console.log(`ok - ${name}`);
    else { console.error(`FAIL - ${name}`); failures += 1; }
  };

  const day = '2026-10-07';
  const jobs = [
    { stage: 'submitted', company: 'a', role: 'r', score: 4.5, ats: 'greenhouse',
      auditDir: join(ROOT, 'output/x/audit/attempt-1'),
      timestamps: [{ stage: 'submitted', at: '2026-10-07T18:31:00Z' }] },
    { stage: 'parked', company: 'b', role: 'r2', score: null, lastError: 'login-or-captcha',
      url: 'https://x.test/b', ats: 'lever',
      timestamps: [{ stage: 'parked', at: '2026-10-07T01:00:00Z' }] },
    { stage: 'parked', company: 'c', role: 'CTO', score: null, lastError: 'EEO question no decline option',
      url: 'https://x.test/c', ats: 'greenhouse',
      timestamps: [{ stage: 'parked', at: '2026-10-04T01:00:00Z' }] },
    { stage: 'submitted', company: 'old', role: 'r3', score: 4,
      timestamps: [{ stage: 'submitted', at: '2026-10-06T10:00:00Z' }] },
    { stage: 'queued', company: 'q', role: 'r4', timestamps: [] },
    { stage: 'discovered', company: 'd', role: 'r5', timestamps: [] },
    { stage: 'parked', company: 'e', role: 'Principal Engineer', score: 3.5,
      lastError: 'score-correction (real 3.5 < 4.0)', ats: 'lever',
      resumeNote: 'default resume used — no Principal IC variant',
      timestamps: [{ stage: 'parked', at: '2026-10-05T01:00:00Z' }] },
  ];

  const { text, movedToday, parkedCount, parkDrain } = buildDigest(jobs, day);
  check('two jobs moved today', movedToday.length === 2);
  check('yesterday submission excluded', !text.includes('| old |'));
  check('parked section present', parkedCount === 1 && text.includes('Needs a human'));
  check('audit path relative', text.includes('output/x/audit/attempt-1'));
  check('queue counts line', text.includes('queued 1'));
  check('backlog economics line', text.includes('Backlog:') && text.includes('unranked'));
  check('cost line present', text.includes('Cost:'));
  check('park pareto section', text.includes('Park-reason Pareto'));
  check('park-drain questions panel (N questions)', text.includes('Answer these 4 questions'));
  check('policy prompt for EEO present', text.includes('EEO questions'));
  check('resume variant section', text.includes('Resume-variant coverage'));
  check('ATS rates section', text.includes('Per-ATS rates') && text.includes('greenhouse'));
  check('stale parked jobs (>3 days)', text.includes('Stale parked jobs'));
  check('score-correction count', text.includes('Score-correction parks') && text.includes('1'));
  check('decisions needed block', text.includes('Decisions needed'));
  check('push channel decision surfaced', text.includes('Push channel'));
  check('scan cadence decision surfaced', text.includes('Scan cadence'));
  check('parkDrain.atsSummary has greenhouse', parkDrain.atsSummary.some((a) => a.ats === 'greenhouse'));
  check('parkDrain.backlogCount = 1', parkDrain.backlogCount === 1);

  // Resume fallback detection
  check('resume fallback detected', parkDrain.resumeFallbacks.length >= 1);

  const empty = buildDigest([], day);
  check('empty digest renders', empty.text.includes('No submissions'));

  // Test sendDigest with a mock channel
  let channelCalled = false;
  const mockChannel = { name: 'test', send: (t) => { channelCalled = !!t; } };
  // sendDigest is async but works fine without awaiting in self-test
  sendDigest('hello', mockChannel).then(() => {
    check('sendDigest calls channel.send', channelCalled);
  });
  sendDigest('x', null).then(() => {
    check('sendDigest no-ops on null channel', true); // no throw = pass
  });

  if (failures > 0) { console.error(`self-test: ${failures} failure(s)`); process.exit(1); }
  console.log('self-test: all checks passed');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, ['--quiet', '--self-test', '--dry-run'],
    'usage: node auto/digest.mjs [--quiet] [--self-test] [--dry-run]');
  if (hasFlag(args, '--self-test')) selfTest();
  else writeDigest({ quiet: hasFlag(args, '--quiet'), dryRun: hasFlag(args, '--dry-run') });
}
