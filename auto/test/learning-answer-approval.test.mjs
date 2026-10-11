// auto/test/learning-answer-approval.test.mjs — T08: durable proposal and
// approval. Every source/value is a synthetic fixture copy; the real
// config/standing-answers.yml is never read or written here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import { createLearningContext } from '../learning/context.mjs';
import { commitRecord, getRecord } from '../learning/store.mjs';
import {
  approvalIntentPath, approveAnswer, createUserApproval, hashFileHex,
  listAnswerProposals, previewAnswerSourcePatch, proposeAnswer,
  reconcileApprovals, standingSourcePath,
} from '../learning/answers.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const hashFile = hashFileHex;

// Synthetic standing-answers fixture: comments and ordering must survive.
const BASE_STANDING = `# synthetic standing-answers fixture (T08) — top comment must survive
# second unrelated comment line
filled_in_by_user: true

salary:
  # inline section comment stays put
  expectation_single_number_usd: 123456

availability:
  notice_period: "Three synthetic weeks"

custom:
  "existing synthetic question?": "Existing synthetic answer"
  # trailing comment inside the custom block

# tail comment after the custom block
tail_marker: true
`;

let fixture;
let ctx;
let standingPath;

before(() => {
  fixture = createLearningFixture();
  ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  standingPath = standingSourcePath(ctx);
  writeFileSync(standingPath, BASE_STANDING);
});
after(() => fixture.cleanup());

function resetStanding() {
  writeFileSync(standingPath, BASE_STANDING);
}

function mkProposal(overrides = {}) {
  return proposeAnswer(ctx, {
    question: { normalizedText: 'do you require synthetic sponsorship?', originalText: 'Do you require synthetic sponsorship?', fieldType: 'text' },
    fileKey: 'standing',
    selector: 'custom.do you require synthetic sponsorship?',
    proposedValue: 'No — synthetic fixture answer',
    sourceHash: hashFile(standingPath),
    affectedApplicationIds: ['app-fixture-001'],
    scope: { locale: 'en' },
    ...overrides,
  });
}

test('fixture isolation: everything happens under the scratch root, never the live checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep));
  assert.ok(!fixture.dataRoot.startsWith(repoRoot));
  assert.ok(standingPath.startsWith(fixture.dataRoot + sep), 'standing path is the fixture copy');
});

test('proposeAnswer stores the proposal without changing any candidate source', async () => {
  resetStanding();
  const beforeHash = hashFile(standingPath);
  const proposal = await mkProposal();
  assert.equal(hashFile(standingPath), beforeHash, 'source untouched by proposal');
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.revision, 1);
  const d = proposal.data;
  assert.equal(d.kind, 'answer');
  assert.deepEqual(d.affectedSources, [{ fileKey: 'standing', selector: 'custom.do you require synthetic sponsorship?', sha256: beforeHash }]);
  assert.equal(d.diff.question.normalizedText, 'do you require synthetic sponsorship?');
  assert.deepEqual(d.diff.affectedApplicationIds, ['app-fixture-001']);
  assert.deepEqual(d.diff.scope, { locale: 'en' });
});

test('sensitive proposed values are hidden from the default list, shown only on explicit opt-in', async () => {
  resetStanding();
  const proposal = await mkProposal({
    selector: 'custom.synthetic compensation detail?',
    question: { normalizedText: 'synthetic compensation detail?' },
    proposedValue: 'synthetic-sensitive-value-77',
    sensitive: true,
  });
  const listed = listAnswerProposals(ctx).find((p) => p.id === proposal.id);
  assert.equal(listed.data.diff.proposedValue, '[redacted-sensitive]');
  assert.equal(JSON.stringify(listAnswerProposals(ctx)).includes('synthetic-sensitive-value-77'), false);
  const opted = listAnswerProposals(ctx, { includeSensitiveValues: true }).find((p) => p.id === proposal.id);
  assert.equal(opted.data.diff.proposedValue, 'synthetic-sensitive-value-77');
  // The stored record keeps the real value; redaction is a list-view property.
  assert.equal(getRecord(ctx, 'proposals', proposal.id).data.diff.proposedValue, 'synthetic-sensitive-value-77');
});

test('source-patch preview preserves unrelated YAML/comments and changes only the approved custom path', async () => {
  resetStanding();
  const proposal = await mkProposal();
  const preview = previewAnswerSourcePatch(ctx, proposal);
  assert.equal(preview.beforeHash, hashFile(standingPath));
  assert.notEqual(preview.afterHash, preview.beforeHash);
  for (const comment of [
    '# synthetic standing-answers fixture (T08) — top comment must survive',
    '# inline section comment stays put',
    '# trailing comment inside the custom block',
    '# tail comment after the custom block',
  ]) {
    assert.ok(preview.afterText.includes(comment), `preserved: ${comment}`);
  }
  // Explicitly quoted key and scalar under standing custom.
  assert.ok(preview.afterText.includes('  "do you require synthetic sponsorship?": "No — synthetic fixture answer"'));
  assert.equal(preview.afterText.split('\n').length, BASE_STANDING.split('\n').length + 1, 'exactly one line added');
  // Nothing written by the preview.
  assert.equal(hashFile(standingPath), preview.beforeHash);
  // Array values render as a quoted flow array.
  const arrProposal = await mkProposal({
    selector: 'custom.synthetic multi?',
    question: { normalizedText: 'synthetic multi?' },
    proposedValue: ['alpha', 'beta'],
  });
  assert.ok(previewAnswerSourcePatch(ctx, arrProposal).afterText.includes('  "synthetic multi?": ["alpha", "beta"]'));
});

test('complex or conflicting edits are refused: profile/CV targets and existing custom keys need a reviewed source patch', async () => {
  resetStanding();
  const profileProposal = await mkProposal({ fileKey: 'profile', selector: 'application_facts.synthetic' });
  assert.throws(() => previewAnswerSourcePatch(ctx, profileProposal), (e) => e.code === 'COMPLEX_SOURCE_EDIT');
  const nonCustom = await mkProposal({ selector: 'salary.expectation_text' });
  assert.throws(() => previewAnswerSourcePatch(ctx, nonCustom), (e) => e.code === 'COMPLEX_SOURCE_EDIT');
  const conflicting = await mkProposal({
    selector: 'custom.existing synthetic question?',
    question: { normalizedText: 'existing synthetic question?' },
    proposedValue: 'A different conflicting synthetic answer',
  });
  assert.throws(() => previewAnswerSourcePatch(ctx, conflicting), (e) => e.code === 'CONFLICTING_SOURCE_EDIT');
  assert.equal(readFileSync(standingPath, 'utf-8'), BASE_STANDING, 'all rejects left the source untouched');
});

test('approveAnswer applies under the source lock: intent, atomic write, committed hash, records, no leftover intent', async () => {
  resetStanding();
  const proposal = await mkProposal();
  const userApproval = createUserApproval({ approvedBy: 'synthetic-harness-user' });
  const result = await approveAnswer(ctx, { proposalId: proposal.id, expectedRevision: proposal.revision, approval: userApproval });
  assert.equal(result.status, 'applied');
  assert.equal(result.sourceHash, hashFile(standingPath), 'committed hash recorded');
  const text = readFileSync(standingPath, 'utf-8');
  assert.ok(text.includes('  "do you require synthetic sponsorship?": "No — synthetic fixture answer"'));
  assert.ok(text.includes('# tail comment after the custom block'), 'unrelated content preserved');
  const applied = getRecord(ctx, 'proposals', proposal.id);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.data.evaluationResult.committedHash, result.sourceHash);
  assert.equal(applied.data.rollbackVersion, proposal.data.affectedSources[0].sha256);
  const answer = getRecord(ctx, 'answers', `ans-${proposal.id}`);
  assert.equal(answer.status, 'approved');
  assert.equal(answer.data.authority, 'user_confirmed');
  assert.equal(answer.data.approvalRef, proposal.id);
  assert.deepEqual(answer.data.sourceRefs, [{ fileKey: 'standing', selector: proposal.data.affectedSources[0].selector, sha256: result.sourceHash }]);
  const change = getRecord(ctx, 'sourceChanges', `srcchg-${proposal.id}`);
  assert.equal(change.status, 'recorded');
  assert.equal(change.data.newHash, result.sourceHash);
  assert.equal(existsSync(approvalIntentPath(ctx, proposal.id)), false, 'intent cleared after commit');
});

test('stale approval conflicts: stale expectedRevision rejects and the independently edited source stays untouched', async () => {
  resetStanding();
  const proposal = await mkProposal({ selector: 'custom.synthetic stale case?', question: { normalizedText: 'synthetic stale case?' } });
  const proposalId = proposal.id;
  const oldRevision = proposal.revision;
  // The proposal advances (content revised) after the approval was granted…
  await commitRecord(ctx, 'proposals', proposalId, proposal.data, {
    expectedRevision: oldRevision, status: 'proposed', sourceIds: proposal.sourceIds,
  });
  // …and the standing source is edited independently in the meantime.
  writeFileSync(standingPath, `${BASE_STANDING}# independent synthetic edit\n`);
  const hashAfterIndependentEdit = hashFile(standingPath);
  const userApproval = createUserApproval({ approvedBy: 'synthetic-harness-user' });
  await assert.rejects(
    approveAnswer(ctx,{proposalId,expectedRevision:oldRevision,approval:userApproval}),
    error=>error.code==='REVISION_CONFLICT'
  );
  assert.ok(hashFile(standingPath)===hashAfterIndependentEdit);
  // Even with the CURRENT proposal revision, the changed source hash rejects.
  await assert.rejects(
    approveAnswer(ctx, { proposalId, expectedRevision: oldRevision + 1, approval: userApproval }),
    (error) => error.code === 'REVISION_CONFLICT',
  );
  assert.equal(hashFile(standingPath), hashAfterIndependentEdit);
});

test("agent/model-supplied actor:'user' never confers approval authority", async () => {
  resetStanding();
  const proposal = await mkProposal({ selector: 'custom.synthetic forged case?', question: { normalizedText: 'synthetic forged case?' } });
  const before = hashFile(standingPath);
  for (const forged of [
    { actor: 'user' },
    { kind: 'user_approval', approvedBy: 'model-claiming-user' },
    'user', null, undefined,
  ]) {
    await assert.rejects(
      approveAnswer(ctx, { proposalId: proposal.id, expectedRevision: proposal.revision, approval: forged }),
      (e) => e.code === 'APPROVAL_REQUIRED',
    );
  }
  assert.equal(hashFile(standingPath), before, 'source untouched by forged approvals');
  assert.equal(getRecord(ctx, 'answers', `ans-${proposal.id}`), null);
});

test('repeated approval is idempotent: already_applied, no second source write', async () => {
  resetStanding();
  const proposal = await mkProposal({ selector: 'custom.synthetic repeat case?', question: { normalizedText: 'synthetic repeat case?' } });
  const userApproval = createUserApproval({ approvedBy: 'synthetic-harness-user' });
  const first = await approveAnswer(ctx, { proposalId: proposal.id, expectedRevision: proposal.revision, approval: userApproval });
  const hashAfterApply = hashFile(standingPath);
  const again = await approveAnswer(ctx, { proposalId: proposal.id, expectedRevision: proposal.revision, approval: userApproval });
  assert.equal(again.status, 'already_applied');
  assert.equal(again.sourceHash, first.sourceHash);
  assert.equal(hashFile(standingPath), hashAfterApply, 'file not rewritten');
  assert.equal(getRecord(ctx, 'proposals', proposal.id).revision, 2, 'no extra proposal revision');
});

test('crash BEFORE the source write: pending intent is reconciled away and never becomes a usable fact', async () => {
  resetStanding();
  const proposal = await mkProposal({ selector: 'custom.synthetic crash before?', question: { normalizedText: 'synthetic crash before?' } });
  const preview = previewAnswerSourcePatch(ctx, proposal);
  // Simulate: intent persisted, then crash before the source write happened.
  writeFileSync(approvalIntentPath(ctx, proposal.id), JSON.stringify({
    proposalId: proposal.id, proposalRevision: proposal.revision, fileKey: 'standing',
    selector: preview.selector, beforeHash: preview.beforeHash, afterHash: preview.afterHash,
    approvedBy: 'synthetic-harness-user', approvedAt: '2026-10-11T00:00:00.000Z',
  }, null, 2));
  assert.equal(getRecord(ctx, 'answers', `ans-${proposal.id}`), null, 'pending intent is not an approved usable fact');
  const summary = await reconcileApprovals(ctx);
  assert.deepEqual(summary.rolledBack, [proposal.id]);
  assert.deepEqual(summary.finalized, []);
  assert.equal(existsSync(approvalIntentPath(ctx, proposal.id)), false, 'intent dropped');
  assert.equal(getRecord(ctx, 'proposals', proposal.id).status, 'proposed', 'approval must be granted again');
  assert.equal(getRecord(ctx, 'answers', `ans-${proposal.id}`), null);
  assert.equal(hashFile(standingPath), preview.beforeHash, 'source never written');
});

test('crash AFTER the source write: reconciliation finalizes once, never applies twice', async () => {
  resetStanding();
  const proposal = await mkProposal({ selector: 'custom.synthetic crash after?', question: { normalizedText: 'synthetic crash after?' } });
  const preview = previewAnswerSourcePatch(ctx, proposal);
  writeFileSync(approvalIntentPath(ctx, proposal.id), JSON.stringify({
    proposalId: proposal.id, proposalRevision: proposal.revision, fileKey: 'standing',
    selector: preview.selector, beforeHash: preview.beforeHash, afterHash: preview.afterHash,
    approvedBy: 'synthetic-harness-user', approvedAt: '2026-10-11T00:00:00.000Z',
  }, null, 2));
  // Simulate: the atomic source write committed, then crash before finalize.
  writeFileSync(standingPath, preview.afterText);
  const summary = await reconcileApprovals(ctx);
  assert.deepEqual(summary.finalized, [proposal.id]);
  assert.equal(hashFile(standingPath), preview.afterHash, 'file untouched by finalize (not applied twice)');
  assert.equal(getRecord(ctx, 'proposals', proposal.id).status, 'applied');
  assert.equal(getRecord(ctx, 'answers', `ans-${proposal.id}`).status, 'approved');
  assert.equal(existsSync(approvalIntentPath(ctx, proposal.id)), false);
  // A second reconciliation pass finds nothing to do.
  assert.deepEqual(await reconcileApprovals(ctx), { finalized: [], rolledBack: [], diverged: [] });
});

test('diverged source during a pending intent is reported, kept for review, and not auto-applied', async () => {
  resetStanding();
  const proposal = await mkProposal({ selector: 'custom.synthetic diverged?', question: { normalizedText: 'synthetic diverged?' } });
  const preview = previewAnswerSourcePatch(ctx, proposal);
  writeFileSync(approvalIntentPath(ctx, proposal.id), JSON.stringify({
    proposalId: proposal.id, proposalRevision: proposal.revision, fileKey: 'standing',
    selector: preview.selector, beforeHash: preview.beforeHash, afterHash: preview.afterHash,
    approvedBy: 'synthetic-harness-user', approvedAt: '2026-10-11T00:00:00.000Z',
  }, null, 2));
  writeFileSync(standingPath, `${BASE_STANDING}# unexpected third-party synthetic edit\n`);
  const summary = await reconcileApprovals(ctx);
  assert.deepEqual(summary.diverged, [proposal.id]);
  assert.equal(existsSync(approvalIntentPath(ctx, proposal.id)), true, 'kept for human review');
  assert.equal(getRecord(ctx, 'answers', `ans-${proposal.id}`), null);
  // Clean up the kept intent so later suites see a clean intents dir.
  const rolled = await (async () => { resetStanding(); return reconcileApprovals(ctx); })();
  assert.deepEqual(rolled.rolledBack, [proposal.id]);
});

test('reload: applied approvals and answer records survive a fresh context on the same roots', async () => {
  resetStanding();
  const proposal = await mkProposal({ selector: 'custom.synthetic reload case?', question: { normalizedText: 'synthetic reload case?' } });
  const userApproval = createUserApproval({ approvedBy: 'synthetic-harness-user' });
  const result = await approveAnswer(ctx, { proposalId: proposal.id, expectedRevision: proposal.revision, approval: userApproval });
  const ctx2 = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock('2026-10-12T00:00:00Z') });
  assert.equal(getRecord(ctx2, 'proposals', proposal.id).status, 'applied');
  const answer = getRecord(ctx2, 'answers', `ans-${proposal.id}`);
  assert.equal(answer.status, 'approved');
  assert.equal(answer.data.sourceRefs[0].sha256, result.sourceHash);
});
