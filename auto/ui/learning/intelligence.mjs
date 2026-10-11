// T23: Role Intelligence view — renders persisted D6 insight records: role
// family + cohort controls, observed capabilities with DISTINCT job/company
// denominators, evidence window, capture gaps, source references,
// contradictory evidence, and grounded positioning drafts. Also builds the
// fixed insight cards and screens generated card payloads: unsupported
// card/code types are refused and shown as a proposal needing implementation
// review, never executed. Pure view-model functions are exported for
// node:test; rendering is textContent only (no innerHTML anywhere).

import { el } from './questions.mjs';

// Mirrors auto/learning/intelligence.mjs RATE_SAMPLE_FLOOR: below it the UI
// shows counts and limitations, never confident shares or conclusions.
export const SAMPLE_FLOOR = 5;

export const SUPPORTED_CARD_TYPES = Object.freeze([
  'question_trend', 'role_capability', 'unresolved_information',
  'operational_friction', 'procedure_candidate', 'outcome_summary',
]);

// Keys whose presence marks a generated card as executable content rather
// than data. Such cards are never rendered as markup.
const CODE_PAYLOAD_KEYS = Object.freeze(['html', 'script', 'code', 'component', 'render', 'template', 'style']);

export function clip(text, max = 200) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function asCount(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

export function countLabel(v) {
  const n = asCount(v);
  return n === null ? 'unknown' : String(n);
}

/** shareLabel(share, cohortJobs) — a confident % only at/above the sample
 *  floor and for a well-formed 0..1 number; otherwise an honest limitation. */
export function shareLabel(share, cohortJobs) {
  const jobs = asCount(cohortJobs);
  if (jobs === null || jobs < SAMPLE_FLOOR) {
    return `below sample floor (${jobs === null ? '?' : jobs}/${SAMPLE_FLOOR} sampled jobs) — counts only, no share`;
  }
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) return 'unknown (malformed)';
  return `${Math.round(share * 100)}% of ${jobs} sampled jobs`;
}

export function windowLabel(from, to) {
  const day = (v) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null);
  const f = day(from);
  const t = day(to);
  if (!f && !t) return 'evidence window unknown';
  return `${f ?? 'unknown start'} → ${t ?? 'unknown end'}`;
}

/** capabilityRows(data) -> rows for one insight's observed capabilities.
 *  Denominators are DISTINCT jobs/companies, raw rows shown separately. */
export function capabilityRows(data = {}) {
  const cohortJobs = asCount(data.distinctJobs);
  const stats = Array.isArray(data.statistics) ? data.statistics : [];
  return stats.map((s) => ({
    definitionId: s?.definitionId ?? null,
    label: clip(s?.label ?? '(unlabeled capability)'),
    distinctJobs: countLabel(s?.distinctJobs),
    distinctCompanies: countLabel(s?.distinctCompanies),
    rawOccurrences: countLabel(s?.rawOccurrences),
    share: shareLabel(s?.shareOfSampledJobs, cohortJobs),
    origin: typeof s?.origin === 'string' ? s.origin : 'unknown',
    sourceIds: Array.isArray(s?.sourceIds) ? s.sourceIds.slice(0, 20) : [],
  }));
}

/** captureGaps(data) -> honest "what we did not see" rows from coverage. */
export function captureGaps(data = {}) {
  const c = data.coverage;
  if (!c || typeof c !== 'object') return [{ label: 'coverage', value: 'unknown — capture gaps not recorded' }];
  const rows = [
    { label: 'unanswered questions', value: countLabel(c.unansweredQuestions) },
    { label: 'jobs with partially observed forms', value: countLabel(c.partiallyObservedFormJobs) },
    { label: 'jobs with unknown company', value: countLabel(c.unknownCompanyJobs) },
  ];
  if (c.byObservation && typeof c.byObservation === 'object') {
    for (const [k, v] of Object.entries(c.byObservation)) {
      rows.push({ label: `observations ${k}`, value: countLabel(v) });
    }
  }
  if (c.sample && typeof c.sample === 'object') {
    rows.push({ label: 'applied vs discovered-only jobs', value: `${countLabel(c.sample.appliedJobs)} applied / ${countLabel(c.sample.discoveredOnlyJobs)} discovered-only — different samples, never pooled silently` });
  }
  return rows;
}

/** contradictionRows(data) -> visible contradictory evidence, never hidden. */
export function contradictionRows(data = {}) {
  const list = Array.isArray(data.contradictions) ? data.contradictions : [];
  return list.map((c) => ({
    type: typeof c?.type === 'string' ? c.type : 'unknown',
    detail: clip(JSON.stringify({ ...c, type: undefined, sourceIds: undefined } ?? {}), 240),
    sourceIds: Array.isArray(c?.sourceIds) ? c.sourceIds.slice(0, 10) : [],
  }));
}

/**
 * positioningDrafts(recommendations) -> grounded drafts ONLY where approved
 * evidence exists (verbatim quote cited); partial matches become questions to
 * the user and genuine gaps are listed as gaps — never drafted claims.
 */
export function positioningDrafts(recommendations = {}) {
  const r = recommendations && typeof recommendations === 'object' ? recommendations : {};
  const supported = (Array.isArray(r.alreadySupported) ? r.alreadySupported : []).map((s) => ({
    kind: 'draft',
    capability: clip(s?.capability ?? ''),
    draft: `Grounded draft — cite verbatim: “${clip(s?.quote ?? '', 240)}”`,
    evidence: s?.storyId ? [s.storyId] : [],
    publicUse: s?.publicUse ?? 'applications_only',
  }));
  const ask = (Array.isArray(r.userMightSupply) ? r.userMightSupply : []).map((s) => ({
    kind: 'ask',
    capability: clip(s?.capability ?? ''),
    draft: clip(s?.prompt ?? `Do you have experience for: ${s?.capability ?? '?'}?`),
    evidence: [],
    publicUse: 'applications_only',
  }));
  const gaps = (Array.isArray(r.genuineGaps) ? r.genuineGaps : []).map((s) => ({
    kind: 'gap',
    capability: clip(s?.capability ?? ''),
    draft: 'No supporting evidence in approved sources — listed as a gap, no claim drafted.',
    evidence: [],
    publicUse: 'applications_only',
  }));
  return [...supported, ...ask, ...gaps];
}

/** insightRows(items) -> one row per persisted insight record. */
export function insightRows(items = []) {
  return items.map((rec) => {
    const d = rec?.data ?? {};
    const distinctJobs = asCount(d.distinctJobs);
    return {
      id: rec?.id ?? null,
      status: rec?.status ?? 'unknown',
      roleFamily: typeof d.roleFamily === 'string' ? d.roleFamily : 'unknown',
      filters: d.filters && typeof d.filters === 'object' ? d.filters : {},
      window: windowLabel(d.from, d.to),
      distinctJobs: countLabel(d.distinctJobs),
      distinctCompanies: countLabel(d.distinctCompanies),
      rawOccurrences: countLabel(d.rawOccurrences),
      smallSample: distinctJobs === null || distinctJobs < SAMPLE_FLOOR,
      capabilities: capabilityRows(d),
      gaps: captureGaps(d),
      contradictions: contradictionRows(d),
      drafts: positioningDrafts(d.recommendations),
      sourceIds: Array.isArray(d.sourceIds) ? d.sourceIds.slice(0, 20) : [],
    };
  });
}

export function insightFamilies(rows = []) {
  return [...new Set(rows.map((r) => r.roleFamily))].sort();
}

// ---------------------------------------------------------------------------
// Fixed insight cards. Always all six supported types, auto-populated from
// current data; absent evidence yields an honest "no evidence yet" body.

export function buildInsightCards({ questions = [], blockers = [], insights = [], procedures = [], metrics = null } = {}) {
  const cards = [];

  const topQ = [...questions].sort((a, b) => (b?.data?.occurrenceCount ?? 0) - (a?.data?.occurrenceCount ?? 0))[0];
  cards.push({
    type: 'question_trend',
    title: 'Question trend',
    body: topQ && (topQ.data?.occurrenceCount ?? 0) >= 2
      ? `Seen ${topQ.data.occurrenceCount}×: “${clip(topQ.data?.normalizedText ?? topQ.data?.originalText ?? '', 160)}”`
      : 'No repeated question observed yet.',
    evidence: topQ ? [topQ.id] : [],
  });

  const ins = insightRows(insights).find((r) => r.capabilities.length > 0) ?? null;
  const topCap = ins?.capabilities?.[0] ?? null;
  cards.push({
    type: 'role_capability',
    title: 'Role capability',
    body: topCap
      ? `${topCap.label} — ${topCap.distinctJobs} distinct jobs, ${topCap.distinctCompanies} companies (${topCap.share})`
      : 'No capability evidence derived yet.',
    evidence: topCap ? topCap.sourceIds.slice(0, 5) : [],
  });

  const open = blockers.filter((b) => b?.status === 'open' || b?.status === 'waiting');
  cards.push({
    type: 'unresolved_information',
    title: 'Unresolved information',
    body: open.length > 0
      ? `${open.length} open/waiting blocker${open.length === 1 ? '' : 's'}; most recent: ${clip(open[0]?.data?.question ?? open[0]?.data?.type ?? open[0]?.id ?? '', 120)}`
      : 'No open information blockers.',
    evidence: open.slice(0, 5).map((b) => b.id),
  });

  const unknownActive = asCount(metrics?.time?.attemptsWithUnknownActiveTime);
  const notSubmitted = asCount(metrics?.attempts?.byStatus?.definitely_not_submitted);
  cards.push({
    type: 'operational_friction',
    title: 'Operational friction',
    body: metrics
      ? `${countLabel(notSubmitted)} attempt(s) definitely not submitted; ${countLabel(unknownActive)} attempt(s) with unknown active time (excluded, not zeroed).`
      : 'No operations metrics available yet.',
    evidence: [],
  });

  const candidates = procedures.filter((p) => p?.status === 'candidate' || p?.status === 'tested');
  cards.push({
    type: 'procedure_candidate',
    title: 'Procedure candidate',
    body: candidates.length > 0
      ? `${candidates.length} candidate/tested procedure(s) awaiting promotion; first: ${candidates[0].id}`
      : 'No candidate procedures.',
    evidence: candidates.slice(0, 5).map((p) => p.id),
  });

  const resolved = metrics?.outcomes?.resolved;
  cards.push({
    type: 'outcome_summary',
    title: 'Outcome summary',
    body: metrics?.outcomes
      ? `Resolved outcomes: ${countLabel(resolved)}; rates shown only at/above the ${SAMPLE_FLOOR}-sample floor.`
      : 'No outcome data joined yet.',
    evidence: [],
  });

  return cards;
}

/**
 * screenGeneratedCards(cards) -> {accepted, refused}. A generated card with
 * an unsupported type or any code/markup payload key is REFUSED and surfaced
 * as a proposal requiring implementation review — never rendered or executed.
 */
export function screenGeneratedCards(cards = []) {
  const accepted = [];
  const refused = [];
  for (const card of cards) {
    const type = card?.type;
    if (!SUPPORTED_CARD_TYPES.includes(type)) {
      refused.push({ card, reason: `unsupported card type "${String(type)}" — refused; shown as a proposal requiring implementation review` });
      continue;
    }
    const codeKey = CODE_PAYLOAD_KEYS.find((k) => card != null && typeof card === 'object' && k in card);
    if (codeKey) {
      refused.push({ card, reason: `card carries a code payload ("${codeKey}") — refused; code changes require an implementation-review proposal` });
      continue;
    }
    accepted.push(card);
  }
  return { accepted, refused };
}

// ---------------------------------------------------------------------------
// Rendering (textContent only).

function kv(doc, label, value) {
  return el(doc, 'div', { className: 'lrn-kv' }, [
    el(doc, 'span', { className: 'lrn-muted', text: `${label}: ` }),
    el(doc, 'span', { text: value }),
  ]);
}

export function renderIntelligenceView(doc, root, model) {
  const { rows = [], cards = [], refusedCards = [], selectedFamily = null, onSelectFamily = () => {}, feature = null } = model;
  root.replaceChildren();
  if (feature && feature.enabled === false) {
    root.append(el(doc, 'p', { className: 'lrn-muted', text: 'learning disabled — no insights derived' }));
    return;
  }

  // Fixed insight cards.
  const cardWrap = el(doc, 'div', { className: 'lrn-cards' });
  for (const card of cards) {
    cardWrap.append(el(doc, 'div', { className: 'lrn-card' }, [
      el(doc, 'h3', { text: card.title }),
      el(doc, 'p', { text: card.body }),
      card.evidence.length > 0
        ? el(doc, 'p', { className: 'lrn-muted', text: `evidence: ${card.evidence.join(', ')}` })
        : el(doc, 'p', { className: 'lrn-muted', text: 'evidence: none yet' }),
    ]));
  }
  root.append(cardWrap);
  for (const r of refusedCards) {
    root.append(el(doc, 'p', { className: 'lrn-error', text: `Refused card: ${r.reason}` }));
  }

  // Cohort controls: role family selector over persisted insights.
  const families = insightFamilies(rows);
  const bar = el(doc, 'div', { className: 'lrn-filters' });
  bar.append(el(doc, 'span', { className: 'lrn-muted', text: 'role family:' }));
  const sel = el(doc, 'select', { className: 'lrn-select' });
  const all = el(doc, 'option', { text: 'all' });
  all.value = '';
  sel.append(all);
  for (const fam of families) {
    const o = el(doc, 'option', { text: fam });
    o.value = fam;
    sel.append(o);
  }
  sel.value = selectedFamily ?? '';
  sel.addEventListener('change', () => onSelectFamily(sel.value || null));
  bar.append(sel);
  root.append(bar);

  const visible = selectedFamily ? rows.filter((r) => r.roleFamily === selectedFamily) : rows;
  if (visible.length === 0) {
    root.append(el(doc, 'p', { className: 'lrn-muted', text: 'no persisted insights yet — run learn.mjs review to derive them' }));
    return;
  }

  for (const row of visible) {
    const box = el(doc, 'div', { className: 'lrn-insight' });
    box.append(el(doc, 'h3', { text: `${row.roleFamily} (${row.status})` }));
    const filterText = Object.entries(row.filters).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    box.append(kv(doc, 'cohort filters', filterText));
    box.append(kv(doc, 'evidence window', row.window));
    box.append(kv(doc, 'distinct jobs / companies / raw rows', `${row.distinctJobs} / ${row.distinctCompanies} / ${row.rawOccurrences}`));
    if (row.smallSample) {
      box.append(el(doc, 'p', { className: 'lrn-warn', text: `Small sample (below ${SAMPLE_FLOOR} distinct jobs): counts and limitations only — no confident conclusions.` }));
    }

    if (row.capabilities.length > 0) {
      const table = el(doc, 'table', { className: 'lrn-table' });
      const hr = el(doc, 'tr');
      for (const h of ['observed capability (what employers ask)', 'distinct jobs', 'companies', 'raw rows', 'share of sampled jobs', 'origin']) hr.append(el(doc, 'th', { text: h }));
      const thead = el(doc, 'thead'); thead.append(hr); table.append(thead);
      const tbody = el(doc, 'tbody');
      for (const c of row.capabilities) {
        const tr = el(doc, 'tr');
        tr.append(el(doc, 'td', { text: c.label, title: c.sourceIds.join(', ') }));
        tr.append(el(doc, 'td', { text: c.distinctJobs }));
        tr.append(el(doc, 'td', { text: c.distinctCompanies }));
        tr.append(el(doc, 'td', { text: c.rawOccurrences }));
        tr.append(el(doc, 'td', { text: c.share }));
        tr.append(el(doc, 'td', { text: c.origin }));
        tbody.append(tr);
      }
      table.append(tbody);
      box.append(table);
    }

    const gaps = el(doc, 'div', { className: 'lrn-gaps' }, [el(doc, 'h4', { text: 'Capture gaps (what we did not see)' })]);
    for (const g of row.gaps) gaps.append(kv(doc, g.label, g.value));
    box.append(gaps);

    if (row.contradictions.length > 0) {
      const con = el(doc, 'div', { className: 'lrn-contradictions' }, [el(doc, 'h4', { text: 'Contradictory evidence' })]);
      for (const c of row.contradictions) {
        con.append(el(doc, 'p', { text: `${c.type}: ${c.detail}` }));
        if (c.sourceIds.length > 0) con.append(el(doc, 'p', { className: 'lrn-muted', text: `sources: ${c.sourceIds.join(', ')}` }));
      }
      box.append(con);
    }

    if (row.drafts.length > 0) {
      const dr = el(doc, 'div', { className: 'lrn-drafts' }, [el(doc, 'h4', { text: 'Positioning (grounded in approved evidence only)' })]);
      for (const d of row.drafts) {
        dr.append(el(doc, 'p', { text: `[${d.kind}] ${d.capability} — ${d.draft}` }));
        if (d.evidence.length > 0) dr.append(el(doc, 'p', { className: 'lrn-muted', text: `evidence: ${d.evidence.join(', ')} · public use: ${d.publicUse}` }));
      }
      box.append(dr);
    }

    if (row.sourceIds.length > 0) {
      box.append(el(doc, 'p', { className: 'lrn-muted', text: `insight sources: ${row.sourceIds.join(', ')}` }));
    }
    root.append(box);
  }
}
