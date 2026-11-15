import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

const run = async (args) => {
  const result = await promisify(execFile)(process.execPath, [bin, ...args], { cwd: repo }).catch((error) => error);
  return { doc: JSON.parse(result.stdout), code: result.code ?? 0 };
};

const COMMANDS = [
  ['graph lint', ['graph', 'lint', '--json']],
  ['skills index', ['skills', 'index', '--json']],
  ['check', ['check', '--json']],
  ['rules list', ['rules', 'list', '--json']],
  ['plan status', ['plan', 'status', '--json']],
];

test('every JSON document names the command path that produced it', async () => {
  // The dispatcher resolved the path; a document that names a different one - `plugin`
  // used to answer as `plugin claude`, `sync` as `sync --check` - tells a script it ran
  // something it did not (review 0003 Q65).
  for (const [path, args] of COMMANDS) {
    const { doc } = await run(args);
    assert.equal(doc.command, path, `${args.join(' ')} named ${doc.command}`);
  }
});

test('a document that could not fit its ceiling exits non-zero (A14)', async () => {
  // The handler returns EXIT.OK because writing the document is what it did; the document
  // says the answer was replaced by a MAX_BYTES envelope. A process that exits 0 here
  // tells a script the command succeeded while its own output says it did not.
  const { doc, code } = await run(['why', 'src/name.mjs', '--json', '--max-bytes', '120']);
  assert.equal(doc.ok, false);
  assert.equal(doc.error.code, 'MAX_BYTES');
  assert.notEqual(code, 0, 'the process said success for a document that says failure');
  assert.equal(doc.exitCode, code);
});

test('a document names the exit code it shipped with, and ok agrees with it', async () => {
  // `upgrade` used to answer `ok: false` and exit 0. A caller that trusted either half
  // was wrong about the other, and nothing in the document said which was the truth.
  for (const [path, args] of COMMANDS) {
    const { doc, code } = await run(args);
    assert.equal(doc.exitCode, code, `${path} named exit ${doc.exitCode}, shipped ${code}`);
    assert.equal(doc.ok, code === 0, `${path} said ok: ${doc.ok} at exit ${code}`);
  }
});
