// T23: Operations view — answer reuse vs new-question rates, active vs
// waiting time, capture failures, blockers, account verification state,
// procedure versions/scope/staleness, reviewer cursor + next due, and model
// budget with unknown costs labeled "unknown" (never zeroed). Controls: pause
// the LEARNER independently of applications, run a LOCAL-ONLY review, inspect
// cloud-disabled reasons, and preview the privacy export. No control here can
// ever start an application cycle. Pure view models exported for node:test;
// rendering is textContent only.

import { el } from './questions.mjs';
import { SAMPLE_FLOOR } from './intelligence.mjs';

function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

export function fmtMs(ms) {
  if (!finite(ms) || ms < 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

export function fmtUsd(v) {
  return finite(v) ? `$${v.toFixed(2)}` : 'unknown';
}

/** fmtRate(honestRate result) — a % only when the floor was met. */
export function fmtRate(r) {
  if (!r || typeof r !== 'object') return 'unknown';
  if (finite(r.rate)) return `${Math.round(r.rate * 100)}% (${r.numerator}/${r.denominator})`;
  if (r.reason === 'sample_below_floor') return `below ${SAMPLE_FLOOR}-sample floor (${r.numerator ?? '?'}/${r.denominator ?? '?'}) — no rate claimed`;
  return 'unknown';
}

export function dateLabel(v) {
  return typeof v === 'string' && v.length >= 10 ? v.slice(0, 16).replace('T', ' ') : 'unknown';
}

export function reuseSummary(metrics = null) {
  const reuse = metrics?.reuse ?? {};
  const by = reuse.byDisposition && typeof reuse.byDisposition === 'object' ? reuse.byDisposition : {};
  return {
    dispositions: Object.entries(by).map(([k, v]) => ({ label: k, count: finite(v) ? v : 0 })),
    distinctQuestions: finite(reuse.distinctQuestions) ? reuse.distinctQuestions : 0,
    newQuestions: finite(reuse.newQuestions) ? reuse.newQuestions : 0,
    newQuestionRate: fmtRate(reuse.newQuestionRate),
  };
}

export function timeSummary(metrics = null) {
  const t = metrics?.time ?? {};
  return {
    wait: fmtMs(t.waitMsTotal),
    activeKnown: fmtMs(t.activeMsKnownTotal),
    knownCount: finite(t.attemptsWithKnownActiveTime) ? t.attemptsWithKnownActiveTime : 0,
    unknownCount: finite(t.attemptsWithUnknownActiveTime) ? t.attemptsWithUnknownActiveTime : 0,
  };
}

export function captureSummary(metrics = null) {
  const byStatus = metrics?.attempts?.byStatus && typeof metrics.attempts.byStatus === 'object'
    ? metrics.attempts.byStatus : {};
  return {
    byStatus: Object.entries(byStatus).map(([k, v]) => ({ label: k, count: finite(v) ? v : 0 })),
    distinctApplications: finite(metrics?.attempts?.distinctApplications) ? metrics.attempts.distinctApplications : 0,
    duplicates: finite(metrics?.attempts?.duplicateAttemptApplications) ? metrics.attempts.duplicateAttemptApplications : 0,
    missingAnswerBlockers: finite(metrics?.blockers?.missingAnswerBlockers) ? metrics.blockers.missingAnswerBlockers : 0,
    repeats: Array.isArray(metrics?.blockers?.repeats) ? metrics.blockers.repeats : [],
  };
}

/** budgetSummary(metrics) — unknown costs stay labeled "unknown". */
export function budgetSummary(metrics = null) {
  const m = metrics?.modelUsage ?? {};
  const tokens = m.tokens && typeof m.tokens === 'object' ? m.tokens : null;
  return {
    runs: finite(m.runs) ? m.runs : 0,
    knownCost: finite(m.knownCostUsd) ? fmtUsd(m.knownCostUsd) : 'unknown',
    runsWithKnownCost: finite(m.runsWithKnownCost) ? m.runsWithKnownCost : 0,
    runsWithUnknownCost: finite(m.runsWithUnknownCost) ? m.runsWithUnknownCost : 0,
    reservedCeiling: finite(m.reservedEstUsdUnknownOutcome) ? fmtUsd(m.reservedEstUsdUnknownOutcome) : 'unknown',
    tokens: tokens && finite(tokens.total) ? `${tokens.total} (in ${tokens.input ?? '?'} / out ${tokens.output ?? '?'})` : 'unknown',
  };
}

export function accountRows(items = []) {
  return items.map((rec) => {
    const d = rec?.data ?? {};
    return {
      id: rec?.id ?? '?',
      status: rec?.status ?? 'unknown',
      tenant: typeof d.tenant === 'string' ? d.tenant : (typeof d.atsVendor === 'string' ? d.atsVendor : 'unknown'),
      verified: d.verifiedAt ? dateLabel(d.verifiedAt) : 'not verified',
      lastUsedAt: d.lastUsedAt ? dateLabel(d.lastUsedAt) : 'never used',
    };
  });
}

export function procedureRows(items = [], now = new Date()) {
  return items.map((rec) => {
    const d = rec?.data ?? {};
    let staleness = 'never verified';
    const lv = d.lastVerifiedAt ?? d.verifiedAt ?? null;
    if (typeof lv === 'string') {
      const t = Date.parse(lv);
      staleness = Number.isNaN(t) ? 'unknown (malformed date)' : `${Math.max(0, Math.floor((now.getTime() - t) / 86400000))}d since verified`;
    }
    const scope = [d.atsVendor, d.scope, d.companyId].filter((v) => typeof v === 'string' && v !== '').join(' / ') || 'unknown scope';
    return {
      id: rec?.id ?? '?',
      status: rec?.status ?? 'unknown',
      revision: finite(rec?.revision) ? rec.revision : null,
      scope,
      staleness,
      revoked: rec?.status === 'revoked',
    };
  });
}

export function reviewerSummary(review = null, learner = null) {
  const r = review && typeof review === 'object' ? review : {};
  return {
    enabled: r.reviewEnabled === true,
    paused: learner?.paused === true || r.paused === true,
    due: r.due === true,
    dueAt: dateLabel(r.dueAt),
    lastRunAt: dateLabel(r.lastRunAt),
    activeRunId: typeof r.activeRunId === 'string' ? r.activeRunId : null,
    cursorProcessed: finite(r.cursor?.processed) ? r.cursor.processed : 0,
    cursorUpdatedAt: dateLabel(r.cursor?.updatedAt),
    error: typeof r.error === 'string' ? r.error : null,
  };
}

export function cloudSummary(cloud = null) {
  if (!cloud || typeof cloud !== 'object') return { enabled: false, text: 'cloud lane state unknown' };
  if (cloud.enabled === true) return { enabled: true, text: 'cloud lane enabled (per-run approval still required)' };
  const reasons = {
    disabled_in_config: 'disabled in config/learning.yml (cloud.enabled: false)',
    no_budget: 'disabled: no cloud budget configured (daily_usd_cap / max_calls_per_day is 0)',
    config_error: `disabled: config error${cloud.error ? ` — ${cloud.error}` : ''}`,
  };
  return { enabled: false, text: reasons[cloud.reason] ?? `disabled: ${cloud.reason ?? 'unknown reason'}` };
}

// ---------------------------------------------------------------------------
// Rendering.

function kv(doc, label, value) {
  return el(doc, 'div', { className: 'lrn-kv' }, [
    el(doc, 'span', { className: 'lrn-muted', text: `${label}: ` }),
    el(doc, 'span', { text: value }),
  ]);
}

function section(doc, title) {
  return el(doc, 'div', { className: 'lrn-ops-section' }, [el(doc, 'h3', { text: title })]);
}

export function renderOperationsView(doc, root, model) {
  const {
    metrics = null, review = null, learner = null, cloud = null,
    accounts = [], procedures = [], busy = false, readback = null,
    onPauseLearner = () => {}, onRunReview = () => {}, onPrivacyPreview = () => {},
  } = model;
  root.replaceChildren();

  // Controls. Each is scoped and labeled: nothing here starts a cycle.
  const rs = reviewerSummary(review, learner);
  const controls = el(doc, 'div', { className: 'lrn-ops-controls' });
  const pauseBtn = el(doc, 'button', {
    className: 'lrn-btn',
    text: rs.paused ? 'Resume learner (review runs)' : 'Pause learner (review runs)',
    title: 'Pauses ONLY the learner/reviewer. The application pipeline is unaffected.',
  });
  pauseBtn.disabled = busy;
  pauseBtn.addEventListener('click', () => onPauseLearner(!rs.paused));
  controls.append(pauseBtn);
  const reviewBtn = el(doc, 'button', {
    className: 'lrn-btn',
    text: 'Run local-only review',
    title: 'Local lane only: no cloud calls, no application cycle is ever started by this button.',
  });
  reviewBtn.disabled = busy || rs.paused;
  reviewBtn.addEventListener('click', () => onRunReview());
  controls.append(reviewBtn);
  const privacyBtn = el(doc, 'button', { className: 'lrn-btn', text: 'Preview privacy/export', title: 'Read-only preview of what a forget/export would touch; applies nothing.' });
  privacyBtn.disabled = busy;
  privacyBtn.addEventListener('click', () => onPrivacyPreview());
  controls.append(privacyBtn);
  controls.append(el(doc, 'span', { className: 'lrn-muted', text: 'these controls never start an application cycle' }));
  root.append(controls);
  if (readback) {
    const rb = el(doc, 'p', { className: 'lrn-readback', text: readback, role: 'status' });
    rb.tabIndex = -1;
    root.append(rb);
  }

  // Reviewer state.
  const rev = section(doc, 'Reviewer');
  rev.append(kv(doc, 'state', rs.error ? `error: ${rs.error}` : (rs.paused ? 'PAUSED (learner pause sentinel)' : (rs.enabled ? (rs.due ? 'due' : 'up to date') : 'disabled'))));
  rev.append(kv(doc, 'next due', rs.dueAt));
  rev.append(kv(doc, 'last run', rs.lastRunAt));
  rev.append(kv(doc, 'cursor', `${rs.cursorProcessed} source(s) processed · updated ${rs.cursorUpdatedAt}`));
  if (rs.activeRunId) rev.append(kv(doc, 'active run', rs.activeRunId));
  root.append(rev);

  // Cloud lane.
  const cs = cloudSummary(cloud);
  const cl = section(doc, 'Cloud lane');
  cl.append(kv(doc, 'status', cs.text));
  root.append(cl);

  if (!metrics) {
    root.append(el(doc, 'p', { className: 'lrn-muted', text: 'no metrics available — the metrics endpoint returned nothing yet' }));
  } else {
    const ru = reuseSummary(metrics);
    const reuseBox = section(doc, 'Answer reuse vs new questions');
    for (const d of ru.dispositions) reuseBox.append(kv(doc, d.label, String(d.count)));
    reuseBox.append(kv(doc, 'distinct questions in window', String(ru.distinctQuestions)));
    reuseBox.append(kv(doc, 'new questions', String(ru.newQuestions)));
    reuseBox.append(kv(doc, 'new-question rate', ru.newQuestionRate));
    root.append(reuseBox);

    const ts = timeSummary(metrics);
    const timeBox = section(doc, 'Active vs waiting time');
    timeBox.append(kv(doc, 'waiting (total)', ts.wait));
    timeBox.append(kv(doc, `active (known, ${ts.knownCount} attempts)`, ts.activeKnown));
    timeBox.append(kv(doc, 'attempts with unknown active time', `${ts.unknownCount} (excluded, not zeroed)`));
    root.append(timeBox);

    const cap = captureSummary(metrics);
    const capBox = section(doc, 'Capture failures & blockers');
    for (const s of cap.byStatus) capBox.append(kv(doc, `attempts ${s.label}`, String(s.count)));
    capBox.append(kv(doc, 'distinct applications', String(cap.distinctApplications)));
    capBox.append(kv(doc, 'duplicate-attempt applications', String(cap.duplicates)));
    capBox.append(kv(doc, 'missing-answer blockers', String(cap.missingAnswerBlockers)));
    for (const rpt of cap.repeats.slice(0, 10)) {
      capBox.append(kv(doc, `repeated missing fact (${rpt.count}×)`, String(rpt.question ?? '?')));
    }
    root.append(capBox);

    const bu = budgetSummary(metrics);
    const budBox = section(doc, 'Model usage & budget');
    budBox.append(kv(doc, 'review runs with reservations', String(bu.runs)));
    budBox.append(kv(doc, `known cost (${bu.runsWithKnownCost} runs)`, bu.knownCost));
    budBox.append(kv(doc, 'runs with unknown cost', `${bu.runsWithUnknownCost} — cost unknown, shown as unknown`));
    budBox.append(kv(doc, 'reserved ceiling for unknown-outcome runs', bu.reservedCeiling));
    budBox.append(kv(doc, 'tokens', bu.tokens));
    root.append(budBox);
  }

  // Accounts.
  const accBox = section(doc, 'Account verification');
  if (accounts.length === 0) accBox.append(el(doc, 'p', { className: 'lrn-muted', text: 'no account records' }));
  for (const a of accountRows(accounts)) {
    accBox.append(kv(doc, `${a.id} (${a.tenant})`, `${a.status} · verified: ${a.verified} · last used: ${a.lastUsedAt}`));
  }
  root.append(accBox);

  // Procedures.
  const prBox = section(doc, 'Procedures');
  const prRows = procedureRows(procedures);
  if (prRows.length === 0) prBox.append(el(doc, 'p', { className: 'lrn-muted', text: 'no procedure records' }));
  for (const p of prRows) {
    const line = `${p.status}${p.revision != null ? ` rev ${p.revision}` : ''} · ${p.scope} · ${p.staleness}${p.revoked ? ' · REVOKED — never used' : ''}`;
    prBox.append(kv(doc, p.id, line));
  }
  root.append(prBox);
}
