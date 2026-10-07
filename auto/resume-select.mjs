#!/usr/bin/env node
// auto/resume-select.mjs — match queued jobs to a pre-built resume variant.
//
// For every job in stage `queued`, scores the job's role title against the
// resume-library variant titles (token overlap + seniority compatibility),
// picks the best match, verifies its cv.pdf exists, and transitions the job
// to `resume_ready` with { resumeVariant, resumePdf, resumeNote? }.
//
// Falls back to cfg.resume_default_variant (or the first library variant)
// when no variant scores above the floor — flagged via resumeNote so the
// digest can report fuzzy fallbacks.
//
// Usage:
//   node auto/resume-select.mjs [--limit N] [--dry-run]
//   node auto/resume-select.mjs --self-test

import './lib/sanitize-env.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { flagValue, hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { roleTokens, SENIORITY_TOKENS } from '../role-matcher.mjs';
import { loadAutoConfig } from './lib/config.mjs';
import { listLibrary } from './resume-library.mjs';
import { listJobs, loadJob, saveJob, transition } from './state.mjs';

const MATCH_FLOOR = 0.34; // Jaccard floor below which we fall back to default

function seniorities(title) {
  return new Set(
    String(title ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => SENIORITY_TOKENS.has(w))
  );
}

/**
 * Score how well a library variant title fits a job role title.
 * Jaccard over roleTokens, with a penalty when both sides state seniority
 * and they disagree (Director vs Staff etc.).
 */
export function scoreVariant(jobRole, variantTitle) {
  const a = [...new Set(roleTokens(jobRole))];
  const b = [...new Set(roleTokens(variantTitle))];
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const overlap = a.filter(w => setB.has(w)).length;
  const union = new Set([...a, ...b]).size;
  let score = overlap / union;

  const senJob = seniorities(jobRole);
  const senVar = seniorities(variantTitle);
  if (senJob.size > 0 && senVar.size > 0) {
    const agree = [...senJob].some(s => senVar.has(s));
    if (!agree) score *= 0.4;
    else score += 0.1;
  }
  return score;
}

/**
 * Pick the best variant for a job role.
 * @returns {{ variant: {title, slug, pdf}, score: number, fallback: boolean }}
 */
export function selectVariant(jobRole, library, defaultTitle) {
  const senJob = seniorities(jobRole);
  const senEq = (title) => {
    const s = seniorities(title);
    return s.size === senJob.size && [...s].every(t => senJob.has(t));
  };
  let best = null;
  let bestScore = -1;
  let bestSenEq = false;
  for (const v of library) {
    const s = scoreVariant(jobRole, v.title);
    const eq = senEq(v.title);
    // Tie-break: prefer the variant whose stated seniority exactly matches
    // the job's ("Director X" -> "Director of Engineering", not "Senior
    // Director of Engineering").
    if (s > bestScore || (s === bestScore && eq && !bestSenEq)) {
      best = v; bestScore = s; bestSenEq = eq;
    }
  }
  if (best && bestScore >= MATCH_FLOOR) {
    return { variant: best, score: bestScore, fallback: false };
  }
  const def = library.find(v => v.title === defaultTitle) || library[0];
  return { variant: def, score: bestScore, fallback: true };
}

export function runSelect({ limit, dryRun = false, log = console.log } = {}) {
  const cfg = loadAutoConfig();
  const library = listLibrary();
  if (library.length === 0) {
    throw new Error('resume-select: library empty — run `node auto/resume-library.mjs` first');
  }
  const defaultTitle = cfg.resume_default_variant || library[0].title;

  const queued = listJobs(['queued']);
  const batch = Number.isFinite(limit) ? queued.slice(0, limit) : queued;
  let ready = 0;
  for (const summary of batch) {
    const job = loadJob(summary.urlKey);
    const { variant, score, fallback } = selectVariant(job.role, library, defaultTitle);
    const patch = {
      resumeVariant: variant.title,
      resumePdf: variant.pdf,
    };
    if (fallback) {
      patch.resumeNote = `no variant matched "${job.role}" (best ${score.toFixed(2)}) — defaulted to "${variant.title}"`;
    }
    log(`resume-select: ${job.company} — ${job.role}`);
    log(`  -> ${variant.title}${fallback ? ' (DEFAULT fallback)' : ` (score ${score.toFixed(2)})`}`);
    if (!dryRun) {
      transition(job, 'resume_ready', patch);
      saveJob(job);
      ready += 1;
    }
  }
  log(`resume-select: done — ${ready} job(s) -> resume_ready${dryRun ? ' (dry-run, no writes)' : ''}`);
  return ready;
}

// ---------------------------------------------------------------------------
function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (cond) console.log(`ok - ${name}`);
    else { console.error(`FAIL - ${name}`); failures += 1; }
  };

  const lib = [
    { title: 'Director of Engineering', slug: 'director-of-engineering', pdf: '/x/d.pdf' },
    { title: 'Staff Software Engineer', slug: 'staff-software-engineer', pdf: '/x/s.pdf' },
    { title: 'Solutions Architect', slug: 'solutions-architect', pdf: '/x/sa.pdf' },
    { title: 'AI Engineer', slug: 'ai-engineer', pdf: '/x/ai.pdf' },
  ];

  const r1 = selectVariant('Director, Analytics Engineering', lib, 'Staff Software Engineer');
  check('director title matches director variant', r1.variant.title === 'Director of Engineering' && !r1.fallback);

  const r2 = selectVariant('Senior Staff Software Engineer, Platform', lib, 'Staff Software Engineer');
  check('staff title matches staff variant', r2.variant.title === 'Staff Software Engineer' && !r2.fallback);

  const r3 = selectVariant('Underwater Basket Weaver', lib, 'Staff Software Engineer');
  check('unmatched title falls back to default', r3.fallback && r3.variant.title === 'Staff Software Engineer');

  const r4 = selectVariant('Solutions Architect, Enterprise', lib, 'AI Engineer');
  check('solutions architect matches', r4.variant.title === 'Solutions Architect' && !r4.fallback);

  check('seniority disagreement penalized',
    scoreVariant('Director of Engineering', 'Director of Engineering')
      > scoreVariant('Staff Engineer of Engineering', 'Director of Engineering'));

  if (failures > 0) { console.error(`self-test: ${failures} failure(s)`); process.exit(1); }
  console.log('self-test: all passed');
}

// ---------------------------------------------------------------------------
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  validateFlags(argv, ['--limit', '--dry-run', '--self-test'], 'usage: resume-select [--limit N] [--dry-run] [--self-test]', { valueFlags: ['--limit'] });
  if (hasFlag(argv, '--self-test')) {
    selfTest();
  } else {
    const limitRaw = flagValue(argv, '--limit');
    runSelect({
      limit: limitRaw === undefined || limitRaw === null ? undefined : Number(limitRaw),
      dryRun: hasFlag(argv, '--dry-run'),
    });
  }
}
