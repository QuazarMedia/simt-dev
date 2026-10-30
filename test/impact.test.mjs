// Impact (R23, ADR-096).
//
// A changed export lists the files that import it, the tests of that closure,
// and a contract another repository references. The list is the fixture, not
// a measurement of this checkout.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { impactCommand } from '../src/commands/impact.mjs';
import { dependents, ownersOf } from '../src/index/impact.mjs';

const exec = promisify(execFile);
const tick = String.fromCharCode(96);

test('dependents are the importers, and the last CODEOWNERS line wins', () => {
  const imports = [
    { src: 'src/use.mjs', dst: 'src/keep.mjs', kind: 'import' },
    { src: 'src/mid.mjs', dst: 'src/use.mjs', kind: 'import' },
    { src: 'test/mid.test.mjs', dst: 'src/mid.mjs', kind: 'import' },
    { src: 'src/other.mjs', dst: 'src/else.mjs', kind: 'import' },
  ];
  const reach = dependents('src/keep.mjs', imports);
  assert.deepEqual(reach.importers, ['src/mid.mjs', 'src/use.mjs']);
  assert.deepEqual(reach.tests, ['test/mid.test.mjs']);
  assert.equal(reach.truncated, false);
  const capped = dependents('src/keep.mjs', imports, 1);
  assert.equal(capped.truncated, true);
  assert.deepEqual(ownersOf('*\t@platform\nsrc/keep.mjs @api\n', 'src/keep.mjs'), ['@api']);
  assert.deepEqual(ownersOf('*\t@platform\nsrc/keep.mjs @api\n', 'src/other.mjs'), ['@platform']);
});

test('impact lists the importers, their test, and one cross-repo consumer', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'idx-impact-'));
  const producer = join(parent, 'producer');
  const consumer = join(parent, 'consumer');
  try {
    await mkdir(join(producer, 'src'), { recursive: true });
    await mkdir(join(producer, 'test'), { recursive: true });
    await mkdir(join(producer, 'api'), { recursive: true });
    await mkdir(join(producer, 'docs', 'decisions'), { recursive: true });
    await mkdir(join(producer, 'rules'), { recursive: true });
    await mkdir(join(producer, '.github'), { recursive: true });
    await mkdir(join(consumer, 'src'), { recursive: true });
    await writeFile(join(producer, 'src', 'keep.mjs'), 'export function keep() { return 1; }\n');
    await writeFile(join(producer, 'src', 'use.mjs'), "import { keep } from './keep.mjs';\nexport function use() { return keep(); }\n");
    await writeFile(join(producer, 'src', 'mid.mjs'), "import { use } from './use.mjs';\nexport function mid() { return use(); }\n");
    await writeFile(join(producer, 'src', 'other.mjs'), 'export function other() { return 0; }\n');
    await writeFile(join(producer, 'test', 'mid.test.mjs'), "import { mid } from '../src/mid.mjs';\n");
    await writeFile(
      join(producer, 'api', 'openapi.json'),
      '{"openapi":"3.0.0","paths":{"/keep":{"get":{"operationId":"keep"}}}}\n',
    );
    await writeFile(
      join(producer, 'docs', 'decisions', 'ADR-001-keep.md'),
      ['# ADR-001 — keep', '', 'Status: **accepted**', '', 'Affects: ' + tick + 'src/keep.mjs' + tick, ''].join('\n'),
    );
    await writeFile(
      join(producer, 'rules', 'keep.md'),
      ['---', 'simt-id: keep', 'simt-title: keep the export', 'simt-scope: ["src/keep.mjs"]', '---', ''].join('\n'),
    );
    await writeFile(join(producer, '.github', 'CODEOWNERS'), '* @platform\nsrc/keep.mjs @api\n');
    await writeFile(join(consumer, 'src', 'client.mjs'), 'const spec = "api/openapi.json";\n');
    await writeFile(join(consumer, 'src', 'note.mjs'), 'export const note = 1;\n');
    await git(['init', '-q', producer]);
    await git(['init', '-q', consumer]);
    await git(['-C', producer, 'add', '-A']);
    await git(['-C', consumer, 'add', '-A']);
    await git(['-C', producer, 'commit', '-qm', 'producer']);
    await git(['-C', consumer, 'commit', '-qm', 'consumer']);

    const listed = await capture(() => impactCommand(['keep'], { root: producer, workspace: parent }));
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /file\s+src\/keep\.mjs/);
    assert.match(listed.stdout, /symbol\s+keep/);
    assert.match(listed.stdout, /importer\s+src\/mid\.mjs/);
    assert.match(listed.stdout, /importer\s+src\/use\.mjs/);
    assert.match(listed.stdout, /test\s+test\/mid\.test\.mjs/);
    assert.match(listed.stdout, /decision\s+ADR-001\s+keep/);
    assert.match(listed.stdout, /rule\s+keep\s+keep the export/);
    assert.match(listed.stdout, /owner\s+@api/);
    assert.match(listed.stdout, /consumer\s+consumer\/src\/client\.mjs\s+api\/openapi\.json/);
    assert.equal(listed.stdout.includes('src/other.mjs'), false);
    assert.equal(listed.stdout.includes('note.mjs'), false);

    const alone = await capture(() => impactCommand(['src/keep.mjs'], { root: producer, workspace: 'off' }));
    assert.equal(alone.code, 0, alone.stderr);
    assert.match(alone.stdout, /importer\s+src\/use\.mjs/);
    assert.equal(alone.stdout.includes('consumer'), false);

    const bare = await mkdtemp(join(tmpdir(), 'idx-impact-'));
    const refused = await capture(() => impactCommand(['keep'], { root: bare }));
    assert.equal(refused.code, 5);
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('impact names a non-ASCII path instead of calling it missing (Q39)', async () => {
  // Without `-z`, `git ls-files` C-quotes the path and the reader's real
  // filename matches nothing, so impact reported "not a file or an export".
  const root = await mkdtemp(join(tmpdir(), 'idx-impact-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'ünï.mjs'), 'export const uni = 1;\n');
    await git(['init', '-q', root]);
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const listed = await capture(() => impactCommand(['src/ünï.mjs'], { root, workspace: 'off' }));
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /file\s+src\/ünï\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(args) {
  return exec('git', ['-c', 'user.name=simt-dev tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 16 << 20 });
}

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
