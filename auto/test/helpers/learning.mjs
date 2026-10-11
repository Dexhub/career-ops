// auto/test/helpers/learning.mjs — isolated fixture root for learning tests
// (T01). Creates a mkdtemp scratch directory with the synthetic layout, points
// CAREER_OPS_ROOT and CAREER_OPS_DB at it before any store access, and cleans
// up only what it created. Nothing executes at import time.

import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const FIXTURE_PREFIX = 'career-learning-';

/**
 * createLearningFixture() -> {root, codeRoot, dataRoot, cleanup}
 * dataRoot is the scratch root itself (config/, data/auto/jobs, output,
 * reports, jds beneath it); codeRoot is a synthetic sibling tree so tests can
 * prove code/data separation. cleanup removes ONLY the helper-created root
 * and restores the environment variables it set.
 */
export function createLearningFixture() {
  const realTmp = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(realTmp, FIXTURE_PREFIX)));
  for (const dir of [
    'config', 'data/auto/jobs', 'output', 'reports', 'jds',
    'code/config', 'code/auto/prompts',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const prevRoot = process.env.CAREER_OPS_ROOT;
  const prevDb = process.env.CAREER_OPS_DB;
  // Set before any module could resolve paths from the environment: the
  // learning modules take an explicit ctx, but this guards every fallback.
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_DB = join(root, 'career-ops-test.db');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (prevRoot === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = prevRoot;
    if (prevDb === undefined) delete process.env.CAREER_OPS_DB;
    else process.env.CAREER_OPS_DB = prevDb;
    // Remove only the helper-created root: it must live under tmpdir and
    // carry the fixture prefix, or we refuse to delete anything.
    const base = root.slice(root.lastIndexOf(sep) + 1);
    if (root.startsWith(realTmp + sep) && base.startsWith(FIXTURE_PREFIX)) {
      rmSync(root, { recursive: true, force: true });
    }
  };

  return { root, codeRoot: join(root, 'code'), dataRoot: root, cleanup };
}

/** Fixed injected clock for deterministic timestamps. */
export function fixedClock(iso = '2026-10-11T00:00:00Z') {
  return () => new Date(iso);
}
