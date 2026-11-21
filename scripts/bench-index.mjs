#!/usr/bin/env node
// The incremental-index benchmark, separate from the correctness suite.
//
// `test/index.test.mjs` used to assert a 300 ms wall-clock budget beside a test of
// which rows changed. A loaded runner failed the second claim while the first was
// true, and the failure was reported as a correctness failure. The work-set answer
// stays there; the budget lives here, on a fixed 400-file fixture, with a declared
// budget and repeated samples.
//
// This is a qualification step, not a unit test: run it alone. `npm run qualify:offline`
// runs it after the suite, and the qualification job does the same on each runner.
// A regression in incremental work is an order-of-magnitude change, not a few ms, so
// the budget is deliberately far above the observed value and far below the cost of
// rebuilding every row.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { reindex } from '../src/index/store.mjs';

const exec = promisify(execFile);

/** A predeclared budget for one changed file in a 400-file tree. */
const BUDGET_MS = 750;
/** Samples after one warm-up; the median is the reported figure. */
const SAMPLES = 7;
const FILES = 400;

const git = (args, cwd) =>
  exec('git', ['-c', 'user.name=simt-dev benchmark', '-c', 'user.email=tests@simt.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'simt-index-bench-'));
  await git(['init', '-q'], root);
  await mkdir(join(root, 'src'), { recursive: true });
  for (let i = 0; i < FILES; i += 1) {
    await writeFile(join(root, 'src', `f${i}.js`), `export const n = ${i};\n`);
  }
  await git(['add', '-A'], root);
  await git(['commit', '-qm', 'initial'], root);
  return root;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const root = await fixture();
  try {
    await reindex(root);
    const samples = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const file = join(root, 'src', 'f0.js');
      await writeFile(file, `export const n = ${1000 + i};\n`);
      await git(['add', 'src/f0.js'], root);
      const result = await reindex(root);
      samples.push(result.ms);
      if (result.updated !== 1) {
        throw new Error(`sample ${i + 1} rewrote ${result.updated} rows, expected 1`);
      }
    }
    const middle = median(samples);
    const report = {
      ok: middle <= BUDGET_MS,
      command: 'bench-index',
      files: FILES,
      samples,
      medianMs: middle,
      budgetMs: BUDGET_MS,
      loadAverage1m: loadavg()[0],
      cpus: cpus().length,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`bench-index: ${error.message}\n`);
    process.exit(1);
  },
);
