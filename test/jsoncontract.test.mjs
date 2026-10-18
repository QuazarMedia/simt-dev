// The JSON contract, asserted rather than documented.
//
// The review this was filed for (S51) asked for a contract test, and the reason it asked
// is that `emitJson` was `JSON.stringify(value, null, 2)` with no version anywhere. A
// reader could parse every payload and still have no way to notice that a field had been
// renamed: the parse succeeds, the lookup returns undefined, and the answer is quietly
// wrong. Both halves are asserted here - the version, and the form.
//
// Every command here is run with arguments it already accepts and a root it can answer
// for, so this test depends on the command registry and not on a fixture per command.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { IMPLEMENTED } from '../src/commands/index.mjs';
import { SCHEMA_VERSION } from '../src/output/index.mjs';
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** One empty git repository, so `compare` has a directory that holds one to answer for. */
async function oneRepo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-contract-root-'));
  made.push(root);
  await mkdir(join(root, 'r'), { recursive: true });
  await writeFile(join(root, 'r', 'README.md'), '# r\n');
  await git(['init', '-q', join(root, 'r')]);
  await git(['-C', join(root, 'r'), 'add', '.']);
  await git(['-C', join(root, 'r'), 'commit', '-qm', 'initial']);
  return root;
}

let CONTRACT_ROOT = null;

/**
 * Run the real binary and return stdout.
 *
 * stdin is ignored rather than piped: `mcp` without `--list` serves on stdio and waits
 * for it to end, so a test that leaves the pipe open hangs instead of failing. An
 * invocation that ignores stdin is also the honest shape of a scripted call.
 */
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

/**
 * Every command that emits JSON, with the arguments that make it answer rather than
 * refuse.
 *
 * The list is deliberately short and driverless: a command in it must run with no
 * repository, or the test would be asserting the contract against a fixture's answer
 * instead of the contract.
 *
 * An entry is either the argument list, or an object - `args` for the list, `noRoot`
 * when the command reads the workspace rather than a `--root`, and `root` for the one
 * case (`tokens`) that measures a member instead of the directory that holds it.
 */
const JSON_COMMANDS = {
  doctor: [],
  'skills index': { noRoot: true },
  'skills brief': ['--task', 'write a test'],
  brief: ['--task', 'write a test'],
  // Reads the workspace, not a root; the fixture holds no workspace to read.
  'skills find': { noRoot: true, args: ['test'] },
  'graph lint': { noRoot: true },
  compare: [],
  tokens: { root: 'r' },
  'harness detect': [],
  'harness loaders': [],
  'bench mine': { root: 'r' },
  'bench run': { root: 'r' },
  'bench report': { root: 'r' },
  'bench ablate': { root: 'r' },
  'bench probes': { root: 'r' },
  check: [],
  'rules list': [],
  'hooks run': ['pre-commit'],
  'agent-hooks status': [],
  // Without `--list` this command serves on stdio and waits for it, which is why the
  // entry says what it says and why the runner above ignores stdin.
  mcp: ['--list'],
  'plan status': [],
  'plan next': [],
  'plan done': ['no-such-slice'],
  // Reads the directory that holds the repositories rather than one of them, so it is
  // given the fixture root and not a member: the fixture holds exactly one repository, and
  // a workspace of one is a workspace.
  evidence: { root: 'r' },
  index: { root: 'r' },
  map: { root: 'r' },
  tests: { root: 'r' },
  why: { root: 'r' },
  gate: { root: 'r' },
  impact: { root: 'r' },
  'shared plan': { root: '.' },
  // The preview, not the write: the write lands in the reader's home directory, and a
  // contract test must never do that.
  'shared install': { root: '.' },
};

test('every command that emits json emits one compact document with a version', async () => {
  CONTRACT_ROOT ??= await oneRepo();

  for (const [name, entry] of Object.entries(JSON_COMMANDS)) {
    assert.ok(name in IMPLEMENTED, `${name} is not a command any more; this list is the contract`);
    const spec = Array.isArray(entry) ? { args: entry } : (entry ?? {});
    const parts = name.split(' ');
    const member = spec.root ? join(CONTRACT_ROOT, spec.root) : CONTRACT_ROOT;
    const argv = [...parts, '--json', ...(spec.args ?? []), ...(spec.noRoot ? [] : ['--root', member])];
    const out = await run(argv);

    // One document, exactly one line. A second line is a second document, and a reader
    // that parses the first gets half the answer while believing it has all of it.
    const trimmed = out.trim();
    const detail = out === '' ? ` (ran: ${argv.join(' ')})` : `\n${trimmed.slice(0, 200)}`;
    assert.ok(trimmed.length > 0, `${name} emitted nothing on stdout${detail}`);
    assert.equal(trimmed.split('\n').length, 1, `${name} emitted more than one line of JSON${detail}`);
    assert.ok(!/^\s+/m.test(trimmed), `${name} is indented; a piped reader pays for bytes nobody reads`);

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (failure) {
      assert.fail(`${name} is not JSON: ${failure.message}${detail}`);
    }
    assert.ok(payload !== null && typeof payload === 'object', `${name} emitted ${typeof payload}`);
    assert.equal(
      payload.schemaVersion,
      SCHEMA_VERSION,
      `${name} carries no schemaVersion, so a renamed field is silent`,
    );
  }
});

test('a reader that asks for pretty gets pretty', async () => {
  CONTRACT_ROOT ??= await oneRepo();
  const out = await run(['doctor', '--json', '--pretty', '--root', CONTRACT_ROOT]);
  assert.match(out, /\n\s+/);
  assert.equal(JSON.parse(out).schemaVersion, SCHEMA_VERSION);
});

test("the version is the payload's, not the documentation's", () => {
  // The guard against the failure this fixes: a version that lives in a comment goes
  // stale without failing anything, and the reader is the one who pays.
  assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1);
});
