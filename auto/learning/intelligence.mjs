// auto/learning/intelligence.mjs — T16: role/capability intelligence from
// distinct evidence (CONTRACTS D6/E). Deterministic local computation only:
// no model calls, no network, no browser; nothing executes at import time.
// Never imports core/db.mjs.
//
// Exports:
//   ROLE_FAMILIES                                            (constant)
//   classifyRoleTitle(roleTitle) -> classification           (pure)
//   recordRoleCorrection(ctx, {...}) -> proposal envelope
//   classifyQuestionOrigin(stats) -> origin                  (pure)
//   joinCapabilitiesToExperience({capabilities,stories})     (pure)
//   screenProposedTopics(topics, sources) -> {evidenceBacked,rejected} (pure)
//   deriveRoleInsights(ctx, {roleFamily, filters, asOf}) -> insights[]
//
// Counts always use DISTINCT requisitions (applicationId) and DISTINCT
// companies as denominators — never raw audit/observation rows. Raw evidence
// volume is reported separately as rawOccurrences. Displays must say
// "observed in your sampled roles", never "required by the entire market".

import { createHash } from 'node:crypto';
import { LearningError, validateRecordData } from './contracts.mjs';
import { commitRecord, getRecord, listRecords } from './store.mjs';
import { normalizeQuestion } from './questions.mjs';
import { loadSourceSnapshot, extractExperienceStories } from './retrieval.mjs';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// --- Role taxonomy -------------------------------------------------------------
// Small, explicit, closed set. Employer titles are NEVER rewritten: the
// original title is preserved verbatim everywhere; tags are additive metadata.

export const ROLE_FAMILIES = Object.freeze([
  'ai_transformation_leadership',
  'engineering_leadership',
  'product_leadership',
  'ai_engineering',
  'software_engineering',
  'solutions_architecture',
  'other',
  'unknown',
]);

// Heuristic title patterns. A title may match several families (multi-role
// jobs keep every tag). These are classification hints, not truths: a reviewed
// correction always overrides them.
const FAMILY_PATTERNS = Object.freeze([
  ['ai_transformation_leadership',
    /(?:(?:head|director|vp|vice president|chief|lead|leader|manager)[^,;|]*(?:ai|artificial intelligence)[\s-]*(?:transformation|strategy|adoption|enablement|change|innovation))|(?:(?:ai|artificial intelligence)[\s-]*(?:transformation|strategy|adoption|enablement)[^,;|]*(?:head|director|vp|lead|leader|manager|officer))|chief ai officer/i],
  ['engineering_leadership',
    /engineering (?:manager|director|lead(?:er)?)|(?:head|vp|vice president|director) of(?: \w+)? engineering|chief technology officer|\bcto\b/i],
  ['product_leadership',
    /product (?:manager|director|lead(?:er)?|owner)|(?:head|vp|vice president|director) of(?: \w+)? product|chief product officer|\bcpo\b/i],
  ['ai_engineering',
    /(?:machine learning|\bml\b|\bai\b|\bllm\b|deep learning|genai|generative ai)[\s-]*(?:engineer(?:ing)?|scientist|developer)/i],
  ['software_engineering',
    /(?:software|backend|back-end|frontend|front-end|full[- ]stack|platform|systems) (?:engineer|developer)|\bswe\b/i],
  ['solutions_architecture', /solutions? architect/i],
]);

/**
 * classifyRoleTitle(roleTitle) ->
 *   { originalTitle, roleTags, source, confidence }
 * Pure heuristic. Missing/empty titles stay 'unknown' (never guessed);
 * non-matching titles are 'other'. Multi-family titles keep every tag.
 */
export function classifyRoleTitle(roleTitle) {
  const originalTitle = typeof roleTitle === 'string' ? roleTitle : null;
  if (originalTitle === null || originalTitle.trim() === '') {
    return { originalTitle, roleTags: ['unknown'], source: 'none', confidence: 'none' };
  }
  const tags = [];
  for (const [family, re] of FAMILY_PATTERNS) {
    if (re.test(originalTitle)) tags.push(family);
  }
  if (tags.length === 0) {
    return { originalTitle, roleTags: ['other'], source: 'title_heuristic', confidence: 'low' };
  }
  return { originalTitle, roleTags: tags, source: 'title_heuristic', confidence: 'medium' };
}

const SENIORITY_RE = Object.freeze([
  ['chief', /\bchief|\bc[tpa]o\b/i],
  ['vp', /\bvp\b|vice president/i],
  ['director', /director/i],
  ['head', /\bhead\b/i],
  ['principal', /principal/i],
  ['staff', /\bstaff\b/i],
  ['lead', /\blead(?:er)?\b/i],
  ['manager', /manager/i],
  ['senior', /\bsenior\b|\bsr\.?\b/i],
  ['junior', /\bjunior\b|\bjr\.?\b|entry[- ]level|graduate/i],
]);

function detectSeniority(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    return { value: 'unknown', source: 'none', confidence: 'none' };
  }
  for (const [value, re] of SENIORITY_RE) {
    if (re.test(title)) return { value, source: 'title_heuristic', confidence: 'medium' };
  }
  return { value: 'unknown', source: 'none', confidence: 'none' };
}

// --- Reviewed role corrections -------------------------------------------------
// A correction is a new immutable, reviewed record (proposals collection,
// kind 'positioning'); the raw observations and the employer's title are never
// rewritten. Only an 'approved' correction affects classification.

export function roleCorrectionId(applicationId) {
  return `rolecorr-${sha256(String(applicationId)).slice(0, 40)}`;
}

/**
 * recordRoleCorrection(ctx, {applicationId, originalTitle, roleTags, reason,
 * reviewedBy, evidenceIds}) -> proposal envelope. roleTags must be valid
 * taxonomy families. Stored approved (it IS the review); re-correcting the
 * same application commits a new revision.
 */
export async function recordRoleCorrection(ctx, {
  applicationId, originalTitle, roleTags, reason, reviewedBy, evidenceIds = [],
} = {}) {
  if (typeof applicationId !== 'string' || applicationId.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'recordRoleCorrection requires applicationId');
  }
  if (!Array.isArray(roleTags) || roleTags.length === 0
      || roleTags.some((t) => !ROLE_FAMILIES.includes(t))) {
    throw new LearningError('SCHEMA_VALIDATION',
      `roleTags must be a nonempty array drawn from the role taxonomy (${ROLE_FAMILIES.join('|')})`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new LearningError('SCHEMA_VALIDATION', 'a reviewed correction requires a reason');
  }
  const id = roleCorrectionId(applicationId);
  const existing = getRecord(ctx, 'proposals', id);
  return commitRecord(ctx, 'proposals', id, {
    kind: 'positioning',
    evidenceIds: [applicationId, ...evidenceIds],
    intendedBenefit: 'reviewed role reclassification',
    baseline: originalTitle ?? null, // employer's title preserved verbatim, never rewritten
    diff: {
      correctionType: 'role_tags',
      applicationId,
      roleTags: [...roleTags],
      reason,
      reviewedBy: reviewedBy ?? null,
    },
  }, {
    expectedRevision: existing ? existing.revision : 0,
    status: 'approved',
    sourceIds: evidenceIds.slice(0, 200),
  });
}

function loadRoleCorrections(ctx) {
  const corrections = new Map();
  let cursor;
  do {
    const page = listRecords(ctx, 'proposals', { cursor, limit: 500, filters: { status: 'approved' } });
    for (const record of page.items) {
      const diff = record.data?.diff;
      if (record.data?.kind === 'positioning' && isPlainObject(diff)
          && diff.correctionType === 'role_tags' && typeof diff.applicationId === 'string') {
        corrections.set(diff.applicationId, { record, roleTags: diff.roleTags });
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return corrections;
}

// --- Question origin -----------------------------------------------------------

/**
 * classifyQuestionOrigin({distinctCompanies, distinctJobs, atsVendors}) ->
 * 'ats_boilerplate'|'employer_general'|'role_specific'|'unknown'. Pure,
 * deliberately conservative: sparse/ambiguous evidence stays 'unknown' rather
 * than being promoted to a confident label.
 */
export function classifyQuestionOrigin({ distinctCompanies, distinctJobs, atsVendors } = {}) {
  const vendors = [...new Set((atsVendors ?? []).filter((v) => v != null))];
  if (Number.isInteger(distinctCompanies) && distinctCompanies >= 3 && vendors.length === 1) {
    return 'ats_boilerplate';
  }
  if (distinctCompanies === 1 && Number.isInteger(distinctJobs) && distinctJobs >= 2) {
    return 'employer_general';
  }
  if (distinctCompanies === 1 && distinctJobs === 1) {
    return 'role_specific';
  }
  return 'unknown';
}

// --- Capability/experience join ------------------------------------------------
// Capability REQUESTS (what employers ask) stay separate from candidate
// EVIDENCE (approved experience stories). The join can only ever cite verbatim
// claims from approved sources; it can never add a qualification or clear a
// private experience for LinkedIn/public use.

const CAPABILITY_STOPWORDS = new Set([
  'you', 'your', 'yours', 'have', 'has', 'had', 'how', 'many', 'much', 'years',
  'year', 'experience', 'with', 'does', 'the', 'and', 'for', 'are', 'what',
  'which', 'describe', 'please', 'tell', 'about', 'can', 'will', 'would',
  'required', 'using', 'use', 'used', 'any', 'all', 'this', 'that', 'our',
  'who', 'why', 'when', 'where', 'they', 'their', 'from', 'into', 'per',
]);

function capabilityTokens(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 2 && !CAPABILITY_STOPWORDS.has(t)));
}

/**
 * joinCapabilitiesToExperience({capabilities, stories}) ->
 *   { alreadySupported, userMightSupply, genuineGaps }
 * capabilities: [{definitionId, label}]; stories: retrieval.mjs experience
 * stories (verbatim approved spans). Three disjoint outputs:
 *   alreadySupported — approved evidence exists; cite it (verbatim quote).
 *   userMightSupply  — partial signal; ASK the user, never assert.
 *   genuineGaps      — no supporting evidence at all.
 * Every item keeps publicUse 'applications_only' unless the cited story
 * itself was approved for public use; nothing here grants public clearance.
 */
export function joinCapabilitiesToExperience({ capabilities = [], stories = [] } = {}) {
  const alreadySupported = [];
  const userMightSupply = [];
  const genuineGaps = [];
  for (const capability of capabilities) {
    const capTokens = capabilityTokens(capability.label);
    let best = null;
    for (const story of stories) {
      const storyTokens = new Set([
        ...(story.capabilityTags ?? []), ...(story.roleTags ?? []),
        ...(story.claims ?? []).flatMap((c) => [...capabilityTokens(c)]),
      ].map((t) => String(t).toLowerCase()));
      let inter = 0;
      for (const t of capTokens) if (storyTokens.has(t)) inter += 1;
      const score = capTokens.size === 0 ? 0 : inter / capTokens.size;
      if (score > 0 && (best === null || score > best.score)) {
        const quote = (story.claims ?? []).find((c) => {
          const ct = capabilityTokens(c);
          for (const t of capTokens) if (ct.has(t)) return true;
          return false;
        }) ?? null;
        best = { story, score, quote };
      }
    }
    const base = { definitionId: capability.definitionId, capability: capability.label };
    if (best && best.score >= 0.5 && best.quote) {
      alreadySupported.push({
        ...base,
        action: 'emphasize_existing_experience',
        storyId: best.story.id,
        sourceRef: best.story.sourceRef,
        quote: best.quote, // verbatim from the approved source, never synthesized
        publicUse: best.story.publicUse ?? 'applications_only',
      });
    } else if (best && best.score > 0) {
      userMightSupply.push({
        ...base,
        action: 'ask_user',
        prompt: `Do you have experience you want recorded for: ${capability.label}?`,
        nearestStoryId: best.story.id,
        publicUse: 'applications_only',
      });
    } else {
      genuineGaps.push({ ...base, action: 'genuine_gap', publicUse: 'applications_only' });
    }
  }
  return { alreadySupported, userMightSupply, genuineGaps };
}

// --- Model-proposed topic screening ---------------------------------------------
// A model may PROPOSE topics, but an insight is displayed as evidence-backed
// only when the cited source actually contains the verbatim quote. Numeric
// market percentages that do not appear verbatim in the cited source are
// fabricated and rejected outright.

const PERCENT_RE = /\d+(?:\.\d+)?\s*%/g;

/**
 * screenProposedTopics(topics, sources) -> {evidenceBacked, rejected}
 * topics: [{topic, sourceId, quote, prose?}]; sources: {id: text} map or
 * [{id, text}]. Pure; no model calls.
 */
export function screenProposedTopics(topics = [], sources = {}) {
  const sourceText = new Map(Array.isArray(sources)
    ? sources.map((s) => [s.id, s.text])
    : Object.entries(sources));
  const evidenceBacked = [];
  const rejected = [];
  for (const topic of topics) {
    const cited = sourceText.get(topic?.sourceId);
    if (typeof cited !== 'string') {
      rejected.push({ ...topic, evidenceBacked: false, reason: 'unknown_source' });
      continue;
    }
    if (typeof topic.quote !== 'string' || topic.quote.length === 0 || !cited.includes(topic.quote)) {
      rejected.push({ ...topic, evidenceBacked: false, reason: 'quote_not_in_source' });
      continue;
    }
    const prose = `${topic.topic ?? ''}\n${topic.prose ?? ''}`;
    const percents = prose.match(PERCENT_RE) ?? [];
    const fabricated = percents.filter((p) => !cited.includes(p));
    if (fabricated.length > 0) {
      rejected.push({ ...topic, evidenceBacked: false, reason: 'fabricated_percentage' });
      continue;
    }
    evidenceBacked.push({ ...topic, evidenceBacked: true });
  }
  return { evidenceBacked, rejected };
}

// --- Insight derivation ----------------------------------------------------------

const ALLOWED_FILTERS = new Set(['country', 'atsVendor', 'companyId', 'appliedOnly']);
const MAX_SOURCE_IDS = 200;
const MAX_CAPABILITIES = 100;
const MAX_JOBS_DETAIL = 200;

function listAllObservations(ctx) {
  const items = [];
  let cursor;
  do {
    const page = listRecords(ctx, 'observations', { cursor, limit: 500 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function companyKeyOf(data) {
  return data.companyId ?? data.employerName ?? null;
}

/**
 * deriveRoleInsights(ctx, {roleFamily, filters, asOf}) -> insights[] (CONTRACTS E).
 *
 * SYNCHRONOUS, read-only derivation (the plan's assertion snippet consumes the
 * return value directly). Groups stored D1 observations into DISTINCT
 * requisitions (applicationId is the requisition identity) and DISTINCT
 * companies; raw observation rows are reported only as rawOccurrences evidence
 * volume. Each returned insight is a draft D6-shaped record (validated before
 * return); persist it explicitly with saveRoleInsight. All statistics carry
 * basis 'observed_sample': they describe the sampled roles, never the market.
 */
export function deriveRoleInsights(ctx, { roleFamily, filters = {}, asOf } = {}) {
  if (!ROLE_FAMILIES.includes(roleFamily)) {
    throw new LearningError('SCHEMA_VALIDATION',
      `roleFamily must be one of ${ROLE_FAMILIES.join('|')}, got ${String(roleFamily)}`);
  }
  if (!isPlainObject(filters)) {
    throw new LearningError('SCHEMA_VALIDATION', 'filters must be a plain object');
  }
  for (const key of Object.keys(filters)) {
    if (!ALLOWED_FILTERS.has(key)) {
      throw new LearningError('SCHEMA_VALIDATION', `unknown filter "${key}"`);
    }
  }
  const asOfDate = asOf instanceof Date ? asOf : new Date(asOf ?? ctx.now());
  if (Number.isNaN(asOfDate.getTime())) {
    throw new LearningError('SCHEMA_VALIDATION', 'asOf must be a Date or ISO date string');
  }

  const corrections = loadRoleCorrections(ctx);
  const all = listAllObservations(ctx);

  // Observation-level filters first (country/vendor/company/applied-only).
  const matching = all.filter((record) => {
    const d = record.data;
    if (filters.country != null && d.country !== filters.country) return false;
    if (filters.atsVendor != null && d.atsVendor !== filters.atsVendor) return false;
    if (filters.companyId != null && d.companyId !== filters.companyId) return false;
    if (filters.appliedOnly === true && d.attemptId == null) return false;
    return true;
  });

  // Group raw rows into DISTINCT requisitions.
  const jobs = new Map();
  for (const record of matching) {
    const appId = record.data.applicationId ?? `unknown-app-${record.id}`;
    let job = jobs.get(appId);
    if (!job) {
      job = { applicationId: appId, titles: new Set(), records: [] };
      jobs.set(appId, job);
    }
    if (typeof record.data.roleTitle === 'string' && record.data.roleTitle.trim() !== '') {
      job.titles.add(record.data.roleTitle);
    }
    job.records.push(record);
  }

  const contradictions = [];
  const cohortJobs = [];
  for (const job of jobs.values()) {
    const titles = [...job.titles];
    if (titles.length > 1) {
      contradictions.push({
        type: 'conflicting_role_titles',
        applicationId: job.applicationId,
        titles,
        sourceIds: job.records.map((r) => r.id).slice(0, 20),
      });
    }
    const originalTitle = titles[0] ?? null;
    const heuristic = classifyRoleTitle(originalTitle);
    const correction = corrections.get(job.applicationId);
    let classification = heuristic;
    if (correction) {
      classification = {
        originalTitle, // the employer's title, preserved verbatim
        roleTags: [...correction.roleTags],
        source: 'reviewed_correction',
        confidence: 'high',
      };
      const same = heuristic.roleTags.length === correction.roleTags.length
        && heuristic.roleTags.every((t) => correction.roleTags.includes(t));
      if (!same) {
        contradictions.push({
          type: 'role_reclassified',
          applicationId: job.applicationId,
          heuristicTags: heuristic.roleTags,
          correctedTags: [...correction.roleTags],
          sourceIds: [correction.record.id],
        });
      }
    }
    job.classification = classification;
    if (classification.roleTags.includes(roleFamily)) cohortJobs.push(job);
  }

  const cohortRecords = cohortJobs.flatMap((j) => j.records);
  const distinctJobs = cohortJobs.length;
  const companyKeys = new Set();
  let unknownCompanyJobs = 0;
  for (const job of cohortJobs) {
    const key = companyKeyOf(job.records[0].data);
    if (key === null) unknownCompanyJobs += 1;
    else companyKeys.add(key);
  }
  const distinctCompanies = companyKeys.size;
  const rawOccurrences = cohortRecords.length;

  // Observation window: earliest observed evidence through asOf.
  let from = null;
  for (const record of cohortRecords) {
    const at = record.data.observedAt ?? record.createdAt;
    if (typeof at === 'string' && (from === null || at < from)) from = at;
  }

  // Coverage: unanswered questions and partially observed forms stay VISIBLE.
  const coverageCounts = { observed: 0, partially_observed: 0, not_reached: 0, unknown: 0 };
  let unanswered = 0;
  for (const record of cohortRecords) {
    const c = record.data.coverage ?? 'unknown';
    coverageCounts[c in coverageCounts ? c : 'unknown'] += 1;
    if ((record.data.answerDisposition ?? 'unanswered') === 'unanswered') unanswered += 1;
  }
  const partialFormJobs = cohortJobs.filter((j) => j.records.some((r) =>
    ['partially_observed', 'not_reached', 'unknown'].includes(r.data.coverage ?? 'unknown'))).length;
  const appliedJobs = cohortJobs.filter((j) => j.records.some((r) => r.data.attemptId != null)).length;
  const coverage = {
    byObservation: coverageCounts,
    unansweredQuestions: unanswered,
    partiallyObservedFormJobs: partialFormJobs,
    unknownCompanyJobs,
    sample: {
      appliedJobs,
      discoveredOnlyJobs: distinctJobs - appliedJobs,
      note: 'applied-only and discovered-job evidence are different samples; do not pool silently',
    },
  };

  // Capability requests: group cohort rows by question definition (what the
  // employer ASKS), kept separate from candidate evidence.
  const byDefinition = new Map();
  for (const record of cohortRecords) {
    const d = record.data;
    if (typeof d.originalText !== 'string' || d.originalText.trim() === '') continue;
    let definition;
    try {
      definition = normalizeQuestion(d);
    } catch { continue; }
    let entry = byDefinition.get(definition.id);
    if (!entry) {
      entry = {
        definitionId: definition.id, label: definition.normalizedText,
        apps: new Set(), companies: new Set(), vendors: new Set(),
        rawOccurrences: 0, requiredValues: new Set(), sourceIds: new Set(),
      };
      byDefinition.set(definition.id, entry);
    }
    entry.apps.add(d.applicationId ?? record.id);
    const ck = companyKeyOf(d);
    if (ck !== null) entry.companies.add(ck);
    entry.vendors.add(d.atsVendor ?? null);
    entry.rawOccurrences += 1;
    if (d.required === true || d.required === false) entry.requiredValues.add(d.required);
    entry.sourceIds.add(record.id);
  }

  const capabilities = [...byDefinition.values()]
    .sort((a, b) => b.apps.size - a.apps.size || (a.definitionId < b.definitionId ? -1 : 1))
    .slice(0, MAX_CAPABILITIES)
    .map((entry) => {
      if (entry.requiredValues.size > 1) {
        contradictions.push({
          type: 'conflicting_required_state',
          definitionId: entry.definitionId,
          sourceIds: [...entry.sourceIds].slice(0, 20),
        });
      }
      return {
        definitionId: entry.definitionId,
        label: entry.label,
        distinctJobs: entry.apps.size,
        distinctCompanies: entry.companies.size,
        rawOccurrences: entry.rawOccurrences,
        // Share of DISTINCT sampled requisitions, never raw rows and never a
        // market percentage.
        shareOfSampledJobs: distinctJobs === 0 ? 0 : entry.apps.size / distinctJobs,
        origin: classifyQuestionOrigin({
          distinctCompanies: entry.companies.size,
          distinctJobs: entry.apps.size,
          atsVendors: [...entry.vendors],
        }),
        sourceIds: [...entry.sourceIds].slice(0, 20),
      };
    });

  // Candidate evidence: approved experience stories from the data root (CV
  // material). Absent sources simply mean no supporting evidence yet.
  let stories = [];
  try {
    const { snapshot, texts } = loadSourceSnapshot(ctx);
    for (const source of snapshot.sources) {
      if (source.fileKey !== 'cv') continue;
      stories = extractExperienceStories({
        fileKey: source.fileKey, text: texts[source.fileKey], sha256hex: source.sha256,
      });
    }
  } catch {
    stories = []; // malformed sources: no evidence claims, never a crash here
  }
  const recommendations = joinCapabilitiesToExperience({
    capabilities: capabilities.map((c) => ({ definitionId: c.definitionId, label: c.label })),
    stories,
  });

  const jobDetails = cohortJobs.slice(0, MAX_JOBS_DETAIL).map((job) => ({
    applicationId: job.applicationId,
    originalTitle: job.classification.originalTitle, // verbatim, never rewritten
    roleTags: job.classification.roleTags,
    role: { source: job.classification.source, confidence: job.classification.confidence },
    seniority: detectSeniority(job.classification.originalTitle),
    country: job.records[0].data.country != null
      ? { value: job.records[0].data.country, source: 'observation', confidence: 'medium' }
      : { value: 'unknown', source: 'none', confidence: 'none' },
    // No company size/funding evidence exists in observations: it STAYS
    // unknown rather than being inferred.
    companyType: { value: 'unknown', source: 'none', confidence: 'none' },
  }));

  const sourceIds = [...new Set(cohortRecords.map((r) => r.id))].slice(0, MAX_SOURCE_IDS);

  const data = {
    roleFamily,
    filters,
    from,
    to: asOfDate.toISOString(),
    distinctJobs,
    distinctCompanies,
    rawOccurrences,
    coverage,
    statistics: {
      basis: 'observed_sample',
      note: 'observed in your sampled roles, not required by the entire market',
      capabilities,
      jobs: jobDetails,
    },
    sourceIds,
    contradictions,
    recommendations,
  };

  validateRecordData('insights', data); // guarantee the shared D6 shape
  const insightId = `ins-${sha256(JSON.stringify({ v: 1, roleFamily, filters })).slice(0, 48)}`;
  return [{ id: insightId, collection: 'insights', status: 'draft', sourceIds, data }];
}

/**
 * saveRoleInsight(ctx, insight) -> envelope. Persists one derived insight as a
 * draft record; re-saving the same roleFamily+filters commits a new revision.
 */
export async function saveRoleInsight(ctx, insight) {
  if (!isPlainObject(insight) || typeof insight.id !== 'string' || !isPlainObject(insight.data)) {
    throw new LearningError('SCHEMA_VALIDATION', 'saveRoleInsight requires a derived insight object');
  }
  const existing = getRecord(ctx, 'insights', insight.id);
  return commitRecord(ctx, 'insights', insight.id, insight.data, {
    expectedRevision: existing ? existing.revision : 0,
    status: 'draft',
    sourceIds: (insight.sourceIds ?? []).slice(0, MAX_SOURCE_IDS),
  });
}
