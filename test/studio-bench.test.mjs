// ST14: the Bench reads `bench report`, `bench replay` and `bench calibrate` as documents,
// draws the report as bars, names every failing task, and labels an absent optional package.
//
// The optional package is present in this checkout, so the absent state is asserted as a
// view state; the document path is asserted against the CLI's own JSON on a fixture vault.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio, treeDigest } from './studio-fixture.mjs';
import { calibrationView, bench, barChart, replayView } from '../src/studio/public/bench.js';
import { benchInput, benchPayload } from '../src/studio/bench.mjs';

async function vault(files) {
  const root = await realpath(await fixtureRepo());
  const runs = join(root, '.simt', 'bench', 'runs', 'claude-bare-r1');
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, 'task-one.json'), JSON.stringify({
    schemaVersion: 1, task: 'task-one', arm: 'bare', harness: 'claude', model: 'sonnet', rep: 1,
    resolved: false, gatesPassed: false, usage: { input: 1000, cacheWrite: 0, cacheRead: 0, output: 100, turns: 2, toolCalls: 1 },
    diff: { files: 1, outsideBlastRadius: 0 }, probe: null,
  }));
  await writeFile(join(runs, 'task-two.json'), JSON.stringify({
    schemaVersion: 1, task: 'task-two', arm: 'bare', harness: 'claude', model: 'sonnet', rep: 1,
    resolved: true, gatesPassed: true, usage: { input: 1000, cacheWrite: 0, cacheRead: 0, output: 100, turns: 2, toolCalls: 1 },
    diff: { files: 1, outsideBlastRadius: 0 }, probe: null,
  }));
  for (const [rel, body] of Object.entries(files ?? {})) await writeFile(join(root, rel), body);
  return root;
}

test('the report payload equals `bench report --json` and names the failing task', async () => {
  const root = await vault();
  const payload = await benchPayload(root);
  const cli = await simt(['bench', 'report', '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(payload, JSON.parse(cli.stdout));
  assert.deepEqual(payload.failures, [{ task: 'task-one', arm: 'bare', harness: 'claude', model: 'sonnet' }]);
  const html = bench(payload);
  assert.match(html, /data-failing-task="task-one"/);
  assert.match(html, /task-one/);
  assert.match(html, /resolved share by arm/);
  assert.match(html, /<svg/);
});

test('a comparison renders paired deltas and the verdict verbatim', async () => {
  const root = await vault();
  const kernel = join(root, '.simt', 'bench', 'runs', 'claude-kernel-r1');
  await mkdir(kernel, { recursive: true });
  for (const task of ['task-one', 'task-two']) {
    await writeFile(join(kernel, `${task}.json`), JSON.stringify({
      schemaVersion: 1, task, arm: 'kernel', harness: 'claude', model: 'sonnet', rep: 1,
      resolved: true, gatesPassed: true, usage: { input: 1000, cacheWrite: 0, cacheRead: 0, output: 100, turns: 2, toolCalls: 1 },
      diff: { files: 1, outsideBlastRadius: 0 }, probe: null,
    }));
  }
  const payload = await benchPayload(root, ['bare', 'kernel']);
  const cli = await simt(['bench', 'report', '--compare', 'bare', 'kernel', '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(payload, JSON.parse(cli.stdout));
  const html = bench(payload);
  assert.match(html, /Comparison: kernel vs bare/);
  assert.match(html, /paired-bar/);
  assert.match(html, new RegExp(`data-delta="resolved"[\\s\\S]*${Number(payload.comparison.deltas.R).toFixed(3)}`));
  assert.match(html, new RegExp(payload.comparison.verdict));
});

test('an absent optional package is a labelled install state, not a refusal', () => {
  const html = bench({ ok: true, absent: true, error: 'the bench is not installed', remedy: 'install @simt-dev/bench' });
  assert.match(html, /bench is not installed/);
  assert.match(html, /npm install simt-dev @simt-dev\/bench/);
  assert.doesNotMatch(html, /Refused/);
});

test('calibration prints the decision and bound, replay prints the relation verdicts', () => {
  const calibration = calibrationView({
    ok: true,
    measured: { samples: 10, falseAccepts: 1, falseAcceptRate: 0.1, disagreement: 0 },
    decision: { decision: 'blocked', bound: 0.2, reason: 'not enough labels' },
  });
  assert.match(calibration, /blocked/);
  assert.match(calibration, /0\.2/);
  assert.match(calibration, /not enough labels/);
  const replay = replayView({ ok: true, trace: { replayable: true, missing: [] }, metamorphic: { holds: true, results: [{ holds: true, relation: 'same-outcome', reason: 'irrelevant change' }] } });
  assert.match(replay, /replayable/);
  assert.match(replay, /HOLDS<\/strong> same-outcome/);
});

test('the bench routes serve the CLI documents and an offline input reads inside the root only', async (t) => {
  const root = await vault({ 'bench-calibration.json': JSON.stringify({ pairs: [], scope: 'test', capability: 'judge' }) });
  const before = await treeDigest(root);
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);

  const report = await httpReq(studio.port, { path: '/api/bench', headers: { cookie } });
  assert.equal(report.status, 200, report.body);
  const cliReport = await simt(['bench', 'report', '--json'], { cwd: root });
  assert.equal(cliReport.code, 0, cliReport.stderr);
  assert.deepEqual(JSON.parse(report.body), JSON.parse(cliReport.stdout));

  const input = await httpReq(studio.port, { path: '/api/bench/calibrate?input=bench-calibration.json', headers: { cookie } });
  assert.equal(input.status, 200, input.body);
  const cliInput = await simt(['bench', 'calibrate', '--input', join(root, 'bench-calibration.json'), '--json'], { cwd: root });
  // A blocked calibration is a verdict, and the CLI exits nonzero for it.
  assert.ok([0, 1].includes(cliInput.code), cliInput.stderr);
  assert.deepEqual(JSON.parse(input.body), JSON.parse(cliInput.stdout));

  const escaped = await httpReq(studio.port, { path: '/api/bench/calibrate?input=../outside.json', headers: { cookie } });
  assert.equal(escaped.status, 403);
  assert.equal(await treeDigest(root), before);
});

test('the bar chart scales a share to the bar and an unmeasured recall is labelled', () => {
  const svg = barChart('resolved', [{ label: 'a', value: 0.5 }]);
  assert.match(svg, /width="95"/);
  assert.match(svg, /50\.0%/);
  const html = bench({ ok: true, runCount: 0, pricesLoaded: false, arms: [], failures: [], mapRecall: { measured: false, reason: 'not run' } });
  assert.match(html, /Unmeasured/);
  assert.match(html, /not run/);
});
