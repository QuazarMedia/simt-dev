import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { readSqliteRows } from '../src/index/persist.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, git, simt, tempDir } from './fixture.mjs';

test('why finds shortest command, import and Git witnesses across file, symbol, directory and diff subjects', async () => {
  const root = await tempDir('why-graph-');
  const target = 'src/brief/assemble.mjs';
  const dispatcher = 'src/commands/brief.mjs';
  const schema = 'src/brief/contract.mjs';
  const original = "import { contract } from './contract.mjs';\nexport function assemblePacket() { return contract; }\n";
  const records = {
    'ADR-001': ['Direct authority', [target]],
    'ADR-002': ['Command authority', ['simt brief']],
    'ADR-003': ['Contract authority', [schema]],
    'ADR-004': ['Historical policy', []],
    'ADR-005': ['Dispatcher authority', [dispatcher]],
  };
  const files = {
    [target]: original,
    [dispatcher]: "import '../brief/assemble.mjs';\nimport './alternate.mjs';\n",
    [schema]: 'export const contract = 1;\n',
    'src/commands/alternate.mjs': "import '../brief/assemble.mjs';\n",
  };
  for (const [id, [title, paths]] of Object.entries(records)) {
    files['docs/decisions/' + id + '-record.md'] = '---\nsimt-affects: ' + JSON.stringify(paths)
      + '\n---\n# ' + id + ' — ' + title + '\n\nStatus: accepted\n';
  }
  for (const [path, body] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  await ensureGit(root);
  await writeFile(join(root, target), original + '// notes\n');
  await git(['commit', '-qam', 'record packet history', '-m', 'Refs: ADR-004'], { cwd: root });
  await reindex(root);

  async function why(...args) {
    const result = await simt(['why', ...args, '--json'], { cwd: root });
    assert.equal(result.code, 0, result.stdout || result.stderr);
    return JSON.parse(result.stdout);
  }
  const path = await why(target);
  assert.equal(path.basis, 'sqlite');
  assert.equal(path.graphBasis, 'staged');
  assert.deepEqual(path.items.filter(({ kind }) => kind === 'decision').map(({ id }) => id), ['ADR-001']);
  assert.deepEqual(path.witnesses.command.filter(({ id }) => id === 'ADR-002').map(({ witness }) => witness),
    [['simt brief', dispatcher, target]]);
  assert.ok(path.witnesses.command.some(({ id }) => id === 'ADR-005'));
  assert.deepEqual(path.witnesses.inherited.map(({ id, witness }) => [id, witness]), [['ADR-003', [target, schema]]]);
  assert.equal(path.witnesses.historical[0].id, 'ADR-004');
  assert.match(path.witnesses.historical[0].sha, /^[a-f0-9]{40}$/u);

  for (const subject of ['assemblePacket', target + '#assemblePacket']) {
    const symbol = await why(subject);
    assert.equal(symbol.subjects[0].symbol, 'assemblePacket');
    assert.deepEqual(symbol.files, [target]);
  }
  const directory = await why('src/brief/');
  assert.deepEqual(directory.files, [target, schema]);
  assert.equal(directory.counts.find(({ id }) => id === 'ADR-001').fileCount, 1);
  assert.deepEqual((await why(target, schema)).files, [target, schema]);
  await writeFile(join(root, target), original.replace('return contract', 'return contract + 1'));
  assert.deepEqual((await why('--changed')).files, [target]);

  await git(['commit', '-qam', 'update packet', '-m', 'Refs: ADR-001'], { cwd: root });
  await reindex(root);
  const { rows, error } = await readSqliteRows(root, 'select adr_id, sha from commit_citations where path = ? order by position', [target]);
  assert.equal(error, null);
  assert.deepEqual(rows.map(({ adr_id }) => adr_id), ['ADR-004', 'ADR-001']);
  assert.equal((await why(target)).witnesses.historical.length, 2);
});
