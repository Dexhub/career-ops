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
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { flagValue, hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { slugifySegment } from '../application-artifacts.mjs';
import { loadAutoConfig, loadStandingAnswers } from './lib/config.mjs';
import { listJobs, loadJob, pickOrder, saveJob, transition } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_TEMPLATE = join(ROOT, 'auto', 'prompts', 'apply-submit.md');
const CHROME_PROFILE = join(ROOT, 'data', 'auto', 'chrome-profile');
const ACCOUNTS_FILE = join(ROOT, 'data', 'auto', 'accounts.json'); // gitignored (data/*)
const DEFAULT_TIMEOUT_MINS = 25;
const MAX_ATTEMPTS = 2;

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
    // Agents write either an array of {label,value,source} rows or a
    // structured object keyed by form section — both are valid evidence.
    const answers = JSON.parse(readFileSync(join(auditDir, 'answers.json'), 'utf8'));
    const empty = Array.isArray(answers)
      ? answers.length === 0
      : !(answers && typeof answers === 'object' && Object.keys(answers).length > 0);
    if (empty) {
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
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    env,
    timeout,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(join(auditDir, `${agent}-output.txt`), `${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`);
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

function pickJob(needle) {
  const candidates = listJobs(['resume_ready', 'applying']);
  const pool = needle
    ? candidates.filter(j => j.urlKey.includes(needle) || (j.company || '').includes(needle))
    : pickOrder(candidates, MAX_ATTEMPTS); // shared order: priority → score → oldest; held excluded
  if (pool.length === 0) return null;
  return loadJob(pool[0].urlKey);
}

export function runApply({ needle, submit = true, agent = 'claude', timeoutMins, log = console.log } = {}) {
  const cfg = loadAutoConfig();
  const standing = loadStandingAnswers();
  if (!standing || standing.filled_in_by_user !== true) {
    throw new Error('apply-worker: config/standing-answers.yml missing or filled_in_by_user is not true — refusing to start');
  }

  const job = pickJob(needle);
  if (!job) { log('apply-worker: no resume_ready job found'); return null; }
  if (!job.resumePdf || !existsSync(job.resumePdf)) {
    throw new Error(`apply-worker: resume PDF missing for ${job.company}: ${job.resumePdf}`);
  }

  const attemptNo = (job.attempts || 0) + 1;
  const attemptName = submit ? `attempt-${attemptNo}` : `attempt-dryrun-${Date.now()}`;
  const auditDir = join(ROOT, 'output', appKey(job), 'audit', attemptName);
  mkdirSync(auditDir, { recursive: true });

  const prompt = renderPrompt({
    job,
    submit,
    auditDir,
    profileYaml: readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8'),
    standingYaml: readFileSync(join(ROOT, 'config', 'standing-answers.yml'), 'utf8'),
    cvText: readFileSync(join(ROOT, 'cv.md'), 'utf8'),
    resumeSha: createHash('sha256').update(readFileSync(job.resumePdf)).digest('hex'),
  });
  // resume.txt per the audit contract: variant + sha of the exact PDF.
  writeFileSync(join(auditDir, 'resume.txt'),
    `variant: ${job.resumeVariant}\npdf: ${job.resumePdf}\nsha256: ${createHash('sha256').update(readFileSync(job.resumePdf)).digest('hex')}\n`);

  log(`apply-worker: ${job.company} — ${job.role} [${submit ? 'SUBMIT' : 'dry-run'}] -> ${auditDir}`);

  if (submit) {
    // resume_ready -> applying (or applying -> applying on retry)
    transition(job, 'applying', { attempts: attemptNo });
    saveJob(job);
  }

  const agentCfg = cfg.agent || {};
  // Quality escalation: a retry means the cheap primary already failed once,
  // so attempt 2+ runs on the fallback agent/model instead of re-rolling.
  let agentUsed = agent;
  if (submit && attemptNo > 1 && agentCfg.fallback && agentCfg.fallback !== agent) {
    agentUsed = agentCfg.fallback;
    log(`apply-worker: attempt ${attemptNo} — escalating to fallback agent ${agentUsed}`);
  }
  const run = runAgent({
    agent: agentUsed, prompt, auditDir,
    timeoutMins: timeoutMins ?? cfg.apply?.timeout_minutes ?? DEFAULT_TIMEOUT_MINS,
    model: agentUsed === 'codex' ? agentCfg.codex_model : agentCfg.claude_model,
    smallFastModel: agentCfg.claude_small_fast_model,
    log,
  });

  harvestCredentials(auditDir, undefined, log);

  const verdict = run.timedOut
    ? { ok: false, status: 'failed', reason: `agent timeout` }
    : verifyAudit(auditDir, { submit });

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

  if (!submit) return { job, auditDir, verdict }; // dry runs never mutate state

  if (verdict.ok && verdict.status === 'submitted') {
    transition(job, 'submitted', { auditDir, lastError: null });
  } else if (verdict.ok && verdict.status === 'parked') {
    transition(job, 'parked', { auditDir, lastError: verdict.reason });
  } else if (attemptNo >= MAX_ATTEMPTS) {
    transition(job, 'failed', { auditDir, lastError: verdict.reason });
  } else {
    // stay in applying; next cycle retries once more
    job.auditDir = auditDir;
    job.lastError = verdict.reason;
  }
  saveJob(job);
  log(`apply-worker: ${job.company} -> stage ${job.stage}`);
  return { job, auditDir, verdict };
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
    runApply({
      needle: flagValue(argv, '--job') ?? undefined,
      submit: !hasFlag(argv, '--no-submit'),
      agent: flagValue(argv, '--agent') ?? 'claude',
      timeoutMins: timeoutRaw ? Number(timeoutRaw) : undefined,
    });
  }
}
