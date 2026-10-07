#!/usr/bin/env node
/**
 * auto/resume-library.mjs — Phase 3: pre-built resume variants.
 *
 * One PDF per `config/auto.yml: resume_variants` entry, built from cv.md via
 * the existing pipeline (build-cv-html.mjs → generate-pdf.mjs) and gated by
 * verify-cv-facts.mjs. Variants differ ONLY in the headline title under the
 * candidate name (candidate.title) — every other byte comes verbatim from
 * cv.md, so the fact gate holds by construction.
 *
 * Library layout: data/auto/resume-library/<role-slug>/{cv.html,cv.pdf,meta.json}
 * A variant is rebuilt when sha256(cv.md + title + PARSER_VERSION) changes.
 *
 * Usage:
 *   node auto/resume-library.mjs            # build/refresh all variants
 *   node auto/resume-library.mjs --force    # rebuild even when hash matches
 *   node auto/resume-library.mjs --limit 2  # build at most N (smoke test)
 *   node auto/resume-library.mjs --self-test
 */
import './lib/sanitize-env.mjs';

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { loadAutoConfig } from './lib/config.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CV_PATH = join(ROOT, 'cv.md');
// Bump when parseCv() output changes shape/content, so stale PDFs rebuild.
const PARSER_VERSION = '1';

export function libraryDir() {
  return process.env.CAREER_OPS_AUTO_LIBRARY_DIR || join(ROOT, 'data/auto/resume-library');
}

export function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// cv.md → build-cv-html payload (deterministic, no model in the loop)
// ---------------------------------------------------------------------------

/** Split markdown into {heading, level, lines[]} blocks. */
function splitSections(md) {
  const sections = [];
  let current = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      current = { level: m[1].length, heading: m[2].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

function bullets(lines) {
  return lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).replace(/\*\*/g, '').trim());
}

/**
 * Parse cv.md into the HTML builder's payload (lib/cv-payload-schema.mjs).
 * Known deliberate drops: "Earlier Roles" (no Company — Role header, pre-2013
 * internships) and the Languages section (no matching template block).
 * @returns {{payload: object, warnings: string[]}}
 */
export function parseCv(md) {
  const warnings = [];
  const sections = splitSections(md);
  const payload = { candidate: {}, summary: '', competencies: [], experience: [], projects: [], education: [], awards: [], skills: [] };

  // H1 = name; following non-blank lines = location / email · phone / [LinkedIn](url)
  const h1 = sections.find(s => s.level === 1);
  if (!h1) throw new Error('cv.md: no H1 name heading');
  payload.candidate.name = h1.heading;
  const contact = h1.lines.map(l => l.trim()).filter(Boolean);
  for (const line of contact) {
    const link = line.match(/\[LinkedIn\]\((\S+)\)/i);
    if (link) { payload.candidate.linkedin = { url: link[1], display: 'LinkedIn' }; continue; }
    if (line.includes('@')) {
      const parts = line.split('·').map(p => p.trim());
      for (const p of parts) {
        if (p.includes('@')) payload.candidate.email = p;
        else if (/\+?[\d-]{7,}/.test(p)) payload.candidate.phone = p;
      }
      continue;
    }
    if (!payload.candidate.location) payload.candidate.location = line;
  }

  let mode = null; // which H2 we are inside, for H3 handling
  for (const s of sections) {
    if (s.level === 2) {
      const h = s.heading.toLowerCase();
      if (h === 'summary') {
        payload.summary = s.lines.map(l => l.trim()).filter(Boolean).join(' ');
        mode = null;
      } else if (h.includes('leadership profile')) {
        // "**Tag:** long text" bullets → short competency tags from the bold lead-ins.
        for (const l of s.lines) {
          const m = l.match(/^-\s+\*\*(.+?):?\*\*/);
          if (m) payload.competencies.push(m[1].replace(/:$/, ''));
        }
        mode = null;
      } else if (h === 'experience') mode = 'experience';
      else if (h.includes('projects')) mode = 'projects';
      else if (h === 'education') mode = 'education';
      else if (h === 'skills') {
        for (const l of s.lines) {
          const m = l.match(/^-\s+\*\*(.+?):\*\*\s*(.+)$/);
          if (m) payload.skills.push({ category: m[1], items: m[2].trim() });
        }
        mode = null;
      } else if (h === 'publication' || h === 'publications') mode = 'publication';
      else {
        if (h !== 'languages') warnings.push(`unhandled section: ${s.heading}`);
        mode = null;
      }
      continue;
    }
    if (s.level !== 3) continue;

    if (mode === 'experience') {
      const m = s.heading.match(/^(.+?)\s+—\s+(.+)$/);
      if (!m) { warnings.push(`experience entry skipped (no "Company — Role"): ${s.heading}`); continue; }
      const entry = { company: m[1].trim(), role: m[2].trim(), bullets: bullets(s.lines) };
      const meta = s.lines.map(l => l.trim()).find(l => l && !l.startsWith('- '));
      if (meta) {
        const parts = meta.split('·').map(p => p.trim());
        if (parts.length > 1) { entry.location = parts[0]; entry.dates = parts.slice(1).join(' · '); }
        else entry.dates = parts[0];
      }
      payload.experience.push(entry);
    } else if (mode === 'projects') {
      payload.projects.push({ name: s.heading, bullets: bullets(s.lines) });
    } else if (mode === 'education') {
      // "Degree · years · GPA: x" line under "### School"
      const meta = s.lines.map(l => l.trim()).find(Boolean) || '';
      const parts = meta.split('·').map(p => p.trim());
      payload.education.push({
        title: parts[0] || s.heading,
        org: s.heading,
        year: parts[1] || '',
        description: parts.slice(2).join(' · '),
      });
    } else if (mode === 'publication') {
      const meta = s.lines.map(l => l.trim()).find(Boolean) || '';
      const yearM = meta.match(/\b(19|20)\d{2}\b/);
      payload.awards.push({
        title: s.heading,
        org: meta.split('·')[0].replace(/\[.*\]\(.*\)/, '').trim(),
        year: yearM ? yearM[0] : '',
      });
    }
  }
  return { payload, warnings };
}

// ---------------------------------------------------------------------------
// Build one variant
// ---------------------------------------------------------------------------

function run(script, args) {
  const res = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT, encoding: 'utf-8', timeout: 5 * 60 * 1000,
  });
  return { ok: res.status === 0, out: `${res.stdout || ''}\n${res.stderr || ''}`.trim() };
}

export function variantHash(cvMd, title) {
  return createHash('sha256').update(`${PARSER_VERSION}\n${title}\n${cvMd}`).digest('hex');
}

/**
 * Build (or skip) one variant. @returns {{title, slug, pdf, status, error?}}
 * status: 'fresh' | 'built' | 'failed'
 */
export function buildVariant({ title, basePayload, cvMd, force = false, log = console.log }) {
  const slug = slugify(title);
  const dir = join(libraryDir(), slug);
  const metaPath = join(dir, 'meta.json');
  const pdfPath = join(dir, 'cv.pdf');
  const hash = variantHash(cvMd, title);

  if (!force && existsSync(metaPath) && existsSync(pdfPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.hash === hash) return { title, slug, pdf: pdfPath, status: 'fresh' };
    } catch { /* corrupt meta — rebuild */ }
  }

  mkdirSync(dir, { recursive: true });
  const payload = { ...basePayload, candidate: { ...basePayload.candidate, title } };
  const payloadPath = join(dir, 'payload.json');
  const htmlPath = join(dir, 'cv.html');
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf-8');

  log(`resume-library: building ${slug}`);
  const html = run('build-cv-html.mjs', [payloadPath, htmlPath]);
  if (!html.ok) return { title, slug, pdf: null, status: 'failed', error: `build-cv-html: ${html.out.split('\n').slice(-3).join(' | ')}` };

  // Fact gate (plan Phase 3): every variant must pass before it can be used.
  const facts = run('verify-cv-facts.mjs', [htmlPath]);
  if (!facts.ok) return { title, slug, pdf: null, status: 'failed', error: `fact-gate: ${facts.out.split('\n').slice(-3).join(' | ')}` };

  // generate-pdf re-runs the fact check internally for kind=cv; harmless.
  const pdf = run('generate-pdf.mjs', [htmlPath, pdfPath, '--kind=cv']);
  if (!pdf.ok) return { title, slug, pdf: null, status: 'failed', error: `generate-pdf: ${pdf.out.split('\n').slice(-3).join(' | ')}` };

  const tmp = `${metaPath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ title, slug, hash, builtAt: new Date().toISOString(), pdf: pdfPath }, null, 2), 'utf-8');
  renameSync(tmp, metaPath);
  return { title, slug, pdf: pdfPath, status: 'built' };
}

/** Build all configured variants. @returns results[] */
export function buildLibrary({ force = false, limit, log = console.log } = {}) {
  const cfg = loadAutoConfig();
  const variants = cfg.resume_variants || [];
  if (variants.length === 0) throw new Error('config/auto.yml: resume_variants is empty');
  const cvMd = readFileSync(CV_PATH, 'utf-8');
  const { payload, warnings } = parseCv(cvMd);
  for (const w of warnings) log(`resume-library: note — ${w}`);

  const todo = limit ? variants.slice(0, limit) : variants;
  const results = [];
  for (const title of todo) {
    const r = buildVariant({ title, basePayload: payload, cvMd, force, log });
    if (r.status === 'failed') log(`resume-library: FAILED ${r.slug} — ${r.error}`);
    results.push(r);
  }
  const built = results.filter(r => r.status === 'built').length;
  const fresh = results.filter(r => r.status === 'fresh').length;
  const failed = results.filter(r => r.status === 'failed').length;
  log(`resume-library: done — ${built} built, ${fresh} fresh, ${failed} failed (${results.length} variants)`);
  return results;
}

/** All usable variants currently on disk: [{title, slug, pdf}] */
export function listLibrary() {
  const cfg = loadAutoConfig();
  const out = [];
  for (const title of cfg.resume_variants || []) {
    const slug = slugify(title);
    const pdf = join(libraryDir(), slug, 'cv.pdf');
    if (existsSync(pdf)) out.push({ title, slug, pdf });
  }
  return out;
}

// ---------------------------------------------------------------------------
function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
    if (!cond) failures++;
  };
  const md = readFileSync(CV_PATH, 'utf-8');
  const { payload } = parseCv(md);
  check('candidate name parsed', payload.candidate.name === 'Himanshu Shah');
  check('candidate email parsed', (payload.candidate.email || '').includes('@'));
  check('summary non-trivial', payload.summary.length > 200);
  check('competencies extracted', payload.competencies.length >= 4);
  check('experience entries parsed', payload.experience.length >= 5);
  check('every experience entry has company+role+bullets',
    payload.experience.every(e => e.company && e.role && e.bullets.length > 0));
  check('AWS dates parsed', (payload.experience[0].dates || '').includes('2025'));
  check('Apple location parsed', payload.experience.some(e => e.company === 'Apple' && e.location));
  check('projects parsed', payload.projects.length >= 5);
  check('education has 2 entries with title+org', payload.education.length === 2 && payload.education.every(e => e.title && e.org));
  check('skills categories parsed', payload.skills.length >= 8 && payload.skills.every(s => s.category && s.items));
  check('publication → awards', payload.awards.length === 1 && payload.awards[0].year === '2014');
  check('slugify', slugify('Head of AI Strategy & Adoption') === 'head-of-ai-strategy-adoption');
  check('variantHash stable', variantHash('x', 't') === variantHash('x', 't') && variantHash('x', 't') !== variantHash('x', 'u'));
  console.log(failures === 0 ? 'self-test: all passed' : `self-test: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) selfTest();
  else {
    const limit = flagValue(args, '--limit');
    const results = buildLibrary({ force: hasFlag(args, '--force'), limit: limit ? Number(limit) : undefined });
    process.exit(results.some(r => r.status === 'failed') ? 1 : 0);
  }
}
