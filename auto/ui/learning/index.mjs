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
import { insightRows, buildInsightCards, screenGeneratedCards, renderIntelligenceView } from './intelligence.mjs';
import { renderOperationsView } from './operations.mjs';
import { proposalRows, approvalScopeNote, renderProposalsView } from './proposals.mjs';

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
    selectedFamily: null,
    opsReadback: null,
    propReadback: null,
    data: null, // {status, questions, answers, blockers, proposals, insights, procedures, accounts, metrics}
    freshness: { mode: null, preview: null, jobs: [], error: null },
  };

  // ---- learning pane ---------------------------------------------------------

  async function loadLearning() {
    const status = await client.status({ key: 'status' });
    const [questions, answers, blockers, proposals, insights, procedures, accounts] = await Promise.all([
      client.listAll('questions', { key: 'questions' }),
      client.listAll('answers', { key: 'answers' }),
      client.listAll('blockers', { key: 'blockers' }),
      client.listAll('proposals', { key: 'proposals' }),
      client.listAll('insights', { key: 'insights' }),
      client.listAll('procedures', { key: 'procedures' }),
      client.listAll('accounts', { key: 'accounts' }),
    ]);
    // Metrics endpoint returns {metrics, feature}; null metrics stays null.
    let metrics = null;
    try { metrics = (await client.list('metrics', { key: 'metrics' }))?.metrics ?? null; } catch { metrics = null; }
    state.data = { status, questions, answers, blockers, proposals, insights, procedures, accounts, metrics };
  }

  function renderLearning() {
    if (!learningRoot) return;
    learningRoot.replaceChildren();
    const d = state.data;
    if (!d) {
      // T24: a failed FIRST load must be announced (role=alert) and leave a
      // retry control; previously it rendered as silent muted text.
      if (state.error) {
        const errEl = el(doc, 'p', { className: 'lrn-error', text: state.error, role: 'alert' });
        errEl.tabIndex = -1;
        const retry = el(doc, 'button', { className: 'lrn-btn', text: '↻', label: 'reload from server' });
        retry.addEventListener('click', () => refreshLearning());
        learningRoot.append(errEl, retry);
      } else {
        learningRoot.append(el(doc, 'p', { className: 'lrn-muted', text: 'loading…' }));
      }
      return;
    }
    const head = el(doc, 'div', { className: 'lrn-head' });
    for (const [key, label] of [
      ['questions', 'Questions'], ['knowledge', 'Candidate knowledge'],
      ['intelligence', 'Role intelligence'], ['operations', 'Operations'], ['proposals', 'Proposals'],
    ]) {
      const b = el(doc, 'button', { className: `lrn-tab${state.tab === key ? ' lrn-here' : ''}`, text: label });
      b.setAttribute('aria-pressed', String(state.tab === key));
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
    const reload = el(doc, 'button', { className: 'lrn-btn', text: '↻', label: 'reload from server' });
    reload.title = 'reload from server';
    reload.addEventListener('click', () => refreshLearning());
    head.append(reload);
    learningRoot.append(head);
    if (state.error) {
      const errEl = el(doc, 'p', { className: 'lrn-error', text: state.error, role: 'alert' });
      errEl.tabIndex = -1;
      learningRoot.append(errEl);
    }

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
        truncated: d.questions.truncated === true,
        feature,
        answerStatus: answerStatusByQuestion({ families: [], answers: d.answers.items }),
        groups: familyGroups({ families: [], questionsById, answers: d.answers.items, proposals: d.proposals.items }),
        onFilter: (filters) => { state.filters = filters; renderLearning(); },
      });
    } else if (state.tab === 'knowledge') {
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
    } else if (state.tab === 'intelligence') {
      // Fixed cards from current data, screened: unsupported/code card types
      // are refused and surfaced, never rendered.
      const { accepted, refused } = screenGeneratedCards(buildInsightCards({
        questions: d.questions.items,
        blockers: d.blockers.items,
        insights: d.insights.items,
        procedures: d.procedures.items,
        metrics: d.metrics,
      }));
      renderIntelligenceView(doc, body, {
        rows: insightRows(d.insights.items),
        cards: accepted,
        refusedCards: refused,
        selectedFamily: state.selectedFamily,
        onSelectFamily: (fam) => { state.selectedFamily = fam; renderLearning(); },
        feature,
      });
    } else if (state.tab === 'operations') {
      renderOperationsView(doc, body, {
        metrics: d.metrics,
        review: d.status?.review ?? null,
        learner: d.status?.learner ?? null,
        cloud: d.status?.cloud ?? null,
        accounts: d.accounts.items,
        procedures: d.procedures.items,
        busy: state.busy,
        readback: state.opsReadback,
        onPauseLearner: (paused) => pauseLearner(paused),
        onRunReview: () => runLocalReview(),
        onPrivacyPreview: () => privacyPreview(),
      });
    } else {
      renderProposalsView(doc, body, {
        rows: proposalRows(d.proposals.items),
        busy: state.busy,
        readback: state.propReadback,
        feature,
        onDecide: (p, decision) => decideProposal(p, decision),
      });
    }
  }

  async function refreshLearning() {
    state.error = null;
    try { await loadLearning(); } catch (err) { state.error = describeError(err); }
    renderLearning();
  }

  // T24 a11y: after a dialog-driven action re-renders the pane, move focus to
  // the outcome (error alert first, else the committed-state readback) instead
  // of letting it drop to <body>.
  function focusFeedback() {
    learningRoot?.querySelector?.('[role="alert"], [role="status"]')?.focus?.();
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
    focusFeedback();
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
    focusFeedback();
  }

  // ---- T23 operations/proposals actions ----------------------------------------
  // Every consequential POST is followed by a mandatory server re-read; the
  // readback always reflects committed state, never the request we sent.

  async function pauseLearner(paused) {
    state.busy = true;
    state.opsReadback = null;
    renderLearning();
    try {
      await client.post('learner/pause', { opId: opId(), paused });
    } catch (err) {
      state.error = describeError(err);
    }
    try {
      await loadLearning();
      const p = state.data.status?.learner?.paused;
      state.opsReadback = p === true
        ? 'Learner is PAUSED (server state). Review runs are refused; the application pipeline is unaffected.'
        : 'Learner is running (server state).';
    } catch (err) { state.error = describeError(err); }
    state.busy = false;
    renderLearning();
    focusFeedback();
  }

  async function runLocalReview() {
    const ok = globalThis.confirm?.('Run a LOCAL-ONLY review now? No cloud calls; no application cycle is started.') ?? true;
    if (!ok) return;
    state.busy = true;
    state.opsReadback = null;
    renderLearning();
    try {
      const out = await client.post('review', { opId: opId() });
      const r = out?.report ?? {};
      state.opsReadback = `Local review ${r.runId ?? 'run'} finished: ${r.processedSources ?? r.processed ?? '?'} source(s) processed.`;
    } catch (err) {
      state.error = describeError(err);
    }
    try { await loadLearning(); } catch (err) { state.error = describeError(err); }
    state.busy = false;
    renderLearning();
    focusFeedback();
  }

  async function privacyPreview() {
    const target = globalThis.prompt?.('Preview what forgetting would touch. Target (question text or answer id):', '') ?? null;
    if (!target) return;
    state.busy = true;
    state.opsReadback = null;
    renderLearning();
    try {
      const out = await client.post('privacy/preview', { opId: opId(), targets: [target] });
      state.opsReadback = `Privacy preview (nothing deleted): ${JSON.stringify({ ...out, opId: undefined, csrfToken: undefined })}`;
    } catch (err) {
      state.error = describeError(err);
    }
    state.busy = false;
    renderLearning();
    focusFeedback();
  }

  async function decideProposal(p, decision) {
    const verdict = decision === 'approve' ? 'approved' : 'rejected';
    const ok = globalThis.confirm?.(
      `Mark proposal ${p.id} as ${verdict}?\n\n${approvalScopeNote(p.kind)}`,
    ) ?? true;
    if (!ok) return;
    state.busy = true;
    state.propReadback = null;
    renderLearning();
    try {
      await client.post('proposals/decision', {
        opId: opId(), proposalId: p.id, expectedRevision: p.expectedRevision, decision: verdict,
      });
    } catch (err) {
      state.error = describeError(err);
    }
    try {
      await loadLearning();
      const after = state.data.proposals.items.find((x) => x.id === p.id) ?? null;
      state.propReadback = after
        ? `Server state: proposal ${p.id} is now "${after.status}" (revision ${after.revision}). ${approvalScopeNote(after.data?.kind)}`
        : `Server state: proposal ${p.id} no longer listed.`;
    } catch (err) { state.error = describeError(err); }
    state.busy = false;
    renderLearning();
    focusFeedback();
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
    if (f.error) queueRoot.append(el(doc, 'p', { className: 'lrn-error', text: f.error, role: 'alert' }));
    if (!f.preview) { queueRoot.append(el(doc, 'p', { className: 'lrn-muted', text: 'loading…' })); return; }

    const bar = el(doc, 'div', { className: 'lrn-filters' });
    bar.append(el(doc, 'span', { className: 'lrn-muted', text: `live order mode: ${f.preview.liveMode} (changing the preview below does NOT change the live order)` }));
    const sel = el(doc, 'select', { className: 'lrn-select', label: 'queue order preview mode' });
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
