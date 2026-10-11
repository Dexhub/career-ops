// T22: learning UI entry — mounts the Questions and Candidate Knowledge views
// into Mission Control's #pane-learning and the queue freshness extension into
// #pane-queue. Self-mounting: panel.html only adds the nav button, the pane,
// the queue mount div and this module script. All rendering is textContent
// based; the live queue order is NEVER changed from here (ordering preview is
// read-only via GET /api/auto/queue-preview).

import { createLearningClient, LearningClientError } from './client.mjs';
import {
  questionRows, questionFacets, filterQuestions, answerStatusByQuestion,
  familyGroups, renderQuestionsView, el,
} from './questions.mjs';
import {
  knowledgeRows, pendingProposalRows, blockerRows, approvalReadback,
  renderKnowledgeView,
} from './profile.mjs';

const ASSET_BASE = '/auto/assets/learning/';

function opId() {
  return (globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function describeError(err) {
  if (!(err instanceof LearningClientError)) return String(err?.message ?? err);
  if (err.kind === 'unknown_result') {
    return 'The request failed mid-flight — it MAY have executed. Showing re-read server state; nothing was retried automatically.';
  }
  if (err.kind === 'stale') return 'Records changed while loading — refresh to retry.';
  return `${err.kind}: ${err.message}`;
}

export function mountLearningUI({ doc = globalThis.document, client = createLearningClient() } = {}) {
  const learningRoot = doc.getElementById('learning-root');
  const queueRoot = doc.getElementById('queue-freshness-root');
  if (!learningRoot && !queueRoot) return null;

  // Stylesheet (kept out of panel.html to keep its diff minimal).
  if (!doc.getElementById('learning-css')) {
    const link = doc.createElement('link');
    link.id = 'learning-css';
    link.rel = 'stylesheet';
    link.href = `${ASSET_BASE}learning.css`;
    doc.head.append(link);
  }

  const state = {
    tab: 'questions',
    filters: {},
    revealed: new Set(),
    busy: false,
    readback: null,
    error: null,
    data: null, // {status, questions, answers, blockers, proposals}
    freshness: { mode: null, preview: null, jobs: [], error: null },
  };

  // ---- learning pane ---------------------------------------------------------

  async function loadLearning() {
    const status = await client.status({ key: 'status' });
    const [questions, answers, blockers, proposals] = await Promise.all([
      client.listAll('questions', { key: 'questions' }),
      client.listAll('answers', { key: 'answers' }),
      client.listAll('blockers', { key: 'blockers' }),
      client.listAll('proposals', { key: 'proposals' }),
    ]);
    state.data = { status, questions, answers, blockers, proposals };
  }

  function renderLearning() {
    if (!learningRoot) return;
    learningRoot.replaceChildren();
    const d = state.data;
    if (!d) {
      learningRoot.append(el(doc, 'p', { className: 'lrn-muted', text: state.error ?? 'loading…' }));
      return;
    }
    const head = el(doc, 'div', { className: 'lrn-head' });
    for (const [key, label] of [['questions', 'Questions'], ['knowledge', 'Candidate knowledge']]) {
      const b = el(doc, 'button', { className: `lrn-tab${state.tab === key ? ' lrn-here' : ''}`, text: label });
      b.addEventListener('click', () => { state.tab = key; renderLearning(); });
      head.append(b);
    }
    const review = d.status?.review;
    head.append(el(doc, 'span', {
      className: 'lrn-muted',
      text: d.status?.feature?.enabled === false
        ? 'learning disabled'
        : (review?.due ? 'review due — run learn.mjs review' : 'review up to date'),
    }));
    const reload = el(doc, 'button', { className: 'lrn-btn', text: '↻' });
    reload.title = 'reload from server';
    reload.addEventListener('click', () => refreshLearning());
    head.append(reload);
    learningRoot.append(head);
    if (state.error) learningRoot.append(el(doc, 'p', { className: 'lrn-error', text: state.error }));

    const body = el(doc, 'div');
    learningRoot.append(body);
    const feature = d.questions?.feature ?? d.status?.feature ?? null;

    if (state.tab === 'questions') {
      const rows = questionRows(d.questions.items);
      const facets = questionFacets(rows);
      const filtered = filterQuestions(rows, state.filters);
      const questionsById = new Map(d.questions.items.map((q) => [q.id, q]));
      renderQuestionsView(doc, body, {
        rows: filtered,
        facets,
        filters: state.filters,
        coverage: d.questions.coverage,
        feature,
        answerStatus: answerStatusByQuestion({ families: [], answers: d.answers.items }),
        groups: familyGroups({ families: [], questionsById, answers: d.answers.items, proposals: d.proposals.items }),
        onFilter: (filters) => { state.filters = filters; renderLearning(); },
      });
    } else {
      renderKnowledgeView(doc, body, {
        rows: knowledgeRows({ answers: d.answers.items }),
        proposals: pendingProposalRows(d.proposals.items),
        blockers: blockerRows(d.blockers.items),
        feature,
        busy: state.busy,
        readback: state.readback,
        error: null,
        revealed: state.revealed,
        onReveal: (id) => { state.revealed.add(id); renderLearning(); },
        onApprove: (preview) => approve(preview),
        onResolveBlocker: (b) => resolveBlocker(b),
      });
    }
  }

  async function refreshLearning() {
    state.error = null;
    try { await loadLearning(); } catch (err) { state.error = describeError(err); }
    renderLearning();
  }

  async function approve(preview) {
    const ok = globalThis.confirm?.(
      `Approve this answer?\n\n${preview.target}\nvalue: ${preview.value}\nsource ${preview.sourceVersions.join(', ')}\naffects: ${preview.affectedApplicationIds.join(', ') || '(no recorded applications)'}`,
    ) ?? true;
    if (!ok) return;
    state.busy = true;
    renderLearning();
    let postResult = null;
    try {
      postResult = await client.post('answers/approve', {
        opId: opId(), proposalId: preview.proposalId, expectedRevision: preview.expectedRevision,
      });
    } catch (err) {
      state.error = describeError(err);
      // unknown_result or conflict: fall through to the mandatory re-read.
    }
    // Committed-state readback: ALWAYS from a server re-read.
    try {
      await loadLearning();
      const proposal = state.data.proposals.items.find((p) => p.id === preview.proposalId) ?? null;
      state.readback = approvalReadback({
        postResult, proposal,
        answers: state.data.answers.items,
        blockers: state.data.blockers.items,
      });
    } catch (err) {
      state.error = describeError(err);
    }
    state.busy = false;
    renderLearning();
  }

  async function resolveBlocker(b) {
    let payload = { opId: opId(), blockerId: b.id };
    if (b.type === 'missing_answer' || b.type === 'unknown_question') {
      const answerId = globalThis.prompt?.('Resolve with APPROVED answer id (ans-…):', '') ?? null;
      if (!answerId) return;
      payload = { ...payload, resolution: { answerId } };
    } else {
      const ok = globalThis.confirm?.(`Confirm ${b.type} is handled? This resumes application ${b.applicationId ?? '?'} at ${b.resumePoint ?? 'its resume point'}.`) ?? true;
      if (!ok) return;
      payload = { ...payload, confirm: true };
    }
    state.busy = true;
    renderLearning();
    try {
      await client.post('blockers/resolve', payload);
    } catch (err) {
      state.error = describeError(err);
    }
    await refreshLearning(); // committed state from re-read
    state.busy = false;
    renderLearning();
  }

  // ---- queue freshness extension ---------------------------------------------

  function dateLabel(value, precision) {
    if (!value) return 'unknown';
    const day = value.slice(0, 10);
    return precision === 'timestamp' ? value.slice(0, 16).replace('T', ' ') : day;
  }

  function rankWhy(item, mode) {
    const posted = dateLabel(item.dates?.postedAt, item.dates?.postedPrecision);
    const base = `priority ${item.priority}`;
    if (mode === 'existing') return `${base} · score ${item.score ?? 0} · last transition ${item.lastTransition ? item.lastTransition.slice(0, 10) : 'unknown'}`;
    if (mode === 'fit_then_freshness') return `${base} · score ${item.score ?? 0} · posted ${posted} · first seen ${item.firstSeen ? item.firstSeen.slice(0, 10) : 'unknown'} · ${item.urlKey}`;
    return `${base} · bucket ${item.bucket} · score ${item.score ?? 0} · posted ${posted} · first seen ${item.firstSeen ? item.firstSeen.slice(0, 10) : 'unknown'} · ${item.urlKey}`;
  }

  async function refreshFreshness() {
    if (!queueRoot) return;
    try {
      const jobsPayload = await client.panelGet('jobs', { key: 'fresh-jobs' });
      const mode = state.freshness.mode;
      const preview = await client.panelGet(`queue-preview${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`, { key: 'fresh-preview' });
      state.freshness = { ...state.freshness, jobs: jobsPayload.jobs ?? [], preview, mode: mode ?? preview.liveMode, error: null };
    } catch (err) {
      state.freshness.error = describeError(err);
    }
    renderFreshness();
  }

  function renderFreshness() {
    if (!queueRoot) return;
    queueRoot.replaceChildren();
    const f = state.freshness;
    queueRoot.append(el(doc, 'h2', { text: 'Freshness' }, [
      el(doc, 'span', { className: 'note', text: ' — verified posting dates; unknown stays unknown, never guessed' }),
    ]));
    if (f.error) queueRoot.append(el(doc, 'p', { className: 'lrn-error', text: f.error }));
    if (!f.preview) { queueRoot.append(el(doc, 'p', { className: 'lrn-muted', text: 'loading…' })); return; }

    const bar = el(doc, 'div', { className: 'lrn-filters' });
    bar.append(el(doc, 'span', { className: 'lrn-muted', text: `live order mode: ${f.preview.liveMode} (changing the preview below does NOT change the live order)` }));
    const sel = el(doc, 'select', { className: 'lrn-select' });
    for (const m of f.preview.modes) {
      const o = el(doc, 'option', { text: m });
      o.value = m;
      sel.append(o);
    }
    sel.value = f.preview.mode;
    sel.addEventListener('change', () => { state.freshness.mode = sel.value; refreshFreshness(); });
    bar.append(sel);
    queueRoot.append(bar);

    const table = el(doc, 'table', { className: 'lrn-table' });
    const hr = el(doc, 'tr');
    for (const h of ['#', 'company / role', 'posted', 'first seen', 'last checked', 'bucket', 'why this rank']) hr.append(el(doc, 'th', { text: h }));
    const thead = el(doc, 'thead');
    thead.append(hr);
    table.append(thead);
    const tbody = el(doc, 'tbody');
    for (const item of f.preview.items) {
      const tr = el(doc, 'tr');
      tr.append(el(doc, 'td', { text: item.rank }));
      tr.append(el(doc, 'td', { text: `${item.company ?? '?'} — ${item.role ?? '?'}` }));
      tr.append(el(doc, 'td', { text: `${dateLabel(item.dates?.postedAt, item.dates?.postedPrecision)}${item.dates?.postedSource ? ` (${item.dates.postedSource})` : ''}` }));
      tr.append(el(doc, 'td', { text: item.firstSeen ? item.firstSeen.slice(0, 10) : 'unknown' }));
      tr.append(el(doc, 'td', { text: item.dates?.lastCheckedAt ? item.dates.lastCheckedAt.slice(0, 10) : 'unknown' }));
      tr.append(el(doc, 'td', { text: item.bucket }));
      tr.append(el(doc, 'td', { className: 'lrn-muted', text: rankWhy(item, f.preview.mode) }));
      tbody.append(tr);
    }
    if (f.preview.items.length === 0) {
      const tr = el(doc, 'tr');
      tr.append(el(doc, 'td', { className: 'lrn-muted', text: 'no pickable jobs' }));
      tbody.append(tr);
    }
    table.append(tbody);
    queueRoot.append(table);
  }

  // ---- tab wiring (panel.html's setTab toggles pane visibility; we lazily
  // load data the first time each pane is shown) --------------------------------

  let learningLoaded = false;
  let freshnessLoaded = false;
  function onTabShown(tab) {
    if (tab === 'learning' && !learningLoaded) { learningLoaded = true; refreshLearning(); }
    if (tab === 'queue' && !freshnessLoaded) { freshnessLoaded = true; refreshFreshness(); }
  }
  doc.getElementById('tabs')?.addEventListener('click', (e) => {
    const t = e.target?.closest?.('[data-tab]')?.dataset?.tab;
    if (t) onTabShown(t);
  });
  globalThis.addEventListener?.('hashchange', () => onTabShown(globalThis.location.hash.slice(1)));
  const initial = globalThis.location?.hash?.slice(1);
  if (initial) onTabShown(initial);

  renderLearning();
  renderFreshness();
  return { refreshLearning, refreshFreshness, state };
}

if (globalThis.document?.getElementById?.('learning-root') || globalThis.document?.getElementById?.('queue-freshness-root')) {
  mountLearningUI({});
}
