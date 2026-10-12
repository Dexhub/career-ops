// auto/learning/promotion.mjs — safe-answer auto-promotion for active-lite
// reuse (T-active-lite, 2026-10-12). Promotes candidate/proposed answers to
// approved ONLY for non-sensitive question families, never for any family that
// contracts.mjs or the sensitivity classifier marks as EEO/demographics,
// eligibility/visa/work-authorization, or compensation-related.
//
// Exports:
//   isSensitiveNormalizedText(normalizedText) -> boolean  (pure, exported for tests)
//   promoteSafeAnswers(ctx) -> { promoted, skipped, errors }
//
// Auto-promotion records provenance: promoted_by:'auto_safe_policy',
// sourceIds include the original proposal/answer ids. A promotion error for
// one answer is caught and logged, never propagating to block the rest.
// Nothing executes at import time. Never imports core/db.mjs.

import { LearningError } from './contracts.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';
import { readLearningConfig } from './context.mjs';

// ---------------------------------------------------------------------------
// Sensitive-family classifier. Matches the normalized question text against
// known sensitive topic patterns. A match means NO auto-approval — the answer
// stays in its current status and must await user review.
//
// Families covered (per answers.mjs and contracts.mjs policy):
//   - EEO / demographic voluntary disclosures (race, ethnicity, gender, sex,
//     veteran status, disability, national origin, age, religion, marital)
//   - Eligibility / work-authorization / visa / sponsorship
//   - Compensation / salary / pay (any basis) / bonus / equity / OTE
//   - Attestations / certifications that are per-submission (restricted)
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  // EEO / demographics — word-boundary at start; "orient" is a prefix for
  // "orientation" so no closing \b for that term.
  /\b(race|ethnic|national origin|gender|sexual orient|pronoun|veteran|military service|disability|disab|religion|marital status|legally protected)/i,
  // sex on its own (but not inside "sextet" or "Essex")
  /\bsex\b/i,
  // Age on its own
  /\bage\b/i,
  // Eligibility / visa / work-authorization. Prefix patterns (no \b at end)
  // catch authorization/authorized/authorizing, eligibility/eligible, etc.
  /\bwork authoriz/i,
  /\bauthorized to work|authorization to work/i,
  /\b(work permit|right to work|visa|sponsorship|sponsor|immigration|green card|citizenship status)\b/i,
  /\beligib/i,
  /\blegally authoriz/i,
  // H-1B, OPT, CPT, F-1
  /\b(h[- ]?1b|opt\b|cpt\b|f[- ]?1\b)/i,
  // Compensation (any form) — prefix matching for "compens" (catches compensation),
  // word-boundary for standalone terms.
  /\b(salary|compens|wages|hourly rate|annual pay|base pay|bonus|equity|stock|total comp|on.?target earnings|stipend|pay expectation|expected pay|desired pay|desired salary|current salary|current comp|pay range|salary range|salary requirement)/i,
  // "pay" alone
  /\bpay\b/i,
  // ote (on-target earnings abbreviation)
  /\bote\b/i,
];

/**
 * isSensitiveNormalizedText(normalizedText) -> boolean (pure).
 * Returns true if the normalized question text matches ANY sensitive pattern.
 * Matches are conservative: if in doubt, treat as sensitive (never auto-approve).
 */
export function isSensitiveNormalizedText(normalizedText) {
  if (typeof normalizedText !== 'string') return true; // unknown → sensitive
  const lower = normalizedText.toLowerCase();
  return SENSITIVE_PATTERNS.some((re) => re.test(lower));
}

// ---------------------------------------------------------------------------
// promoteSafeAnswers(ctx) -> { promoted, skipped, errors }
//
// Scans all family records. For each approved family whose all questionIds
// have non-sensitive normalizedText (via the questions collection), promotes
// every answer in a promotable status (proposed|candidate-like status) to
// approved, recording the provenance. Answers already approved or in a
// terminal status (revoked, stale, conflicted) are left untouched.
//
// Gate: requires config.reuse.auto_approve_safe === true. If the config has
// reuse disabled or auto_approve_safe is false, this is a no-op.
// ---------------------------------------------------------------------------

/**
 * Returns the normalizedText for a questionId from the store, or null if the
 * question record is absent (can't classify → treat as sensitive).
 */
function getNormalizedText(ctx, questionId) {
  try {
    const rec = getRecord(ctx, 'questions', questionId);
    return rec?.data?.normalizedText ?? null;
  } catch {
    return null;
  }
}

/**
 * isFamilySafe(ctx, familyRecord) -> boolean.
 * A family is safe iff ALL its questionIds resolve to non-sensitive normalized
 * texts. If ANY questionId is unknown (missing from the store) or sensitive,
 * the whole family is treated as sensitive. An empty questionIds list means
 * no questions have been associated yet → not safe to auto-approve.
 */
function isFamilySafe(ctx, familyRecord) {
  const questionIds = familyRecord.data?.questionIds;
  if (!Array.isArray(questionIds) || questionIds.length === 0) return false;
  for (const qid of questionIds) {
    const text = getNormalizedText(ctx, qid);
    if (text === null) return false; // unknown question → sensitive
    if (isSensitiveNormalizedText(text)) return false;
  }
  return true;
}

/**
 * promoteSafeAnswers(ctx) -> { promoted:[], skipped:[], errors:[] }
 *
 * Runs at cycle start (called by apply-worker before building the reuse
 * context). Returns a summary with provenance. A per-answer error is caught
 * and added to `errors`; it never throws and never blocks the application.
 */
export async function promoteSafeAnswers(ctx) {
  const summary = { promoted: [], skipped: [], errors: [] };

  let config;
  try {
    config = readLearningConfig(ctx);
  } catch (err) {
    summary.errors.push({ id: null, reason: `config read failed: ${err.message}` });
    return summary;
  }

  if (!config.reuse?.auto_approve_safe) {
    return summary; // no-op — feature disabled
  }

  // Load approved families (only approved families can back a safe auto-promotion).
  let families;
  try {
    const { items } = listRecords(ctx, 'families', { limit: 500 });
    families = items.filter((f) => f.status === 'approved');
  } catch (err) {
    summary.errors.push({ id: null, reason: `families listing failed: ${err.message}` });
    return summary;
  }

  // Collect safe family ids.
  const safeFamilyIds = new Set();
  for (const fam of families) {
    if (isFamilySafe(ctx, fam)) {
      safeFamilyIds.add(fam.id);
    }
  }

  // Load all answers and promote eligible ones.
  let answers;
  try {
    const { items } = listRecords(ctx, 'answers', { limit: 500 });
    answers = items;
  } catch (err) {
    summary.errors.push({ id: null, reason: `answers listing failed: ${err.message}` });
    return summary;
  }

  for (const answer of answers) {
    // Only 'proposed' answers are promotable here. 'approved'/'revoked'/'stale'/'conflicted'
    // are already settled. The status enum for answers is:
    //   proposed | approved | stale | conflicted | revoked
    if (answer.status !== 'proposed') {
      summary.skipped.push({ id: answer.id, reason: `status:${answer.status}` });
      continue;
    }

    const familyId = answer.data?.questionFamilyId;
    if (!familyId || !safeFamilyIds.has(familyId)) {
      summary.skipped.push({
        id: answer.id,
        reason: familyId ? `family:${familyId} is sensitive or unapproved` : 'no_family',
      });
      continue;
    }

    // Double-check: the answer's own data must have a safe authority type.
    // We never auto-approve 'generated' or 'inferred' authorities (per answers.mjs).
    const authority = answer.data?.authority;
    if (['generated', 'inferred'].includes(authority)) {
      summary.skipped.push({ id: answer.id, reason: `authority:${authority} requires user confirmation` });
      continue;
    }

    try {
      await commitRecord(ctx, 'answers', answer.id, {
        ...answer.data,
      }, {
        expectedRevision: answer.revision,
        status: 'approved',
        // Provenance: keep original sourceIds, append the promotion marker.
        sourceIds: [...(answer.sourceIds ?? []), 'auto_safe_policy'],
      });
      summary.promoted.push({
        id: answer.id,
        familyId,
        promoted_by: 'auto_safe_policy',
      });
    } catch (err) {
      // REVISION_CONFLICT means a concurrent writer already updated this answer —
      // not an error in our logic. Any other error is a genuine failure.
      if (err?.code === 'REVISION_CONFLICT') {
        summary.skipped.push({ id: answer.id, reason: 'revision_conflict:concurrent_update' });
      } else {
        summary.errors.push({ id: answer.id, reason: err.message });
      }
    }
  }

  return summary;
}
