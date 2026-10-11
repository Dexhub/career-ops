// T23: Proposals view — every improvement proposal shows WHY it is suggested,
// the affected source/component, evidence, baseline, evaluation cases and
// results, risk, approval requirement, previous version and rollback status.
// Approval SCOPE is spelled out per kind: approving an answer is NOT
// permission to modify code, and nothing here publishes LinkedIn or external
// content — publishing needs its own explicit permission. Pure view models
// exported for node:test; rendering is textContent only.

import { el } from './questions.mjs';
import { clip } from './intelligence.mjs';

export function sourceLabel(s) {
  if (!s || typeof s !== 'object') return 'unknown source';
  const key = typeof s.fileKey === 'string' ? s.fileKey : (typeof s.component === 'string' ? s.component : 'unknown');
  const sha = typeof s.sha256 === 'string' ? `@${s.sha256.slice(0, 12)}` : '';
  const sel = typeof s.selector === 'string' ? ` ${s.selector}` : '';
  return `${key}${sha}${sel}`;
}

/** approvalScopeNote(kind) — what approving does and, loudly, does NOT do. */
export function approvalScopeNote(kind) {
  switch (kind) {
    case 'answer_update':
    case 'answer':
      return 'Approving records a decision on this ANSWER only. It is not permission to modify code, procedures, or publish anything.';
    case 'code':
    case 'ui':
    case 'component':
      return 'Approving records a review DECISION only — it does not grant permission to modify code. Any diff shown is a proposal and is never executed from this panel.';
    case 'positioning':
    case 'content':
      return 'Approving does NOT publish anything. Publishing LinkedIn or any external content requires its own explicit permission.';
    case 'procedure':
      return 'Approving records a decision; promoting a procedure to active still goes through the separate promotion approval.';
    default:
      return 'Approving records a decision on this proposal only; it grants no further permission (no code changes, no publishing).';
  }
}

export function evaluationSummary(ev) {
  if (ev == null) return { label: 'pending — not yet evaluated', cases: [] };
  if (typeof ev !== 'object') return { label: 'unknown (malformed evaluation result)', cases: [] };
  const cases = Array.isArray(ev.cases)
    ? ev.cases.map((c) => ({ name: clip(c?.name ?? c?.id ?? 'case', 120), result: String(c?.result ?? c?.outcome ?? 'unknown') }))
    : [];
  const pass = typeof ev.pass === 'boolean' ? (ev.pass ? 'passed' : 'FAILED') : null;
  const parts = [];
  if (pass) parts.push(pass);
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'cases' || k === 'pass') continue;
    if (['string', 'number', 'boolean'].includes(typeof v)) parts.push(`${k}: ${v}`);
  }
  return { label: parts.join(' · ') || (cases.length > 0 ? `${cases.length} case(s)` : 'recorded (no summary fields)'), cases };
}

export function rollbackLabel(rec) {
  const d = rec?.data ?? {};
  if (rec?.status === 'rolled_back') return `ROLLED BACK${d.rollbackVersion != null ? ` to version ${d.rollbackVersion}` : ''}`;
  if (d.rollbackVersion != null) return `rollback target recorded: version ${d.rollbackVersion}`;
  return 'no rollback recorded';
}

export function proposalRows(items = []) {
  return items.map((rec) => {
    const d = rec?.data ?? {};
    const ev = evaluationSummary(d.evaluationResult);
    const revision = Number.isInteger(rec?.revision) ? rec.revision : null;
    return {
      id: rec?.id ?? '?',
      status: rec?.status ?? 'unknown',
      revision,
      previousRevision: revision != null && revision > 1 ? revision - 1 : null,
      kind: typeof d.kind === 'string' ? d.kind : 'unknown',
      why: typeof d.intendedBenefit === 'string' && d.intendedBenefit !== '' ? clip(d.intendedBenefit, 300) : 'not recorded',
      affected: Array.isArray(d.affectedSources) && d.affectedSources.length > 0
        ? d.affectedSources.map(sourceLabel) : ['unknown source/component'],
      evidence: Array.isArray(d.evidenceIds) ? d.evidenceIds.slice(0, 20) : [],
      baseline: d.baseline == null ? 'no baseline recorded' : clip(typeof d.baseline === 'string' ? d.baseline : JSON.stringify(d.baseline), 240),
      evaluation: ev,
      risk: typeof d.risk === 'string' ? d.risk : 'unknown',
      approvals: Array.isArray(d.requiredApprovals) && d.requiredApprovals.length > 0 ? d.requiredApprovals : ['user'],
      rollback: rollbackLabel(rec),
      hasDiff: d.diff != null,
      scopeNote: approvalScopeNote(d.kind),
      decidable: rec?.status === 'proposed',
      expectedRevision: revision,
    };
  });
}

// ---------------------------------------------------------------------------
// Rendering.

function kv(doc, label, value) {
  return el(doc, 'div', { className: 'lrn-kv' }, [
    el(doc, 'span', { className: 'lrn-muted', text: `${label}: ` }),
    el(doc, 'span', { text: value }),
  ]);
}

export function renderProposalsView(doc, root, model) {
  const { rows = [], busy = false, readback = null, feature = null, onDecide = () => {} } = model;
  root.replaceChildren();
  if (feature && feature.enabled === false) {
    root.append(el(doc, 'p', { className: 'lrn-muted', text: 'learning disabled — no proposals' }));
    return;
  }
  if (readback) root.append(el(doc, 'p', { className: 'lrn-readback', text: readback }));
  if (rows.length === 0) {
    root.append(el(doc, 'p', { className: 'lrn-muted', text: 'no proposals' }));
    return;
  }
  for (const p of rows) {
    const box = el(doc, 'div', { className: 'lrn-proposal' });
    box.append(el(doc, 'h3', { text: `${p.id} — ${p.kind} (${p.status})` }));
    box.append(kv(doc, 'why suggested', p.why));
    box.append(kv(doc, 'affects', p.affected.join(', ')));
    box.append(kv(doc, 'evidence', p.evidence.length > 0 ? p.evidence.join(', ') : 'none recorded'));
    box.append(kv(doc, 'baseline', p.baseline));
    box.append(kv(doc, 'evaluation', p.evaluation.label));
    for (const c of p.evaluation.cases) box.append(kv(doc, `  case ${c.name}`, c.result));
    box.append(kv(doc, 'risk', p.risk));
    box.append(kv(doc, 'requires approval from', p.approvals.join(', ')));
    box.append(kv(doc, 'version', `revision ${p.revision ?? '?'}${p.previousRevision != null ? ` (previous: ${p.previousRevision})` : ' (first version)'}`));
    box.append(kv(doc, 'rollback', p.rollback));
    if (p.hasDiff) box.append(el(doc, 'p', { className: 'lrn-muted', text: 'a diff is attached — it is a proposal, never executed from this panel' }));
    box.append(el(doc, 'p', { className: 'lrn-scope', text: p.scopeNote }));
    if (p.decidable) {
      const bar = el(doc, 'div', { className: 'lrn-ops-controls' });
      for (const decision of ['approve', 'reject']) {
        const b = el(doc, 'button', { className: 'lrn-btn', text: decision });
        b.disabled = busy;
        b.addEventListener('click', () => onDecide(p, decision));
        bar.append(b);
      }
      box.append(bar);
    }
    root.append(box);
  }
}
