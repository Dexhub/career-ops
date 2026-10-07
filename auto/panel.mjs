#!/usr/bin/env node
// auto/panel.mjs — Mission Control: the single UI for career-ops.
//
// One origin, http://127.0.0.1:3002 —
//   /auto            the automation dashboard (auto/panel.html)
//   /api/auto/*      panel API (status, jobs, drill-down, start/stop, requeue)
//   everything else  reverse-proxied to the upstream web UI on 127.0.0.1:3001
//                    (Host/Origin rewritten so its origin-guard passes; a small
//                    floating "Mission Control" link is injected into HTML)
//
// The upstream app under web/ is never patched — `npm run update` stays safe.
// The panel never applies to anything by itself; it only spawns/kills the
// same `node auto/run.mjs` the user would run in a terminal.
//
//   node auto/panel.mjs               # serve on 127.0.0.1:3002
//   node auto/panel.mjs --port 3002
//   node auto/panel.mjs --self-test

import './lib/sanitize-env.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJobs, loadJob, transition, submittedCountOn, STAGES } from './state.mjs';
import { loadAutoConfig } from './lib/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_OWNER = join(ROOT, 'data', 'auto', 'orchestrator.lock', 'owner.json');
const RUN_LOG = join(ROOT, 'data', 'auto', 'run.log');
const OUTPUT_ROOT = join(ROOT, 'output');
const PANEL_HTML = join(ROOT, 'auto', 'panel.html');
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.CAREER_OPS_WEB_PORT) || 3001 };

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
  if (!['.png', '.json', '.md', '.txt', '.yml'].includes(extname(abs))) return null;
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

function logTail(lines = 200) {
  try {
    const text = readFileSync(RUN_LOG, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch { return ''; }
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

const NAV_SNIPPET = '<a href="/auto" style="position:fixed;right:16px;bottom:16px;z-index:99999;'
  + 'background:#101014;color:#d8d8e0;border:1px solid #3a3a44;border-radius:20px;'
  + 'padding:8px 16px;font:600 13px/1 system-ui,sans-serif;text-decoration:none;'
  + 'box-shadow:0 2px 12px rgba(0,0,0,.5)">&#9881; Mission Control</a>';

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
          const types = { '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain', '.yml': 'text/plain' };
          return send(res, 200, readFileSync(abs), types[extname(abs)]);
        }
        if (req.method === 'GET' && p === '/api/auto/digest') {
          const text = digestToday();
          return text ? send(res, 200, text, 'text/plain; charset=utf-8') : send(res, 404, { error: 'no digest today' });
        }
        if (req.method === 'POST' && p === '/api/auto/start') {
          const body = await readBody(req);
          return send(res, 200, startCycle({ skipScan: !!body.skipScan }));
        }
        if (req.method === 'POST' && p === '/api/auto/stop') return send(res, 200, stopCycle());
        if (req.method === 'POST' && p === '/api/auto/requeue') {
          const body = await readBody(req);
          return send(res, 200, requeueJob(body.key));
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

  const h = rewriteProxyHeaders({ host: '127.0.0.1:3002', origin: 'http://127.0.0.1:3002', 'accept-encoding': 'gzip', referer: 'http://127.0.0.1:3002/jobs' });
  check('proxy rewrites host/origin/referer to upstream', h.host === '127.0.0.1:3001' && h.origin === 'http://127.0.0.1:3001'
    && h.referer === 'http://127.0.0.1:3001/jobs' && !('accept-encoding' in h));
  check('nav injection lands before </body>', injectNav('<html><body>x</body></html>').includes('Mission Control</a></body>'));

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
    const port = Number(args[args.indexOf('--port') + 1]) || 3002;
    createPanelServer().listen(port, '127.0.0.1', () => {
      console.log(`mission control: http://127.0.0.1:${port}/auto (loopback only; proxies ${UPSTREAM.host}:${UPSTREAM.port})`);
    });
  }
}
