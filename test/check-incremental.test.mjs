import assert from 'node:assert/strict';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { diagnose, serialisedFindings } from '../src/commands/doctor.mjs';
import { checkRepo } from '../src/commands/sync.mjs';
import { readSourceLineFacts } from '../src/index/graph-read.mjs';
import { reindex } from '../src/index/store.mjs';
import { runDeclaredChecks } from '../src/kernel/checks.mjs';
import { git } from './fixture.mjs';

const length = { source: 'house.md', body: '- File length. <!-- simt-check: max-file-lines -->' };
const max = { limits: { fileLines: { warn: 1, error: 2 } } };
const long = 'export const x = 1;\n// two\n// three\n';

async function repo(files) {
  const root = await mkdtemp(join(tmpdir(), 'simt-check-incremental-'));
  await git(['init', '-q', root]);
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

const files = (findings, status = 'file-lines') => findings.filter((row) => row.status === status)
  .map(({ file }) => file);

test('a warm length check uses staged facts and overlays dirty files', async () => {
  const root = await repo({
    'old.mjs': long,
    'new.mjs': '',
    'binary.bin': Buffer.from([0, 10, 10, 10]),
    'rendered.md': '<!-- simt:generated -->\nA\nB\n',
  });
  await reindex(root);
  const rows = await readSourceLineFacts(root);
  assert.equal(rows.get('old.mjs').lines, 3);
  assert.equal(rows.get('new.mjs').lines, 0);
  assert.equal(rows.get('binary.bin').lines, null);
  assert.equal(rows.get('rendered.md').generated, 1);

  // Git reports this file as clean. A worktree read would see a different line count.
  await git(['-C', root, 'update-index', '--assume-unchanged', 'old.mjs']);
  await writeFile(join(root, 'old.mjs'), '');
  await writeFile(join(root, 'new.mjs'), long);
  await git(['-C', root, 'add', 'new.mjs']);
  await writeFile(join(root, 'new.mjs'), 'short\n');
  await writeFile(join(root, 'draft.mjs'), long);
  assert.deepEqual(files(await runDeclaredChecks(root, [length], max)), ['draft.mjs', 'old.mjs']);
});

test('changed checks include staged and unstaged paths, prior neighbors and deleted targets', async () => {
  const root = await repo({
    'a.mjs': 'import "./b.mjs";\n' + long,
    'b.mjs': 'import "./c.mjs";\n' + long,
    'c.mjs': long,
    'unrelated.mjs': 'import "./missing.mjs";\n' + long,
    'empty.mjs': '',
  });
  const manifest = { limits: { ...max.limits, graph: { brokenImports: true } } };
  await reindex(root);
  await unlink(join(root, 'b.mjs'));
  await writeFile(join(root, 'empty.mjs'), long);
  await git(['-C', root, 'add', 'empty.mjs']);
  const scoped = await runDeclaredChecks(root, [length], manifest, { changed: true });
  assert.deepEqual(files(scoped), ['a.mjs', 'c.mjs', 'empty.mjs']);
  assert.deepEqual(files(scoped, 'broken-relative-import'), ['a.mjs']);
  const full = await runDeclaredChecks(root, [length], manifest);
  assert.deepEqual(files(full, 'broken-relative-import'), ['a.mjs', 'unrelated.mjs']);
});

test('cold changed check follows importers of a deleted target', async () => {
  const root = await repo({ 'a.mjs': 'import "./b.mjs";\n' + long, 'b.mjs': '' });
  await unlink(join(root, 'b.mjs'));
  assert.deepEqual(files(await runDeclaredChecks(root, [length], max, { changed: true })), ['a.mjs']);
});

test('check and doctor retain flat findings and link gates with the same cause', async () => {
  const root = await repo({
    'pyproject.toml': '[project]\nname = "fixture"\n',
    'simt.json': JSON.stringify({ gates: { preCommit: ['test', 'lint', 'format'], prePush: [] } }),
  });
  const report = await checkRepo(root, { changed: true });
  assert.ok(report.findings.some(({ file }) => file === 'AGENTS.md'));
  const rows = report.findings.filter(({ status }) => status === 'unrunnable');
  assert.deepEqual(rows.map(({ gate }) => gate), ['test', 'lint', 'format']);
  assert.equal(rows[0].rootCause.id, 'runner:python');
  assert.equal(rows[1].causedBy, rows[0].rootCause.id);
  assert.equal(rows[2].causedBy, undefined);
  const diagnosis = await diagnose(root);
  const doctorRows = serialisedFindings(diagnosis.findings).filter(({ id }) => id === 'unrunnable');
  assert.deepEqual(doctorRows[0].rootCause, rows[0].rootCause);
  assert.equal(doctorRows[1].causedBy, rows[1].causedBy);
  await writeFile(join(root, 'simt.json'), '{');
  assert.ok((await checkRepo(root, { changed: true })).findings.some(({ status }) => status === 'manifest-invalid'));
});
