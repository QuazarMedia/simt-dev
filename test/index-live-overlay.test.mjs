import assert from 'node:assert/strict';
import { mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadLiveGraph } from '../src/index/live.mjs';
import { runDeclaredChecks } from '../src/kernel/checks.mjs';
import { SQLITE_FILE, reindex } from '../src/index/store.mjs';
import { ensureGit, git, simt, tempDir } from './fixture.mjs';

test('overlays source, lexical rows and cross-file bindings while preserving the staged database', async () => {
  const root = await tempDir('index-live-overlay-');
  await writeFile(join(root, 'source.mjs'), 'export function previous() {}');
  await writeFile(join(root, 'caller.mjs'), "import { previous } from './source.mjs';\nexport function caller() { previous(); }");
  await writeFile(join(root, 'old.mjs'), 'export function renameMe() {}');
  await ensureGit(root);
  await reindex(root, { fielded: true });
  const file = join(root, SQLITE_FILE);
  const before = await readFile(file);
  const stamp = (await stat(file)).mtimeMs;
  await writeFile(join(root, 'source.mjs'), 'export function current() {}\n// unusual searchable marker');
  await writeFile(join(root, 'caller.mjs'), "import { current } from './source.mjs';\nexport function caller() { current(); }");
  await git(['mv', 'old.mjs', 'new.mjs'], { cwd: root });
  await symlink('source.mjs', join(root, 'link.mjs'));
  const graph = await loadLiveGraph(root, { text: true, fielded: true, binding: true });
  assert.deepEqual(graph.files.map(({ path }) => path), ['caller.mjs', 'new.mjs', 'source.mjs']);
  assert.equal(graph.files.find(({ path }) => path === 'source.mjs').provenance, 'worktree');
  assert.ok(graph.fieldedRows.some(({ ref, body }) => ref === 'source.mjs' && body.includes('searchable')));
  assert.ok(graph.symbolGraph.edges.some(({ kind, dst, provenance }) => kind === 'calls_symbol' && dst === 'sym:source.mjs#current@1' && provenance === 'worktree'));
  assert.equal(graph.symbolGraph.edges.some(({ dst }) => dst.includes('#previous@')), false);
  assert.deepEqual(graph.basis.overlay.unreadable, ['link.mjs']);
  assert.deepEqual(await readFile(file), before);
  assert.equal((await stat(file)).mtimeMs, stamp);
});

test('brief, impact, gate and tests observe dirty imports and exports on their normal CLI paths', async () => {
  const root = await tempDir('index-live-cli-');
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  await writeFile(join(root, 'old.mjs'), 'export const old = 1;\n');
  await writeFile(join(root, 'current.mjs'), 'export function previous() {}\n');
  await writeFile(join(root, 'test', 'dependent.test.mjs'), "import '../old.mjs';\n");
  await ensureGit(root);
  await reindex(root);
  await writeFile(join(root, 'current.mjs'), 'export function markerCurrent() {}\n');
  await writeFile(join(root, 'test', 'dependent.test.mjs'), "import '../current.mjs';\n");

  const file = join(root, SQLITE_FILE);
  const before = await readFile(file);
  const brief = await simt(['brief', 'inspect markerCurrent', '--json'], { cwd: root });
  assert.equal(brief.code, 0, brief.stderr);
  assert.match(brief.stdout, /current\.mjs/);
  const impact = await simt(['impact', 'markerCurrent', '--json'], { cwd: root });
  assert.equal(impact.code, 0, impact.stdout + impact.stderr);
  assert.deepEqual(JSON.parse(impact.stdout).tests, ['test/dependent.test.mjs']);
  const tests = await simt(['tests', 'current.mjs', '--json'], { cwd: root });
  assert.equal(tests.code, 0, tests.stderr);
  assert.deepEqual(JSON.parse(tests.stdout).tests, ['test/dependent.test.mjs']);
  const gate = await simt(['gate', 'current.mjs', '--json'], { cwd: root });
  assert.equal(gate.code, 0, gate.stdout);
  assert.deepEqual(JSON.parse(gate.stdout).selected, ['test/dependent.test.mjs']);
  assert.deepEqual(await readFile(file), before);
});

test('transient reads use changed blobs after a commit and leave clean reads cold without a cache', async () => {
  const root = await tempDir('index-live-cold-');
  await writeFile(join(root, 'source.mjs'), 'export function beforeCommit() {}\n');
  await ensureGit(root);
  assert.equal((await loadLiveGraph(root, { build: false })).cold, true);
  assert.ok((await loadLiveGraph(root)).symbols.some(({ name }) => name === 'beforeCommit'));
  await assert.rejects(stat(join(root, SQLITE_FILE)), { code: 'ENOENT' });
  await reindex(root);
  const old = await readFile(join(root, SQLITE_FILE));
  await writeFile(join(root, 'source.mjs'), 'export function afterCommit() {}\n');
  await git(['commit', '-am', 'edit source'], { cwd: root });
  const graph = await loadLiveGraph(root);
  assert.deepEqual(graph.symbols.map(({ name }) => name), ['afterCommit']);
  assert.deepEqual(graph.basis.overlay.readPaths, []);
  assert.equal(graph.files[0].provenance, 'committed');
  assert.deepEqual(await readFile(join(root, SQLITE_FILE)), old);
});

test('a cold live graph keeps binary blob metadata and leaves it out of the search index', async () => {
  const root = await tempDir('index-live-binary-');
  const body = Buffer.from([0xff, 0, 0x12]);
  await writeFile(join(root, 'asset.bin'), body);
  await ensureGit(root);
  const graph = await loadLiveGraph(root, { text: true, binding: true });
  assert.equal(graph.files.find(({ path }) => path === 'asset.bin').bytes, body.length);
  assert.deepEqual(graph.fts, []);
  assert.equal(graph.stale, false);
});

test('why and file checks can address a newly created path', async () => {
  const root = await tempDir('index-live-paths-');
  await writeFile(join(root, 'existing.mjs'), '// existing\n');
  await ensureGit(root);
  await writeFile(join(root, 'draft.mjs'), 'export const draft = true;\n// line two\n// line three\n');
  const why = await simt(['why', 'draft.mjs', '--json'], { cwd: root });
  assert.equal(why.code, 0, why.stdout);
  assert.equal(JSON.parse(why.stdout).path, 'draft.mjs');
  const findings = await runDeclaredChecks(root, [{
    id: 'length',
    source: 'AGENTS.md',
    body: '- Limit file lines. <!-- simt-check: max-file-lines -->',
  }], { limits: { fileLines: { warn: 1, error: 2 } } });
  assert.ok(findings.some(({ file, status }) => file === 'draft.mjs' && status === 'file-lines'));
});

test('a git index written moments ago does not break the stamp-fast snapshot read', async () => {
  const root = await tempDir('index-live-unsafe-stamp-');
  await writeFile(join(root, 'a.mjs'), 'import "./b.mjs";\nexport function a() { return 1; }\n');
  await writeFile(join(root, 'b.mjs'), 'import "./a.mjs";\nexport function b() { return 1; }\n');
  await ensureGit(root);
  await reindex(root, { fielded: true });
  // Force the racy-git window: a stamp git wrote within the last second is unsafe, so the
  // stamp-fast path must fall through to the slow snapshot that computes a tree digest.
  const now = new Date();
  await utimes(join(root, '.git', 'index'), now, now);
  const graph = await loadLiveGraph(root, { text: false, fielded: true, nativeLexical: true, binding: true });
  assert.ok(!graph.broken);
  assert.ok(!graph.indexError);
  assert.deepEqual(graph.files.map(({ path }) => path).sort(), ['a.mjs', 'b.mjs']);
});
