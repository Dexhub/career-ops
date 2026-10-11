#!/usr/bin/env node
// auto/learn.mjs — learning backfill CLI (T05, CONTRACTS B). Main-module guard
// only: nothing executes at import time. Read-only except for the explicitly
// requested dry-run report artifact and `backfill --apply` store commits.
//
//   node auto/learn.mjs inspect --json
//   node auto/learn.mjs backfill --dry-run --out <path>
//   node auto/learn.mjs backfill --apply --manifest <path>
//   node auto/learn.mjs rebuild --verify
//
// Never starts a worker, panel, model, or browser. Dry run writes ONLY the
// --out artifact (refused if it points inside the learning store).

import { existsSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { createLearningContext, learningDataRoot } from './learning/context.mjs';
import { rebuildIndexes } from './learning/store.mjs';
import { buildBackfillManifest, backfillHistory, discoverHistory } from './learning/evidence.mjs';

const USAGE = `Usage:
  node auto/learn.mjs inspect --json
  node auto/learn.mjs backfill --dry-run --out <path>
  node auto/learn.mjs backfill --apply --manifest <path>
  node auto/learn.mjs rebuild --verify`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (['out', 'manifest'].includes(name)) {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`);
      flags[name] = value;
      i += 1;
    } else if (['json', 'dry-run', 'apply', 'verify'].includes(name)) {
      flags[name] = true;
    } else {
      throw new Error(`unknown flag: --${name}`);
    }
  }
  return { command, flags };
}

function buildCtx() {
  const dataRoot = getCareerOpsRoot();
  const codeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return createLearningContext({ codeRoot, dataRoot, now: () => new Date() });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function summarize(entries, gaps) {
  const byAdapter = {};
  for (const e of entries) byAdapter[e.adapter] = (byAdapter[e.adapter] ?? 0) + 1;
  const gapsByType = {};
  for (const g of gaps) gapsByType[g.type] = (gapsByType[g.type] ?? 0) + 1;
  return {
    entries: entries.length,
    settled: entries.filter((e) => e.settled).length,
    unsettled: entries.filter((e) => !e.settled).length,
    byAdapter,
    coverageGaps: gaps.length,
    gapsByType,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  const ctx = buildCtx();

  if (command === 'inspect') {
    // Read-only discovery; --json is the only output form.
    const { entries, gaps } = discoverHistory(ctx);
    print({ dataRoot: ctx.dataRoot, ...summarize(entries, gaps) });
    return 0;
  }

  if (command === 'backfill') {
    if (flags['dry-run'] && flags.apply) throw new Error('--dry-run and --apply are mutually exclusive');
    if (flags['dry-run']) {
      if (!flags.out) throw new Error('backfill --dry-run requires --out <path>');
      const outPath = resolve(flags.out);
      const storeRoot = learningDataRoot(ctx);
      if (outPath === storeRoot || outPath.startsWith(storeRoot + sep)) {
        throw new Error('--out must not point inside the learning store');
      }
      const manifest = buildBackfillManifest(ctx);
      writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
      print({ wrote: outPath, ...manifest.summary });
      return 0;
    }
    if (flags.apply) {
      if (!flags.manifest) throw new Error('backfill --apply requires --manifest <path>');
      const summary = await backfillHistory(ctx, { manifestPath: resolve(flags.manifest), apply: true });
      print(summary);
      return 0;
    }
    throw new Error('backfill requires --dry-run or --apply');
  }

  if (command === 'rebuild') {
    if (!flags.verify) throw new Error('rebuild requires --verify');
    if (!existsSync(learningDataRoot(ctx))) {
      // No store: report that honestly without creating one.
      print({ store: 'absent', note: 'no learning store exists; nothing to rebuild' });
      return 0;
    }
    const applied = await rebuildIndexes(ctx, { apply: true });
    const check = await rebuildIndexes(ctx, { apply: false });
    const countsMatch = JSON.stringify(applied.counts) === JSON.stringify(check.counts);
    print({ generation: applied.generation, counts: applied.counts, errors: applied.errors, verified: countsMatch });
    return countsMatch ? 0 : 1;
  }

  throw new Error(`unknown command: ${String(command)}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
