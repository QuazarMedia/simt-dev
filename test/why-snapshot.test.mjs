// The Affects lines as they stood at 4c27514 (R25, ADR-093).
//
// That commit is the one the plan measured: 16 lines, and the dispatcher named
// by a single record. Later records name it too. This test reads that commit
// so the parser is held to the lines the plan described.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { COMMANDS } from '../src/commands/index.mjs';
import {
  affectsTokens,
  decisionHits,
  resolveToken,
  sourceRoots,
  unresolvedAffects,
} from '../src/index/govern.mjs';

const exec = promisify(execFile);
const SNAPSHOT = '4c27514';

test('snapshot 4c27514 resolves every Affects token or reports it, and only ADR-017 names the dispatcher', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const tree = await exec('git', ['ls-tree', '-r', '--name-only', SNAPSHOT], { cwd: root, maxBuffer: 16 << 20 });
  const files = new Set(tree.stdout.split('\n').filter(Boolean));
  const ctx = { files, commands: new Set(COMMANDS), roots: sourceRoots(files) };
  const listed = await exec('git', ['grep', '-l', 'Affects:', SNAPSHOT, '--', 'docs/decisions'], { cwd: root, maxBuffer: 4 << 20 });
  const paths = listed.stdout.split('\n').filter(Boolean).map((line) => line.slice(line.indexOf(':') + 1));
  assert.equal(paths.length, 16);
  const records = [];
  for (const path of paths) {
    const shown = await exec('git', ['show', SNAPSHOT + ':' + path], { cwd: root, maxBuffer: 4 << 20 });
    const base = path.slice(path.lastIndexOf('/') + 1);
    records.push({ id: /^ADR-\d{3}/.exec(base)[0], title: path, text: shown.stdout });
  }
  let tokens = 0;
  let resolved = 0;
  for (const record of records) {
    for (const token of affectsTokens(record.text)) {
      tokens += 1;
      const answer = resolveToken(token, ctx);
      assert.ok(answer.kind === 'command' || answer.kind === 'paths' || answer.kind === 'unresolved');
      if (answer.kind !== 'unresolved') resolved += 1;
    }
  }
  assert.ok(tokens > 16);
  const named = records
    .filter((record) => decisionHits([record], 'src/hooks/dispatcher.mjs', ctx).hits.length === 1)
    .map((record) => record.id);
  assert.deepEqual(named, ['ADR-017']);
  const unresolved = unresolvedAffects(records, ctx);
  assert.ok(unresolved.some((item) => item.token === 'simt-dev'));
  assert.equal(unresolved.length + resolved, tokens);
});
