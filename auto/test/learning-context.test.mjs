// auto/test/learning-context.test.mjs — T01: isolated context, roots, config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createLearningFixture, fixedClock } from './helpers/learning.mjs';
import {
  createLearningContext, readLearningConfig, learningDataRoot,
  learningCodePath, learningConfigPath, LEARNING_CONFIG_DEFAULTS,
} from '../learning/context.mjs';

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

// Safety check (not acceptance): live config files must be byte-identical
// before and after this suite.
const liveFiles = ['config/auto.yml', 'config/learning.yml']
  .map((p) => join(repoRoot, p))
  .filter((p) => existsSync(p));
const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let liveHashesBefore;

let fixture;
before(() => {
  liveHashesBefore = liveFiles.map(hashOf);
  fixture = createLearningFixture();
});
after(() => {
  fixture.cleanup();
  assert.deepEqual(liveFiles.map(hashOf), liveHashesBefore,
    'live config files changed during the learning-context suite');
});

test('the fixture root is a scratch directory, never the checkout', () => {
  const realTmp = realpathSync(tmpdir());
  assert.ok(fixture.dataRoot.startsWith(realTmp + sep), 'fixture must live under tmpdir');
  assert.ok(!fixture.dataRoot.startsWith(repoRoot), 'fixture must not live inside the repo');
  assert.ok(!repoRoot.startsWith(fixture.dataRoot), 'repo must not live inside the fixture');
  assert.equal(process.env.CAREER_OPS_ROOT, fixture.root);
  assert.ok(process.env.CAREER_OPS_DB.startsWith(fixture.root + sep));
});

test('an isolated context never inherits the code checkout as its data root', () => {
  const ctx = createLearningContext({ codeRoot: '/fixture/code', dataRoot: '/fixture/data', now: () => new Date('2026-10-11T00:00:00Z') });
  assert.equal(ctx.dataRoot, '/fixture/data');
  assert.equal(ctx.codeRoot, '/fixture/code');
  assert.equal(ctx.now().toISOString(), '2026-10-11T00:00:00.000Z');
});

test('context validation: roots must be absolute nonempty strings, clock defaults', () => {
  assert.throws(() => createLearningContext({ codeRoot: '', dataRoot: '/x' }), /codeRoot/);
  assert.throws(() => createLearningContext({ codeRoot: '/x' }), /dataRoot/);
  assert.throws(() => createLearningContext({ codeRoot: 'relative/path', dataRoot: '/x' }), /absolute/);
  assert.throws(() => createLearningContext({ codeRoot: '/x', dataRoot: '/y', now: 'nope' }), /now/);
  const ctx = createLearningContext({ codeRoot: '/x', dataRoot: '/y' });
  assert.ok(ctx.now() instanceof Date);
  assert.ok(Object.isFrozen(ctx));
});

test('source paths resolve from codeRoot; private state resolves from dataRoot', () => {
  const ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  assert.equal(learningCodePath(ctx, 'auto', 'prompts', 'x.md'),
    join(fixture.codeRoot, 'auto', 'prompts', 'x.md'));
  assert.ok(learningDataRoot(ctx).startsWith(fixture.dataRoot + sep));
  assert.equal(learningDataRoot(ctx), join(fixture.dataRoot, 'data', 'auto', 'learning'));
  assert.ok(!learningDataRoot(ctx).startsWith(fixture.codeRoot));
  // Config is private state: it reads from dataRoot even when codeRoot has one.
  writeFileSync(join(fixture.codeRoot, 'config', 'learning.yml'), 'schema_version: 1\nenabled: true\n');
  assert.equal(learningConfigPath(ctx), join(fixture.dataRoot, 'config', 'learning.yml'));
  const config = readLearningConfig(ctx); // dataRoot has no config yet
  assert.equal(config.enabled, false, 'codeRoot config must not leak into dataRoot resolution');
});

test('missing config yields disabled defaults (CONTRACTS F verbatim)', () => {
  const ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  const config = readLearningConfig(ctx);
  assert.deepEqual(config, structuredClone(LEARNING_CONFIG_DEFAULTS));
  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'shadow');
  assert.equal(config.review.enabled, false);
  assert.equal(config.cloud.enabled, false);
  assert.equal(config.cloud.daily_usd_cap, 0);
});

test('valid config merges over defaults with strict validation', () => {
  const ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  const path = learningConfigPath(ctx);
  writeFileSync(path, 'schema_version: 1\nenabled: true\nretrieval:\n  max_candidates: 5\n');
  const config = readLearningConfig(ctx);
  assert.equal(config.enabled, true);
  assert.equal(config.retrieval.max_candidates, 5);
  assert.equal(config.retrieval.max_context_bytes, 24000); // default preserved
  assert.equal(config.capture.max_artifact_bytes, 2097152);
  writeFileSync(path, 'schema_version: 1\nqueue:\n  mode: not_a_mode\n');
  assert.throws(() => readLearningConfig(ctx), (err) => err.code === 'CONFIG_MALFORMED');
  writeFileSync(path, 'schema_version: 1\nsurprise_key: 1\n');
  assert.throws(() => readLearningConfig(ctx), (err) => err.code === 'CONFIG_MALFORMED');
  writeFileSync(path, 'schema_version: 1\nenabled: "yes"\n');
  assert.throws(() => readLearningConfig(ctx), (err) => err.code === 'CONFIG_MALFORMED');
});

test('malformed config throws and is never overwritten; future version refused', () => {
  const ctx = createLearningContext({ codeRoot: fixture.codeRoot, dataRoot: fixture.dataRoot, now: fixedClock() });
  const path = learningConfigPath(ctx);
  const garbage = 'enabled: [unclosed\n  ::: not yaml {{{';
  writeFileSync(path, garbage);
  assert.throws(() => readLearningConfig(ctx), (err) => err.code === 'CONFIG_MALFORMED');
  assert.equal(readFileSync(path, 'utf-8'), garbage, 'malformed config must not be rewritten');
  writeFileSync(path, 'schema_version: 2\nenabled: false\n');
  assert.throws(() => readLearningConfig(ctx), (err) => err.code === 'CONFIG_UNSUPPORTED_VERSION');
  writeFileSync(path, 'just a string');
  assert.throws(() => readLearningConfig(ctx), (err) => err.code === 'CONFIG_MALFORMED');
});

test('the checked-in config/learning.yml is CONTRACTS F defaults, enabled only in shadow mode (T2.1)', () => {
  // Read-only look at the checkout: parse it through the same validator by
  // pointing a context's dataRoot at the repo root (no writes happen).
  // Shadow = defaults with enabled:true; review/cloud/queue stay at defaults.
  // active-lite (T-active-lite): reuse.enabled and reuse.auto_approve_safe are
  // additionally true in the checked-in config (the bridge is live in shadow mode).
  const ctx = createLearningContext({ codeRoot: repoRoot, dataRoot: repoRoot, now: fixedClock() });
  const config = readLearningConfig(ctx);
  assert.deepEqual(config, {
    ...structuredClone(LEARNING_CONFIG_DEFAULTS),
    enabled: true,
    mode: 'shadow',
    reuse: { enabled: true, auto_approve_safe: true, max_context_bytes: 0 },
  });
});
