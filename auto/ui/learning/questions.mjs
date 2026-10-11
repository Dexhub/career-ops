// T22: Questions view — searchable/filterable table of observed application
// questions with occurrence history, source references, coverage and
// approved-answer status. Pure view-model functions are exported for the
// node:test suite; DOM rendering uses textContent only (no innerHTML with
// data), so page text can never inject markup.

// --- pure view model ---------------------------------------------------------

/** Honest requiredness: questions records do not carry `required` (that lives
 *  on per-occurrence observations, which the API does not list), so the value
 *  is 'unknown' unless occurrence metadata supplies it. */
export function requirednessOf(meta) {
  if (meta === true || meta?.required === true) return 'required';
  if (meta === false || meta?.required === false) return 'optional';
  return 'unknown';
}

/**
 * questionRows(items, {occurrenceMeta}) -> rows[] for rendering/filtering.
 * `occurrenceMeta` is an optional map questionId -> {required, roleFamily,
 * employerName, ...} assembled from whatever metadata is actually available
 * (e.g. blockers); absent values stay honestly 'unknown'.
 */
export function questionRows(items = [], { occurrenceMeta = new Map() } = {}) {
  return items.map((rec) => {
    const d = rec.data ?? {};
    const meta = occurrenceMeta.get(rec.id) ?? null;
    return {
      id: rec.id,
      revision: rec.revision,
      status: rec.status,
      text: d.normalizedText ?? '',
      examples: Array.isArray(d.originalExamples) ? d.originalExamples : [],
      fieldType: d.fieldType ?? 'unknown',
      locale: d.locale ?? null,
      occurrenceIds: Array.isArray(d.occurrenceIds) ? d.occurrenceIds : [],
      occurrenceCount: Array.isArray(d.occurrenceIds) ? d.occurrenceIds.length : 0,
      sourceIds: Array.isArray(rec.sourceIds) ? rec.sourceIds : [],
      required: requirednessOf(meta),
      roleFamily: meta?.roleFamily ?? null,
      company: meta?.employerName ?? null,
      createdAt: rec.createdAt ?? null,
      updatedAt: rec.updatedAt ?? null,
    };
  });
}

/** Distinct facet values for the filter dropdowns ('' = any). */
export function questionFacets(rows = []) {
  const uniq = (vals) => [...new Set(vals.filter((v) => v != null && v !== ''))].sort();
  return {
    fieldTypes: uniq(rows.map((r) => r.fieldType)),
    statuses: uniq(rows.map((r) => r.status)),
    roles: uniq(rows.map((r) => r.roleFamily)),
    companies: uniq(rows.map((r) => r.company)),
  };
}

/**
 * filterQuestions(rows, {search, fieldType, status, role, company, required,
 * dateFrom, dateTo}) -> rows[]. Search matches normalized text, original
 * wording examples and the question id, case-insensitively. Date range
 * filters on updatedAt (ISO prefix compare).
 */
export function filterQuestions(rows = [], f = {}) {
  const q = (f.search ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (q) {
      const hay = `${r.text} ${r.examples.join(' ')} ${r.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.fieldType && r.fieldType !== f.fieldType) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.required && r.required !== f.required) return false;
    if (f.role && r.roleFamily !== f.role) return false;
    if (f.company && r.company !== f.company) return false;
    if (f.dateFrom && (!r.updatedAt || r.updatedAt < f.dateFrom)) return false;
    if (f.dateTo && (!r.updatedAt || r.updatedAt.slice(0, 10) > f.dateTo)) return false;
    return true;
  });
}

/**
 * answerStatusByQuestion({families, answers}) -> Map questionId ->
 * {state:'approved'|'pending'|'conflicted'|'unresolved'|'unknown',
 *  familyId, answerIds}. Families are joined when family records are
 * available; a question with no derivable family link reports 'unknown'
 * (honest — the list API does not expose family membership).
 */
export function answerStatusByQuestion({ families = [], answers = [] } = {}) {
  const byFamily = new Map();
  for (const a of answers) {
    const fid = a.data?.questionFamilyId;
    if (!fid) continue;
    if (!byFamily.has(fid)) byFamily.set(fid, []);
    byFamily.get(fid).push(a);
  }
  const out = new Map();
  for (const fam of families) {
    if (fam.status === 'revoked') continue;
    const famAnswers = byFamily.get(fam.id) ?? [];
    let state = 'unresolved';
    if (famAnswers.some((a) => a.status === 'conflicted')) state = 'conflicted';
    else if (famAnswers.some((a) => a.status === 'approved')) state = 'approved';
    else if (famAnswers.some((a) => a.status === 'proposed')) state = 'pending';
    for (const qid of fam.data?.questionIds ?? []) {
      out.set(qid, { state, familyId: fam.id, answerIds: famAnswers.map((a) => a.id) });
    }
  }
  return out;
}

/**
 * familyGroups({families, questionsById, answers, proposals}) -> groups[] for
 * the family inspector: members with their wording, the grouping evidence
 * (sourceIds), and any pending regrouping proposals that reference the
 * family. Corrections happen ONLY through the explicit review flow
 * (reviewer-created proposals decided via POST /proposals/decision) — the
 * client never regroups directly.
 */
export function familyGroups({ families = [], questionsById = new Map(), answers = [], proposals = [] } = {}) {
  const answersByFamily = new Map();
  for (const a of answers) {
    const fid = a.data?.questionFamilyId;
    if (!fid) continue;
    if (!answersByFamily.has(fid)) answersByFamily.set(fid, []);
    answersByFamily.get(fid).push(a);
  }
  return families
    .filter((f) => f.status !== 'revoked')
    .map((f) => ({
      id: f.id,
      label: f.data?.label ?? f.id,
      status: f.status,
      revision: f.revision,
      scope: f.data?.scope ?? {},
      evidence: Array.isArray(f.sourceIds) ? f.sourceIds : [],
      members: (f.data?.questionIds ?? []).map((qid) => ({
        id: qid,
        text: questionsById.get(qid)?.data?.normalizedText ?? '(not in current page)',
      })),
      answers: (answersByFamily.get(f.id) ?? []).map((a) => ({ id: a.id, status: a.status })),
      pendingProposals: proposals.filter((p) => (
        ['draft', 'proposed'].includes(p.status)
        && ((p.data?.evidenceIds ?? []).includes(f.id)
          || (p.data?.affectedSources ?? []).some((s) => String(s).includes(f.id)))
      )).map((p) => ({ id: p.id, revision: p.revision, kind: p.data?.kind ?? 'unknown' })),
    }));
}

// --- DOM rendering (textContent only) ----------------------------------------

export function el(doc, tag, { className, text, title } = {}, children = []) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  if (title) node.title = title;
  for (const c of children) node.append(c);
  return node;
}

function statusChip(doc, state) {
  return el(doc, 'span', { className: `lrn-chip lrn-chip-${state}`, text: state });
}

/**
 * renderQuestionsView(doc, root, model) — model is
 * {rows, facets, filters, answerStatus, groups, coverage, feature, onFilter}.
 */
export function renderQuestionsView(doc, root, model) {
  root.replaceChildren();
  const { rows, facets, filters, answerStatus, groups, coverage, feature } = model;

  if (feature && feature.enabled === false) {
    root.append(el(doc, 'p', {
      className: 'lrn-muted',
      text: `Learning is not activated (${feature.reason ?? 'learning_not_activated'}) — nothing has been recorded.`,
    }));
    return;
  }

  // Filter bar.
  const bar = el(doc, 'div', { className: 'lrn-filters' });
  const search = el(doc, 'input', { className: 'lrn-search' });
  search.type = 'search';
  search.placeholder = 'search question wording / id…';
  search.value = filters.search ?? '';
  search.addEventListener('input', () => model.onFilter({ ...filters, search: search.value }));
  bar.append(search);
  const selects = [
    ['fieldType', 'any type', facets.fieldTypes],
    ['status', 'any status', facets.statuses],
    ['required', 'any requiredness', ['required', 'optional', 'unknown']],
    ['role', 'any role', facets.roles],
    ['company', 'any company', facets.companies],
  ];
  for (const [key, label, options] of selects) {
    const sel = el(doc, 'select', { className: 'lrn-select' });
    sel.append(el(doc, 'option', { text: label }));
    sel.options[0].value = '';
    for (const opt of options) {
      const o = el(doc, 'option', { text: opt });
      o.value = opt;
      sel.append(o);
    }
    sel.value = filters[key] ?? '';
    sel.addEventListener('change', () => model.onFilter({ ...filters, [key]: sel.value }));
    bar.append(sel);
  }
  for (const [key, label] of [['dateFrom', 'from'], ['dateTo', 'to']]) {
    const inp = el(doc, 'input', { className: 'lrn-date', title: `updated ${label}` });
    inp.type = 'date';
    inp.value = filters[key] ?? '';
    inp.addEventListener('change', () => model.onFilter({ ...filters, [key]: inp.value }));
    bar.append(inp);
  }
  root.append(bar);

  if (coverage) {
    root.append(el(doc, 'p', {
      className: 'lrn-muted',
      text: `coverage: ${coverage.observed} observed · ${coverage.partial} partial · ${coverage.unknown} unknown`,
    }));
  }

  // Questions table.
  const table = el(doc, 'table', { className: 'lrn-table' });
  const thead = el(doc, 'thead');
  const hr = el(doc, 'tr');
  for (const h of ['question', 'type', 'required', 'seen', 'status', 'answer', 'sources', 'updated']) {
    hr.append(el(doc, 'th', { text: h }));
  }
  thead.append(hr);
  table.append(thead);
  const tbody = el(doc, 'tbody');
  for (const r of rows) {
    const tr = el(doc, 'tr');
    const qCell = el(doc, 'td', { className: 'lrn-qcell' });
    qCell.append(el(doc, 'div', { text: r.text, title: r.id }));
    if (r.examples.length > 0) {
      const det = el(doc, 'details');
      det.append(el(doc, 'summary', { className: 'lrn-muted', text: `original wording (${r.examples.length})` }));
      for (const ex of r.examples) det.append(el(doc, 'div', { className: 'lrn-example', text: ex }));
      qCell.append(det);
    }
    tr.append(qCell);
    tr.append(el(doc, 'td', { text: r.fieldType }));
    tr.append(el(doc, 'td', { text: r.required }));
    const seen = el(doc, 'td', { title: r.occurrenceIds.join('\n') });
    seen.textContent = `${r.occurrenceCount}×`;
    tr.append(seen);
    const st = el(doc, 'td');
    st.append(statusChip(doc, r.status));
    tr.append(st);
    const ans = answerStatus.get(r.id) ?? { state: 'unknown' };
    const ansCell = el(doc, 'td', { title: ans.familyId ? `family ${ans.familyId}` : 'family link not exposed by the list API' });
    ansCell.append(statusChip(doc, ans.state));
    tr.append(ansCell);
    tr.append(el(doc, 'td', { className: 'lrn-muted', text: r.sourceIds.join(', ') || '—', title: 'source record ids' }));
    tr.append(el(doc, 'td', { className: 'lrn-muted', text: (r.updatedAt ?? '').slice(0, 10) || '—' }));
    tbody.append(tr);
  }
  if (rows.length === 0) {
    const tr = el(doc, 'tr');
    tr.append(el(doc, 'td', { className: 'lrn-muted', text: 'no questions match' }));
    tbody.append(tr);
  }
  table.append(tbody);
  root.append(table);

  // Family grouping inspector + explicit review flow.
  const famHead = el(doc, 'h3', { text: 'Question families' });
  root.append(famHead);
  if (groups.length === 0) {
    root.append(el(doc, 'p', {
      className: 'lrn-muted',
      text: 'No family records available here. Grouping corrections go through the reviewer (learn.mjs review) and appear below as proposals to approve or reject — the UI never regroups directly.',
    }));
  }
  for (const g of groups) {
    const det = el(doc, 'details', { className: 'lrn-family' });
    const sum = el(doc, 'summary');
    sum.append(el(doc, 'span', { text: `${g.label} ` }));
    sum.append(statusChip(doc, g.status));
    sum.append(el(doc, 'span', { className: 'lrn-muted', text: ` ${g.members.length} member(s)` }));
    det.append(sum);
    for (const m of g.members) det.append(el(doc, 'div', { className: 'lrn-example', text: `${m.id}: ${m.text}` }));
    det.append(el(doc, 'div', { className: 'lrn-muted', text: `evidence: ${g.evidence.join(', ') || '(none recorded)'}` }));
    if (g.pendingProposals.length > 0) {
      for (const p of g.pendingProposals) {
        const row = el(doc, 'div', { className: 'lrn-proposal-row', text: `pending ${p.kind} proposal ${p.id} — decide in the proposals flow` });
        det.append(row);
      }
    } else {
      det.append(el(doc, 'div', {
        className: 'lrn-muted',
        text: 'Grouping wrong? Run the reviewer (learn.mjs review) to generate a correction proposal — corrections are reviewed, never applied directly from this page.',
      }));
    }
    root.append(det);
  }
}
