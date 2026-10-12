// auto/dispatch-gate.mjs — pre-dispatch identity gate (T0.2).
//
// Run BEFORE handing a queued/resume_ready job to the apply worker to catch
// three classes of unsafe dispatch:
//
//   (a) already-applied:   same company + similar role already submitted/Applied
//   (b) declined-cooldown: same company was declined/rejected within 90 days
//                          AND same-or-near role (avoids re-applying after rejection)
//   (c) employer-cap:      company already has >2 live (non-terminal) applications
//
// Each violation parks the job with a distinct reason instead of dispatching.
// Rule (a) and (b) require role-title similarity to avoid parking obviously-
// different roles at big companies.  Rule (c) is company-only (no role check).
//
// Normalization strategy: normalizeKey() strips everything outside [a-z0-9]
// and lowercases (same as normalizeTextKey in tracker-parse.mjs).  Title
// similarity: EITHER the normalized titles are equal, OR one contains the
// other as a substring (conservative — over-parking is safe for human review,
// but we avoid matching "Director, Engineering" vs "VP Marketing" just because
// both are at "Google").
//
// Data sources:
//   - auto_jobs table (listAutoJobs) — submitted + all non-terminal stages
//   - applications table (listApplications) — human tracker (Applied rows)
//
// Only pure reads: this module never writes to the DB.
//
// Usage:
//   import { checkDispatchGate, parkViolations } from './auto/dispatch-gate.mjs';
//   const result = await checkDispatchGate(job);
//   if (result.park) { /* result.reason, result.rule */ }

import { listAutoJobs } from '../core/db.mjs';
import { listApplications } from '../core/db.mjs';
import { loadJob, updateJob } from './state.mjs';

// ---------------------------------------------------------------------------
// Normalization helpers

/** Strip non-alphanumeric, lowercase — same as tracker-parse normalizeTextKey. */
export function normalizeKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Conservative role-title similarity: same normalized title, OR one is a
 * substring of the other (min 6 chars to avoid false positives from short
 * titles like "VP" or "CTO").
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function roleSimilar(a, b) {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const minLen = 6;
  if (na.length >= minLen && nb.includes(na)) return true;
  if (nb.length >= minLen && na.includes(nb)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Non-terminal stages: queued/applying/submitted/resume_ready are "live"
// for the employer-cap rule.
const LIVE_STAGES = new Set(['queued', 'resume_ready', 'applying', 'submitted']);
// Already-applied stages: submitted (auto_jobs) or Applied (tracker).
const APPLIED_STAGES = new Set(['submitted']);

// Tracker statuses that imply an application was actually submitted.
// A status change (e.g. Applied → Rejected, Applied → Interview) must never
// remove duplicate/cooldown protection — once submitted, always submitted.
const SUBMITTED_TRACKER_STATUSES = new Set([
  'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected',
]);

// ---------------------------------------------------------------------------

/**
 * Load all data needed for the gate from the DB (two table reads).
 * Extracted so tests can inject their own rows without hitting the live DB.
 * @param {{autoJobsFn?: Function, applicationsFn?: Function}} [sources]
 * @returns {{ autoJobs: object[], trackerApplied: object[] }}
 */
export function loadGateData({ autoJobsFn = null, applicationsFn = null } = {}) {
  const autoJobs = (autoJobsFn ?? listAutoJobs)();
  // F2: load ALL statuses that imply a submitted application, not just 'Applied'.
  // A status change (Applied → Rejected/Interview/Offer/etc.) must never remove
  // duplicate/cooldown protection — once you applied, reapply protection persists.
  const trackerApplied = (applicationsFn ?? (() => {
    const rows = listApplications();
    return rows.filter((r) => SUBMITTED_TRACKER_STATUSES.has(r.status));
  }))();
  return { autoJobs, trackerApplied };
}

/**
 * Run the pre-dispatch identity gate for one job.
 *
 * @param {object} job — the job record (must have .company, .role, .stage, .urlKey)
 * @param {{autoJobsFn?: Function, applicationsFn?: Function, now?: Date}} [opts]
 *   - autoJobsFn: override for listAutoJobs() (testing)
 *   - applicationsFn: override for listApplications({status:'Applied'}) (testing)
 *   - now: override current date (testing / cooldown calculation)
 * @returns {{ park: boolean, rule?: string, reason?: string }}
 *   park=false when dispatch is allowed; park=true with rule+reason when blocked.
 */
export function checkDispatchGate(job, { autoJobsFn = null, applicationsFn = null, now = new Date() } = {}) {
  const coKey = normalizeKey(job.company);
  const jobKey = job.urlKey;

  const { autoJobs, trackerApplied } = loadGateData({ autoJobsFn, applicationsFn });

  // ── (a) already-applied: submitted in auto_jobs ─────────────────────────
  for (const j of autoJobs) {
    if (j.urlKey === jobKey) continue; // skip self
    if (!APPLIED_STAGES.has(j.stage)) continue;
    if (normalizeKey(j.company) !== coKey) continue;
    if (!roleSimilar(j.role, job.role)) continue;
    return {
      park: true,
      rule: 'already-applied',
      reason: `already-applied: ${j.company} — ${j.role} is already in stage "${j.stage}" (urlKey=${j.urlKey})`,
    };
  }

  // ── (b) declined-cooldown ────────────────────────────────────────────────
  // Check tracker Applied rows for same company + similar role first, BEFORE
  // the plain already-applied tracker check, so a row with decline notes parks
  // with the more specific reason instead of just "already-applied".
  // Rule: decline/rejection notes within 90 days → park "declined-cooldown".
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;
  const DECLINE_RE = /declin|reject|no longer moving|not moving forward|not selected|unsuccessful/i;
  for (const a of trackerApplied) {
    if (normalizeKey(a.company) !== coKey) continue;
    if (!roleSimilar(a.role, job.role)) continue;
    const notes = String(a.notes ?? '');
    if (!DECLINE_RE.test(notes)) continue;
    // Extract the most recent YYYY-MM-DD date from the notes (e.g. "declined … on 2026-09-07").
    const dateMatch = notes.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
    const declineDate = dateMatch ? dateMatch[dateMatch.length - 1] : (a.date || '');
    if (declineDate) {
      const declineMs = new Date(declineDate).getTime();
      if (!Number.isNaN(declineMs) && nowMs - declineMs <= COOLDOWN_MS) {
        return {
          park: true,
          rule: 'declined-cooldown',
          reason: `declined-cooldown: ${a.company} / ${a.role} declined on ~${declineDate} (within 90-day cooldown)`,
        };
      }
    } else {
      // No datable evidence — still park conservatively since notes indicate decline.
      return {
        park: true,
        rule: 'declined-cooldown',
        reason: `declined-cooldown: ${a.company} / ${a.role} has decline notes but no parseable date — parking for human review`,
      };
    }
  }

  // ── (a) already-applied: Applied in human tracker (no decline notes) ─────
  // Checked AFTER declined-cooldown so declined rows get the specific reason.
  for (const a of trackerApplied) {
    if (normalizeKey(a.company) !== coKey) continue;
    if (!roleSimilar(a.role, job.role)) continue;
    return {
      park: true,
      rule: 'already-applied',
      reason: `already-applied: tracker row #${a.num} — ${a.company} / ${a.role} already Applied`,
    };
  }

  // ── (c) employer-cap: >2 live applications for same company ─────────────
  // Known limits (out of scope): this count is tracker-only live applications;
  // pending-entry priority inversion (a queued job may jump ahead of an
  // applying job from the same employer) is not handled here.
  const liveForCompany = autoJobs.filter(
    (j) => j.urlKey !== jobKey && normalizeKey(j.company) === coKey && LIVE_STAGES.has(j.stage),
  );
  // F4 fix: budget is at most 2 per employer INCLUDING the candidate.
  // liveForCompany excludes the candidate, so >= 2 means adding the candidate
  // would reach or exceed 3 total — block it.
  if (liveForCompany.length >= 2) {
    const summary = liveForCompany.slice(0, 4).map((j) => `${j.role?.slice(0, 30)} (${j.stage})`).join('; ');
    return {
      park: true,
      rule: 'employer-cap',
      reason: `employer-cap: ${job.company} already has ${liveForCompany.length} live applications [${summary}${liveForCompany.length > 4 ? '…' : ''}]`,
    };
  }

  return { park: false };
}

/**
 * Run the gate over the current non-terminal queue and return a dry-run table.
 * Does NOT write to the DB.
 *
 * @param {{autoJobsFn?: Function, applicationsFn?: Function, now?: Date}} [opts]
 * @returns {{ rows: Array<{urlKey,company,role,stage,result}> }}
 */
export function dryRunGate({ autoJobsFn = null, applicationsFn = null, now = new Date() } = {}) {
  const fetchAll = autoJobsFn ?? listAutoJobs;
  // Same status filter as loadGateData (F2): previews must see the identical
  // tracker snapshot the production gate sees, or dry-run disagrees with it.
  const fetchApplied = applicationsFn ?? (() =>
    listApplications().filter((r) => SUBMITTED_TRACKER_STATUSES.has(r.status)));
  const activeStages = ['queued', 'resume_ready', 'applying'];
  // Get snapshot once so each per-job call sees the same data
  const allAutoJobs = fetchAll();
  const allApplied = fetchApplied();
  const active = allAutoJobs.filter((j) => activeStages.includes(j.stage));

  const rows = [];
  for (const j of active) {
    const result = checkDispatchGate(j, {
      autoJobsFn: () => allAutoJobs,
      applicationsFn: () => allApplied,
      now,
    });
    rows.push({
      urlKey: j.urlKey,
      company: j.company,
      role: j.role,
      stage: j.stage,
      park: result.park,
      rule: result.rule ?? null,
      reason: result.reason ?? null,
    });
  }
  return { rows };
}

/**
 * Apply the gate: park all violating queued/resume_ready jobs.
 * Jobs in `applying` are skipped (an in-flight apply may be draining).
 *
 * @param {{dryRun?: boolean, autoJobsFn?: Function, applicationsFn?: Function,
 *          now?: Date, log?: Function}} [opts]
 * @returns {Promise<{parked: number, skipped: number, rows: object[]}>}
 */
export async function parkViolations({
  dryRun = false,
  autoJobsFn = null,
  applicationsFn = null,
  now = new Date(),
  log = console.log,
} = {}) {
  const { rows } = dryRunGate({ autoJobsFn, applicationsFn, now });
  let parked = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.park) continue;
    if (row.stage === 'applying') {
      log(`dispatch-gate: skip applying job ${row.company} (${row.rule}) — may be mid-apply`);
      skipped += 1;
      continue;
    }
    if (dryRun) {
      log(`dispatch-gate [dry-run]: would park ${row.stage} ${row.company} — ${row.reason}`);
      parked += 1;
    } else {
      try {
        await updateJob(row.urlKey, {
          transitionTo: 'parked',
          patch: { lastError: row.reason },
        });
        log(`dispatch-gate: parked ${row.stage} ${row.company} — ${row.reason}`);
        parked += 1;
      } catch (err) {
        log(`dispatch-gate: failed to park ${row.urlKey}: ${err.message}`);
      }
    }
  }
  return { parked, skipped, rows };
}
