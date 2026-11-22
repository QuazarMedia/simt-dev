import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bindSymbols, symbolKey } from '../src/index/bind.mjs';
import { extract } from '../src/index/extract.mjs';
import { readSqliteRows } from '../src/index/persist.mjs';
import { readEdges, readSymbolGraph, reindex } from '../src/index/store.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

function bind(sources) {
  const files = [];
  const symbols = [];
  for (const [path, text] of Object.entries(sources)) {
    const lang = path.endsWith('.py') ? 'python' : 'javascript';
    const { symbols: definitions, ...evidence } = extract(path, text, lang, { references: true });
    files.push({ path, lang, ...evidence });
    symbols.push(...definitions);
  }
  return bindSymbols(files, symbols);
}

const sources = {
  'a.mjs': 'export function targetFn() {}\nexport function otherFn() {}\nexport default function Default() {}',
  'barrel1.mjs': "export { targetFn as renamed, default as defaultFn } from './a.mjs';",
  'barrel2.mjs': "export * from './barrel1.mjs';\nexport * from './cycle.mjs';",
  'cycle.mjs': "export * from './barrel2.mjs';",
  'caller.mjs': "import * as barrel from './barrel2.mjs';\nexport function run() { barrel.renamed(); barrel.defaultFn(); }",
  'sibling.mjs': "import { otherFn as handle } from './a.mjs';\nfunction sibling() { handle(); }",
};

test('unwraps named, default and star barrel chains past cycles with directed witnesses', () => {
  const { ownerRows, bindingCoverage } = bind(sources);
  const caller = ownerRows.get('caller.mjs').edges;
  assert.deepEqual(caller.filter(({ kind }) => kind === 'calls_symbol'), [
    {
      src: symbolKey('caller.mjs', 'run', 2), kind: 'calls_symbol', dst: symbolKey('a.mjs', 'targetFn', 1),
      viaBarrels: ['barrel2.mjs', 'barrel1.mjs'], lines: [2],
    },
    {
      src: symbolKey('caller.mjs', 'run', 2), kind: 'calls_symbol', dst: symbolKey('a.mjs', 'Default', 3),
      viaBarrels: ['barrel2.mjs', 'barrel1.mjs'], lines: [2],
    },
  ]);
  assert.deepEqual(ownerRows.get('sibling.mjs').edges.filter(({ kind }) => kind === 'calls_symbol').map(({ dst }) => dst), [
    symbolKey('a.mjs', 'otherFn', 2),
  ]);
  assert.ok(ownerRows.get('barrel2.mjs').edges.some(({ kind, dst }) => kind === 'reexports_symbol' && dst === symbolKey('a.mjs', 'targetFn', 1)));
  assert.deepEqual(bindingCoverage.javascript, { total: 3, bound: 3, unresolved: 0, ratio: 1 });
});

test('records ambiguous and dynamic references, leaves shadowed parameters local, and finds lexical Python imports', () => {
  const result = bind({
    'a.mjs': 'export function action() {}',
    'b.mjs': 'export function action() {}',
    'barrel.mjs': "export * from './a.mjs';\nexport * from './b.mjs';",
    'call.mjs': "import { action } from './barrel.mjs';\nfunction local(action) { action(); }\nfunction outer() { action(); import('./dynamic.mjs'); }",
    'pkg/public.py': 'def action():\n    pass',
    'pkg/call.py': 'def run():\n    from .public import action\n    return action()\ndef outside():\n    return action()',
  });
  assert.equal(result.ownerRows.get('call.mjs').edges.filter(({ kind }) => kind === 'calls_symbol').length, 0);
  assert.deepEqual(result.unresolved.map(({ path, kind, line }) => [path, kind, line]), [
    ['call.mjs', 'call', 3], ['call.mjs', 'dynamic-import', 3], ['pkg/call.py', 'call', 5],
  ]);
  assert.deepEqual(result.ownerRows.get('pkg/call.py').edges.filter(({ kind }) => kind === 'calls_symbol').map(({ dst }) => dst), [
    symbolKey('pkg/public.py', 'action', 1),
  ]);
});

test('persists binding coverage and refreshes only affected symbol edge rows', async () => {
  const root = await tempDir('index-bind-');
  for (const [path, text] of Object.entries(sources)) await writeFile(join(root, path), text);
  await ensureGit(root);
  await reindex(root);
  const first = await readSymbolGraph(root);
  assert.equal(first.error, null);
  assert.equal(first.bindingCoverage.javascript.ratio, 1);

  const cli = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'index', '--open', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(status.bindingCoverage, first.bindingCoverage);
  assert.ok((await readEdges(root)).every(({ kind }) => kind === 'import'));

  const siblingQuery = `select e.rowid as edgeId, e.src_id as src, e.dst_id as dst
     from edges e join sources s on s.id = e.owner_source_id
     where e.kind = 'calls_symbol' and s.path = 'sibling.mjs'`;
  const stable = (await readSqliteRows(root, siblingQuery)).rows;
  assert.equal(stable.length, 1);
  await writeFile(join(root, 'barrel1.mjs'), "export { otherFn as renamed, default as defaultFn } from './a.mjs';");
  await git(['add', 'barrel1.mjs'], { cwd: root });
  assert.equal((await reindex(root)).updated, 1);
  const second = await readSymbolGraph(root);
  assert.equal(second.error, null);
  assert.deepEqual((await readSqliteRows(root, siblingQuery)).rows, stable);
  assert.deepEqual(second.edges.filter(({ path, kind }) => path === 'caller.mjs' && kind === 'calls_symbol').map(({ dst }) => dst), [
    symbolKey('a.mjs', 'Default', 3), symbolKey('a.mjs', 'otherFn', 2),
  ]);

  await git(['rm', 'a.mjs'], { cwd: root });
  await reindex(root);
  const third = await readSymbolGraph(root);
  assert.equal(third.bindingCoverage.javascript.ratio, 0);
  assert.ok(third.edges.every(({ dst }) => !dst.startsWith('sym:a.mjs#')));
  assert.equal((await readSqliteRows(root, siblingQuery)).rows.length, 0);
});
