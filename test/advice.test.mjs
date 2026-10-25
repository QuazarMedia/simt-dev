// The advice engine (plan 0003 R40): bench history in, a tier sentence out.
//
// The tests hold two properties. The advice is evidence rather than opinion — a tier is
// named only when the history has a run that resolved a similar task, and the claim says
// the numbers it came from. And the advice is deterministic — the same runs directory
// gives the same sentence, ties and all, so a review of a packet can re-derive the claim.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { advise, briefAdvice, loadHistory, METRIC_NOTE, tierOfRank } from '../src/advice/advice.mjs';
import { git } from './fixture.mjs';

const BIN = new URL('../bin/simt-dev.mjs', import.meta.url).pathname;

async function runCli(root, args) {
  try {
    const { stdout, stderr } = await promisify(execFile)('node', [BIN, ...args, '--root', root], {
      maxBuffer: 8 << 20,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A row in loadHistory's output shape, convenient to write assertions against. */
function histRun(overrides = {}) {
  return {
    task: 't-x',
    model: 'mini',
    resolved: true,
    cost: 0.001,
    tokens: 1000,
    toolCalls: 4,
    files: 2,
    kind: 'bugfix',
    ...overrides,
  };
}

test('the tier ladder is thirds, and a short ladder keeps its honesty', () => {
  assert.equal(tierOfRank(0, 1), 'small');
  assert.deepEqual([tierOfRank(0, 2), tierOfRank(1, 2)], ['small', 'default']);
  assert.deepEqual([tierOfRank(0, 3), tierOfRank(1, 3), tierOfRank(2, 3)], ['small', 'default', 'frontier']);
  assert.deepEqual(
    [tierOfRank(0, 4), tierOfRank(1, 4), tierOfRank(2, 4), tierOfRank(3, 4)],
    ['small', 'small', 'default', 'frontier'],
  );
});

test('no history, no advice — not a made-up tier', () => {
  assert.equal(advise({ kind: 'bugfix', files: 2 }, { runs: [] }), null);
});

test('a history without this kind advises nothing and says why', () => {
  const history = { runs: [histRun({ kind: 'docs', task: 't-d' })] };
  const outcome = advise({ kind: 'bugfix', files: 2 }, history);
  assert.equal(outcome.picked, null);
  assert.match(outcome.caution, /holds no bugfix task/);
});

test('a neighborhood where nothing resolved advises nothing', () => {
  const history = {
    runs: [histRun({ resolved: false }), histRun({ resolved: false, task: 't-2' })],
  };
  const outcome = advise({ kind: 'bugfix', files: 2 }, history);
  assert.equal(outcome.picked, null);
  assert.match(outcome.caution, /no model resolved/);
});

test('the cheapest class that resolved is the pick, and small is its tier when the ladder is short', () => {
  const history = {
    runs: [
      histRun({ model: 'dear', cost: 0.5, tokens: 90000 }),
      histRun({ model: 'mini', cost: 0.002, tokens: 4000, task: 't-2' }),
    ],
  };
  const outcome = advise({ kind: 'bugfix', files: 2 }, history);
  assert.match(outcome.picked.line, /^small model, /);
  assert.match(outcome.picked.basis, /cheapest that resolved: mini \(median cost \$0\.0020\)/);
  assert.match(outcome.picked.basis, /2 bugfix tasks/);
  assert.equal(outcome.picked.metric, METRIC_NOTE);
});

test('cheap never beats resolved: a class that failed for less money is not the pick', () => {
  const history = {
    runs: [
      histRun({ model: 'cheap', cost: 0.001, tokens: 2000, resolved: false }),
      histRun({ model: 'dear', cost: 0.4, tokens: 80000, task: 't-2' }),
    ],
  };
  const outcome = advise({ kind: 'bugfix', files: 2 }, history);
  assert.match(outcome.picked.basis, /cheapest that resolved: dear/);
});

test('a ladder with three classes can name the frontier honestly', () => {
  const history = {
    runs: [
      // The two cheaper classes fail on this kind's tasks; only the dear one resolved one,
      // so the pick is the estate's top rung.
      histRun({ model: 'a', cost: 0.001, tokens: 2000, resolved: false }),
      histRun({ model: 'b', cost: 0.01, tokens: 8000, resolved: false, task: 't-2' }),
      histRun({ model: 'c', cost: 0.9, tokens: 150000, task: 't-3' }),
    ],
  };
  const outcome = advise({ kind: 'bugfix', files: 2 }, history);
  assert.equal(outcome.picked.line, 'frontier model, no plan mode');
});

test('tool effort is relative to the estate median, not a constant', () => {
  const history = {
    runs: [
      histRun({ model: 'busy', cost: 0.002, tokens: 5000, toolCalls: 44 }),
      histRun({ model: 'busy', cost: 0.002, tokens: 5000, toolCalls: 40, task: 't-2' }),
      histRun({ model: 'quiet', cost: 0.3, tokens: 100000, toolCalls: 10, task: 't-4' }),
    ],
  };
  // Estate median over resolved history is 40; the pick's own median is 42, which is what
  // "heavier than typical" means when the ladder only contains the estate's own runs.
  const busy = advise({ kind: 'bugfix', files: 2 }, history);
  assert.equal(busy.picked.line, 'small model, plan first');
  const quiet = advise(
    { kind: 'bugfix', files: 1 },
    { runs: [histRun({ model: 'quiet', cost: 0.3, tokens: 100000, toolCalls: 2 })] },
  );
  assert.equal(quiet.picked.line, 'small model, no plan mode');
});

test('without a prices table the pick is ordered in tokens, and says so', () => {
  const history = {
    runs: [
      histRun({ model: 'dear', cost: 0, tokens: 400000, task: 't-1' }),
      histRun({ model: 'mini', cost: 0, tokens: 9000, task: 't-2' }),
    ],
  };
  const outcome = advise({ kind: 'bugfix', files: 2 }, history);
  assert.match(outcome.picked.basis, /cheapest that resolved: mini \(median tokens 9000\)/);
});

test('equal evidence breaks the tie on the name, the same way every time', () => {
  const history = {
    runs: [
      histRun({ model: 'zeta', cost: 0.002, tokens: 5000 }),
      histRun({ model: 'alpha', cost: 0.002, tokens: 5000, task: 't-2' }),
    ],
  };
  const outcome = advise({ kind: 'bugfix', files: 2 }, history);
  assert.match(outcome.picked.basis, /cheapest that resolved: alpha/);
});

test('the file window specializes only a neighborhood with evidence to spare', () => {
  // Six same-kind tasks is enough to try the window (NARROW_MIN_POOL); the cheaper class
  // resolved only tasks far beyond the factor-of-two window around the estimate, so only
  // the dearer class stands inside it with three resolved runs.
  const runs = [
    histRun({ model: 'mini', cost: 0.001, tokens: 3000, files: 40 }),
    histRun({ model: 'mini', cost: 0.001, tokens: 3000, files: 40, task: 't-2' }),
    histRun({ model: 'mini', cost: 0.001, tokens: 3000, files: 40, task: 't-3' }),
    histRun({ model: 'maxi', cost: 0.5, tokens: 120000, files: 9 }),
    histRun({ model: 'maxi', cost: 0.5, tokens: 120000, files: 9, task: 't-5' }),
    histRun({ model: 'maxi', cost: 0.5, tokens: 120000, files: 9, task: 't-6' }),
  ];
  const outcome = advise({ kind: 'bugfix', files: 8 }, { runs });
  assert.ok(outcome.picked, JSON.stringify(outcome));
  assert.match(outcome.picked.basis, /3 bugfix tasks/);
  assert.match(outcome.picked.basis, /cheapest that resolved: maxi/);
});

test('loadHistory reads the stored records and the mined descriptors behind them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'advice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsDir = join(root, '.simt-dev', 'bench', 'runs', 'stub-current-r1');
  const tasksDir = join(root, '.simt-dev', 'bench', 'tasks');
  await mkdir(tasksDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  const descriptor = {
    schemaVersion: 1,
    id: 't-abc1234-01',
    prompt: 'fix the flaky keep helper in src/keep.mjs',
    gold: { files: 3, linesAdded: 12, linesRemoved: 4 },
  };
  await writeFile(join(tasksDir, `${descriptor.id}.json`), `${JSON.stringify(descriptor, null, 2)}\n`);
  await writeFile(
    join(runsDir, `${descriptor.id}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        task: descriptor.id,
        arm: 'current',
        harness: 'stub',
        model: 'stub-model',
        rep: 1,
        resolved: true,
        gatesPassed: true,
        usage: { input: 1000, output: 500, turns: 3, toolCalls: 7 },
        costUsd: 0.004,
        diff: { files: 2, linesAdded: 5, linesRemoved: 1 },
        skills: {},
        probe: null,
      },
      null,
      2,
    )}\n`,
  );
  const history = await loadHistory(root);
  assert.equal(history.runs.length, 1);
  const [row] = history.runs;
  assert.equal(row.kind, 'bugfix');
  assert.equal(row.files, 3);
  assert.equal(row.resolved, true);
  assert.equal(row.cost, 0.004);
  assert.equal(row.toolCalls, 7);
});

test('a record without its mined task stays honest, and a task nobody ran is no evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'advice-orphans-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsDir = join(root, '.simt-dev', 'bench', 'runs', 'stub-current-r1');
  const tasksDir = join(root, '.simt-dev', 'bench', 'tasks');
  await mkdir(tasksDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await writeFile(
    join(tasksDir, 't-aaa1111-01.json'),
    `${JSON.stringify({ schemaVersion: 1, id: 't-aaa1111-01', prompt: 'rename the keep helper', gold: { files: 4, linesAdded: 9, linesRemoved: 9 } }, null, 2)}\n`,
  );
  await writeFile(
    join(runsDir, 't-bbb2222-01.json'),
    `${JSON.stringify({ schemaVersion: 1, task: 't-bbb2222-01', model: 'ghost', resolved: true, usage: {}, costUsd: 0.003, diff: { files: 1 } }, null, 2)}\n`,
  );
  const history = await loadHistory(root);
  // The row joins on records: a mined task with no stored run has no cost evidence, so it
  // produces no advice row rather than a guess about which model would have run it; and a
  // run whose descriptor is gone keeps its row with kind null — unable to join any
  // neighborhood, which is the local bedrock of the verify line below. The descriptor can
  // only reclassify a run that happened.
  assert.deepEqual(history.runs.map((row) => [row.kind, row.files]), [[null, 1]]);
});

test('the brief carries the advice in its header when the history has the evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'advice-brief-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value;\n}\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  assert.equal(await briefAdvice(root, { task: 'fix the keep helper' }), null);

  const tasksDir = join(root, '.simt-dev', 'bench', 'tasks');
  const runsDir = join(root, '.simt-dev', 'bench', 'runs', 'stub-mini-r1');
  await mkdir(tasksDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  const descriptor = {
    schemaVersion: 1,
    id: 't-abb1234-01',
    prompt: 'fix the flaky keep helper in src/keep.mjs',
    gold: { files: 2, linesAdded: 4, linesRemoved: 0 },
  };
  await writeFile(join(tasksDir, `${descriptor.id}.json`), `${JSON.stringify(descriptor, null, 2)}\n`);
  await writeFile(
    join(runsDir, `${descriptor.id}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        task: descriptor.id,
        arm: 'mini',
        harness: 'stub',
        model: 'small-class',
        rep: 1,
        resolved: true,
        gatesPassed: true,
        usage: { turns: 3, toolCalls: 6 },
        costUsd: 0.002,
        diff: { files: 2 },
        skills: {},
        probe: null,
      },
      null,
      2,
    )}\n`,
  );

  const advice = await briefAdvice(root, { task: 'fix the keep helper' });
  assert.ok(advice?.picked, JSON.stringify(advice));
  assert.equal(advice.picked.line, 'small model, no plan mode');
  assert.match(advice.picked.basis, /1 bugfix task/);

  const { stdout, code } = await runCli(root, ['brief', 'fix the keep helper', '--budget', '0']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('\nADVICE\n'), stdout);
  assert.ok(stdout.includes('small model, no plan mode'), stdout);
  assert.ok(stdout.includes('advisory until a held-out bench'), stdout);
});

test('a brief without bench history stays quiet about models', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'advice-quiet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value;\n}\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  const { code, stdout } = await runCli(root, ['brief', 'fix the keep helper', '--budget', '0']);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('ADVICE'), stdout);
});
