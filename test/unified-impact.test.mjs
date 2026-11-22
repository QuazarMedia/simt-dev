import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { digestOf } from '../src/knowledge/observations.mjs';
import { ensureGit, git, simt, tempDir } from './fixture.mjs';

async function fixture(files) {
  const root = await tempDir('unified-impact-');
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  await ensureGit(root);
  const inputs = Object.keys(files).filter((path) => path.startsWith('.simt/knowledge/'));
  if (inputs.length) {
    await git(['add', '-f', '--', ...inputs], { cwd: root });
    await git(['commit', '-qm', 'declare knowledge inputs'], { cwd: root });
  }
  return root;
}

async function query(root, args) {
  const result = await simt([...args, '--json'], { cwd: root });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('code and scoped knowledge reports connect a generator to claims, output and obligations', async () => {
  const generator = 'src/generate.mjs';
  const initial = 'export function generateOutput() {\n  return 1;\n}\n';
  const document = 'handbook/output.md';
  const output = '<!-- generated, do not edit -->\n---\nid: report\n---\n# Output\n';
  const root = await fixture({
    'simt.json': JSON.stringify({ work: { version: 2, scopes: [
      { id: 'handbook', paths: ['handbook', 'src/use.mjs', 'test'], kind: 'document' },
      { id: 'private', paths: ['private'], kind: 'document' },
    ] } }),
    [generator]: initial,
    'api/report.schema.json': '{"type":"number"}',
    'src/use.mjs': "import { generateOutput } from './generate.mjs';\nexport function useOutput() { return generateOutput(); }\n",
    'test/use.test.mjs': "import { useOutput } from '../src/use.mjs';\nuseOutput();\n",
    'private/note.md': '# Confidential\n',
    'handbook/source.md': '---\nid: summary\nauthority: reviewed\nsources: ["src/generate.mjs#generateOutput"]\n---\n'
      + '# Summary\n<!-- claim: id=output-limit subject=output predicate=minimum type=number value=1 evidence=src/generate.mjs status=reviewed -->\n',
    [document]: output,
    'handbook/schema.md': '---\nid: schema-notes\nauthority: reviewed\nsources: ["api/report.schema.json"]\n---\n# Schema\n',
    '.simt/knowledge/derivations.json': JSON.stringify({ receipts: [{
      id: 'output-receipt', output: { path: document, digest: digestOf(output) },
      tools: [{ kind: 'generator', id: generator, version: 1, digest: digestOf(initial) }],
      generator: { id: 'generator', version: 1 }, complete: true,
    }] }),
  });
  await writeFile(join(root, generator), initial.replace('return 1', 'return 2'));
  await writeFile(join(root, 'private/note.md'), '# Edited out-of-scope text\n');
  const code = await query(root, ['impact', 'src/generate.mjs#generateOutput', '--with-knowledge']);
  assert.deepEqual(code.importers, ['src/use.mjs']);
  assert.deepEqual(code.tests, ['test/use.test.mjs']);
  const scoped = code.knowledge.scopes.find(({ scope }) => scope === 'handbook');
  assert.ok(scoped.affected.claims.includes('output-limit'), JSON.stringify(scoped.affected));
  assert.ok(scoped.affected.artifacts.includes('summary'));
  assert.equal(scoped.regeneration.stale[0]?.output, document, JSON.stringify(scoped.regeneration));
  assert.ok(scoped.verification.obligations.some(({ paths }) => paths.includes(document)));

  const knowledge = await query(root, ['knowledge', 'impact', '--changed', '--scope', 'handbook']);
  assert.deepEqual(knowledge.code.tests, code.tests);
  assert.deepEqual(knowledge.affected.claims, scoped.affected.claims);
  assert.doesNotMatch(JSON.stringify(knowledge), /private\/note|out-of-scope text/);
  const contract = await query(root, ['impact', 'api/report.schema.json', '--with-knowledge']);
  assert.ok(contract.knowledge.scopes[0].affected.artifacts.includes('schema-notes'));
});

test('conventional tracked impact inputs use exact identity and code-only output stays compatible', async () => {
  const plain = await fixture({ 'code.mjs': 'export function example() { return 1; }\n' });
  assert.deepEqual(await query(plain, ['impact', 'code.mjs', '--with-knowledge']), await query(plain, ['impact', 'code.mjs']));
  const root = await fixture({
    'code.mjs': 'export function example() {\n  return 1;\n}\n',
    'copies/code.mjs': 'export function other() {}\n',
    '.simt/knowledge/impact.json': JSON.stringify({ graph: {
      nodes: [{ id: 'original', kind: 'source', path: 'code.mjs' }, { id: 'copy', kind: 'source', path: 'copies/code.mjs' },
        { id: 'notes', kind: 'document' }, { id: 'other', kind: 'document' }],
      edges: [{ from: 'notes', to: 'original', kind: 'derived-from', status: 'reviewed' },
        { from: 'other', to: 'copy', kind: 'derived-from', status: 'reviewed' }],
    } }),
  });
  await writeFile(join(root, 'code.mjs'), 'export function example() {\n  return 2;\n}\n');
  const report = await query(root, ['knowledge', 'impact', '--changed']);
  assert.deepEqual(report.knowledge.inputs.changed, ['original'], JSON.stringify(report));
  assert.deepEqual(report.knowledge.inputs.affected.artifacts, ['notes']);
  assert.equal(report.code.targets[0].symbol, 'example');
});

test('impact --json stays one document when the workspace siblings are not git repositories', async () => {
  // A workspace full of stale sibling repos used to wedge one `{ok:false}` document
  // into stdout per sibling: `tracked` answered a library call with `fail`, which emits.
  // An empty `.git` directory classifies as a repo but fails `ls-files` - the exact
  // shape of the fixture dirs left in the temp directory the gate worktree lives in.
  const ws = await tempDir('unified-impact-ws-');
  for (const name of ['stale-a', 'stale-b']) await mkdir(join(ws, name, '.git'), { recursive: true });
  const root = await tempDir('unified-impact-repo-');
  await mkdir(join(root, 'api'));
  await writeFile(join(root, 'api/report.schema.json'), '{"type":"number"}\n');
  await writeFile(join(root, 'simt.json'), JSON.stringify({ workspace: ws }));
  await ensureGit(root);
  const result = await simt(['impact', 'api/report.schema.json', '--json'], { cwd: root });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected exactly one JSON document, got ${lines.length}`);
  assert.equal(JSON.parse(lines[0]).ok, true);
});
