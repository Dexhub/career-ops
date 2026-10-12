#!/usr/bin/env node
/**
 * auto/eval-score-audit.mjs — re-derive scores from saved report files using
 * the F1-fixed parser and flag/correct any jobs whose stored score was
 * hijacked by the <think>-block regex defect.
 *
 * Scans every job whose stored score is 5 (mis-score candidates) OR whose
 * report file exists (broader net). For each, re-parses the score from the
 * report body using `parseReportScore` from eval-queue.mjs.
 *
 * Output: a table of job id, company, stage, stored score, real score.
 * For jobs in stages queued / resume_ready / parked with real score < 4.0:
 *   --dry-run (default) — list proposed changes only, make no writes.
 *   --apply            — update stored score + transition to parked with
 *                        reason "score-correction (real X.X < 4.0)".
 *
 * Stages applying/submitted/failed/skipped/evaluated/discovered are LISTED
 * but never mutated (applying = in-flight, submitted = done, others = N/A).
 *
 * Usage:
 *   node auto/eval-score-audit.mjs           # dry-run (safe)
 *   node auto/eval-score-audit.mjs --apply   # write corrections
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { listJobs, updateJob } from './state.mjs';
import { parseReportScore } from './eval-queue.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { validateFlags } from '../lib/cli-flags.mjs';

const ROOT = getCareerOpsRoot();

// Stages the audit may correct (parked is included because a job may have
// been queued at 5/5 and then manually parked — we still want to flag it).
const CORRECTABLE_STAGES = new Set(['queued', 'resume_ready', 'parked']);

// Stages that are in-flight or terminal — listed but never mutated.
const SKIP_MUTATE_STAGES = new Set(['applying', 'submitted', 'failed', 'skipped', 'evaluated', 'discovered']);

/**
 * For every job with score===5 or a reportPath, re-derive the score from the
 * saved report body.
 *
 * @returns {Array<{job, reportPath, realScore, realSource, action}>}
 *   action: 'correct' | 'ok' | 'no-report' | 'skip-stage'
 */
export function auditScores() {
  const allJobs = listJobs(); // all stages
  const candidates = allJobs.filter((j) => j.score === 5 || j.score === '5' || j.reportPath);
  const results = [];

  for (const job of candidates) {
    const reportPath = job.reportPath;
    if (!reportPath) {
      results.push({ job, reportPath: null, realScore: null, realSource: null, action: 'no-report' });
      continue;
    }

    const absPath = join(ROOT, reportPath);
    if (!existsSync(absPath)) {
      results.push({ job, reportPath, realScore: null, realSource: null, action: 'no-report' });
      continue;
    }

    let body;
    try {
      body = readFileSync(absPath, 'utf-8');
    } catch {
      results.push({ job, reportPath, realScore: null, realSource: null, action: 'no-report' });
      continue;
    }

    const { score: realScore, source: realSource } = parseReportScore(body);

    // Determine action: only correct jobs in correctable stages where the
    // real score differs from stored AND real < 4.0.
    const storedScore = typeof job.score === 'number' ? job.score : Number(job.score);
    const isCorrectableStage = CORRECTABLE_STAGES.has(job.stage);
    const needsCorrection =
      realScore !== null &&
      realScore < 4.0 &&
      isCorrectableStage &&
      Math.abs((realScore ?? 0) - (storedScore || 0)) > 0.01; // avoid floating-point equality noise

    let action;
    if (!isCorrectableStage && !SKIP_MUTATE_STAGES.has(job.stage)) {
      action = 'skip-stage';
    } else if (SKIP_MUTATE_STAGES.has(job.stage)) {
      action = 'skip-stage';
    } else if (needsCorrection) {
      action = 'correct';
    } else {
      action = 'ok';
    }

    results.push({ job, reportPath, realScore, realSource, action });
  }

  return results;
}

/**
 * Apply corrections: for every 'correct' result, update score and transition
 * to parked (if not already) with a standardized reason.
 * @param {Array} results - from auditScores()
 * @returns {Promise<{corrected: number, alreadyParked: number, errors: string[]}>}
 */
export async function applyCorrections(results) {
  let corrected = 0;
  let alreadyParked = 0;
  const errors = [];

  for (const r of results) {
    if (r.action !== 'correct') continue;
    const { job, realScore } = r;
    const reason = `score-correction (real ${realScore} < 4.0)`;
    try {
      if (job.stage === 'parked') {
        // Already parked — just update score + note reason in lastError.
        await updateJob(job.urlKey, {
          patch: { score: realScore, scoreSource: r.realSource ?? 'body', lastError: reason },
        });
        alreadyParked += 1;
      } else {
        // queued or resume_ready → parked.
        // First update score, then transition.
        await updateJob(job.urlKey, {
          patch: { score: realScore, scoreSource: r.realSource ?? 'body', lastError: reason },
        });
        await updateJob(job.urlKey, { transitionTo: 'parked' });
        corrected += 1;
      }
    } catch (err) {
      errors.push(`${job.urlKey}: ${err.message}`);
    }
  }

  return { corrected, alreadyParked, errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = `auto/eval-score-audit.mjs — re-derive scores from report files and correct mis-scored jobs.

  (default)   --dry-run  Show table of stored vs real scores; make no writes.
              --apply    Apply corrections (update score + park queued/resume_ready; update score only for already-parked).
              --help     Show this help`;
  validateFlags(args, ['--dry-run', '--apply', '--help', '-h'], usage);

  const dryRun = !args.includes('--apply');
  if (dryRun) {
    console.log('eval-score-audit: DRY RUN (pass --apply to write corrections)\n');
  }

  const results = auditScores();

  // Table header
  const COL = { id: 6, company: 22, stage: 14, stored: 7, real: 7, src: 6, action: 12 };
  const pad = (s, n) => String(s ?? '—').slice(0, n).padEnd(n);
  const divider = '-'.repeat(Object.values(COL).reduce((a, b) => a + b + 3, 0));

  console.log(
    pad('id', COL.id) + ' | ' +
    pad('company', COL.company) + ' | ' +
    pad('stage', COL.stage) + ' | ' +
    pad('stored', COL.stored) + ' | ' +
    pad('real', COL.real) + ' | ' +
    pad('src', COL.src) + ' | ' +
    pad('action', COL.action)
  );
  console.log(divider);

  let correctCount = 0;
  let noReportCount = 0;

  for (const r of results) {
    const { job, realScore, realSource, action } = r;
    // Derive a short display id from the report filename or urlKey hash prefix
    const idHint = r.reportPath
      ? r.reportPath.replace('reports/', '').replace(/\.md$/, '').slice(0, 6)
      : job.urlKey.slice(0, 6);

    console.log(
      pad(idHint, COL.id) + ' | ' +
      pad(job.company || '?', COL.company) + ' | ' +
      pad(job.stage, COL.stage) + ' | ' +
      pad(job.score ?? '—', COL.stored) + ' | ' +
      pad(realScore ?? '—', COL.real) + ' | ' +
      pad(realSource ?? '—', COL.src) + ' | ' +
      pad(action, COL.action)
    );
    if (action === 'correct') correctCount += 1;
    if (action === 'no-report') noReportCount += 1;
  }

  console.log(divider);
  console.log(`\nTotal candidates: ${results.length}`);
  console.log(`  Needs correction (real<4.0, correctable stage): ${correctCount}`);
  console.log(`  No report available: ${noReportCount}`);
  console.log(`  OK / skip-stage: ${results.length - correctCount - noReportCount}`);

  if (!dryRun && correctCount > 0) {
    console.log('\nApplying corrections...');
    const { corrected, alreadyParked, errors } = await applyCorrections(results);
    console.log(`  Parked (was queued/resume_ready): ${corrected}`);
    console.log(`  Score-updated (already parked):   ${alreadyParked}`);
    if (errors.length > 0) {
      console.error(`  Errors (${errors.length}):`);
      for (const e of errors) console.error(`    ${e}`);
    }
  } else if (!dryRun && correctCount === 0) {
    console.log('\nNo corrections needed.');
  }
}
