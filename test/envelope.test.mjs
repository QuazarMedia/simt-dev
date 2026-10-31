import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

const run = async (args) => {
  const { stdout } = await promisify(execFile)('node', [bin, ...args], { cwd: repo }).catch((error) => ({ stdout: error.stdout }));
  return JSON.parse(stdout);
};

test('every JSON document names the command path that produced it', async () => {
  // The dispatcher resolved the path; a document that names a different one - `plugin`
  // used to answer as `plugin claude`, `sync` as `sync --check` - tells a script it ran
  // something it did not (review 0003 Q65).
  for (const [path, args] of [
    ['graph lint', ['graph', 'lint', '--json']],
    ['skills index', ['skills', 'index', '--json']],
    ['check', ['check', '--json']],
    ['rules list', ['rules', 'list', '--json']],
    ['plan status', ['plan', 'status', '--json']],
  ]) {
    const doc = await run(args);
    assert.equal(doc.command, path, `${args.join(' ')} named ${doc.command}`);
  }
});
