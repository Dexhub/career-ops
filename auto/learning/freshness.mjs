// auto/learning/freshness.mjs — T11: truthful posting-date metadata and the
// one pure queue comparator (CONTRACTS E: readJobDates / orderJobs, D4 dates).
//
// Pure module: no fs, no DB, no clock of its own. Every function takes its
// inputs (and `now`) explicitly so panel, orchestrator, worker and tests all
// delegate to the SAME ordering logic instead of hand-coding lookalikes.
//
// Date-truth rules (plan 03/T11):
// - A `posted:` pipeline label or a provider's *published* timestamp is
//   publication evidence. A provider's modification date is NOT automatically
//   a publication date and never becomes postedAt here.
// - First discovery (firstSeenAt) and last availability check (lastCheckedAt)
//   are stored separately and are never relabeled as the posting date.
// - Date-only values keep precision 'day' (timezone unknown — explicit via
//   precision, never faked into an exact hour); they sort by calendar day.
// - Future or unparseable values read as unknown (null), not as guesses.

export const ORDER_MODES = Object.freeze(['existing', 'fit_then_freshness', 'freshness_then_fit']);
export const FRESHNESS_BUCKETS = Object.freeze(['0-2', '3-7', '8-30', 'older', 'unknown']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Timestamp WITH an explicit timezone (Z or ±hh:mm). Without one the wall
// time is ambiguous, so it degrades to day precision below.
const TZ_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const NAKED_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
// Same labeled-segment shape as web/src/lib/pipeline-table.mjs (parity
// reference asserted in tests; deliberately not imported at runtime).
// Exported so eval-queue's pending-row parser recognizes the same labels.
export const LABELED_SEGMENT = /^([a-z][a-z_-]*):\s*(.*)$/i;

function typedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function resolveNow(now) {
  if (typeof now === 'function') return now();
  if (now instanceof Date) return now;
  return new Date();
}

/** 'YYYY-MM-DD' calendar-day key of a stored date value. */
function dayKey(value) {
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

/**
 * Classify one raw date string into {value, precision} or null.
 * - 'YYYY-MM-DD'                      -> day precision (tz unknown, explicit)
 * - ISO timestamp with timezone      -> timestamp precision (normalized ISO)
 * - timestamp WITHOUT timezone       -> day precision (no fake exact hour)
 * - anything else / invalid / future -> null (unknown, never a guess)
 */
export function classifyDateValue(raw, nowDate) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const today = nowDate.toISOString().slice(0, 10);
  if (DAY_RE.test(s)) {
    if (Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return null;
    if (s > today) return null; // future calendar day — invalid as publication
    return { value: s, precision: 'day' };
  }
  if (TZ_TS_RE.test(s)) {
    const t = new Date(s);
    if (Number.isNaN(t.getTime())) return null;
    if (t.getTime() > nowDate.getTime()) return null; // future — invalid
    return { value: t.toISOString(), precision: 'timestamp' };
  }
  if (NAKED_TS_RE.test(s)) {
    // Unknown timezone: keep only the calendar day, stay explicit about it.
    const day = s.slice(0, 10);
    if (Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || day > today) return null;
    return { value: day, precision: 'day' };
  }
  return null;
}

/**
 * Labeled segments of one pipeline row (`- [ ] url | company | role | …`),
 * mirroring parseInbox: only cells at overall index >= 3 may be labels, so a
 * `posted:` segment never pollutes the positional company/role/location
 * cells and a colon-y role is never misread as metadata.
 * @returns {Map<string,string>} lowercase label -> trimmed value
 */
export function pipelineRowLabels(line) {
  const labels = new Map();
  if (typeof line !== 'string') return labels;
  const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
  if (!m) return labels;
  const cells = m[2].split('|').map((s) => s.trim());
  for (const [i, seg] of cells.entries()) {
    const lm = i >= 3 ? seg.match(LABELED_SEGMENT) : null;
    if (lm) labels.set(lm[1].toLowerCase(), lm[2].trim());
  }
  return labels;
}

/**
 * readJobDates({pipelineLine,historyRow,providerEvidence,now}) -> dates
 * (CONTRACTS E / D4). Reads publication evidence without scraping anything:
 * the scanner's recorded `posted:` label and/or a provider's published
 * timestamp. historyRow carries discovery metadata ({firstSeenAt,
 * lastCheckedAt}); providerEvidence is {publishedAt, modifiedAt} — modifiedAt
 * is deliberately ignored as a publication signal.
 * @returns {{postedAt:string|null, postedPrecision:'day'|'timestamp'|null,
 *            postedSource:string|null, firstSeenAt:string|null,
 *            lastCheckedAt:string|null, repostedAt:string|null}}
 */
export function readJobDates({ pipelineLine = null, historyRow = null, providerEvidence = null, now } = {}) {
  const t = resolveNow(now);
  const firstSeenAt = historyRow?.firstSeenAt ?? null;
  const lastCheckedAt = historyRow?.lastCheckedAt ?? null;

  let postedAt = null;
  let postedPrecision = null;
  let postedSource = null;

  const provider = classifyDateValue(providerEvidence?.publishedAt, t);
  const label = classifyDateValue(pipelineRowLabels(pipelineLine).get('posted'), t);
  if (provider) {
    postedAt = provider.value;
    postedPrecision = provider.precision;
    postedSource = 'provider_published';
  } else if (label) {
    postedAt = label.value;
    postedPrecision = label.precision;
    postedSource = 'pipeline_label';
  }
  // providerEvidence.modifiedAt: a modification is not a publication — never
  // promoted to postedAt. firstSeenAt is never relabeled as posted either.

  // True repost evidence: a provider-verified publication that postdates our
  // own first discovery of this URL. A pipeline label is not strong enough
  // (it may simply have been recorded late), and changed posting text alone
  // is never a repost.
  let repostedAt = null;
  if (postedSource === 'provider_published' && firstSeenAt && dayKey(postedAt) > dayKey(firstSeenAt)) {
    repostedAt = postedAt;
  }

  return { postedAt, postedPrecision, postedSource, firstSeenAt, lastCheckedAt, repostedAt };
}

/**
 * Calendar-day age of the verified posting date (UTC day arithmetic — honest
 * for day-precision values, which never get exact-hour ages). null = unknown.
 */
export function postedAgeDays(dates, now) {
  const day = dayKey(dates?.postedAt);
  if (!day || !DAY_RE.test(day)) return null;
  const t = resolveNow(now);
  const nowDay = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const posted = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(posted)) return null;
  const diff = Math.floor((nowDay - posted) / 86_400_000);
  return diff < 0 ? null : diff; // a stored future date is unknown, not fresh
}

/** Freshness bucket for freshness_then_fit and for UI aging/starvation views. */
export function freshnessBucket(dates, now) {
  const age = postedAgeDays(dates, now);
  if (age == null) return 'unknown';
  if (age <= 2) return '0-2';
  if (age <= 7) return '3-7';
  if (age <= 30) return '8-30';
  return 'older';
}

// --------------------------------------------------------------------------
// The one comparator
// --------------------------------------------------------------------------

/** Pickable: not held, and resume_ready or applying with attempts left.
 *  (held / ineligible stages / exhausted retries are filtered FIRST in every
 *  mode — identical to the legacy pickOrder gate.) */
function pickable(job, maxAttempts) {
  return !!job && !job.held
    && (job.stage === 'resume_ready'
      || (job.stage === 'applying' && (job.attempts || 0) < maxAttempts));
}

/** Legacy order, byte-for-byte: priority desc -> score desc -> oldest last
 *  state-transition first. Kept verbatim so mode 'existing' preserves the
 *  old pickOrder ordering exactly (including its reliance on sort stability). */
function compareExisting(a, b) {
  return (b.priority || 0) - (a.priority || 0)
    || (b.score || 0) - (a.score || 0)
    || (a.timestamps?.at(-1)?.at || '').localeCompare(b.timestamps?.at(-1)?.at || '');
}

/** Verified posting date, newest first; unknown after known (never discarded).
 *  Day-precision values compare by calendar day only; the exact-timestamp
 *  refinement applies only when BOTH sides carry timestamp precision. */
function comparePostedDesc(a, b) {
  const pa = a.dates?.postedAt ?? null;
  const pb = b.dates?.postedAt ?? null;
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  const da = dayKey(pa);
  const db = dayKey(pb);
  if (da !== db) return db.localeCompare(da);
  if (a.dates?.postedPrecision === 'timestamp' && b.dates?.postedPrecision === 'timestamp') {
    return pb.localeCompare(pa);
  }
  return 0; // same calendar day, day precision involved — tie at day level
}

/** First-seen ascending (missing last). Uses dates.firstSeenAt, falling back
 *  to the job's creation timestamp — NEVER the last state transition, so a
 *  recent requeue/hold/release does not reset a job's place in line. */
function firstSeenOf(job) {
  return job.dates?.firstSeenAt ?? job.timestamps?.[0]?.at ?? null;
}
function compareFirstSeenAsc(a, b) {
  const fa = firstSeenOf(a);
  const fb = firstSeenOf(b);
  if (fa == null && fb == null) return 0;
  if (fa == null) return 1;
  if (fb == null) return -1;
  return fa.localeCompare(fb);
}

/** Stable URL identity: the final deterministic tie-break in the new modes,
 *  so distinct requisitions with similar titles order reproducibly. */
function compareUrlKey(a, b) {
  return String(a.urlKey ?? '').localeCompare(String(b.urlKey ?? ''));
}

/**
 * orderJobs(jobs, {maxAttempts, mode, now}) -> jobs[] (CONTRACTS E).
 * Pure: filters held/ineligible/exhausted jobs first, preserves explicit
 * manual priority in every mode, then:
 *  - 'existing'           legacy order, unchanged (default everywhere).
 *  - 'fit_then_freshness' score desc -> verified posted desc.
 *  - 'freshness_then_fit' bucket (0-2,3-7,8-30,older,unknown) -> score desc
 *                         -> posted desc.
 * Both new modes end with first-seen asc then urlKey. Unknown dates are never
 * hard-discarded — they rank last within their tier and stay visible.
 */
export function orderJobs(jobs, { maxAttempts = 2, mode = 'existing', now } = {}) {
  if (!ORDER_MODES.includes(mode)) {
    throw typedError('ORDER_MODE_UNKNOWN', `orderJobs: unknown mode "${mode}" (expected ${ORDER_MODES.join('|')})`);
  }
  const pool = (Array.isArray(jobs) ? jobs : []).filter((j) => pickable(j, maxAttempts));
  if (mode === 'existing') return pool.sort(compareExisting);

  const t = resolveNow(now);
  const bucketRank = new Map(FRESHNESS_BUCKETS.map((b, i) => [b, i]));
  const cmp = mode === 'fit_then_freshness'
    ? (a, b) => (b.priority || 0) - (a.priority || 0)
      || (b.score || 0) - (a.score || 0)
      || comparePostedDesc(a, b)
      || compareFirstSeenAsc(a, b)
      || compareUrlKey(a, b)
    : (a, b) => (b.priority || 0) - (a.priority || 0)
      || bucketRank.get(freshnessBucket(a.dates, t)) - bucketRank.get(freshnessBucket(b.dates, t))
      || (b.score || 0) - (a.score || 0)
      || comparePostedDesc(a, b)
      || compareFirstSeenAsc(a, b)
      || compareUrlKey(a, b);
  return pool.sort(cmp);
}

// --------------------------------------------------------------------------
// Dry-run date enrichment + rank-difference report (activation deferred)
// --------------------------------------------------------------------------

/**
 * dateEnrichmentReport({jobs, pipelineLineFor, providerEvidenceFor, now,
 *                       maxAttempts, compareMode, apply, updateJob})
 * Enriches legacy jobs' missing date metadata from recorded evidence only
 * (never relabeling first discovery as publication) and reports how the
 * ordering WOULD change under compareMode versus today's 'existing' order.
 *
 * Dry-run by default: with apply=false nothing is written. With apply=true
 * each enrichment commits through the injected updateJob with the job's
 * snapshot recordVersion (CAS recheck — a concurrently changed job is
 * reported as a conflict, not overwritten). Only `dates` is patched: manual
 * priority/held, stage and execution are untouched, and no application is
 * ever started here. Activating a new mode stays a separate, reviewed step.
 */
export async function dateEnrichmentReport({
  jobs,
  pipelineLineFor = () => null,
  providerEvidenceFor = () => null,
  now,
  maxAttempts = 2,
  compareMode = 'freshness_then_fit',
  apply = false,
  updateJob = null,
} = {}) {
  const t = resolveNow(now);
  const entries = [];
  const enriched = (Array.isArray(jobs) ? jobs : []).map((job) => {
    const current = job.dates && typeof job.dates === 'object' ? job.dates : {};
    const read = readJobDates({
      pipelineLine: pipelineLineFor(job),
      providerEvidence: providerEvidenceFor(job),
      historyRow: {
        firstSeenAt: current.firstSeenAt ?? job.timestamps?.[0]?.at ?? null,
        lastCheckedAt: current.lastCheckedAt ?? null,
      },
      now: t,
    });
    // Fill only what is missing; already-stored metadata wins.
    const next = {
      postedAt: current.postedAt ?? read.postedAt,
      postedPrecision: current.postedAt ? (current.postedPrecision ?? null) : read.postedPrecision,
      postedSource: current.postedAt ? (current.postedSource ?? null) : read.postedSource,
      firstSeenAt: current.firstSeenAt ?? read.firstSeenAt,
      lastCheckedAt: current.lastCheckedAt ?? null,
      repostedAt: current.repostedAt ?? read.repostedAt,
    };
    const changed = ['postedAt', 'postedPrecision', 'postedSource', 'firstSeenAt', 'repostedAt']
      .some((k) => (next[k] ?? null) !== (current[k] ?? null));
    if (changed) {
      entries.push({
        urlKey: job.urlKey,
        recordVersion: job.recordVersion ?? null,
        before: { ...current },
        after: next,
      });
    }
    return { ...job, dates: next };
  });

  const orderBefore = orderJobs(jobs, { maxAttempts, mode: 'existing', now: t }).map((j) => j.urlKey);
  const orderAfter = orderJobs(enriched, { maxAttempts, mode: compareMode, now: t }).map((j) => j.urlKey);
  const rankDiff = orderAfter
    .map((urlKey, to) => ({ urlKey, from: orderBefore.indexOf(urlKey), to }))
    .filter((r) => r.from !== r.to);

  let applied = 0;
  const conflicts = [];
  if (apply) {
    if (typeof updateJob !== 'function') {
      throw typedError('UPDATE_JOB_REQUIRED', 'dateEnrichmentReport: apply=true requires an injected updateJob');
    }
    for (const entry of entries) {
      try {
        await updateJob(entry.urlKey, {
          expectedVersion: entry.recordVersion ?? undefined,
          patch: { dates: entry.after },
        });
        applied += 1;
      } catch (err) {
        if (err?.code === 'VERSION_CONFLICT') {
          conflicts.push({ urlKey: entry.urlKey, code: err.code, actualVersion: err.actualVersion ?? null });
        } else {
          throw err;
        }
      }
    }
  }

  return { dryRun: !apply, mode: compareMode, entries, orderBefore, orderAfter, rankDiff, applied, conflicts };
}
