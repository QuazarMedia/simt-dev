// A44: the shared document reader, tested directly rather than through a door.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readJsonDocument } from '../src/commands/doc-input.mjs';

const LIMIT = 4 * 1024 * 1024;

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'doc-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const moduleUrl = new URL('../src/commands/doc-input.mjs', import.meta.url).href;
const stdinScript = `
import { readJsonDocument } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(await readJsonDocument({ input: '-' }, 'input')));
`;

/** Run the reader with a child's stdin, because `-` means this process's own stdin. */
function viaStdin(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', stdinScript]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`the reader printed no document: ${stdout} ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}

test('a path the caller passed is read and parsed as an object', async (t) => {
  const dir = await workspace(t);
  const file = join(dir, 'doc.json');
  await writeFile(file, '{"ok":true}\n');

  assert.deepEqual(await readJsonDocument({ input: file }, 'input'), { doc: { ok: true } });
  await writeFile(file, '[]\n');
  assert.deepEqual(await readJsonDocument({ input: file }, 'input'), { doc: [] });
});

test('a missing path names the flag and the failure', async (t) => {
  const dir = await workspace(t);
  const result = await readJsonDocument({ input: join(dir, 'missing.json') }, 'input');
  assert.match(result.error, /cannot read --input/);
  assert.match(result.error, /ENOENT/);
});

test('a document that is not an object or array is refused', async (t) => {
  const dir = await workspace(t);
  const file = join(dir, 'scalar.json');
  await writeFile(file, 'null\n');
  const result = await readJsonDocument({ input: file }, 'input');
  assert.match(result.error, /must hold a JSON object or array/);
});

test('a file over the 4 MiB ceiling is refused before it is parsed', async (t) => {
  const dir = await workspace(t);
  const file = join(dir, 'big.json');
  await writeFile(file, `"${'x'.repeat(LIMIT)}"`);

  const result = await readJsonDocument({ input: file }, 'input');
  assert.match(result.error, /over the 4194304 byte ceiling/);
});

test('stdin is read when the path is -', async () => {
  assert.deepEqual(await viaStdin('{"from":"stdin"}'), { doc: { from: 'stdin' } });
});

test('stdin over the 4 MiB ceiling is refused', async () => {
  const result = await viaStdin('x'.repeat(LIMIT + 1));
  assert.match(result.error, /over the 4194304 byte ceiling/);
});
