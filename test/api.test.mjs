import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = fileURLToPath(new URL('..', import.meta.url));
const { name, exports: map } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the package can be imported by its own name, through the exports map', async () => {
  // Not a path import: this is what a UI, a harness or a sibling package does, and a
  // missing exports entry is invisible until somebody outside this tree tries it.
  const api = await import(name);
  assert.equal(typeof api.checkRepo, 'function');
  assert.equal(typeof api.rulesWhyFacts, 'function');
  assert.equal(map['.'], './src/api.mjs');
  assert.equal(map['./src/*'], './src/*', 'the deep paths the plugin runtime imports must keep resolving');
});

test('a read returns its facts as data and prints nothing', async () => {
  // In a child process, because this test file's own runner writes to the same stdout:
  // capturing in-process measured the reporter, not the library.
  const script = `import(${JSON.stringify(name)}).then(async (api) => {
    const result = await api.checkRepo(process.cwd());
    if (!Array.isArray(result.findings) || typeof result.ok !== 'boolean') {
      throw new Error('checkRepo did not return its facts');
    }
    // Nothing else: a library read that prints has already chosen a renderer.
  }).catch((error) => { console.error(error.message); process.exit(1); });`;
  const { stdout } = await promisify(execFile)('node', ['--input-type=module', '-e', script], { cwd: repo });
  assert.equal(stdout, '', 'checkRepo wrote to stdout');
});
