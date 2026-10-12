#!/usr/bin/env node
/**
 * auto/mail-sync.mjs — Read-only Gmail inbox ingestion via BrowserOS Neo.
 *
 * MECHANISM: Dispatches a single bounded claude-CLI session with the BrowserOS
 * Neo MCP (remote SSE at http://127.0.0.1:9010/mcp). The agent opens
 * https://mail.google.com in a Neo-owned tab (already signed in), reads inbox
 * messages newer than the stored high-water mark, and writes a JSON array of
 * extracted message objects to a local output file. No other browser surface,
 * no AppleScript, no IMAP.
 *
 * STRICT READ-ONLY GUARANTEE: The agent prompt forbids any mutation — no
 * archive, mark-read/unread, delete, reply, forward, or label change. The
 * Neo MCP only provides browser interaction tools; the prompt enforces that
 * only navigation and reading actions are taken.
 *
 * INVOCATION: User-triggered one-shot only. No scheduling.
 *   node auto/mail-sync.mjs               # normal sync
 *   node auto/mail-sync.mjs --dry-run     # classify but don't write candidates
 *   node auto/mail-sync.mjs --test-pipeline  # run full pipeline with synthetic data (no browser)
 *   node auto/mail-sync.mjs --backfill    # force full backfill (ignore HWM)
 *   node auto/mail-sync.mjs --json        # output summary as JSON
 *
 * PREREQUISITES: BrowserOS Neo must be running (http://127.0.0.1:9010/mcp).
 *   If unreachable the script exits non-zero with a clear error message.
 *
 * Exit codes: 0 success · 1 Neo unreachable or agent failure.
 *
 * FILES:
 *   data/auto/mail-sync-hwm.json   — { lastSyncDate: "YYYY-MM-DD" }
 *   data/auto/mail-sync-seen.json  — { seenIds: ["<id>", ...] }
 *   data/auto/mail-sync/<run>/     — audit dir per run (prompt.md, agent output)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { localToday } from '../lib/local-today.mjs';
import { renameSyncWithRetry } from '../tracker-utils.mjs';

const ROOT = getCareerOpsRoot();
const AUTO_DIR = join(ROOT, 'data', 'auto');
const HWM_PATH = join(AUTO_DIR, 'mail-sync-hwm.json');
const SEEN_PATH = join(AUTO_DIR, 'mail-sync-seen.json');

/** Default BrowserOS Neo MCP endpoint. */
const NEO_MCP_URL = process.env.CAREER_OPS_NEO_MCP_URL || 'http://127.0.0.1:9010/mcp';

/** Days to backfill on first run (application era). */
const BACKFILL_DAYS = 180;
/** Max messages agent should return per run (prompt cap). */
const FETCH_CAP = 150;
/** Agent timeout in minutes. */
const AGENT_TIMEOUT_MINS = 10;
/** Max seen-IDs to persist (rolling window). */
const SEEN_IDS_MAX = 10000;

// ── High-water mark ───────────────────────────────────────────────────────────

/**
 * Load the high-water mark. Returns null if this is the first run.
 * @returns {{ lastSyncDate: string } | null}
 */
export function loadHwm() {
  if (!existsSync(HWM_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(HWM_PATH, 'utf-8'));
    if (data && typeof data.lastSyncDate === 'string') return data;
  } catch { /* treat as first run */ }
  return null;
}

/**
 * Save the high-water mark atomically.
 * @param {string} date - YYYY-MM-DD
 */
export function saveHwm(date) {
  mkdirSync(AUTO_DIR, { recursive: true });
  const tmp = `${HWM_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastSyncDate: date }, null, 2), 'utf-8');
  renameSyncWithRetry(tmp, HWM_PATH);
}

// ── Seen-IDs dedup set ────────────────────────────────────────────────────────

/**
 * Load the set of already-processed message IDs.
 * @returns {Set<string>}
 */
export function loadSeenIds() {
  if (!existsSync(SEEN_PATH)) return new Set();
  try {
    const data = JSON.parse(readFileSync(SEEN_PATH, 'utf-8'));
    if (Array.isArray(data?.seenIds)) return new Set(data.seenIds);
  } catch { /* start fresh */ }
  return new Set();
}

/**
 * Append new IDs to the seen set and save atomically. Trims to SEEN_IDS_MAX.
 * @param {Set<string>} existing
 * @param {string[]} newIds
 */
export function saveSeenIds(existing, newIds) {
  mkdirSync(AUTO_DIR, { recursive: true });
  const merged = [...existing, ...newIds];
  const trimmed = merged.length > SEEN_IDS_MAX
    ? merged.slice(merged.length - SEEN_IDS_MAX)
    : merged;
  const tmp = `${SEEN_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ seenIds: trimmed }, null, 2), 'utf-8');
  renameSyncWithRetry(tmp, SEEN_PATH);
}

// ── Neo availability check ────────────────────────────────────────────────────

/**
 * Check if BrowserOS Neo MCP is reachable.
 * Does a fast HTTP probe; Neo returns a non-200 or SSE header on any GET.
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkNeoAvailable() {
  // Use node's built-in http/https for a synchronous-style probe via spawnSync
  const probeScript = `
const http = require('http');
const u = new URL(${JSON.stringify(NEO_MCP_URL)});
const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET', timeout: 4000 }, (res) => {
  process.exit(res.statusCode < 500 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.end();
`;
  const res = spawnSync(process.execPath, ['-e', probeScript], { timeout: 6000 });
  if (res.status === 0) return { ok: true };
  return {
    ok: false,
    error: `BrowserOS Neo is not reachable at ${NEO_MCP_URL}.\n` +
      'Start BrowserOS Neo and ensure it is paired before running mail-sync.',
  };
}

// ── Prompt composition ────────────────────────────────────────────────────────

/**
 * Build the extraction prompt dispatched to the claude agent.
 * The agent must write a JSON array to `outputPath` and nothing else.
 *
 * @param {object} opts
 * @param {string} opts.sinceDate - YYYY-MM-DD, fetch messages after this date
 * @param {string} opts.outputPath - absolute path where agent writes the JSON
 * @param {number} opts.cap - max messages to return
 * @param {string} opts.userEmail - sender email to confirm correct account
 * @returns {string}
 */
export function buildExtractionPrompt({ sinceDate, outputPath, cap, userEmail }) {
  return `You are a read-only Gmail inbox extraction agent running inside BrowserOS Neo.

## STRICT READ-ONLY CONSTRAINT
You MUST NOT perform any action that mutates mailbox state. This means you MUST NOT:
- Archive, delete, or move any message
- Mark any message as read or unread
- Apply or remove any label
- Reply, forward, or compose any message
- Click any button that changes message state (e.g. "Archive", "Delete", "Mark as read")
Only navigation (clicking to open a message thread to read its content), scrolling, and reading are permitted.

## TASK
Open https://mail.google.com in a new browser tab.
Confirm you are signed in as ${userEmail} (check the account icon or profile area).
If signed in as a different account, stop and output: {"error": "wrong_account", "actual": "<email shown>"}

Navigate to the inbox. Find up to ${cap} messages received after ${sinceDate}.
For each qualifying message, extract:
  - id: a stable identifier — use the Gmail thread or message ID from the URL
    (e.g. from ?threadId=... or #inbox/<hash>), or construct a hash of sender+subject+date
  - from: the sender's email address (not display name alone)
  - subject: the full subject line
  - date: ISO-8601 date string (YYYY-MM-DD or full timestamp if available)
  - snippet: first 300 characters of the message body text (plain text, no HTML)

## HOW TO READ THE INBOX
1. Open https://mail.google.com
2. The inbox lists messages. For each message row, you can see sender, subject, and date.
3. To get the body snippet and message ID: click the message row to open the thread.
   After reading, use the browser back button to return to the inbox list.
   Do NOT click Archive or any other action button.
4. Stop after extracting ${cap} messages or when you reach messages older than ${sinceDate}.

## OUTPUT CONTRACT
When done, write a single valid JSON file to this exact path:
${outputPath}

The file must contain a JSON array (possibly empty []) where each element has:
{ "id": string, "from": string, "subject": string, "date": string, "snippet": string }

If you encounter an error (wrong account, Neo unavailable, inbox inaccessible), write:
{ "error": "<reason>" }

Write ONLY the JSON file. Do not output any other text or files.
Do NOT mark messages as read. Do NOT click Archive. Do NOT interact with ads or banners.`;
}

// ── Agent invocation ──────────────────────────────────────────────────────────

/**
 * Dispatch the claude agent with BrowserOS Neo MCP and wait for completion.
 *
 * Follows the same spawnSync pattern as apply-worker.mjs#runAgent:
 * - Writes prompt to audit dir
 * - Builds an mcp-config.json with the Neo remote SSE server
 * - Spawns claude -p with --dangerously-skip-permissions
 * - Agent stdout/stderr go to a log file (never mixed into our stdout)
 * - Returns { timedOut, exitCode }
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.auditDir
 * @param {number} opts.timeoutMins
 * @param {string} [opts.model]
 * @param {function} opts.log
 * @returns {{ timedOut: boolean, exitCode: number|null }}
 */
export function runMailAgent({ prompt, auditDir, timeoutMins, model, log }) {
  mkdirSync(auditDir, { recursive: true });

  // Write prompt to audit dir (no credentials to redact in this prompt)
  const promptPath = join(auditDir, 'prompt.md');
  writeFileSync(promptPath, prompt, 'utf-8');

  // Build MCP config: BrowserOS Neo as a remote SSE server
  const mcpConfig = {
    mcpServers: {
      browseros: {
        type: 'sse',
        url: NEO_MCP_URL,
      },
    },
  };
  const mcpPath = join(auditDir, 'mcp-config.json');
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');

  const env = { ...process.env };
  if (model) {
    env.ANTHROPIC_MODEL = model;
  }

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--mcp-config', mcpPath,
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
  ];

  log(`mail-sync: spawning claude (timeout ${timeoutMins}m, Neo MCP: ${NEO_MCP_URL})`);
  const started = Date.now();

  // Write agent output to file (avoids pipe-drain deadlock, same as apply-worker pattern)
  const outFd = openSync(join(auditDir, 'claude-output.txt'), 'w');
  const res = spawnSync('claude', args, {
    cwd: ROOT,
    env,
    timeout: timeoutMins * 60 * 1000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', outFd, outFd],
  });
  closeSync(outFd);

  const secs = Math.round((Date.now() - started) / 1000);
  if (res.error?.code === 'ETIMEDOUT') {
    log(`mail-sync: claude timed out after ${secs}s`);
    return { timedOut: true, exitCode: null };
  }
  log(`mail-sync: claude exited ${res.status} after ${secs}s`);
  return { timedOut: false, exitCode: res.status };
}

// ── Candidate filtering ───────────────────────────────────────────────────────

/**
 * Check if a message is potentially a job-related reply.
 * Fast pre-filter to avoid classifying all personal email.
 * Non-matching messages are never logged.
 *
 * @param {{ from: string, subject: string, snippet: string }} msg
 * @param {string[]} companyNames - normalized company names from the tracker
 * @returns {boolean}
 */
export function isPotentialJobReply(msg, companyNames) {
  const from = (msg.from || '').toLowerCase();
  const subject = (msg.subject || '').toLowerCase();
  const body = (msg.snippet || msg.body || '').toLowerCase();

  // Known ATS and recruiting sender domains
  const JOB_DOMAINS = [
    'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'myworkdayjobs.com',
    'icims.com', 'taleo.net', 'smartrecruiters.com', 'jobvite.com', 'breezy.hr',
    'recruitee.com', 'bamboohr.com', 'workable.com', 'pinpoint.co', 'teamtailor.com',
    'rippling.com', 'sequoiaats.com', 'comeet.co', 'paylocity.com', 'adp.com',
    'successfactors.com', 'oracle.com', 'dayforce.com', 'hire.google.com',
    'linkedin.com', 'indeed.com', 'ziprecruiter.com', 'hiring', 'recruiter',
    'careers', 'talent', 'noreply', 'no-reply',
  ];

  if (JOB_DOMAINS.some(d => from.includes(d))) return true;

  // Job-related subject keywords
  const JOB_SUBJECTS = [
    'application', 'interview', 'position', 'role', 'opportunity',
    'candidacy', 'candidate', 'recruiter', 'hiring', 'job offer',
    'assessment', 'screening', 'rejected', 'declined', 'unfortunately',
    'move forward', 'next steps', 'consider you', 'considered for',
    'thank you for applying', 'thank you for your application',
    'update on your', 'regarding your application',
  ];

  if (JOB_SUBJECTS.some(kw => subject.includes(kw))) return true;

  // Company name match — short names (≤4 chars) require word boundary
  const combined = `${from} ${subject} ${body.slice(0, 200)}`;
  for (const co of companyNames) {
    if (co.length < 3) continue;
    if (co.length <= 4) {
      const escaped = co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(combined)) return true;
    } else {
      const normCombined = combined.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normCombined.includes(co)) return true;
    }
  }

  return false;
}

// ── Parse agent JSON output ───────────────────────────────────────────────────

/**
 * Read and parse the JSON array written by the extraction agent.
 * Returns { messages, error } where error is null on success.
 *
 * @param {string} outputPath
 * @returns {{ messages: object[]|null, error: string|null }}
 */
export function parseAgentOutput(outputPath) {
  if (!existsSync(outputPath)) {
    return { messages: null, error: 'agent did not write output file' };
  }
  let raw;
  try {
    raw = readFileSync(outputPath, 'utf-8').trim();
  } catch (err) {
    return { messages: null, error: `cannot read output file: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { messages: null, error: `agent output is not valid JSON (first 200 chars: ${raw.slice(0, 200)})` };
  }
  // Error object from agent
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
    return { messages: null, error: `agent reported error: ${parsed.error}` };
  }
  // Must be an array
  if (!Array.isArray(parsed)) {
    return { messages: null, error: `agent output is not a JSON array (got ${typeof parsed})` };
  }
  return { messages: parsed, error: null };
}

// ── Main sync pipeline ────────────────────────────────────────────────────────

/**
 * Run one full sync cycle:
 * 1. Probe Neo availability
 * 2. Dispatch agent to extract messages from Gmail
 * 3. Parse agent output
 * 4. Pre-filter for job-related messages
 * 5. Dedup by message ID
 * 6. Classify via reply-ingest pipeline
 * 7. Append new candidates + update HWM and seen-IDs
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.backfill]
 * @param {function} [opts.log]
 * @returns {Promise<SyncResult>}
 */
export async function runSync(opts = {}) {
  const { dryRun = false, backfill = false, log = console.error } = opts;

  const db = await import('../core/db.mjs');
  const { ingestText, appendCandidates } = await import('./reply-ingest.mjs');

  // Build normalized company names for pre-filtering
  const apps = db.listApplications();
  const companyNames = [...new Set(
    apps.map(a => (a.company || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(c => c.length >= 3)
  )];

  // Determine since-date
  const hwm = backfill ? null : loadHwm();
  let sinceDate;
  if (hwm) {
    sinceDate = hwm.lastSyncDate;
  } else {
    const d = new Date();
    d.setDate(d.getDate() - BACKFILL_DAYS);
    sinceDate = d.toISOString().slice(0, 10);
  }

  // Build audit dir for this run
  const runTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const auditDir = join(AUTO_DIR, 'mail-sync', runTag);
  mkdirSync(auditDir, { recursive: true });

  // Output path: agent writes extracted messages here
  const outputPath = join(auditDir, 'extracted-messages.json');

  // Load user email from profile
  let userEmail = '0xhshah@gmail.com'; // fallback
  try {
    const yaml = await import('js-yaml');
    const profilePath = join(ROOT, 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      const profile = yaml.default.load(readFileSync(profilePath, 'utf-8'));
      if (profile?.candidate?.email) userEmail = profile.candidate.email;
    }
  } catch { /* use fallback */ }

  // Compose and dispatch extraction prompt
  const prompt = buildExtractionPrompt({ sinceDate, outputPath, cap: FETCH_CAP, userEmail });

  const run = runMailAgent({
    prompt,
    auditDir,
    timeoutMins: AGENT_TIMEOUT_MINS,
    log,
  });

  if (run.timedOut) {
    return {
      sinceDate, scanned: 0, skippedNotJob: 0, skippedAlreadySeen: 0,
      candidatesFound: 0, jobsUpdated: 0, dryRun,
      errors: [`agent timed out after ${AGENT_TIMEOUT_MINS}m`],
      auditDir,
    };
  }

  // Parse agent output
  const { messages, error: parseError } = parseAgentOutput(outputPath);
  if (parseError) {
    return {
      sinceDate, scanned: 0, skippedNotJob: 0, skippedAlreadySeen: 0,
      candidatesFound: 0, jobsUpdated: 0, dryRun,
      errors: [parseError],
      auditDir,
    };
  }

  // Process extracted messages
  const seenIds = loadSeenIds();
  const newSeenIds = [];
  let skippedNotJob = 0;
  let skippedAlreadySeen = 0;
  let candidatesFound = 0;
  let jobsUpdated = 0;
  const errors = [];

  for (const msg of messages) {
    const msgId = (msg.id || '').trim();

    // Dedup by message ID
    if (msgId && seenIds.has(msgId)) {
      skippedAlreadySeen++;
      continue;
    }

    // Pre-filter: is this potentially a job reply?
    if (!isPotentialJobReply(msg, companyNames)) {
      skippedNotJob++;
      if (msgId) { seenIds.add(msgId); newSeenIds.push(msgId); }
      continue;
    }

    // Classify via reply-ingest pipeline
    let proposal;
    try {
      const raw = [
        `Subject: ${msg.subject || ''}`,
        `From: ${msg.from || ''}`,
        '',
        msg.snippet || '',
      ].join('\n');
      proposal = await ingestText(raw, {});
    } catch (err) {
      errors.push(`classify error for msg ${msgId}: ${err.message}`);
      continue;
    }

    // Override message_id with stable extracted ID
    if (msgId) proposal.message_id = msgId;
    proposal.source = 'mail-sync';
    proposal.addedAt = localToday();

    candidatesFound++;
    if (proposal.matchedAppRef) jobsUpdated++;

    if (!dryRun) {
      try {
        appendCandidates([proposal]);
      } catch (err) {
        errors.push(`write error for msg ${msgId}: ${err.message}`);
      }
    }

    if (msgId) { seenIds.add(msgId); newSeenIds.push(msgId); }
  }

  // Persist state
  const today = localToday();
  if (!dryRun) {
    saveHwm(today);
    if (newSeenIds.length > 0) saveSeenIds(seenIds, newSeenIds);
  }

  return {
    sinceDate,
    scanned: messages.length,
    skippedNotJob,
    skippedAlreadySeen,
    candidatesFound,
    jobsUpdated,
    errors,
    dryRun,
    auditDir,
  };
}

/**
 * @typedef {object} SyncResult
 * @property {string} sinceDate
 * @property {number} scanned
 * @property {number} skippedNotJob
 * @property {number} skippedAlreadySeen
 * @property {number} candidatesFound
 * @property {number} jobsUpdated
 * @property {string[]} errors
 * @property {boolean} dryRun
 * @property {string} auditDir
 */

// ── Synthetic test pipeline (no browser, no network) ─────────────────────────

/**
 * Synthetic job-related messages for --test-pipeline mode.
 * Covers the main reply types the filter and classifier must handle.
 */
export const SYNTHETIC_TEST_MESSAGES = [
  {
    id: '<synthetic-test-reject-001@mail-sync-test>',
    from: 'noreply@greenhouse.io',
    subject: 'Update on your application at OpenAI',
    date: new Date().toISOString(),
    snippet: 'Thank you for your interest in the position at OpenAI. After careful consideration, we have decided to move forward with other candidates at this time.',
  },
  {
    id: '<synthetic-test-interview-002@mail-sync-test>',
    from: 'recruiting@stripe.com',
    subject: 'Interview Invitation - Software Engineer at Stripe',
    date: new Date().toISOString(),
    snippet: 'Hi Himanshu, We would like to invite you to schedule an interview with our engineering team at Stripe.',
  },
  {
    id: '<synthetic-test-assessment-003@mail-sync-test>',
    from: 'no-reply@ashbyhq.com',
    subject: 'Next steps: Technical Assessment',
    date: new Date().toISOString(),
    snippet: 'As a next step in your application, we would like you to complete a technical assessment.',
  },
  {
    id: '<synthetic-test-noise-004@mail-sync-test>',
    from: 'newsletter@cooking.example.com',
    subject: 'Weekly meal prep ideas',
    date: new Date().toISOString(),
    snippet: 'This week: easy chicken parmesan, roasted vegetables, and quick pasta dishes.',
  },
  {
    id: '<synthetic-test-noise-005@mail-sync-test>',
    from: 'friend@gmail.com',
    subject: 'Dinner Saturday?',
    date: new Date().toISOString(),
    snippet: 'Hey! Are you free for dinner this Saturday? New restaurant downtown.',
  },
];

/**
 * Run the full candidate pipeline with synthetic messages (no browser dispatch).
 * Used for --test-pipeline to verify the filter → classify → append path.
 */
export async function runTestPipeline(opts = {}) {
  const { dryRun = false } = opts;
  const db = await import('../core/db.mjs');
  const { ingestText, appendCandidates } = await import('./reply-ingest.mjs');

  const apps = db.listApplications();
  const companyNames = [...new Set(
    apps.map(a => (a.company || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(c => c.length >= 3)
  )];

  const seenIds = loadSeenIds();
  const newSeenIds = [];
  let skippedNotJob = 0;
  let skippedAlreadySeen = 0;
  let candidatesFound = 0;
  let jobsUpdated = 0;
  const errors = [];

  for (const msg of SYNTHETIC_TEST_MESSAGES) {
    const msgId = msg.id;
    if (msgId && seenIds.has(msgId)) { skippedAlreadySeen++; continue; }

    if (!isPotentialJobReply(msg, companyNames)) {
      skippedNotJob++;
      if (msgId) { seenIds.add(msgId); newSeenIds.push(msgId); }
      continue;
    }

    let proposal;
    try {
      const raw = [
        `Subject: ${msg.subject}`,
        `From: ${msg.from}`,
        '',
        msg.snippet || '',
      ].join('\n');
      proposal = await ingestText(raw, {});
    } catch (err) {
      errors.push(`classify error: ${err.message}`);
      continue;
    }

    if (msgId) proposal.message_id = msgId;
    proposal.source = 'mail-sync-test';
    proposal.addedAt = localToday();

    candidatesFound++;
    if (proposal.matchedAppRef) jobsUpdated++;

    if (!dryRun) {
      try { appendCandidates([proposal]); } catch (err) { errors.push(`write error: ${err.message}`); }
    }
    if (msgId) { seenIds.add(msgId); newSeenIds.push(msgId); }
  }

  if (!dryRun && newSeenIds.length > 0) {
    saveSeenIds(seenIds, newSeenIds);
  }

  return {
    mode: 'test-pipeline',
    scanned: SYNTHETIC_TEST_MESSAGES.length,
    skippedNotJob,
    skippedAlreadySeen,
    candidatesFound,
    jobsUpdated,
    errors,
    dryRun,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const jsonOut = argv.includes('--json');
  const backfill = argv.includes('--backfill');
  const testPipeline = argv.includes('--test-pipeline');

  const log = (msg) => console.error(msg); // stderr for progress; stdout for summary

  // --test-pipeline: run full pipeline with synthetic messages (no browser needed)
  if (testPipeline) {
    let result;
    try {
      result = await runTestPipeline({ dryRun });
    } catch (err) {
      if (jsonOut) console.log(JSON.stringify({ error: err.message }));
      else console.error(`mail-sync: test-pipeline error — ${err.message}`);
      process.exit(1);
    }
    if (jsonOut) {
      console.log(JSON.stringify(result));
    } else {
      const tag = dryRun ? '[dry-run] ' : '';
      console.log(`mail-sync: ${tag}mode=test-pipeline (synthetic messages, no browser)`);
      console.log(`  scanned=${result.scanned}  skipped(not-job)=${result.skippedNotJob}  skipped(seen)=${result.skippedAlreadySeen}`);
      console.log(`  candidates=${result.candidatesFound}  jobs-matched=${result.jobsUpdated}`);
      if (result.errors.length > 0) for (const e of result.errors) console.error(`  warn: ${e}`);
    }
    return;
  }

  // Check Neo availability before dispatching
  const neo = checkNeoAvailable();
  if (!neo.ok) {
    if (jsonOut) console.log(JSON.stringify({ error: 'neo_unavailable', detail: neo.error }));
    else console.error(`mail-sync: ${neo.error}`);
    process.exit(1); // non-zero: caller / panel knows Neo must be started
  }

  let result;
  try {
    result = await runSync({ dryRun, backfill, log });
  } catch (err) {
    if (jsonOut) console.log(JSON.stringify({ error: err.message }));
    else console.error(`mail-sync: error — ${err.message}`);
    process.exit(1);
  }

  if (jsonOut) {
    console.log(JSON.stringify(result));
  } else {
    const tag = dryRun ? '[dry-run] ' : '';
    console.log(`mail-sync: ${tag}since=${result.sinceDate}`);
    console.log(`  scanned=${result.scanned}  skipped(not-job)=${result.skippedNotJob}  skipped(seen)=${result.skippedAlreadySeen}`);
    console.log(`  candidates=${result.candidatesFound}  jobs-matched=${result.jobsUpdated}`);
    if (result.errors.length > 0) for (const e of result.errors) console.error(`  warn: ${e}`);
    if (result.auditDir) console.log(`  audit=${result.auditDir}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('mail-sync: fatal —', err.message);
    process.exit(1);
  });
}
