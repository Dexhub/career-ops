#!/usr/bin/env node
// auto/panel.mjs — local control panel for the auto/ layer.
//
// One file, no dependencies. Serves http://127.0.0.1:3002 with:
//   - start/stop of the orchestrator cycle (node auto/run.mjs)
//   - live queue: every job with stage, score, attempts, failure reason
//   - per-job drill-down: audit attempts, verdict vs agent claim, parked
//     reasons, missing answers, and the screenshots the worker saved
//   - run.log tail
//
// The panel never applies to anything by itself; it only spawns/kills the
// same `node auto/run.mjs` the user would run in a terminal.
//
//   node auto/panel.mjs               # serve on 127.0.0.1:3002
//   node auto/panel.mjs --port 3002
//   node auto/panel.mjs --self-test

import './lib/sanitize-env.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJobs, submittedCountOn, STAGES } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_OWNER = join(ROOT, 'data', 'auto', 'orchestrator.lock', 'owner.json');
const RUN_LOG = join(ROOT, 'data', 'auto', 'run.log');
const OUTPUT_ROOT = join(ROOT, 'output');

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
    .sort((a, b) => (order[a.stage] ?? 99) - (order[b.stage] ?? 99) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
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

function logTail(lines = 60) {
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
  return {
    cycle: cycleState(),
    counts,
    total: jobs.length,
    submittedToday: submittedCountOn(new Date().toISOString().slice(0, 10)),
    workingOn: applying ? `${applying.company} — ${applying.role}` : null,
    logTail: logTail(),
  };
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
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, statusPayload());
      if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, { jobs: jobSummaries() });
      if (req.method === 'GET' && url.pathname === '/api/job') {
        const detail = jobDetail(url.searchParams.get('key'));
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'job not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const abs = safeOutputPath(url.searchParams.get('p'));
        if (!abs) return send(res, 404, { error: 'not found' });
        const types = { '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain', '.yml': 'text/plain' };
        return send(res, 200, readFileSync(abs), types[extname(abs)]);
      }
      if (req.method === 'POST' && url.pathname === '/api/start') {
        const body = await readBody(req);
        return send(res, 200, startCycle({ skipScan: !!body.skipScan }));
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') return send(res, 200, stopCycle());
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
}

// ---------- page ----------

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>career-ops auto panel</title>
<style>
  :root{color-scheme:dark}
  body{font:14px/1.5 ui-monospace,Menlo,monospace;background:#101014;color:#d8d8e0;margin:0;padding:20px;max-width:1100px;margin-inline:auto}
  h1{font-size:16px;display:flex;align-items:center;gap:10px}
  .dot{width:10px;height:10px;border-radius:50%;background:#555;display:inline-block}
  .dot.on{background:#3fb950;box-shadow:0 0 8px #3fb950}
  button{background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer}
  button.stop{background:#da3633}button:disabled{opacity:.4;cursor:default}
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
  .chip{background:#1b1b22;border:1px solid #2a2a33;border-radius:14px;padding:2px 10px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  td,th{padding:5px 8px;border-bottom:1px solid #22222a;text-align:left;vertical-align:top}
  tr.job{cursor:pointer}tr.job:hover{background:#17171d}
  .stage{border-radius:10px;padding:1px 8px;font-size:12px;background:#30363d}
  .stage.submitted{background:#1a5c2a}.stage.failed,.stage.parked{background:#6e2b2b}
  .stage.applying{background:#8a6d00}.stage.queued,.stage.resume_ready{background:#1f4b7a}
  .err{color:#f0883e;font-size:12px}
  #detail{background:#15151b;border:1px solid #2a2a33;border-radius:8px;padding:14px;margin:14px 0;display:none}
  #detail img{max-width:100%;border:1px solid #333;border-radius:6px;margin:6px 0}
  pre{background:#0b0b0e;padding:10px;border-radius:6px;overflow:auto;max-height:260px;white-space:pre-wrap}
  .muted{color:#777}
  a{color:#58a6ff}
</style>
<h1><span class="dot" id="dot"></span>career-ops auto panel
  <span id="working" class="muted"></span>
  <span style="flex:1"></span>
  <label class="muted"><input type="checkbox" id="skipScan" checked> skip scan</label>
  <button id="start">Start cycle</button>
  <button id="stop" class="stop">Stop</button>
</h1>
<div class="chips" id="chips"></div>
<div id="detail"></div>
<table id="jobs"><thead><tr><th>stage</th><th>company</th><th>role</th><th>score</th><th>att</th><th>last error / reason</th></tr></thead><tbody></tbody></table>
<h3 class="muted">run.log</h3>
<pre id="log"></pre>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function refresh(){
  const s=await (await fetch('/api/status')).json();
  $('dot').className='dot'+(s.cycle.running?' on':'');
  $('working').textContent=s.cycle.running?('cycle running (pid '+s.cycle.pid+(s.workingOn?', on: '+s.workingOn:'')+')'):'idle';
  $('start').disabled=s.cycle.running; $('stop').disabled=!s.cycle.running;
  $('chips').innerHTML=Object.entries(s.counts).map(([k,v])=>'<span class="chip">'+esc(k)+': <b>'+v+'</b></span>').join('')
    +'<span class="chip">submitted today: <b>'+s.submittedToday+'</b></span>';
  $('log').textContent=s.logTail||'(empty)';
  const j=await (await fetch('/api/jobs')).json();
  $('jobs').querySelector('tbody').innerHTML=j.jobs.map(x=>
    '<tr class="job" data-key="'+esc(x.urlKey)+'"><td><span class="stage '+esc(x.stage)+'">'+esc(x.stage)+'</span></td><td>'+esc(x.company)+
    '</td><td>'+esc(x.role)+'</td><td>'+(x.score??'—')+'</td><td>'+(x.attempts||0)+'</td><td class="err">'+esc(x.lastError??'')+'</td></tr>').join('');
}
document.addEventListener('click',async e=>{
  const row=e.target.closest('tr.job');
  if(row) return showDetail(row.dataset.key);
  if(e.target.id==='start'){await fetch('/api/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({skipScan:$('skipScan').checked})});refresh();}
  if(e.target.id==='stop'){await fetch('/api/stop',{method:'POST'});setTimeout(refresh,800);}
});
async function showDetail(key){
  const r=await fetch('/api/job?key='+encodeURIComponent(key));
  if(!r.ok)return;
  const {job,attempts}=await r.json();
  let h='<b>'+esc(job.company)+' — '+esc(job.role)+'</b> <span class="stage '+esc(job.stage)+'">'+esc(job.stage)+'</span>'
    +' <a href="'+esc(job.url)+'" target="_blank">posting</a><br>'
    +'<span class="muted">score '+(job.score??'—')+' · attempts '+(job.attempts||0)+' · '+esc(job.ats||'?')+'</span>';
  if(job.lastError)h+='<div class="err">'+esc(job.lastError)+'</div>';
  h+='<div class="muted">'+job.timestamps.map(t=>esc(t.stage)+' @ '+esc(t.at.slice(0,19).replace('T',' '))).join(' → ')+'</div>';
  for(const a of attempts){
    h+='<hr><b>'+esc(a.name)+'</b>';
    if(a.verdict)h+=' — verdict: <b>'+esc(a.verdict.status??'?')+'</b>'+(a.verdict.reason?' <span class="err">('+esc(a.verdict.reason)+')</span>':'');
    if(a.result){
      h+='<div>agent claim: '+esc(a.result.status??'?')+(a.result.parked_reason?' · parked_reason: <span class="err">'+esc(a.result.parked_reason)+'</span>':'')+'</div>';
      if(a.result.missing?.length)h+='<div class="err">missing: '+a.result.missing.map(m=>esc(m.label)+' ('+esc(m.needed)+')').join('; ')+'</div>';
    }
    if(a.answersPath)h+='<div><a href="/api/file?p='+encodeURIComponent(a.answersPath)+'" target="_blank">answers.json</a></div>';
    for(const s of a.shots)h+='<div class="muted">'+esc(s.split('/').pop())+'</div><img loading="lazy" src="/api/file?p='+encodeURIComponent(s)+'">';
  }
  if(!attempts.length)h+='<div class="muted">no apply attempts yet</div>';
  $('detail').innerHTML=h; $('detail').style.display='block'; $('detail').scrollIntoView({behavior:'smooth'});
}
refresh(); setInterval(refresh,4000);
</script>`;

// ---------- self-test / main ----------

function isMainModule(metaUrl) {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

async function selfTest() {
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`); if (!ok) failed++; };

  const s = statusPayload();
  check('status payload has cycle/counts/submittedToday', 'cycle' in s && 'counts' in s && typeof s.submittedToday === 'number');
  check('file guard rejects traversal', safeOutputPath('../cv.md') === null && safeOutputPath('/etc/passwd') === null);
  check('file guard rejects non-artifact extensions', safeOutputPath('output/x/audit/attempt-1/evil.sh') === null);

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
      console.log(`auto panel: http://127.0.0.1:${port} (loopback only)`);
    });
  }
}
