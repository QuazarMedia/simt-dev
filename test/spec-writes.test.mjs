// The declared writes tier, and the check that holds it to behaviour.
//
// A row's `writes` is a claim about a command, and a wrong claim is worse than none: a
// caller that plans around "this one does not touch the repository" is exactly the
// caller a silent write damages. So the claim has two halves here - a static one (a
// tier without an apply flag cannot be reached) and a runtime one (a row that claims
// nothing must leave a staged repository unchanged when it is run).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SPEC } from '../src/commands/spec.mjs';
import { git } from './fixture.mjs';

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

test('a declared tier and the flag that reaches it arrive together', () => {
  // `--yes` is what turns a preview into a write. A row declaring one without the other
  // is either unreachable or unguarded, and both are the same defect in different words.
  for (const row of SPEC) {
    if (row.writes === undefined) {
      assert.equal((row.flags ?? []).includes('yes'), false, `${row.path} accepts --yes without declaring writes`);
      continue;
    }
    assert.equal((row.flags ?? []).includes('yes'), true, `${row.path} declares writes but cannot be told to write`);
  }
});

test('a row that declares no writes leaves a repository alone', async () => {
  // The rows below run the gates, reach the network, or read a payload from stdin; each
  // would either change the staged repository for a reason the tier is not about, or hang
  // waiting for input. They are named with the reason, not filtered silently.
  const SKIP = new Map([
    ['slice start', 'runs the declared gates'],
    ['slice finish', 'runs the declared gates and commits'],
    ['review run', 'reaches a model'],
    ['bench run', 'reaches a model'],
    ['workspace upgrade', 'reaches the network'],
    ['self-update', 'reaches the network'],
    ['agent-hook', 'reads a payload from stdin'],
    ['mcp', 'a long-lived transport'],
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'simt-writes-'));
  await exec('git', ['init', '-q', dir]);
  await exec(process.execPath, [BIN, 'init', '--yes', '--root', dir], { cwd: dir });
  // The commit goes through the fixture's git, which carries an identity: a runner
  // derives an empty name from its passwd entry, and a bare `git commit` dies with
  // "empty ident name" before the test under assertion has started.
  const commit = async () => exec('git', ['-C', dir, 'add', '-A'], { cwd: dir }).then(() => git(['-C', dir, 'commit', '-q', '-m', 'staged'], { cwd: dir }));
  await commit();
  const status = async () => (await exec('git', ['-C', dir, 'status', '--porcelain'], { cwd: dir })).stdout.trim();

  const offenders = [];
  for (const row of SPEC) {
    if (row.writes !== undefined || SKIP.has(row.path)) continue;
    const before = await status();
    await exec(process.execPath, [BIN, ...row.path.split(' '), '--json', '--root', dir], { cwd: dir, timeout: 20000 }).catch((error) => error);
    const after = await status();
    if (after !== before) offenders.push(`${row.path}: ${after.split('\n')[0]}`);
  }
  assert.deepEqual(offenders, [], 'rows that changed the repository without declaring writes');
});
