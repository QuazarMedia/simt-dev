import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureGit, git, simt, tempDir } from './fixture.mjs';

test('precise gates retain direct tests, report hub omissions and fall back through star exports', async () => {
  const root = await tempDir('gate-precision-');
  await mkdir(join(root, 'test'));
  const original = 'function internalScore() {\n  return 1;\n}\nexport function scoreOrders() {\n  return internalScore();\n}\n'
    + 'export function formatOrders() {\n  return "ok";\n}\n';
  const sources = {
    '.gitignore': '.simt/\n',
    'package.json': '{"scripts":{"test":"node --test"}}',
    'library.mjs': original,
    'caller.mjs': "import { scoreOrders } from './library.mjs';\nexport function checkScore() { return scoreOrders(); }\n",
    'format.mjs': "import { formatOrders } from './library.mjs';\nexport function checkFormat() { return formatOrders(); }\n",
    'hub.mjs': "import { scoreOrders, formatOrders } from './library.mjs';\nexport function dispatchScore() { return scoreOrders(); }\n"
      + 'export function dispatchFormat() { return formatOrders(); }\n',
    'test/caller.test.mjs': "import { checkScore } from '../caller.mjs';\nif (typeof checkScore() !== 'number') throw Error('score');\n",
    'test/format.test.mjs': "import { checkFormat } from '../format.mjs';\ncheckFormat();\n",
    'test/hub.test.mjs': "import { dispatchFormat } from '../hub.mjs';\ndispatchFormat();\n",
    'test/hub-score.test.mjs': "import { dispatchScore } from '../hub.mjs';\ndispatchScore();\n",
    'test/direct.test.mjs': "import { formatOrders } from '../library.mjs';\nformatOrders();\n",
  };
  for (const [path, source] of Object.entries(sources)) await writeFile(join(root, path), source);
  for (let index = 0; index < 33; index += 1) {
    await writeFile(join(root, 'spoke-' + index + '.mjs'),
      "import { dispatchScore } from './hub.mjs';\nexport function spoke() { return dispatchScore(); }\n");
  }
  await ensureGit(root);
  await writeFile(join(root, 'library.mjs'), original.replace('return 1', 'return 2'));

  async function run(args) {
    const result = await simt([...args, '--json'], { cwd: root });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  const precise = await run(['gate', '--changed', '--precise']);
  assert.deepEqual(precise.selected, ['test/caller.test.mjs', 'test/direct.test.mjs', 'test/hub-score.test.mjs']);
  assert.equal(precise.selection.mode, 'precise');
  assert.deepEqual(precise.selection.hubMediatedSkipped, ['test/hub.test.mjs']);
  assert.equal(precise.selection.otherSkipped, 1);

  const conservative = await run(['tests', '--run', '--changed', '--precise', '--conservative']);
  assert.equal(conservative.selection.mode, 'conservative');
  assert.equal(conservative.selected.length, 5);
  const strict = await run(['gate', '--changed', '--precise', '--strict']);
  assert.match(strict.selection.reason, /strict mode/);
  assert.deepEqual(strict.selected, conservative.selected);

  await writeFile(join(root, 'library.mjs'), original);
  await writeFile(join(root, 'dynamic.mjs'), "export async function call() { return (await import('./library.mjs')).scoreOrders(); }");
  await git(['add', 'dynamic.mjs'], { cwd: root });
  await git(['commit', '-qm', 'add a dynamic consumer'], { cwd: root });
  await writeFile(join(root, 'library.mjs'), original.replace('return 1', 'return 3'));
  const uncertain = await run(['gate', '--changed', '--precise']);
  assert.match(uncertain.selection.reason, /dynamic or unresolved/);
  assert.deepEqual(uncertain.selected, conservative.selected);

  await writeFile(join(root, 'library.mjs'), original);
  await writeFile(join(root, 'barrel.mjs'), "export * from './library.mjs';\n");
  await git(['add', 'barrel.mjs'], { cwd: root });
  await git(['commit', '-qm', 'add wildcard entry point'], { cwd: root });
  await writeFile(join(root, 'library.mjs'), original.replace('return 1', 'return 3'));

  const fallback = await run(['gate', '--changed', '--precise']);
  assert.equal(fallback.selection.mode, 'conservative');
  assert.match(fallback.selection.reason, /star re-export/);
  assert.deepEqual(fallback.selected, conservative.selected);
});

test('tests co-change ranks decayed confidence without requiring a prebuilt index', async () => {
  const root = await tempDir('tests-cochange-');
  await mkdir(join(root, 'test'));
  const older = 'test/older.test.mjs';
  const newer = 'test/newer.test.mjs';
  const source = 'library.mjs';
  for (const path of [source, older, newer]) await writeFile(join(root, path), '// initial\n');
  await ensureGit(root);
  async function change(testPath) {
    await writeFile(join(root, source), '// edited with ' + testPath);
    await writeFile(join(root, testPath), '// edited');
    await git(['commit', '-qam', 'couple library and ' + testPath], { cwd: root });
  }
  await change(older);
  await change(newer);
  const result = await simt(['tests', source, '--cochange', '--json'], { cwd: root });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const { tests, cochange } = JSON.parse(result.stdout);
  assert.deepEqual(tests, [newer, older]);
  assert.deepEqual(cochange.map(({ dst, support }) => [dst, support]), [[newer, 2], [older, 2]]);
  assert.ok(cochange[0].confidence > cochange[1].confidence);
});
