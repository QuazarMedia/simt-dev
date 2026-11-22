import assert from 'node:assert/strict';
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { CHECK_NON_BLOCKING } from '../src/commands/sync.mjs';
import { runDeclaredChecks } from '../src/kernel/checks.mjs';
import { manifestProblems } from '../src/manifest/schema.mjs';
import { cyclicComponents } from '../src/util/components.mjs';
import { git } from './fixture.mjs';

async function repo(files) {
  const root = await mkdtemp(join(tmpdir(), 'simt-graph-checks-'));
  await git(['init', '-q', root]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const check = (root, graph) => runDeclaredChecks(root, [], { limits: { graph } });
const importing = (path) => `import "./${path}";\n`;

test('cycle witnesses start at the smallest component member and legacy paths can be excluded', async () => {
  const root = await repo({
    'a.mjs': importing('b.mjs') + importing('c.mjs'),
    'b.mjs': importing('a.mjs'),
    'c.mjs': importing('d.mjs'),
    'd.mjs': importing('a.mjs'),
    'e.mjs': importing('f.mjs'),
    'f.mjs': importing('g.mjs'),
    'g.mjs': importing('e.mjs'),
  });
  assert.deepEqual(await check(root), []);
  const rows = await check(root, { cycles: true, maxFanIn: 1, maxFanOut: 1 });
  assert.deepEqual(rows.filter(({ status }) => status === 'import-cycle').map(({ witness }) => witness),
    [['a.mjs', 'b.mjs', 'a.mjs'], ['e.mjs', 'f.mjs', 'g.mjs', 'e.mjs']]);
  assert.deepEqual(rows.filter(({ status }) => status.startsWith('hub-')).map(({ file, status }) => [file, status]),
    [['a.mjs', 'hub-fanin-warn'], ['a.mjs', 'hub-fanout-warn']]);
  const excluded = await check(root, { cycles: { exclude: ['b.mjs', 'e.mjs'] } });
  assert.deepEqual(excluded.map(({ witness }) => witness), [['a.mjs', 'c.mjs', 'd.mjs', 'a.mjs']]);
});

test('Tarjan tolerates dependency chains longer than the call stack', () => {
  const count = 12_000;
  const edges = new Map(Array.from({ length: count }, (_, i) => [String(i), [String(i + 1)]]));
  edges.set(String(count - 1), [String(count - 2)]);
  assert.deepEqual(cyclicComponents(edges), [[String(count - 2), String(count - 1)]]);
});

test('a worktree deletion breaks a relative import, including before a commit', async () => {
  const root = await repo({
    'a.mjs': '\nimport { target } from "./b.mjs";\nimport "external";\n' + importing('generated.mjs'),
    'b.mjs': 'export const target = 1;\n',
    '.gitignore': 'generated.mjs\n',
    'generated.mjs': '',
  });
  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'fixture']);
  assert.deepEqual(await check(root, { brokenImports: true }), []);
  await unlink(join(root, 'b.mjs'));
  const [hit, ...other] = await check(root, { brokenImports: true });
  assert.deepEqual(other, []);
  assert.deepEqual([hit.file, hit.status, hit.line, hit.specifier], ['a.mjs', 'broken-relative-import', 2, './b.mjs']);
  assert.equal(CHECK_NON_BLOCKING.has(hit.status), false);
});

test('dead exports require entrypoints and sufficient language binding coverage', async () => {
  const root = await repo({
    'entry.mjs': 'import { used } from "./library.mjs";\nexport const publicName = used;\n',
    'library.mjs': 'export const used = 1;\nexport const unused = 2;\n',
    'public.mjs': 'export const api = true;\n',
    'package.json': '{"exports": {"./public": "./public.mjs"}}',
    'helper.py': 'def uncertain():\n    pass\n',
  });
  const rows = await check(root, { deadExports: true, entrypoints: ['entry.mjs'] });
  assert.deepEqual(rows.map(({ file, status }) => [file, status]),
    [['simt.json', 'graph-coverage-warn'], ['library.mjs', 'dead-export']]);
  assert.match(rows[0].detail, /python.*below 0.9/);
  assert.match(rows[1].detail, /unused at line 2/);
  assert.ok(rows.every(({ status }) => CHECK_NON_BLOCKING.has(status)));
  await unlink(join(root, 'package.json'));
  const unconfigured = await check(root, { deadExports: true });
  assert.match(unconfigured[0].detail, /requires explicit entrypoints/);
  assert.equal(unconfigured.length, 1);
});

test('graph limit settings validate before reaching the checkers', () => {
  assert.deepEqual(manifestProblems({ limits: { graph: { maxFanOut: 0, cycles: { exclude: ['legacy/**'] } } } }), []);
  for (const graph of [[], { cycles: { exclude: ['../x'] } }, { brokenImports: 'true' }, { maxFanIn: -1 }]) {
    assert.match(manifestProblems({ limits: { graph } })[0], /^limits.graph/);
  }
});
