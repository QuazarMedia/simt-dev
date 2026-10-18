// A repository with one of each governor (R25, ADR-093).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { whyCommand } from '../src/commands/why.mjs';

const tick = String.fromCharCode(96);
const bt = (value) => tick + value + tick;

test('a fixture repository lists every governor and reports an unresolved token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-why-'));
  await git(['init'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
  await mkdir(join(root, 'docs', 'lessons'), { recursive: true });
  await mkdir(join(root, 'rules'), { recursive: true });
  await mkdir(join(root, 'graph'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
  await writeFile(join(root, 'docs', 'decisions', 'ADR-001-keep.md'), [
    '# ADR-001 — Keep the file',
    '',
    'Status: **accepted**',
    'Affects: ' + bt('src/keep.mjs') + ', ' + bt('simt-dev no-such') + ',',
    bt('missing.mjs'),
    '',
  ].join('\n'));
  await writeFile(join(root, 'docs', 'lessons', '0001-keep.md'), '---\nsimt-trigger: { paths: ["src/keep.mjs"] }\n---\n\n# Keep\n');
  await writeFile(join(root, 'rules', 'toy.md'), '---\nsimt-id: toy\nsimt-title: Toy\nsimt-scope: ["src/keep.mjs"]\n---\n\n# Toy\n');
  await writeFile(join(root, 'graph', 'skills.graph.json'), JSON.stringify({
    skills: [{ name: 'keep', summary: 'Keep a file', paths: ['src/keep.mjs'] }],
  }));
  await writeFile(join(root, 'simt.json'), JSON.stringify({ gates: { commands: { memory: 'node src/keep.mjs' } } }));
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'keep'], { cwd: root });

  const listed = await capture(() => whyCommand(['src/keep.mjs'], { root }, []));
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /decision {2}ADR-001 {2}Keep the file/);
  assert.match(listed.stdout, /rule {6}toy {2}Toy/);
  assert.match(listed.stdout, /skill {5}keep {2}Keep a file/);
  assert.match(listed.stdout, /gate {6}memory /);
  assert.match(listed.stdout, /lesson {4}0001-keep {2}Keep/);

  const open = await capture(() => whyCommand([], { root }, []));
  assert.match(open.stdout, /UNRESOLVED-AFFECTS {2}simt-dev no-such {2}ADR-001/);
  assert.match(open.stdout, /UNRESOLVED-AFFECTS {2}missing\.mjs {2}ADR-001/);

  const missing = await capture(() => whyCommand(['src/absent.mjs'], { root }, []));
  assert.equal(missing.code, 2);
  await rm(root, { recursive: true, force: true });

  const bare = await mkdtemp(join(tmpdir(), 'idx-why-'));
  const refused = await capture(() => whyCommand(['src/keep.mjs'], { root: bare }, []));
  assert.equal(refused.code, 5);
  await rm(bare, { recursive: true, force: true });
});

async function capture(run) {
  const chunks = [];
  const errors = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { code, stdout: chunks.join(''), stderr: errors.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
