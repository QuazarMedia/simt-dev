import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { git, tempDir } from '../../fixture.mjs';

const scope = 'handbook';
const current = 'handbook/current.md';
const archive = 'handbook/archive.md';
const other = 'handbook/other.md';
const board = 'handbook/work.json';
const cache = '.simt/local/corpus/handbook.json';
const claimed = [current, archive, other];
const now = () => process.hrtime.bigint();
const elapsed = (start) => Math.round(Number(now() - start) / 1e6);
const tokens = (text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

async function existingSearch(root, labels) {
  const contents = await Promise.all(claimed.map(async (path) => ({
    path, text: (await readFile(join(root, path), 'utf8')) + '\n' + path,
  })));
  return labels.filter(({ query, expected, where }) => {
    const terms = [...tokens(query)];
    const ranked = contents.filter(({ text }) => !where || text.includes('"jurisdiction":"FR"')).map(({ path, text }) => {
      const words = tokens(text);
      return { path, score: terms.filter((term) => words.has(term)).length };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return ranked.slice(0, 5).some(({ path }) => path === expected);
  }).length;
}

async function guardedEnvironment() {
  const directory = await tempDir('simt-offline-probe-');
  const log = join(directory, 'attempts');
  const script = join(directory, 'guard.cjs');
  await writeFile(script, `
    const fs = require('node:fs');
    const log = ${JSON.stringify(log)};
    const refuse = (what) => { fs.appendFileSync(log, what + '\\n'); throw new Error(what); };
    for (const [module, name] of [[require('node:net').Socket.prototype, 'connect'],
      [require('node:tls'), 'connect'], [require('node:dns'), 'lookup'],
      [require('node:dns').promises, 'lookup'], [require('node:dgram'), 'createSocket']]) {
      module[name] = () => refuse('network API');
    }
    global.fetch = () => refuse('fetch');
    const privatePath = (path) => typeof path === 'string' && path.includes('/handbook/private/');
    for (const [module, name] of [[fs, 'readFileSync'], [fs.promises, 'readFile'], [fs.promises, 'open']]) {
      const original = module[name];
      module[name] = (path, ...args) => {
        if (privatePath(path)) refuse('private source access');
        return original.call(module, path, ...args);
      };
    }
    require('node:module').syncBuiltinESMExports();
  `);
  return { log, env: { NODE_OPTIONS: `--require ${JSON.stringify(script)}` } };
}

export async function qualifyLocalWork({ root, shape, invoke }) {
  const labels = JSON.parse(await readFile(new URL('./labels.json', import.meta.url), 'utf8'));
  const { log, env } = await guardedEnvironment();
  const put = (path, text) => writeFile(join(root, path), text);
  const read = (path) => readFile(join(root, path), 'utf8');
  const call = async (args, expected = 0) => {
    const result = await invoke([...args, '--json'], env);
    assert.equal(result.code, expected, result.out);
    return JSON.parse(result.out.split('\n')[0]);
  };
  const scoped = (group, sub, ...args) => call([group, sub, '--scope', scope, ...args]);

  const old = await read('simt.json');
  const manifest = JSON.parse(old);
  manifest.work.version = 3;
  Object.assign(manifest.work.scopes[0], {
    ignore: ['private'],
    share: [current],
    checks: [{ id: 'handbook-validation', argv: ['node', 'check.cjs'], covers: ['structure', 'source-support'] }],
    tracker: { kind: 'json', path: board, visibility: 'shared' },
  });
  await put('simt.json', JSON.stringify(manifest));
  await put('.gitignore', 'node_modules/\n.simt/local/\n');
  await put(board, JSON.stringify({ version: 1, tasks: [
    { id: 'CHECK-1', state: 'ready', artifacts: [current, archive], writes: ['retention'] },
  ] }));
  await put('handbook/downstream.md', `---\nid: specification\nauthority: reviewed\nsources: ["${current}#device-checkout"]\n---\n# Reference specification\n\nApply the primary handbook rule.\n`);
  const legacy = 'owned-units.json';
  const authored = JSON.stringify({ units: [{ id: 'legacy', path: current, text: 'legacy retention note' }] });
  await put(legacy, authored);
  await git(['add', '--', 'simt.json', 'package.json', 'package-lock.json', '.gitignore', board, 'handbook/downstream.md',
    'handbook/private/private-task.md', legacy], { cwd: root });
  await git(['commit', '-qm', 'calibration scope and existing workflow'], { cwd: root });

  const legacyRank = await call(['knowledge', 'rank', '--input', legacy, '--query', 'legacy']);
  assert.equal(legacyRank.ranked[0].id, 'legacy');
  assert.equal(await read(legacy), authored);
  await unlink(join(root, cache));
  const beforePreview = (await git(['status', '--porcelain'], { cwd: root })).stdout;
  assert.equal((await scoped('knowledge', 'build')).written, false);
  await assert.rejects(read(cache), { code: 'ENOENT' });
  assert.equal((await git(['status', '--porcelain'], { cwd: root })).stdout, beforePreview);
  let start = now();
  const built = await scoped('knowledge', 'build', '--yes');
  const coldBuildMs = elapsed(start);
  start = now();
  const warm = await scoped('knowledge', 'build', '--yes');
  const warmBuildMs = elapsed(start);
  assert.equal(warm.changed, false);

  let matches = 0;
  for (const { query, expected, where } of labels) {
    const result = await scoped('knowledge', 'rank', '--query', query, ...(where ? ['--where', where] : []));
    const hits = [...new Set([...result.exact.map(({ citation }) => citation.path), ...result.ranked.map(({ path }) => path)])];
    if (hits.slice(0, 5).includes(expected)) matches += 1;
  }
  const baseline = await existingSearch(root, labels);
  assert.ok(matches >= Math.ceil(labels.length * 0.9), `${shape} top-five: ${matches}/${labels.length}`);
  assert.ok(matches >= baseline, `${shape} regressed against existing lexical search`);
  start = now();
  const first = await scoped('knowledge', 'rank', '--query', 'device checkout retention');
  const firstQueryMs = elapsed(start);
  start = now();
  assert.deepEqual(await scoped('knowledge', 'rank', '--query', 'device checkout retention'), first);
  const repeatQueryMs = elapsed(start);

  const initial = await read(current);
  const archived = await read(archive);
  await put(current, initial + '\nChecked the source revision.\n');
  await put(archive, archived + '\nChecked the historical source.\n');
  const impact = await scoped('knowledge', 'impact', '--changed');
  assert.ok(impact.affected.artifacts.includes('specification'));
  const selected = await scoped('verify', 'select', '--changed');
  assert.ok(selected.selection.selected.document.includes('handbook-validation'));
  const preview = await scoped('verify', 'run', '--changed');
  assert.equal(preview.executed, false);
  await assert.rejects(read('.simt/local/ledger.jsonl'), { code: 'ENOENT' });
  const execution = await scoped('verify', 'run', '--changed', '--yes');
  assert.equal(execution.receipts[0].count, 2);
  assert.equal(execution.receipts[0].outcome, 'pass');
  const status = await scoped('verify', 'status', '--changed');
  assert.equal(status.structuralGreen, true);
  assert.equal(status.verified, false);
  assert.equal(status.results.filter(({ kind, state }) => kind === 'structure' && state === 'pass').length, 2);
  const review = join(await tempDir('simt-fixture-review-'), 'attestations.json');
  const attestations = status.results.filter(({ kind }) => kind === 'semantic-review')
    .map(({ id, inputDigest }) => ({ id, inputDigest, reviewer: 'Synthetic fixture review' }));
  await writeFile(review, JSON.stringify({ attestations }));
  assert.equal((await scoped('verify', 'status', '--changed', '--input', review)).verified, true);
  const queue = await scoped('work', 'schedule');
  assert.deepEqual(queue.dispatch, ['CHECK-1']);
  const handoff = await scoped('work', 'handoff', '--task', 'CHECK-1');
  assert.equal(handoff.capsule.completed.length, 4);
  const transfer = join(await tempDir('simt-qualification-handoff-'), 'capsule.json');
  await writeFile(transfer, JSON.stringify(handoff));
  await put(current, initial + '\nOne finding changed after handoff.\n');
  const resumed = await scoped('work', 'resume', '--input', transfer);
  assert.equal(resumed.reopened.reopened.length, 2);
  assert.equal(resumed.reopened.retained.length, 2);
  await put('handbook/unmapped.bin', 'unsupported');
  const partial = await scoped('verify', 'select', '--changed');
  assert.ok(partial.pending.some(({ path, reason }) => path === 'handbook/unmapped.bin' && reason === 'unmapped-path'));
  const different = await scoped('knowledge', 'build', '--yes');
  const incremental = await read(cache);
  await unlink(join(root, cache));
  await scoped('knowledge', 'build', '--yes');
  assert.equal(await read(cache), incremental);
  await assert.rejects(readFile(log), { code: 'ENOENT' });
  return { shape, matches, baseline, cases: labels.length, indexed: built.counts.indexed, changed: different.changed,
    bytes: Buffer.byteLength(incremental), coldBuildMs, warmBuildMs, firstQueryMs, repeatQueryMs };
}
