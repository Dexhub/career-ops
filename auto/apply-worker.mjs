#!/usr/bin/env node
// auto/apply-worker.mjs — spawn one headless agent session to fill and
// (unless --no-submit) submit one job application, then verify the audit
// contract and transition job state. Agent output is UNTRUSTED: state only
// advances when the audit artifacts actually exist on disk.
//
// Usage:
//   node auto/apply-worker.mjs                      # next resume_ready job, real submit
//   node auto/apply-worker.mjs --job 1password      # match company/urlKey substring
//   node auto/apply-worker.mjs --no-submit          # dry run: fill, audit, stop before Submit (no state writes)
//   node auto/apply-worker.mjs --agent codex        # fallback agent
//   node auto/apply-worker.mjs --self-test

import './lib/sanitize-env.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { flagValue, hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { slugifySegment } from '../application-artifacts.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadAutoConfig, loadStandingAnswers, resolveExecutionPolicy } from './lib/config.mjs';
import { createLearningContext, readLearningConfig } from './learning/context.mjs';
import { normalizeAuditAnswers } from './learning/evidence.mjs';
import { finalizeAttemptCapture } from './learn.mjs';
import { findOpenAttemptBlocker, markAttemptLaunched, recordAttemptIntent, reconcileAttempt } from './learning/workflow.mjs';
import { allocateAttempt, listJobs, loadJob, pickOrder, queueOrderOptions, submittedCountOn, updateJob } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_TEMPLATE = join(ROOT, 'auto', 'prompts', 'apply-submit.md');
const LEARNING_PROMPT_TEMPLATE = join(ROOT, 'auto', 'prompts', 'apply-submit-learning.md');
const CHROME_PROFILE = join(ROOT, 'data', 'auto', 'chrome-profile');
const ACCOUNTS_FILE = join(ROOT, 'data', 'auto', 'accounts.json'); // gitignored (data/*)
// Timeout and attempt budget come from the resolved execution policy
// (config/auto.yml via resolveExecutionPolicy) — no competing constants.

// ---------------------------------------------------------------------------
// Prompt rendering

// ---------------------------------------------------------------------------
// ATS credentials store — data/auto/accounts.json: { "<host>": { email, password, created_at } }.
// The worker writes credentials.json into its audit dir when it creates an
// account; harvestCredentials() moves that into the store for sign-in reuse.

export function loadAccounts(file = ACCOUNTS_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

export function savedCredentialsFor(url, file = ACCOUNTS_FILE) {
  try {
    const host = new URL(url).host;
    const acct = loadAccounts(file)[host];
    if (!acct) return 'None on file for this employer — create the account if the form requires one.';
    return `host: ${host}\nemail: ${acct.email}\npassword: ${acct.password}\nSign in with these instead of creating a new account.`;
  } catch {
    return 'None on file for this employer — create the account if the form requires one.';
  }
}

export function harvestCredentials(auditDir, file = ACCOUNTS_FILE, log = () => {}) {
  const src = join(auditDir, 'credentials.json');
  if (!existsSync(src)) return false;
  try {
    const cred = JSON.parse(readFileSync(src, 'utf8'));
    if (!cred.host || !cred.email || !cred.password) return false;
    const accounts = loadAccounts(file);
    accounts[cred.host] = { email: cred.email, password: cred.password, created_at: cred.created_at || new Date().toISOString() };
    writeFileSync(file, JSON.stringify(accounts, null, 2), { mode: 0o600 });
    log(`apply-worker: saved new ATS credentials for ${cred.host}`);
    return true;
  } catch { return false; }
}

export function renderPrompt({ job, submit, auditDir, profileYaml, standingYaml, cvText, resumeSha, savedCreds }) {
  const template = readFileSync(PROMPT_TEMPLATE, 'utf8');
  const submitInstruction = submit
    ? 'You ARE authorized to click the final Submit/Apply button for this job, unattended.'
    : 'DRY RUN: you are NOT authorized to click the final Submit/Apply button in this session. Everything else proceeds exactly as a real run.';
  const submitDetail = submit
    ? 'After the pre-submit sweep is clean and answers.json + 01-form-filled.png are written: click Submit/Apply. Wait for and verify an EXPLICIT confirmation (success page, "thank you", "application received"). Capture 02-confirmation.png and put the visible confirmation snippet in result.json. Only that explicit confirmation justifies status "submitted" — a click alone is "failed" with reason "no-confirmation".'
    : 'Stop once the pre-submit sweep is clean: write answers.json and 01-form-filled.png, then write result.json with status "filled_no_submit" and exit WITHOUT clicking Submit/Apply.';
  const vars = {
    COMPANY: job.company || 'unknown',
    ROLE: job.role || 'unknown',
    URL: job.url,
    RESUME_PDF: job.resumePdf,
    RESUME_SHA256: resumeSha,
    AUDIT_DIR: auditDir,
    PROFILE_YAML: profileYaml.trim(),
    STANDING_ANSWERS_YAML: standingYaml.trim(),
    CV_TEXT: cvText.trim(),
    SUBMIT_INSTRUCTION: submitInstruction,
    SUBMIT_INSTRUCTION_DETAIL: submitDetail,
    SAVED_CREDENTIALS: savedCreds || savedCredentialsFor(job.url),
  };
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`renderPrompt: unresolved placeholder ${leftover[0]}`);
  return out;
}

// ---------------------------------------------------------------------------
// Continuous learning integration (T10). ALL of it is gated on
// config/learning.yml `enabled: true`: with the flag off, learningRuntime()
// returns null and every call site below is a strict no-op, so a flag-off run
// is byte-for-byte identical to the pre-learning worker.

/** Learning runtime, or null when disabled/unconfigured. Never throws. */
export function learningRuntime(log = () => {}) {
  try {
    const ctx = createLearningContext({ codeRoot: ROOT, dataRoot: getCareerOpsRoot() });
    const config = readLearningConfig(ctx);
    if (!config.enabled) return null;
    return { ctx, config };
  } catch (err) {
    log(`apply-worker: learning config unreadable (${err.message}) — continuing without learning`);
    return null;
  }
}

// The executor capability contract (CONTRACTS J): browser capability is the
// Neo/CDP surface the restricted executor already holds. There is no local
// Playwright injection on this path, no invented CLI flags, and no fallback
// to an unrestricted executor — a missing capability is a visible
// tool_unavailable outcome, never a silent downgrade.
const REQUIRED_EXECUTOR_TOOLS = Object.freeze(['browseros_snapshot', 'browseros_act', 'browseros_read']);

/** Preflight an injected executor: Neo/CDP tools present, restricted
 *  capability boundary, task-owned tabs. */
export function preflightExecutor(executor) {
  if (!executor || typeof executor.run !== 'function' || typeof executor.capabilities !== 'function') {
    return { ok: false, reason: 'tool_unavailable: no learning-capable executor was provided' };
  }
  let caps;
  try { caps = executor.capabilities(); } catch (err) {
    return { ok: false, reason: `tool_unavailable: executor capabilities check failed (${err.message})` };
  }
  const tools = Array.isArray(caps?.tools) ? caps.tools : [];
  const missing = REQUIRED_EXECUTOR_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length > 0) {
    return { ok: false, reason: `tool_unavailable: executor lacks required Neo/CDP tools: ${missing.join(', ')}` };
  }
  if (caps.boundary !== 'restricted') {
    return { ok: false, reason: 'tool_unavailable: executor is not capability-restricted — unrestricted fallback is forbidden' };
  }
  if (caps.taskOwnedTabs !== true) {
    return { ok: false, reason: 'tool_unavailable: executor does not confine itself to task-owned tabs' };
  }
  return { ok: true };
}

/** Compose the apply prompt. The learning capture protocol is appended at
 *  composition time ONLY when learning is enabled; with learning null the
 *  output is exactly renderPrompt's. */
export function composeApplyPrompt(args, { learning = null, attemptId = null } = {}) {
  const base = renderPrompt(args);
  if (!learning) return base;
  const extra = readFileSync(LEARNING_PROMPT_TEMPLATE, 'utf8')
    .replaceAll('{{AUDIT_DIR}}', args.auditDir)
    .replaceAll('{{ATTEMPT_ID}}', attemptId ?? 'unallocated');
  return `${base}\n${extra}`;
}

/** Run the injected (restricted, learning-capable) executor. Child/session
 *  cleanup is scoped to the executor itself: no pkill, no shared profile. */
async function runInjectedExecutor({ executor, prompt, auditDir, job, attemptId, submit, timeoutMins, log }) {
  writeFileSync(join(auditDir, 'prompt.md'), prompt);
  log(`apply-worker: running injected learning executor (timeout ${timeoutMins}m)`);
  try {
    const res = await executor.run({ prompt, auditDir, job, attemptId, submit, timeoutMins });
    return { timedOut: res?.timedOut === true, exitCode: res?.exitCode ?? 0 };
  } catch (err) {
    log(`apply-worker: injected executor error: ${err.message}`);
    return { timedOut: false, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Audit verification — the orchestrator-side contract check.

export function verifyAudit(auditDir, { submit }) {
  const resultPath = join(auditDir, 'result.json');
  if (!existsSync(resultPath)) return { ok: false, status: 'failed', reason: 'audit: result.json missing' };
  let result;
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch {
    return { ok: false, status: 'failed', reason: 'audit: result.json unparseable' };
  }
  const status = String(result.status ?? '');
  const reason = String(result.reason ?? '');

  if (status === 'parked') {
    return { ok: true, status, reason: reason || 'parked: unspecified', result };
  }
  if (status === 'failed' || !['submitted', 'filled_no_submit'].includes(status)) {
    return { ok: false, status: 'failed', reason: reason || `agent status "${status}"`, result };
  }

  // submitted / filled_no_submit require the fill artifacts.
  // Evidence captures accept .png or .pdf (BrowserOS exports pdf, not png —
  // observed 2026-10-09: regent real submission marked failed).
  const hasEvidence = (base) =>
    existsSync(join(auditDir, `${base}.png`)) || existsSync(join(auditDir, `${base}.pdf`));
  if (!existsSync(join(auditDir, 'answers.json'))) {
    return { ok: false, status: 'failed', reason: `audit: answers.json missing for status ${status}`, result };
  }
  if (!hasEvidence('01-form-filled')) {
    return { ok: false, status: 'failed', reason: `audit: 01-form-filled.png missing for status ${status}`, result };
  }
  try {
    // Agents write arrays of labeled rows, section objects of rows, or a
    // keyed section/value object — normalizeAuditAnswers (T04) accepts all
    // three. This is audit-SHAPE validation only: whether any row's source
    // authorizes answer reuse is a separate learning-layer decision.
    const raw = JSON.parse(readFileSync(join(auditDir, 'answers.json'), 'utf8'));
    const { entries, rejected } = normalizeAuditAnswers(raw);
    // Rows the normalizer could not recognize are still evidence of a fill
    // (an evidence gap for diagnostics, not an empty audit); only a file with
    // no content at all (pointer '$' = unsupported top-level shape) is empty.
    const hasContent = entries.length > 0 || rejected.some((r) => r.pointer !== '$');
    if (!hasContent) {
      return { ok: false, status: 'failed', reason: 'audit: answers.json empty', result };
    }
  } catch {
    return { ok: false, status: 'failed', reason: 'audit: answers.json unparseable', result };
  }

  if (status === 'submitted') {
    if (!submit) return { ok: false, status: 'failed', reason: 'audit: agent claims submitted in a dry run', result };
    if (!hasEvidence('02-confirmation')) {
      return { ok: false, status: 'failed', reason: 'audit: 02-confirmation.png missing', result };
    }
    // Agents sometimes nest the confirmation under result.confirmation
    // (observed 2026-10-09: jci/gilead real submissions marked failed).
    const conf = result.confirmation ?? {};
    const confText = String(
      result.confirmation_text
      ?? conf.confirmation_text
      ?? (conf.confirmed === true && Array.isArray(conf.evidence) ? conf.evidence.join('; ') : ''),
    ).trim();
    if (!confText) {
      return { ok: false, status: 'failed', reason: 'audit: confirmation_text empty', result };
    }
  }
  if (status === 'filled_no_submit' && submit) {
    return { ok: false, status: 'failed', reason: 'agent stopped before submit in a real run', result };
  }
  return { ok: true, status, reason, result };
}

// ---------------------------------------------------------------------------
// Agent invocation

function mcpConfigFor(auditDir) {
  return {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: [
          '-y', '@playwright/mcp@latest',
          '--browser', 'chrome',
          '--user-data-dir', CHROME_PROFILE,
          '--output-dir', auditDir,
        ],
      },
    },
  };
}

function runAgent({ agent, prompt, auditDir, timeoutMins, model, smallFastModel, log }) {
  const timeout = timeoutMins * 60 * 1000;
  const promptPath = join(auditDir, 'prompt.md');
  writeFileSync(promptPath, prompt);

  // Model override from config (cost experiments): claude reads env vars,
  // codex takes -m. Empty/missing keeps the CLI's own default.
  const env = { ...process.env };
  if (agent !== 'codex' && model) {
    env.ANTHROPIC_MODEL = model;
    if (smallFastModel) env.ANTHROPIC_SMALL_FAST_MODEL = smallFastModel;
  }

  let cmd;
  let args;
  if (agent === 'codex') {
    const mcp = mcpConfigFor(auditDir).mcpServers.playwright;
    cmd = 'codex';
    args = [
      'exec', '--dangerously-bypass-approvals-and-sandbox', '-C', ROOT,
      ...(model ? ['-m', model] : []),
      '-c', `mcp_servers.playwright.command=${JSON.stringify(mcp.command)}`,
      '-c', `mcp_servers.playwright.args=${JSON.stringify(mcp.args)}`,
      prompt,
    ];
  } else {
    const mcpPath = join(auditDir, 'mcp-config.json');
    writeFileSync(mcpPath, JSON.stringify(mcpConfigFor(auditDir), null, 2));
    cmd = 'claude';
    args = [
      '-p', prompt,
      '--output-format', 'json',
      '--mcp-config', mcpPath,
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
    ];
  }

  log(`apply-worker: spawning ${agent} (model ${model || 'cli-default'}, timeout ${timeoutMins}m)`);
  const started = Date.now();
  // Write agent output straight to a file descriptor instead of pipes:
  // with pipes, spawnSync keeps reading until every inheriting grandchild
  // (MCP servers, browser) closes them, so a SIGKILLed-at-timeout agent
  // still blocked us 10-45 extra minutes (observed 2355s/4185s on a 1500s
  // cap, 2026-10-10). A file fd needs no draining — we return at kill time.
  const outFd = openSync(join(auditDir, `${agent}-output.txt`), 'w');
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    env,
    timeout,
    killSignal: 'SIGKILL',
    stdio: ['ignore', outFd, outFd],
  });
  closeSync(outFd);
  // The MCP server dies with the agent, but a headed Chrome on the
  // persistent profile can linger (and holds the profile lock for the next
  // run). Kill anything still using our profile dir.
  spawnSync('pkill', ['-f', CHROME_PROFILE]);
  const secs = Math.round((Date.now() - started) / 1000);
  if (res.error?.code === 'ETIMEDOUT') {
    log(`apply-worker: ${agent} timed out after ${secs}s`);
    return { timedOut: true };
  }
  log(`apply-worker: ${agent} exited ${res.status} after ${secs}s`);
  return { timedOut: false, exitCode: res.status };
}

// ---------------------------------------------------------------------------

function appKey(job) {
  const num = (job.reportPath?.match(/(\d+)/) || [])[1] || '000';
  return `${num}-${slugifySegment(job.company)}-${slugifySegment(job.role, 'role')}`;
}

function pickJob(needle, maxAttempts) {
  const candidates = listJobs(['resume_ready', 'applying']);
  const pool = needle
    ? candidates.filter(j => j.urlKey.includes(needle) || (j.company || '').includes(needle))
    : pickOrder(candidates, maxAttempts, queueOrderOptions()); // THE shared comparator + shared options; held excluded
  if (pool.length === 0) return null;
  return loadJob(pool[0].urlKey);
}

/**
 * T12 dispatch gate, evaluated at execution grain in the REAL worker path
 * before any attempt is allocated or any executor/browser time is spent.
 * Returns a human-readable refusal reason, or null when dispatch is allowed.
 * ATS allowlist and holds gate every run (dry runs drive a browser too);
 * score/daily-cap/pause gate submissions only. Never mutates the job and
 * never consumes the pause sentinel.
 */
export function dispatchPolicyBlock(job, policy, { dataRoot, submit = true, now = new Date() } = {}) {
  if (job.held) return `policy: job is held (${job.urlKey})`;
  const ats = (job.ats || '').trim();
  if (!policy.atsAllowlist.includes(ats)) {
    return `policy: ats "${ats || 'unknown'}" is not in the allowlist [${policy.atsAllowlist.join(', ')}]`;
  }
  if (!submit) return null;
  if (job.score != null && Number(job.score) < policy.scoreThreshold) {
    return `policy: score ${job.score} below threshold ${policy.scoreThreshold}`;
  }
  const today = now.toISOString().slice(0, 10);
  const submitted = submittedCountOn(today);
  if (submitted >= policy.dailySoftLimit) {
    return `policy: daily soft limit reached (${submitted}/${policy.dailySoftLimit})`;
  }
  if (existsSync(join(dataRoot, 'data', 'auto', 'pause-requested'))) {
    return 'policy: pause requested — not dispatching';
  }
  return null;
}

export async function runApply({ needle, submit = true, agent = 'claude', timeoutMins, executor = null, log = console.log } = {}) {
  const cfg = loadAutoConfig({ fresh: true });
  // T12: resolve + validate the ONE execution policy up front. Garbled or
  // out-of-range config is an explicit refusal (POLICY_INVALID) before any
  // job is picked — never a silent fallback to defaults.
  const policy = resolveExecutionPolicy({ cfg });
  const standing = loadStandingAnswers();
  if (!standing || standing.filled_in_by_user !== true) {
    throw new Error('apply-worker: config/standing-answers.yml missing or filled_in_by_user is not true — refusing to start');
  }
  // Learning gate (T10): null when config/learning.yml is absent/disabled, in
  // which case everything below behaves exactly as before.
  const learning = learningRuntime(log);
  // In production the code checkout IS the data root, so this equals ROOT;
  // it differs only under test fixtures with CAREER_OPS_ROOT redirected.
  const dataRoot = learning ? learning.ctx.dataRoot : ROOT;

  let job = pickJob(needle, policy.maxAttempts);
  if (!job) { log('apply-worker: no resume_ready job found'); return null; }

  // T14 (CONTRACTS D4): a retry pick of a job whose PRIOR attempt persisted
  // submission intent must reconcile before any relaunch — a crash after the
  // submit click can never be retried into a double submission. Legacy jobs
  // (no persisted intent) take the unchanged retry path.
  if (learning && submit && job.stage === 'applying'
      && job.execution?.submissionPossible === true && job.execution?.attemptId
      && !['confirmed', 'definitely_not_submitted'].includes(job.execution?.submissionOutcome)) {
    const prior = job.execution.attemptId;
    const rec = await reconcileAttempt(learning.ctx, {
      applicationId: job.applicationId, attemptId: prior,
      evidence: { auditDir: job.auditDir },
    });
    if (rec.status === 'confirmed') {
      const updated = await updateJob(job.urlKey, { transitionTo: 'submitted', patch: { lastError: null } });
      syncTrackerApplied(updated, job.auditDir, log);
      log(`apply-worker: ${job.company} — prior attempt ${prior} reconciled as submitted; no relaunch`);
      return { job: updated, auditDir: job.auditDir, verdict: { ok: true, status: 'submitted', reason: 'reconciled: prior attempt confirmed submitted' } };
    }
    if (rec.status === 'unknown') {
      const updated = await updateJob(job.urlKey, {
        transitionTo: 'parked',
        patch: { lastError: `submission outcome unknown for attempt ${prior} — reconcile before any retry (${rec.reason})` },
      });
      log(`apply-worker: ${job.company} — submission outcome unknown for ${prior}; parked, refusing to relaunch`);
      return { job: updated, auditDir: job.auditDir, verdict: { ok: true, status: 'parked', reason: 'submission outcome unknown — refusing to relaunch' } };
    }
    log(`apply-worker: ${job.company} — prior attempt ${prior} reconciled as definitely not submitted; retry allowed`);
    job = loadJob(job.urlKey); // reconciliation patched execution; work from the fresh record
  }

  // Dispatch gate BEFORE preflight, allocation, and any browser/agent time.
  // A refusal mutates nothing: the job stays where it is, visibly, and the
  // backlog preview (panel /api/auto/policy-preview) explains why.
  const blocked = dispatchPolicyBlock(job, policy, { dataRoot, submit });
  if (blocked) {
    log(`apply-worker: ${blocked} — refusing to dispatch ${job.company}`);
    return { job, auditDir: null, verdict: { ok: false, status: 'policy_blocked', reason: blocked } };
  }

  // Required sources read (and hashed) BEFORE allocating or claiming the
  // attempt: a changed-on-disk resume or a missing profile/CV/standing file
  // refuses the launch without burning an attempt or creating an audit dir.
  if (!job.resumePdf || !existsSync(job.resumePdf)) {
    throw new Error(`apply-worker: required source missing or unreadable — resume PDF for ${job.company}: ${job.resumePdf}`);
  }
  let sources;
  try {
    sources = {
      profileYaml: readFileSync(join(dataRoot, 'config', 'profile.yml'), 'utf8'),
      standingYaml: readFileSync(join(dataRoot, 'config', 'standing-answers.yml'), 'utf8'),
      cvText: readFileSync(join(dataRoot, 'cv.md'), 'utf8'),
      resumePdf: readFileSync(job.resumePdf),
    };
  } catch (err) {
    throw new Error(`apply-worker: required source missing or unreadable — refusing before launch: ${err.message}`);
  }
  const resumeSha = createHash('sha256').update(sources.resumePdf).digest('hex');
  const sourceVersion = `src1-${createHash('sha256').update(JSON.stringify({
    profile: createHash('sha256').update(sources.profileYaml).digest('hex'),
    standing: createHash('sha256').update(sources.standingYaml).digest('hex'),
    cv: createHash('sha256').update(sources.cvText).digest('hex'),
    resume: resumeSha,
  })).digest('hex').slice(0, 16)}`;

  if (learning) {
    // Executor preflight BEFORE claiming the attempt: a missing capability is
    // a visible tool_unavailable verdict, never a launch and never a fallback
    // to the unrestricted legacy agent path.
    const pre = preflightExecutor(executor);
    if (!pre.ok) {
      log(`apply-worker: ${pre.reason} — refusing to launch an application executor`);
      return { job, auditDir: null, verdict: { ok: false, status: 'tool_unavailable', reason: pre.reason } };
    }
  }

  const attemptNo = (job.attempts || 0) + 1;
  const auditRoot = join(dataRoot, 'output', appKey(job), 'audit');
  // Immutable attempt: fresh UUID + exclusively created audit dir — a requeue
  // or retry never reuses (or overwrites) an earlier attempt's directory.
  let attempt = null;
  let auditDir;
  if (submit) {
    // Pin the policy and source versions onto the immutable attempt: the
    // attempt runs under the policy it started with, and later config edits
    // surface as a pending policy change instead of rewriting history.
    attempt = allocateAttempt({ job, auditRoot, policyVersion: policy.policyVersion, sourceVersion });
    auditDir = attempt.auditDir;
  } else {
    auditDir = join(auditRoot, `attempt-dryrun-${Date.now()}`);
    mkdirSync(auditDir, { recursive: true });
  }

  const prompt = composeApplyPrompt({
    job,
    submit,
    auditDir,
    profileYaml: sources.profileYaml,
    standingYaml: sources.standingYaml,
    cvText: sources.cvText,
    resumeSha,
  }, { learning, attemptId: attempt?.attemptId ?? null });
  // resume.txt per the audit contract: variant + sha of the exact PDF.
  writeFileSync(join(auditDir, 'resume.txt'),
    `variant: ${job.resumeVariant}\npdf: ${job.resumePdf}\nsha256: ${resumeSha}\n`);
  if (learning) {
    // Trusted identity binding for the attempt subcommands (learn.mjs reads
    // this, never the executor's own claims).
    mkdirSync(join(auditDir, 'learning'), { recursive: true });
    writeFileSync(join(auditDir, 'learning', 'meta.json'), JSON.stringify({
      attemptId: attempt?.attemptId ?? null,
      applicationId: attempt?.applicationId ?? null,
      urlKey: job.urlKey,
    }, null, 2));
    if (attempt) {
      // T14 (CONTRACTS D4): persist the exact job identity + policy intent
      // BEFORE the submission-capable executor launches. A failure here throws
      // and aborts the launch — the safety boundary must exist first.
      let tenant = null;
      try { tenant = new URL(job.url).hostname || null; } catch { tenant = null; }
      await recordAttemptIntent(learning.ctx, {
        applicationId: attempt.applicationId, attemptId: attempt.attemptId,
        urlKey: job.urlKey, allowedAction: 'submit',
        policyVersion: attempt.policyVersion, sourceVersion: attempt.sourceVersion,
        procedureVersion: attempt.procedureVersion,
        employerId: job.company ?? null, tenant,
        allocatedAt: attempt.allocatedAt,
      });
    }
  }

  log(`apply-worker: ${job.company} — ${job.role} [${submit ? 'SUBMIT' : 'dry-run'}] -> ${auditDir}`);

  if (submit) {
    // CAS claim of the attempt: resume_ready -> applying (or applying ->
    // applying on retry). expectedVersion makes exactly one worker the
    // execution owner — a competitor loses with VERSION_CONFLICT instead of
    // double-applying. No lock is held after this call (never across the
    // browser session below).
    try {
      job = await updateJob(job.urlKey, {
        expectedVersion: job.recordVersion,
        transitionTo: 'applying',
        patch: {
          attempts: attemptNo,
          auditDir,
          execution: {
            attemptId: attempt.attemptId,
            phase: 'in_progress',
            policyVersion: attempt.policyVersion,
            sourceVersion: attempt.sourceVersion,
            procedureVersion: attempt.procedureVersion,
            // The concrete limits this attempt runs under, pinned for the
            // recovery path: a later shrink of max_attempts surfaces as a
            // pending policy change instead of silently failing the job.
            pinnedPolicy: { maxAttempts: policy.maxAttempts, timeoutMinutes: policy.timeoutMinutes },
            // T14 (learning only): the persisted submission-intent flag the
            // shared requeue path keys on. Flag off, the claim is unchanged.
            ...(learning ? { submissionPossible: true, submissionOutcome: null, confirmationRef: null } : {}),
          },
        },
      });
    } catch (err) {
      if (err.code === 'VERSION_CONFLICT') {
        log(`apply-worker: lost the attempt claim for ${job.company} (concurrent writer) — skipping`);
        return null;
      }
      throw err;
    }
  }

  const agentCfg = cfg.agent || {};
  // Quality escalation: a retry means the cheap primary already failed once,
  // so attempt 2+ runs on the fallback agent/model instead of re-rolling.
  let agentUsed = agent;
  if (submit && attemptNo > 1 && agentCfg.fallback && agentCfg.fallback !== agent) {
    agentUsed = agentCfg.fallback;
    log(`apply-worker: attempt ${attemptNo} — escalating to fallback agent ${agentUsed}`);
  }
  if (learning && submit && attempt) {
    // T14: the trusted parent marks the launch; from here on only
    // reconciliation can settle the outcome. A failure throws BEFORE the
    // executor runs — an unlaunched intent reconciles to definitely_not_submitted.
    await markAttemptLaunched(learning.ctx, { attemptId: attempt.attemptId });
  }
  const run = learning
    ? await runInjectedExecutor({
      executor, prompt, auditDir, job,
      attemptId: attempt?.attemptId ?? null, submit,
      timeoutMins: timeoutMins ?? policy.timeoutMinutes,
      log,
    })
    : runAgent({
      agent: agentUsed, prompt, auditDir,
      timeoutMins: timeoutMins ?? policy.timeoutMinutes,
      model: agentUsed === 'codex' ? agentCfg.codex_model : agentCfg.claude_model,
      smallFastModel: agentCfg.claude_small_fast_model,
      log,
    });

  harvestCredentials(auditDir, undefined, log);

  let verdict;
  if (!run.timedOut) {
    verdict = verifyAudit(auditDir, { submit });
    if (learning && attempt) {
      // T14: the executor ran to completion under this parent's supervision and
      // verifyAudit rendered the verdict from artifacts — settle the attempt
      // outcome explicitly so a later retry/requeue is not mistaken for an
      // interrupted (unknown) submission. Crashes/kills/timeouts never reach
      // this branch and stay subject to evidence-bound reconciliation.
      await reconcileAttempt(learning.ctx, {
        applicationId: attempt.applicationId, attemptId: attempt.attemptId,
        evidence: {
          auditDir,
          resolution: {
            outcome: verdict.status === 'submitted' ? 'submitted' : 'not_submitted',
            by: 'apply-worker:verifyAudit',
          },
        },
      });
    }
  } else if (!(learning && attempt)) {
    verdict = { ok: false, status: 'failed', reason: `agent timeout` }; // legacy edge unchanged
  } else {
    // T14 (CONTRACTS D4): a timeout after launch is NOT a failure to retry.
    // Reconcile against the structured captures bound to this exact attempt;
    // unknown parks the job behind a submission_unknown blocker instead of
    // re-entering the retry loop.
    try {
      const rec = await reconcileAttempt(learning.ctx, {
        applicationId: attempt.applicationId, attemptId: attempt.attemptId,
        evidence: { auditDir },
      });
      if (rec.status === 'confirmed') {
        verdict = { ok: true, status: 'submitted', reason: 'reconciled after timeout: confirmation bound to this attempt' };
      } else if (rec.status === 'definitely_not_submitted') {
        verdict = { ok: false, status: 'failed', reason: 'agent timeout (reconciled: definitely not submitted)' };
      } else {
        verdict = { ok: true, status: 'parked', reason: `submission outcome unknown after timeout — ${rec.reason}` };
      }
    } catch (err) {
      log(`apply-worker: post-timeout reconciliation FAILED (${err.message}) — parking conservatively`);
      verdict = { ok: true, status: 'parked', reason: `submission outcome unknown after timeout (reconciliation error: ${err.message})` };
    }
  }

  // The orchestrator's own judgment, stored next to the agent's result.json
  // so every audit dir is self-contained for later diagnosis (a divergence
  // between the two is itself a finding: the agent claimed something the
  // artifacts don't support).
  writeFileSync(join(auditDir, 'verdict.json'), JSON.stringify({
    ...verdict, submit, attempt: attemptNo, agent: agentUsed,
    model: (agentUsed === 'codex' ? agentCfg.codex_model : agentCfg.claude_model) || 'cli-default',
    timedOut: run.timedOut === true,
    exitCode: run.exitCode ?? null, verdictAt: new Date().toISOString(),
  }, null, 2));

  log(`apply-worker: verdict status=${verdict.status} ok=${verdict.ok}${verdict.reason ? ` reason="${verdict.reason}"` : ''}`);

  // Finalize learning evidence for every attempt outcome (completed, parked,
  // failed — interrupted attempts are finalized by run.mjs recovery). A
  // capture failure is logged visibly and never alters the submission verdict.
  if (learning && attempt) {
    try {
      const capture = await finalizeAttemptCapture(learning.ctx, {
        attemptId: attempt.attemptId, auditDir, verdictStatus: verdict.status,
      });
      log(`apply-worker: learning capture finalized — coverage=${capture.coverage} pages=${capture.pagesObserved} sync=${capture.consolidationTaskId}`);
    } catch (err) {
      log(`apply-worker: learning capture FAILED (verdict unchanged): ${err.message}`);
    }
  }

  if (!submit) return { job, auditDir, verdict }; // dry runs never mutate state

  // The agent run is long: re-load fresh state so panel decisions made in the
  // meantime (hold, priority, ...) are not clobbered by the final patch.
  return finalizeVerdict(loadJob(job.urlKey), auditDir, verdict, attemptNo, policy.maxAttempts, log,
    { learning, attempt });
}

/** Mark the job Applied in the web tracker (data/applications.md) so the
 *  /pipeline page reflects auto submissions. Uses the sanctioned root
 *  scripts (merge-tracker.mjs + set-status.mjs); never touches web/.
 *  Best-effort: a tracker failure must not fail the submit. */
export function syncTrackerApplied(job, auditDir, log = console.log) {
  const reportNum = /(\d+)/.exec(job.reportPath || '')?.[1];
  if (!reportNum) { log(`apply-worker: tracker sync skipped — no report number in "${job.reportPath}"`); return false; }
  const node = process.execPath;
  const setStatus = () => spawnSync(node, ['set-status.mjs', '--report', reportNum, 'Applied',
    '--note', `auto-submitted; audit ${auditDir || ''}`.trim(), '--json'],
  { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  // merge any pending tracker-additions so the row exists, then flip status
  spawnSync(node, ['merge-tracker.mjs'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 });
  let res = setStatus();
  if (res.status !== 0 && (res.stdout || '').includes('not-found')) {
    // The eval chain's addition carried company "unknown" and was dropped by
    // merge-tracker's dedup. Re-create it from the job record, which knows
    // the real company/role, then merge and retry once.
    const day = new Date().toISOString().slice(0, 10);
    const esc = (s) => String(s ?? '').replace(/[\t\n|]/g, ' ').trim() || 'unknown';
    const tsv = 'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n'
      + [reportNum, day, esc(job.company), esc(job.role), 'Evaluated',
        Number.isFinite(Number(job.score)) ? `${Number(job.score).toFixed(1)}/5` : 'N/A', '❌',
        `[${reportNum}](${job.reportPath})`, 'auto pipeline', job.urlKey].join('\t') + '\n';
    const addDir = join(getCareerOpsRoot(), 'batch', 'tracker-additions');
    mkdirSync(addDir, { recursive: true });
    writeFileSync(join(addDir, `${reportNum}-${slugifySegment(job.company || 'auto')}.tsv`), tsv);
    spawnSync(node, ['merge-tracker.mjs'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 });
    res = setStatus();
  }
  if (res.status !== 0) {
    log(`apply-worker: tracker sync failed for report ${reportNum} (exit ${res.status}): ${(res.stderr || res.stdout || '').trim().slice(0, 200)}`);
    return false;
  }
  log(`apply-worker: tracker -> Applied (report ${reportNum})`);
  return true;
}

async function finalizeVerdict(job, auditDir, verdict, attemptNo, maxAttempts, log = console.log,
  { learning = null, attempt = null } = {}) {
  // Narrow patches on the fresh record inside one transaction: concurrent
  // panel edits (held/priority) survive the worker's final write.
  let updated;
  // T13 (learning-gated; flag off leaves every path below byte-identical):
  // an unsuccessful attempt that raised a live blocker is a persisted WAIT —
  // the legacy stage routing is unchanged, but execution keeps pointing at the
  // blocker so resolution resumes the SAME application identity later.
  let doneExecution = { phase: 'finished' };
  if (learning && attempt && !(verdict.ok && verdict.status === 'submitted')) {
    try {
      const blocker = findOpenAttemptBlocker(learning.ctx, attempt.attemptId);
      if (blocker) {
        doneExecution = { phase: 'blocked', blockerId: blocker.id };
        log(`apply-worker: ${job.company} waiting on ${blocker.data.type} (${blocker.id}) — resolution resumes this application`);
      }
    } catch (err) {
      log(`apply-worker: blocker lookup failed (verdict routing unchanged): ${err.message}`);
    }
  }
  if (verdict.ok && verdict.status === 'submitted') {
    updated = await updateJob(job.urlKey, { transitionTo: 'submitted', patch: { auditDir, lastError: null, execution: { phase: 'finished' } } });
    syncTrackerApplied(updated, auditDir, log);
  } else if (verdict.ok && verdict.status === 'parked') {
    updated = await updateJob(job.urlKey, { transitionTo: 'parked', patch: { auditDir, lastError: verdict.reason, execution: doneExecution } });
  } else if (attemptNo >= maxAttempts) {
    updated = await updateJob(job.urlKey, { transitionTo: 'failed', patch: { auditDir, lastError: verdict.reason, execution: doneExecution } });
  } else {
    // stay in applying; next cycle retries once more
    updated = await updateJob(job.urlKey, { patch: { auditDir, lastError: verdict.reason, execution: doneExecution } });
  }
  log(`apply-worker: ${updated.company} -> stage ${updated.stage}`);
  return { job: updated, auditDir, verdict };
}

// ---------------------------------------------------------------------------
function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (cond) console.log(`ok - ${name}`);
    else { console.error(`FAIL - ${name}`); failures += 1; }
  };
  // renderPrompt
  const fakeJob = {
    company: 'acme', role: 'Director of Engineering',
    url: 'https://example.com/j/1', resumePdf: '/tmp/x.pdf', resumeVariant: 'Director of Engineering',
  };
  const prompt = renderPrompt({
    job: fakeJob, submit: false, auditDir: '/tmp/audit',
    profileYaml: 'name: X', standingYaml: 'filled_in_by_user: true', cvText: '# CV', resumeSha: 'abc',
  });
  check('prompt renders without leftover placeholders', !/\{\{[A-Z_]+\}\}/.test(prompt));
  check('dry-run prompt forbids submit', prompt.includes('NOT authorized to click the final Submit'));
  const prompt2 = renderPrompt({
    job: fakeJob, submit: true, auditDir: '/tmp/audit',
    profileYaml: 'name: X', standingYaml: 'y: 1', cvText: '# CV', resumeSha: 'abc',
  });
  check('submit prompt authorizes submit', prompt2.includes('ARE authorized to click the final Submit'));

  check('prompt includes saved-credentials section', prompt.includes('Saved ATS credentials'));

  // credentials store round-trip (temp file, never the real store)
  const credTmp = `/tmp/apply-creds-${Date.now()}`;
  mkdirSync(credTmp, { recursive: true });
  const credFile = join(credTmp, 'accounts.json');
  check('no credentials -> create-account hint',
    savedCredentialsFor('https://acme.wd1.myworkdayjobs.com/x', credFile).includes('None on file'));
  writeFileSync(join(credTmp, 'credentials.json'), JSON.stringify({ host: 'acme.wd1.myworkdayjobs.com', email: 'a@b.c', password: 'p4ss!Word123456' }));
  check('harvest stores new credentials', harvestCredentials(credTmp, credFile) === true);
  check('saved credentials injected for matching host',
    savedCredentialsFor('https://acme.wd1.myworkdayjobs.com/job/1', credFile).includes('p4ss!Word123456'));
  check('harvest ignores missing file', harvestCredentials('/tmp/nonexistent-dir-xyz', credFile) === false);

  // verifyAudit
  const tmp = `/tmp/apply-audit-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  check('missing result.json -> failed', verifyAudit(tmp, { submit: true }).ok === false);

  writeFileSync(join(tmp, 'result.json'), JSON.stringify({ status: 'parked', reason: 'captcha' }));
  const parked = verifyAudit(tmp, { submit: true });
  check('parked accepted without artifacts', parked.ok === true && parked.status === 'parked');

  writeFileSync(join(tmp, 'result.json'), JSON.stringify({ status: 'submitted', confirmation_text: 'Thanks!' }));
  check('submitted without artifacts -> failed', verifyAudit(tmp, { submit: true }).ok === false);

  writeFileSync(join(tmp, 'answers.json'), JSON.stringify([{ label: 'Name', value: 'X', source: 'profile' }]));
  writeFileSync(join(tmp, '01-form-filled.png'), 'png');
  writeFileSync(join(tmp, '02-confirmation.png'), 'png');
  const good = verifyAudit(tmp, { submit: true });
  check('submitted with full artifacts -> ok', good.ok === true && good.status === 'submitted');

  check('submitted during dry run -> rejected', verifyAudit(tmp, { submit: false }).ok === false);

  writeFileSync(join(tmp, 'answers.json'), JSON.stringify({ my_information: { name: 'X' }, application_questions: [] }));
  check('object-form answers.json accepted', verifyAudit(tmp, { submit: true }).ok === true);
  writeFileSync(join(tmp, 'answers.json'), JSON.stringify({}));
  check('empty object answers.json rejected', verifyAudit(tmp, { submit: true }).ok === false);
  writeFileSync(join(tmp, 'answers.json'), JSON.stringify([{ label: 'Name', value: 'X', source: 'profile' }]));

  writeFileSync(join(tmp, 'result.json'), JSON.stringify({ status: 'submitted', confirmation: { confirmation_text: 'Application Submitted' } }));
  check('nested confirmation_text accepted', verifyAudit(tmp, { submit: true }).ok === true);
  writeFileSync(join(tmp, 'result.json'), JSON.stringify({ status: 'submitted', confirmation: { confirmed: true, evidence: ['Submitted dialog shown'] } }));
  check('confirmed+evidence accepted', verifyAudit(tmp, { submit: true }).ok === true);
  writeFileSync(join(tmp, 'result.json'), JSON.stringify({ status: 'submitted', confirmation: { confirmed: false } }));
  check('empty nested confirmation still fails', verifyAudit(tmp, { submit: true }).ok === false);

  // pdf evidence alternates (BrowserOS path)
  const tmp2 = `/tmp/apply-audit-pdf-${Date.now()}`;
  mkdirSync(tmp2, { recursive: true });
  writeFileSync(join(tmp2, 'result.json'), JSON.stringify({ status: 'submitted', confirmation_text: 'Thanks!' }));
  writeFileSync(join(tmp2, 'answers.json'), JSON.stringify([{ label: 'Name', value: 'X', source: 'profile' }]));
  writeFileSync(join(tmp2, '01-form-filled.pdf'), 'pdf');
  writeFileSync(join(tmp2, '02-confirmation.pdf'), 'pdf');
  check('pdf evidence alternates accepted', verifyAudit(tmp2, { submit: true }).ok === true);

  writeFileSync(join(tmp, 'result.json'), JSON.stringify({ status: 'filled_no_submit' }));
  check('filled_no_submit ok in dry run', verifyAudit(tmp, { submit: false }).ok === true);
  check('filled_no_submit rejected in real run', verifyAudit(tmp, { submit: true }).ok === false);

  if (failures > 0) { console.error(`self-test: ${failures} failure(s)`); process.exit(1); }
  console.log('self-test: all passed');
}

// ---------------------------------------------------------------------------
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  validateFlags(argv,
    ['--job', '--no-submit', '--agent', '--timeout-mins', '--self-test'],
    'usage: apply-worker [--job NEEDLE] [--no-submit] [--agent claude|codex] [--timeout-mins N] [--self-test]',
    { valueFlags: ['--job', '--agent', '--timeout-mins'] });
  if (hasFlag(argv, '--self-test')) {
    selfTest();
  } else {
    const timeoutRaw = flagValue(argv, '--timeout-mins');
    await runApply({
      needle: flagValue(argv, '--job') ?? undefined,
      submit: !hasFlag(argv, '--no-submit'),
      agent: flagValue(argv, '--agent') ?? 'claude',
      timeoutMins: timeoutRaw ? Number(timeoutRaw) : undefined,
    });
  }
}
