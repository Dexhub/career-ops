#!/usr/bin/env node
// auto/panel.mjs — Mission Control: the single UI for career-ops.
//
// One origin, http://127.0.0.1:3001 —
//   /auto            the automation dashboard (auto/panel.html)
//   /api/auto/*      panel API (status, jobs, drill-down, operator view,
//                    start/stop/pause, requeue single or bulk)
//   everything else  reverse-proxied to the upstream web UI on 127.0.0.1:3003
//                    (Host/Origin rewritten so its origin-guard passes; a small
//                    floating "Mission Control" link is injected into HTML)
//
// The upstream app under web/ is never patched — `npm run update` stays safe.
// The panel never applies to anything by itself; it only spawns/kills the
// same `node auto/run.mjs` the user would run in a terminal.
//
//   node auto/panel.mjs               # serve on 127.0.0.1:3001
//   node auto/panel.mjs --port 3001
//   node auto/panel.mjs --self-test

import './lib/sanitize-env.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJobs, loadJob, transition, submittedCountOn, STAGES } from './state.mjs';
import { loadAutoConfig } from './lib/config.mjs';
import { slugifySegment } from '../application-artifacts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_OWNER = join(ROOT, 'data', 'auto', 'orchestrator.lock', 'owner.json');
const RUN_LOG = join(ROOT, 'data', 'auto', 'run.log');
const OUTPUT_ROOT = join(ROOT, 'output');
const PANEL_HTML = join(ROOT, 'auto', 'panel.html');
const PAUSE_FLAG = join(ROOT, 'data', 'auto', 'pause-requested');
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.CAREER_OPS_WEB_PORT) || 3003 };

let panelChild = null; // cycle process started by this panel

// ---------- cycle control ----------

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function cycleState() {
  if (panelChild && processAlive(panelChild.pid)) {
    return { running: true, pid: panelChild.pid, source: 'panel', since: panelChild.startedAt };
  }
  try {
    const owner = JSON.parse(readFileSync(LOCK_OWNER, 'utf8'));
    if (owner?.pid && processAlive(owner.pid)) {
      return { running: true, pid: owner.pid, source: 'external', since: owner.started_at ?? null };
    }
  } catch { /* no lock, no cycle */ }
  return { running: false };
}

export function startCycle({ skipScan = false, cmd = null } = {}) {
  const state = cycleState();
  if (state.running) return { ok: false, error: `cycle already running (pid ${state.pid}, ${state.source})` };
  try { unlinkSync(PAUSE_FLAG); } catch { /* no stale pause */ }
  const logFd = openSync(RUN_LOG, 'a');
  const [bin, ...args] = cmd ?? [process.execPath, join(ROOT, 'auto', 'run.mjs'), ...(skipScan ? ['--skip-scan'] : [])];
  const child = spawn(bin, args, { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd); // the child holds its own copy
  child.startedAt = new Date().toISOString();
  child.on('exit', () => { if (panelChild === child) panelChild = null; });
  child.unref();
  panelChild = child;
  return { ok: true, pid: child.pid };
}

export function stopCycle() {
  const state = cycleState();
  if (!state.running) return { ok: false, error: 'no cycle running' };
  try {
    if (state.source === 'panel') process.kill(-state.pid, 'SIGTERM'); // whole group: run.mjs + stage children
    else process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: `kill failed: ${err.message}` };
  }
  if (state.source === 'panel') panelChild = null;
  return { ok: true, stopped: state.pid, source: state.source };
}

/** Graceful pause: the orchestrator finishes the in-flight apply, then stops
 *  before picking the next job (run.mjs checks the flag at the loop top). */
export function requestPause() {
  if (!cycleState().running) return { ok: false, error: 'no cycle running' };
  writeFileSync(PAUSE_FLAG, new Date().toISOString());
  return { ok: true };
}

export function cancelPause() {
  try { unlinkSync(PAUSE_FLAG); return { ok: true }; } catch { return { ok: false, error: 'no pause requested' }; }
}

export function pauseRequested() {
  return existsSync(PAUSE_FLAG);
}

// ---------- data readers ----------

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function jobSummaries() {
  const order = Object.fromEntries(STAGES.map((s, i) => [s, i]));
  return listJobs()
    .map((j) => ({
      urlKey: j.urlKey, url: j.url, company: j.company, role: j.role, ats: j.ats,
      stage: j.stage, score: j.score, attempts: j.attempts, lastError: j.lastError,
      auditDir: j.auditDir, updatedAt: j.timestamps?.at(-1)?.at ?? null,
    }))
    .sort((a, b) =>
      (order[a.stage] ?? 99) - (order[b.stage] ?? 99)
      || (b.score ?? 0) - (a.score ?? 0) // within a stage, highest score = next up
      || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/** Full detail for one job: state file plus every audit attempt with artifacts. */
export function jobDetail(urlKey) {
  const job = listJobs().find((j) => j.urlKey === urlKey);
  if (!job) return null;
  const attempts = [];
  if (job.auditDir) {
    const auditRoot = dirname(resolve(ROOT, job.auditDir));
    if (existsSync(auditRoot)) {
      for (const d of readdirSync(auditRoot, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith('attempt-')) continue;
        const dir = join(auditRoot, d.name);
        const rel = (f) => join(dir, f).slice(ROOT.length + 1);
        attempts.push({
          name: d.name,
          result: readJsonSafe(join(dir, 'result.json')),
          verdict: readJsonSafe(join(dir, 'verdict.json')),
          shots: readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map(rel),
          answersPath: existsSync(join(dir, 'answers.json')) ? rel('answers.json') : null,
        });
      }
      attempts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
  }
  return { job, attempts };
}

/** Serve a file strictly inside ROOT/output (audit artifacts only). */
export function safeOutputPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const abs = resolve(ROOT, relPath);
  if (!abs.startsWith(OUTPUT_ROOT + '/')) return null;
  if (!['.png', '.json', '.md', '.txt', '.yml', '.log'].includes(extname(abs))) return null;
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

/** parked/failed → queued with attempts reset. The state machine enforces legality. */
export function requeueJob(urlKey) {
  const job = loadJob(urlKey);
  if (!job) return { ok: false, error: 'job not found' };
  try {
    transition(job, 'queued', { attempts: 0, lastError: null });
    return { ok: true, stage: job.stage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Bulk retry: requeue each key independently; one refusal never blocks the rest. */
export function requeueJobs(keys) {
  const results = (Array.isArray(keys) ? keys : []).map((key) => ({ key, ...requeueJob(key) }));
  return { ok: results.every((r) => r.ok), requeued: results.filter((r) => r.ok).length, results };
}

function logTail(lines = 200) {
  try {
    const text = readFileSync(RUN_LOG, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// ---------- operator view: what each worker is doing right now ----------

/** Same app key the apply worker uses for output/<key>/audit/attempt-N. */
function appKeyFor(job) {
  const num = (job.reportPath?.match(/(\d+)/) || [])[1] || '000';
  return `${num}-${slugifySegment(job.company)}-${slugifySegment(job.role, 'role')}`;
}

/** Pure: classify run.log lines into worker streams and find the live task. */
export function parseWorkers(tail, running) {
  const lines = tail.split('\n').filter(Boolean);
  const last = (pred) => { for (let i = lines.length - 1; i >= 0; i--) if (pred(lines[i])) return { line: lines[i], i }; return null; };
  const lastEvalStart = last((l) => l.startsWith('eval-queue: evaluating '));
  const lastEvalDone = last((l) => l.startsWith('eval-queue: done'));
  const evalCurrent = running && lastEvalStart && (!lastEvalDone || lastEvalDone.i < lastEvalStart.i)
    ? lastEvalStart.line.replace('eval-queue: evaluating ', '') : null;

  const tailLine = lines.at(-1) ?? '';
  let activity = 'idle';
  if (running) {
    if (tailLine.startsWith('apply-worker:')) activity = 'applying';
    else if (tailLine.startsWith('run: jitter sleep')) activity = 'waiting (jitter between applies)';
    else if (tailLine.startsWith('eval-queue:')) activity = 'ranking';
    else if (tailLine.startsWith('resume-select:')) activity = 'selecting resumes';
    else if (lastEvalStart && evalCurrent) activity = 'ranking';
    else activity = tailLine.startsWith('run:') ? tailLine.replace(/^run:\s*/, '') : 'scanning / working';
  }
  const streamTail = (prefix, n = 8) => lines.filter((l) => l.startsWith(prefix)).slice(-n);
  return {
    activity,
    lastLine: tailLine,
    eval: { current: evalCurrent, recent: streamTail('eval-queue:') },
    apply: { recent: streamTail('apply-worker:') },
    scan: { recent: streamTail('scan') },
  };
}

/** Live detail of the in-flight apply attempt: audit files as they appear. */
function liveAttempt() {
  const applying = listJobs('applying')[0];
  if (!applying) return null;
  const job = loadJob(applying.urlKey);
  const attemptDir = join(OUTPUT_ROOT, appKeyFor(job), 'audit', `attempt-${job.attempts || 1}`);
  const startedAt = job.timestamps?.findLast?.((t) => t.stage === 'applying')?.at ?? null;
  let files = [];
  if (existsSync(attemptDir)) {
    files = readdirSync(attemptDir)
      .map((name) => {
        const abs = join(attemptDir, name);
        try {
          const st = statSync(abs);
          return { name, p: abs.slice(ROOT.length + 1), mtime: st.mtime.toISOString(), size: st.size };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }
  const shots = files.filter((f) => f.name.endsWith('.png'));
  return {
    urlKey: job.urlKey, company: job.company, role: job.role,
    attempt: job.attempts || 1, startedAt,
    attemptDir: attemptDir.slice(ROOT.length + 1),
    latestShot: shots[0] ?? null,
    files: files.slice(0, 20),
    result: readJsonSafe(join(attemptDir, 'result.json')),
  };
}

export function operatorPayload() {
  const cycle = cycleState();
  let logMtime = null;
  try { logMtime = statSync(RUN_LOG).mtime.toISOString(); } catch { /* no log yet */ }
  return {
    cycle,
    pauseRequested: pauseRequested(),
    lastActivityAt: logMtime,
    workers: parseWorkers(logTail(400), cycle.running),
    applying: liveAttempt(),
  };
}

function statusPayload() {
  const jobs = jobSummaries();
  const counts = {};
  for (const j of jobs) counts[j.stage] = (counts[j.stage] ?? 0) + 1;
  const applying = jobs.find((j) => j.stage === 'applying');
  let dailyLimit = null;
  try { dailyLimit = loadAutoConfig().daily_soft_limit ?? null; } catch { /* config absent */ }
  const day = new Date().toISOString().slice(0, 10);
  return {
    cycle: cycleState(),
    pauseRequested: pauseRequested(),
    counts,
    total: jobs.length,
    submittedToday: submittedCountOn(day),
    dailyLimit,
    workingOn: applying ? `${applying.company} — ${applying.role}` : null,
    digestToday: existsSync(join(ROOT, 'data', 'auto', `digest-${day}.md`)),
    logTail: logTail(),
  };
}

function digestToday() {
  const day = new Date().toISOString().slice(0, 10);
  const p = join(ROOT, 'data', 'auto', `digest-${day}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ---------- reverse proxy to the upstream web UI ----------

// Styled to the career-ops design system: brand burnt-orange pill
// (hsl(26 73% 51%), near-black foreground), rounded-full, Inter/system sans.
const NAV_SNIPPET = '<a href="/auto" style="position:fixed;right:16px;bottom:16px;z-index:99999;'
  + 'background:hsl(26 73% 51%);color:hsl(24 30% 12%);border-radius:999px;'
  + 'padding:8px 16px;font:500 13px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;text-decoration:none;'
  + 'box-shadow:0 1px 2px rgba(0,0,0,.15),0 4px 14px rgba(0,0,0,.18)">Mission Control</a>';

/** Pure: headers for the proxied upstream request (Host/Origin/Referer rewritten). */
export function rewriteProxyHeaders(headers) {
  const h = { ...headers };
  h.host = `${UPSTREAM.host}:${UPSTREAM.port}`;
  delete h['accept-encoding']; // identity responses so HTML can be injected
  if (h.origin) h.origin = `http://${UPSTREAM.host}:${UPSTREAM.port}`;
  if (h.referer) h.referer = h.referer.replace(/^https?:\/\/[^/]+/, `http://${UPSTREAM.host}:${UPSTREAM.port}`);
  return h;
}

/** Pure: inject the Mission Control link into an upstream HTML page. */
export function injectNav(html) {
  return html.includes('</body>') ? html.replace('</body>', `${NAV_SNIPPET}</body>`) : html + NAV_SNIPPET;
}

function proxyToUpstream(req, res) {
  const up = httpRequest({
    host: UPSTREAM.host, port: UPSTREAM.port, path: req.url,
    method: req.method, headers: rewriteProxyHeaders(req.headers),
  }, (ur) => {
    const type = ur.headers['content-type'] ?? '';
    if (type.includes('text/html')) {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const body = injectNav(Buffer.concat(chunks).toString('utf8'));
        const h = { ...ur.headers };
        delete h['content-length']; delete h['transfer-encoding']; delete h['content-encoding'];
        res.writeHead(ur.statusCode, { ...h, 'content-length': Buffer.byteLength(body) });
        res.end(body);
      });
    } else {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    }
  });
  up.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<body style="background:#101014;color:#d8d8e0;font:14px ui-monospace,monospace;padding:40px">'
      + '<h2>Upstream web UI is not responding</h2>'
      + `<p>Expected on ${UPSTREAM.host}:${UPSTREAM.port} (launchd service io.career-ops.web-ui).</p>`
      + '<p><a style="color:#58a6ff" href="/auto">&larr; Mission Control still works</a></p></body>');
  });
  req.pipe(up);
}

// ---------- http ----------

function hostAllowed(req) {
  const host = (req.headers.host ?? '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

export function createPanelServer() {
  return createServer(async (req, res) => {
    if (!hostAllowed(req)) return send(res, 403, { error: 'loopback only' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/auto' || p === '/auto/')) {
        return send(res, 200, readFileSync(PANEL_HTML, 'utf8'), 'text/html; charset=utf-8');
      }
      if (p.startsWith('/api/auto/')) {
        if (req.method === 'GET' && p === '/api/auto/status') return send(res, 200, statusPayload());
        if (req.method === 'GET' && p === '/api/auto/jobs') return send(res, 200, { jobs: jobSummaries() });
        if (req.method === 'GET' && p === '/api/auto/job') {
          const detail = jobDetail(url.searchParams.get('key'));
          return detail ? send(res, 200, detail) : send(res, 404, { error: 'job not found' });
        }
        if (req.method === 'GET' && p === '/api/auto/file') {
          const abs = safeOutputPath(url.searchParams.get('p'));
          if (!abs) return send(res, 404, { error: 'not found' });
          const types = { '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain', '.yml': 'text/plain', '.log': 'text/plain' };
          return send(res, 200, readFileSync(abs), types[extname(abs)]);
        }
        if (req.method === 'GET' && p === '/api/auto/operator') return send(res, 200, operatorPayload());
        if (req.method === 'GET' && p === '/api/auto/digest') {
          const text = digestToday();
          return text ? send(res, 200, text, 'text/plain; charset=utf-8') : send(res, 404, { error: 'no digest today' });
        }
        if (req.method === 'POST' && p === '/api/auto/start') {
          const body = await readBody(req);
          return send(res, 200, startCycle({ skipScan: !!body.skipScan }));
        }
        if (req.method === 'POST' && p === '/api/auto/stop') return send(res, 200, stopCycle());
        if (req.method === 'POST' && p === '/api/auto/pause') return send(res, 200, requestPause());
        if (req.method === 'POST' && p === '/api/auto/resume') return send(res, 200, cancelPause());
        if (req.method === 'POST' && p === '/api/auto/requeue') {
          const body = await readBody(req);
          return send(res, 200, body.keys ? requeueJobs(body.keys) : requeueJob(body.key));
        }
        return send(res, 404, { error: 'not found' });
      }
      return proxyToUpstream(req, res);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
}

// ---------- self-test / main ----------

function isMainModule(metaUrl) {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

async function selfTest() {
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`); if (!ok) failed++; };

  const s = statusPayload();
  check('status payload has cycle/counts/submittedToday/dailyLimit',
    'cycle' in s && 'counts' in s && typeof s.submittedToday === 'number' && 'dailyLimit' in s);
  check('panel.html exists', existsSync(PANEL_HTML));
  check('file guard rejects traversal', safeOutputPath('../cv.md') === null && safeOutputPath('/etc/passwd') === null);
  check('file guard rejects non-artifact extensions', safeOutputPath('output/x/audit/attempt-1/evil.sh') === null);

  const up = `${UPSTREAM.host}:${UPSTREAM.port}`;
  const h = rewriteProxyHeaders({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001', 'accept-encoding': 'gzip', referer: 'http://127.0.0.1:3001/jobs' });
  check('proxy rewrites host/origin/referer to upstream', h.host === up && h.origin === `http://${up}`
    && h.referer === `http://${up}/jobs` && !('accept-encoding' in h));
  check('nav injection lands before </body>', injectNav('<html><body>x</body></html>').includes('Mission Control</a></body>'));

  const w = parseWorkers('eval-queue: evaluating acme — CTO\napply-worker: spawning claude (timeout 25m)', true);
  check('parseWorkers: applying wins the activity line', w.activity === 'applying');
  check('parseWorkers: current eval surfaced', w.eval.current === 'acme — CTO');
  const w2 = parseWorkers('eval-queue: evaluating acme — CTO\neval-queue: done — 1 evaluated', true);
  check('parseWorkers: eval done clears current', w2.eval.current === null);
  check('parseWorkers: idle when not running', parseWorkers('x', false).activity === 'idle');
  const op = operatorPayload();
  check('operator payload has cycle/workers/applying', 'cycle' in op && 'workers' in op && 'applying' in op);
  check('file guard accepts .log inside output', safeOutputPath('output/../x.log') === null);

  // requeue against a temp jobs dir — never touches real state
  const os = await import('node:os');
  const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'auto-panel-'));
  const prevDir = process.env.CAREER_OPS_AUTO_JOBS_DIR;
  process.env.CAREER_OPS_AUTO_JOBS_DIR = tmp;
  try {
    const { createJob } = await import('./state.mjs');
    const { job } = createJob({ url: 'https://boards.greenhouse.io/acme/jobs/123', company: 'acme', role: 'cto' });
    for (const st of ['evaluated', 'queued', 'resume_ready', 'applying', 'failed']) transition(job, st, { attempts: 2 });
    const r = requeueJob(job.urlKey);
    check('requeue failed→queued resets attempts', r.ok === true && loadJob(job.urlKey).stage === 'queued' && loadJob(job.urlKey).attempts === 0);
    check('requeue refuses an illegal stage', requeueJob(job.urlKey).ok === false); // already queued
    const bulk = requeueJobs([job.urlKey, 'nonexistent']);
    check('bulk requeue reports per-key results', bulk.ok === false && bulk.results.length === 2 && bulk.requeued === 0);
  } finally {
    if (prevDir === undefined) delete process.env.CAREER_OPS_AUTO_JOBS_DIR;
    else process.env.CAREER_OPS_AUTO_JOBS_DIR = prevDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // start/stop checks only when no real cycle is running: stopCycle on an
  // external cycle would kill the user's live run (that is its job).
  if (cycleState().running) {
    console.log('skip - start/stop checks (a real cycle is running right now)');
  } else {
    const started = startCycle({ cmd: ['/bin/sleep', '30'] });
    check('startCycle spawns', started.ok === true && processAlive(started.pid));
    check('second start refused while running', startCycle({ cmd: ['/bin/sleep', '30'] }).ok === false);
    check('pause flag set while running', requestPause().ok === true && pauseRequested());
    check('cancel pause clears the flag', cancelPause().ok === true && !pauseRequested());
    const stopped = stopCycle();
    check('stopCycle kills the group', stopped.ok === true && stopped.source === 'panel');
    await new Promise((r) => setTimeout(r, 300));
    check('cycle reports not running after stop', cycleState().running === false);
  }

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await selfTest();
  } else {
    const port = Number(args[args.indexOf('--port') + 1]) || 3001;
    createPanelServer().listen(port, '127.0.0.1', () => {
      console.log(`mission control: http://127.0.0.1:${port}/auto (loopback only; proxies ${UPSTREAM.host}:${UPSTREAM.port})`);
    });
  }
}
