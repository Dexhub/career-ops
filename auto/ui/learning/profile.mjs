// T22: Candidate Knowledge view — confirmed answers vs pending proposals
// (visibly distinct), conflicts, expiry/revocation, provenance, dependent
// applications, blockers, and the approval flow with preview + committed-state
// readback. The committed state shown after an approval ALWAYS comes from a
// re-read of the server (proposals + answers + blockers), never from an
// optimistic client-side toggle. Pure view-model functions exported for
// node:test; DOM rendering uses textContent only.

import { el } from './questions.mjs';

export const REDACTED = '[redacted-sensitive]';

// --- pure view model ---------------------------------------------------------

/** True when an answer's validity window has lapsed at `now`. */
export function isExpired(answer, now) {
  const until = answer?.data?.validUntil;
  if (!until) return false;
  return Date.parse(until) <= (now instanceof Date ? now : new Date(now)).getTime();
}

/**
 * knowledgeRows({answers, now}) -> rows[] with a display `group`:
 * confirmed | pending | conflicted | expired | revoked | stale.
 * Confirmed = status approved AND not expired. Provenance keeps the exact
 * sourceRefs (fileKey@sha256) and approvalRef so every value is traceable.
 */
export function knowledgeRows({ answers = [], now = new Date() } = {}) {
  return answers.map((a) => {
    const d = a.data ?? {};
    let group;
    if (a.status === 'revoked') group = 'revoked';
    else if (a.status === 'stale') group = 'stale';
    else if (a.status === 'conflicted') group = 'conflicted';
    else if (isExpired(a, now)) group = 'expired';
    else if (a.status === 'approved') group = 'confirmed';
    else group = 'pending';
    return {
      id: a.id,
      revision: a.revision,
      status: a.status,
      group,
      familyId: d.questionFamilyId ?? null,
      kind: d.kind ?? 'unknown',
      authority: d.authority ?? 'unknown',
      scope: d.scope ?? {},
      validFrom: d.validFrom ?? null,
      validUntil: d.validUntil ?? null,
      dependents: Array.isArray(d.dependencies) ? d.dependencies : [],
      provenance: {
        sourceRefs: Array.isArray(d.sourceRefs) ? d.sourceRefs : [],
        approvalRef: d.approvalRef ?? null,
        sourceIds: Array.isArray(a.sourceIds) ? a.sourceIds : [],
        lastValidatedAt: d.lastValidatedAt ?? null,
      },
      updatedAt: a.updatedAt ?? null,
    };
  });
}

/** Pending answer proposals (kind 'answer', status draft/proposed). */
export function pendingProposalRows(proposals = []) {
  return proposals
    .filter((p) => p.data?.kind === 'answer' && ['draft', 'proposed'].includes(p.status))
    .map((p) => ({
      id: p.id,
      revision: p.revision,
      status: p.status,
      question: p.data?.diff?.question?.normalizedText ?? '(unknown question)',
      proposedValue: p.data?.diff?.proposedValue ?? null,
      sensitive: p.data?.diff?.sensitive === true || p.data?.diff?.proposedValue === REDACTED,
      fileKey: p.data?.diff?.fileKey ?? null,
      selector: p.data?.diff?.selector ?? null,
      scope: p.data?.diff?.scope ?? {},
      affectedApplicationIds: p.data?.diff?.affectedApplicationIds ?? [],
      affectedSources: p.data?.affectedSources ?? [],
      requiredApprovals: p.data?.requiredApprovals ?? [],
    }));
}

/** Blocker rows with honest unknowns. */
export function blockerRows(blockers = []) {
  return blockers.map((b) => ({
    id: b.id,
    revision: b.revision,
    status: b.status,
    type: b.data?.type ?? 'unknown',
    question: typeof b.data?.question === 'string'
      ? b.data.question
      : b.data?.question?.normalizedText ?? b.data?.question?.originalText ?? null,
    applicationId: b.data?.applicationId ?? null,
    resumePoint: b.data?.resumePoint ?? null,
    deadline: b.data?.deadline ?? null,
    nextCheckAt: b.data?.nextCheckAt ?? null,
    resolution: b.data?.resolution ?? null,
    updatedAt: b.updatedAt ?? null,
  }));
}

/**
 * approvalPreview(proposal) -> what the user is asked to confirm BEFORE the
 * POST: exact target source, selector, expected source version(s) and the
 * dependent applications. Sensitive values stay redacted until explicitly
 * revealed by the user.
 */
export function approvalPreview(p) {
  return {
    proposalId: p.id,
    expectedRevision: p.revision,
    target: `${p.fileKey ?? 'standing'} → ${p.selector ?? '(selector unknown)'}`,
    sourceVersions: (p.affectedSources ?? []).map((s) => `${s.fileKey}@${(s.sha256 ?? '').slice(0, 12)}`),
    value: p.sensitive ? REDACTED : (p.proposedValue ?? '(empty)'),
    sensitive: p.sensitive,
    affectedApplicationIds: p.affectedApplicationIds ?? [],
    requiredApprovals: p.requiredApprovals ?? [],
  };
}

/**
 * approvalReadback({postResult, proposal, answers, blockers}) -> the committed
 * state model, built ONLY from re-read server records. `proposal` is the
 * re-fetched proposal envelope; answers/blockers are re-fetched lists. The
 * POST result contributes only opId/sourceHash for cross-checking.
 */
export function approvalReadback({ postResult = null, proposal = null, answers = [], blockers = [] } = {}) {
  const answerId = proposal ? `ans-${proposal.id}` : null;
  const committedAnswer = answers.find((a) => a.id === answerId) ?? null;
  const familyId = committedAnswer?.data?.questionFamilyId ?? proposal?.data?.diff?.questionFamilyId ?? null;
  const affected = blockerRows(blockers).filter((b) => (
    b.status !== 'resolved'
    && (b.type === 'missing_answer' || b.type === 'unknown_question')
  ));
  return {
    proposalStatus: proposal?.status ?? 'unknown',
    proposalRevision: proposal?.revision ?? null,
    answerId,
    answerStatus: committedAnswer?.status ?? 'not found on server',
    answerSourceRefs: committedAnswer?.data?.sourceRefs ?? [],
    familyId,
    sourceHash: postResult?.sourceHash ?? null,
    sourceHashConfirmed: Boolean(
      postResult?.sourceHash
      && (committedAnswer?.sourceIds ?? []).some((s) => String(s).endsWith(postResult.sourceHash)),
    ),
    openBlockers: affected,
  };
}

// --- DOM rendering ------------------------------------------------------------

function chip(doc, text) {
  return el(doc, 'span', { className: `lrn-chip lrn-chip-${text}`, text });
}

function provenanceLine(doc, prov) {
  const parts = [];
  for (const ref of prov.sourceRefs) parts.push(`${ref.fileKey}@${String(ref.sha256 ?? '').slice(0, 12)}`);
  if (prov.approvalRef) parts.push(`approval ${prov.approvalRef}`);
  if (prov.lastValidatedAt) parts.push(`validated ${prov.lastValidatedAt.slice(0, 10)}`);
  return el(doc, 'div', { className: 'lrn-muted', text: parts.join(' · ') || 'no provenance recorded' });
}

/**
 * renderKnowledgeView(doc, root, model) — model:
 * {rows, proposals, blockers, feature, busy, readback, error,
 *  onApprove(preview), onResolveBlocker(row), onReveal(proposalId), revealed:Set}
 */
export function renderKnowledgeView(doc, root, model) {
  root.replaceChildren();
  const { rows, proposals, blockers, feature } = model;

  if (feature && feature.enabled === false) {
    root.append(el(doc, 'p', {
      className: 'lrn-muted',
      text: `Learning is not activated (${feature.reason ?? 'learning_not_activated'}) — no knowledge has been recorded.`,
    }));
    return;
  }
  if (model.error) {
    const errEl = el(doc, 'p', { className: 'lrn-error', text: model.error, role: 'alert' });
    errEl.tabIndex = -1;
    root.append(errEl);
  }

  // Pending proposals FIRST and visibly distinct from confirmed knowledge.
  root.append(el(doc, 'h3', { text: `Pending approval (${proposals.length})` }));
  if (proposals.length === 0) {
    root.append(el(doc, 'p', { className: 'lrn-muted', text: 'nothing awaiting approval' }));
  }
  for (const p of proposals) {
    const card = el(doc, 'div', { className: 'lrn-card lrn-pending' });
    card.append(el(doc, 'div', { className: 'lrn-q', text: p.question }));
    const revealed = model.revealed?.has(p.id);
    const valueText = p.sensitive && !revealed ? REDACTED : String(p.proposedValue ?? '(empty)');
    const valueRow = el(doc, 'div', {}, [
      el(doc, 'span', { className: 'lrn-muted', text: 'proposed value: ' }),
      el(doc, 'span', { className: 'lrn-value', text: valueText }),
    ]);
    if (p.sensitive && !revealed) {
      const btn = el(doc, 'button', { className: 'lrn-btn', text: 'reveal', label: `reveal sensitive value (proposal ${p.id})` });
      btn.addEventListener('click', () => model.onReveal(p.id));
      valueRow.append(el(doc, 'span', { text: ' ' }), btn);
    }
    card.append(valueRow);
    const preview = approvalPreview(p);
    card.append(el(doc, 'div', { className: 'lrn-muted', text: `writes ${preview.target} (source ${preview.sourceVersions.join(', ') || 'unknown'})` }));
    if (preview.affectedApplicationIds.length > 0) {
      card.append(el(doc, 'div', { className: 'lrn-muted', text: `dependent applications: ${preview.affectedApplicationIds.join(', ')}` }));
    }
    const approve = el(doc, 'button', { className: 'lrn-btn lrn-approve', text: `Approve (rev ${p.revision})`, label: `approve proposal ${p.id} (rev ${p.revision})` });
    approve.disabled = Boolean(model.busy);
    approve.addEventListener('click', () => model.onApprove(preview));
    card.append(approve);
    root.append(card);
  }

  // Committed-state readback after an approval (server re-read, never optimistic).
  if (model.readback) {
    const rb = model.readback;
    const box = el(doc, 'div', { className: 'lrn-card lrn-readback', role: 'status' });
    box.tabIndex = -1;
    box.append(el(doc, 'h4', { text: 'Committed state (re-read from server)' }));
    box.append(el(doc, 'div', { text: `proposal: ${rb.proposalStatus} (rev ${rb.proposalRevision ?? '?'})` }));
    box.append(el(doc, 'div', { text: `answer ${rb.answerId ?? '?'}: ${rb.answerStatus}` }));
    box.append(el(doc, 'div', {
      text: `source hash ${rb.sourceHash ? rb.sourceHash.slice(0, 12) : 'unknown'} ${rb.sourceHashConfirmed ? '(confirmed on the committed answer record)' : '(not yet confirmed by re-read)'}`,
    }));
    box.append(el(doc, 'div', { text: `open answer blockers after approval: ${rb.openBlockers.length}` }));
    root.append(box);
  }

  // Confirmed vs other knowledge, visibly separated.
  const groups = [
    ['confirmed', 'Confirmed knowledge'],
    ['pending', 'Pending answers'],
    ['conflicted', 'Conflicts'],
    ['expired', 'Expired'],
    ['stale', 'Stale (superseded or invalidated)'],
    ['revoked', 'Revoked'],
  ];
  for (const [group, label] of groups) {
    const list = rows.filter((r) => r.group === group);
    if (list.length === 0 && group !== 'confirmed') continue;
    root.append(el(doc, 'h3', { text: `${label} (${list.length})` }));
    for (const r of list) {
      const card = el(doc, 'div', { className: `lrn-card lrn-${group}` });
      const head = el(doc, 'div');
      head.append(chip(doc, r.group));
      head.append(el(doc, 'span', { text: ` ${r.id} ` }));
      head.append(el(doc, 'span', { className: 'lrn-muted', text: `${r.kind} · authority ${r.authority} · family ${r.familyId ?? 'unknown'}` }));
      card.append(head);
      if (r.validUntil) card.append(el(doc, 'div', { className: 'lrn-muted', text: `valid ${r.validFrom ?? '?'} → ${r.validUntil}` }));
      if (r.dependents.length > 0) card.append(el(doc, 'div', { className: 'lrn-muted', text: `dependents: ${r.dependents.join(', ')}` }));
      card.append(provenanceLine(doc, r.provenance));
      root.append(card);
    }
    if (list.length === 0) root.append(el(doc, 'p', { className: 'lrn-muted', text: 'none' }));
  }

  // Blockers with resume visibility.
  root.append(el(doc, 'h3', { text: `Blockers (${blockers.length})` }));
  for (const b of blockers) {
    const card = el(doc, 'div', { className: `lrn-card lrn-blocker-${b.status}` });
    const head = el(doc, 'div');
    head.append(chip(doc, b.status));
    head.append(el(doc, 'span', { text: ` ${b.type} — ${b.question ?? '(no question text)'}` }));
    card.append(head);
    card.append(el(doc, 'div', {
      className: 'lrn-muted',
      text: `application ${b.applicationId ?? 'unknown'} · resume point ${b.resumePoint ?? 'unknown'}`
        + (b.deadline ? ` · deadline ${b.deadline}` : '')
        + (b.resolution?.resolvedAt ? ` · resolved ${b.resolution.resolvedAt}` : ''),
    }));
    if (b.status === 'resolved') {
      card.append(el(doc, 'div', { className: 'lrn-muted', text: 'resumed application rereads the live field before continuing (rereadRequired)' }));
    }
    if (['open', 'waiting'].includes(b.status) && model.onResolveBlocker) {
      const btn = el(doc, 'button', { className: 'lrn-btn', text: 'Resolve…', label: `resolve blocker ${b.id}` });
      btn.disabled = Boolean(model.busy);
      btn.addEventListener('click', () => model.onResolveBlocker(b));
      card.append(btn);
    }
    root.append(card);
  }
  if (blockers.length === 0) root.append(el(doc, 'p', { className: 'lrn-muted', text: 'no blockers' }));
}
