// The local index (R20, ADR-089).
//
// Two properties. The same blobs come back as the same rows. A
// one-file change rewrites that row and leaves the others. The wall-clock budget is
// not here: a correctness suite cannot tell a busy runner from a regression, so the
// repeatable benchmark lives in `scripts/bench-index.mjs` and the qualification job.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { git } from './fixture.mjs';
import { indexFreshness, isIndexStale } from '../src/index/freshness.mjs';
import {
  buildFtsBodies,
  ftsQueryTerms,
  readEdges,
  readFiles,
  readFts,
  readGraph,
  readSymbols,
  reindex,
  searchFtsBm25,
  tokenizeText,
} from '../src/index/store.mjs';
import { buildOverlay } from '../src/index/overlay.mjs';
import { SQLITE_FILE, indexFileFor } from '../src/index/persist.mjs';
import { openIndex } from '../src/index/open.mjs';
import { indexCommand } from '../src/commands/repoindex.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true });
  await writeFile(join(root, 'apps', 'web', 'package.json'), '{ "name": "web" }\n');
  await writeFile(join(root, 'apps', 'web', 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README'), 'hello\n');
  for (let i = 0; i < 40; i += 1) {
    await writeFile(join(root, 'apps', 'web', 'src', `f${i}.js`), `export const n = ${i};\n`);
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

async function sameRows(root) {
  const first = await reindex(root);
  const rows = await readFiles(root);
  await rm(join(root, SQLITE_FILE));
  const second = await reindex(root);
  const again = await readFiles(root);
  assert.deepEqual(again, rows);
  assert.equal(second.updated, rows.length);
  assert.equal(first.files, rows.length);
  const web = rows.find((row) => row.path === 'apps/web/src/a.ts');
  assert.equal(web.lang, 'typescript');
  assert.equal(web.pkg, 'apps/web');
  assert.equal(rows.find((row) => row.path === 'README').lang, '');
  return rows;
}

test('sqlite rows are a function of the blobs', async () => {
  const root = await repo();
  await sameRows(root, 'sqlite');
  await rm(root, { recursive: true, force: true });
});

test('one changed file is the only row rewritten', async () => {
  const root = await repo();
  await reindex(root);
  const before = await readFiles(root);
  await writeFile(join(root, 'apps', 'web', 'src', 'f0.js'), 'export const n = 99;\n');
  await git(['-C', root, 'add', 'apps/web/src/f0.js']);
  const again = await reindex(root);
  assert.equal(again.updated, 1);
  const after = await readFiles(root);
  const changed = after.filter((row, i) => row.blob !== before[i].blob);
  assert.deepEqual(changed.map((row) => row.path), ['apps/web/src/f0.js']);
  await rm(root, { recursive: true, force: true });
});

test('a removed path leaves the index', async () => {
  const root = await repo();
  await reindex(root);
  await git(['-C', root, 'rm', '-q', 'README']);
  await git(['-C', root, 'commit', '-qm', 'drop readme']);
  const result = await reindex(root);
  assert.equal(result.removed, 1);
  const rows = await readFiles(root);
  assert.equal(rows.some((row) => row.path === 'README'), false);
  await rm(root, { recursive: true, force: true });
});

test(`the tree digest marks a removal stale until the next build (Q42)`, async () => {
  // The freshness signal is a digest compare, not a blob re-read: one
  // `git ls-files -s` against the meta row the last build vouched for.
  const root = await repo();
  try {
    assert.equal(await isIndexStale(root), false, 'no build yet is cold, not stale');
    await reindex(root);
    assert.equal(await isIndexStale(root), false);
    await git(['-C', root, 'rm', '-q', 'README']);
    await git(['-C', root, 'commit', '-qm', 'drop readme']);
    assert.equal(await isIndexStale(root), true);
    await reindex(root);
    assert.equal(await isIndexStale(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a database at a newer version is served from a sidecar, never overwritten (Q44)', async () => {
  // An older simt meeting a newer database used to rewrite it, and two pinned
  // versions flip-flopped the same file (ADR-059). The foreign file now stays
  // with its owner; this version reads and writes its own sidecar.
  const root = await repo();
  try {
    await reindex(root);
    const file = join(root, SQLITE_FILE);
    const newer = new DatabaseSync(file);
    newer.exec('pragma user_version = 6');
    newer.exec(`update meta set value = '6' where key = 'schema'`);
    newer.close();
    await reindex(root);
    const intact = new DatabaseSync(file);
    assert.equal(Number(intact.prepare('pragma user_version').get().user_version), 6, 'the newer database is untouched');
    assert.equal(intact.prepare(`select value from meta where key = 'schema'`).get().value, '6');
    intact.close();
    const sidecar = indexFileFor(root, '6');
    assert.ok((await stat(sidecar)).size > 0, 'this version built its sidecar');
    const rows = await readFiles(root);
    assert.ok(rows.length > 0, 'reads are served from the sidecar, not the foreign file');
    assert.equal(rows.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a v3 database is migrated in place through v4 to v5 (Q44, Q76)', async () => {
  // The 3 -> 4 step recreates the FTS table; the 4 -> 5 step copies its rows by
  // the `ref` column. If 3 -> 4 created the table in the v5 shape, the copy
  // reads a column that is not there and the whole build fails.
  const root = await repo();
  try {
    const file = join(root, SQLITE_FILE);
    await mkdir(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
      create table files(path text primary key, blob text, lang text, bytes int, pkg text);
      create table symbols(id integer primary key, path text, name text, kind text, line int, sig text, exported int);
      create table edges(src text, dst text, kind text, weight real);
      create table embeddings(path text primary key, blob text, model text, dims int, vec blob);
      create table meta(key text primary key, value text);
      create virtual table fts using fts5(kind, ref, body);
      insert into meta(key, value) values ('schema', '3');
      pragma user_version = 3;
      insert into files(path, blob, lang, bytes, pkg) values ('apps/web/src/a.ts', 'deadbeef', 'typescript', 19, 'apps/web');
      insert into symbols(path, name, kind, line, sig, exported) values ('apps/web/src/a.ts', 'a', 'function', 1, 'const a = 1;', 1);
      insert into edges(src, dst, kind, weight) values ('apps/web/src/a.ts', 'README', 'import', 1);
      insert into fts(kind, ref, body) values ('code', 'apps/web/src/a.ts', 'legacy body text');
    `);
    db.close();
    await reindex(root);
    const after = new DatabaseSync(file);
    assert.equal(Number(after.prepare('pragma user_version').get().user_version), 5, 'the chain ended at the current schema');
    const sql = after.prepare(`select sql from sqlite_master where name = 'fts'`).get().sql;
    assert.ok(sql.includes('node_id'), 'the FTS table is the v5 shape');
    assert.ok(after.prepare('select count(*) as n from fts').get().n > 0, 'the FTS rows survived the 3 -> 4 -> 5 chain');
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(`a corrupt index file is named, not read as an empty index (Q44)`, async () => {
  // "Locked", "no such column" and "corrupt" used to all answer `[]`, so a
  // damaged index looked like a cold one.
  const root = await repo();
  try {
    await reindex(root);
    const file = join(root, SQLITE_FILE);
    await writeFile(file, 'not an index');
    const rows = await readFiles(root);
    assert.equal(rows.length, 0);
    assert.equal(rows.error?.code, 'INDEX_CORRUPT', 'the failure is named');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(`reindexing a changed file keeps the edges pointing into it (Q07)`, async () => {
  // The importer owns its outgoing edges: editing src/a.mjs must not delete the
  // test -> src edge, which belongs to the unchanged test file.
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  await writeFile(join(root, 'test.mjs'), "import { a } from './src/a.mjs';\nconsole.log(a);\n");
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  await reindex(root);
  const before = (await readEdges(root)).filter((e) => e.dst === 'src/a.mjs');
  assert.ok(before.length > 0, 'the test -> src edge is indexed');
  await writeFile(join(root, 'src', 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', root, 'add', 'src/a.mjs']);
  await git(['-C', root, 'commit', '-qm', 'bump']);
  await reindex(root);
  const after = (await readEdges(root)).filter((e) => e.dst === 'src/a.mjs');
  assert.ok(after.length > 0, 'reindexing src/a.mjs kept the edge pointing into it');
  await rm(root, { recursive: true, force: true });
});

test('concurrent cold indexes serialize instead of locking (Q08)', async () => {
  // Three writers at once used to fail every run with `database is locked` and
  // leave a database with no tables. Cold builds now go to per-writer temp
  // files with an atomic rename, and incremental writes wait on the lock.
  const root = await repo();
  const runs = await Promise.all([
    reindex(root),
    reindex(root),
    reindex(root),
  ]);
  for (const run of runs) assert.ok(run.files > 0, 'each concurrent run indexed the files');
  const rows = await readFiles(root);
  assert.ok(rows.length > 0, 'the database has tables and rows after concurrent writes');
  await rm(root, { recursive: true, force: true });
});

test('tracked content past the old 64 MiB buffer still indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  // Just past the execFile maxBuffer (64 MiB) that used to cap the cat-file output,
  // so this fails with "stdout maxBuffer length exceeded" on the buffered code path.
  const line = 'lorem ipsum dolor sit amet\n';
  const body = line.repeat(Math.ceil((65 * 1024 * 1024) / line.length));
  await writeFile(join(root, 'large.txt'), body);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'big']);
  const result = await reindex(root);
  assert.equal(result.files, 1);
  const rows = await readFiles(root);
  assert.equal(rows[0].bytes, Buffer.byteLength(body));
  await rm(root, { recursive: true, force: true });
});

test('index refuses a directory that is not a repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  assert.equal(await indexCommand([], { root }), 5);
  await rm(root, { recursive: true, force: true });
});

test('the shared tokenizer folds diacritics and splits CJK into characters (Q43)', async () => {
  // unicode61 remove_diacritics 2 folds München the same way, and this
  // SQLite build folds ß on neither side, so both agree to keep it.
  assert.deepEqual(tokenizeText('Die Straße in München'), ['die', 'straße', 'in', 'munchen']);
  assert.deepEqual(tokenizeText('日本語のドキュメント'), ['日', '本', '語', 'の', 'ド', 'キ', 'ュ', 'メ', 'ン', 'ト']);
  assert.deepEqual(ftsQueryTerms('Fix the magicToken checksum in this file'), ['fix', 'magictoken', 'checksum']);
  const mixed = ftsQueryTerms('日本語の refactor 方法');
  assert.ok(mixed.includes('日') && mixed.includes('refactor') && mixed.includes('法'));
});

test('whole documents index in sections past the old caps (Q43)', async () => {
  // The old body kept 24k characters and 600 tokens: a token at the end of a
  // long file never indexed. Sections keep every token.
  const filler = Array.from({ length: 3000 }, (_, i) => `const fillerVar${i} = ${i};`).join('\n');
  const rows = buildFtsBodies('src/big.mjs', [{ name: 'top', sig: 'function top()' }], `${filler}\nconst needleDeepToken = 1;\n`);
  assert.ok(rows.length > 1, `one row would cap again (got ${rows.length})`);
  assert.ok(rows.every((row) => row.ref === 'src/big.mjs'));
  assert.ok(rows.some((row) => row.body.includes('needledeeptoken')), 'the tail token is indexed');
  assert.ok(rows[0].body.includes('top'), 'symbol tokens ride on the first section');
});

test(`kind and ref no longer match, CJK is retrievable, binaries are counted (Q43)`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'docs', 'decisions', 'why.md'), 'hello world\n');
    await writeFile(join(root, 'jp.md'), '日本語のドキュメントです\n');
    await writeFile(join(root, 'src', 'greet.mjs'), 'Die Straße in München ist groß\n');
    await writeFile(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const result = await reindex(root);
    assert.equal(result.skipped, 1);
    const fts = await readFts(root);
    assert.ok(fts.every((row) => row.ref !== 'bin.dat'), 'the binary leaves no FTS row');
    // The decisions file's body never says "decisions": kind and ref are
    // UNINDEXED now, so only body terms match.
    assert.deepEqual(await searchFtsBm25(root, 'decisions'), []);
    const jp = await searchFtsBm25(root, '日本語');
    assert.ok(jp.some((row) => row.path === 'jp.md'), 'the Japanese document is found');
    const de = await searchFtsBm25(root, 'straße');
    assert.ok(de.some((row) => row.path === 'src/greet.mjs'), 'the German document is found');
    // ß does not fold: the boundary is stated rather than half-fixed.
    assert.deepEqual(await searchFtsBm25(root, 'strasse'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sections of one file collapse to one hit and results stop at 200 (Q43)', async () => {
  const rows = [];
  for (let i = 0; i < 250; i += 1) rows.push({ kind: 'code', ref: `f${i}.js`, body: 'common target token' });
  rows.push(
    { kind: 'code', ref: 'multi.js', body: 'target section one' },
    { kind: 'code', ref: 'multi.js', body: 'target section two target' },
  );
  const ranked = await searchFtsBm25('/nonexistent', 'target', { fts: rows });
  assert.equal(ranked.length, 200);
  assert.equal(ranked.filter((row) => row.path === 'multi.js').length, 1);
});

test('a fresh build is the v5 entity layout, and the read shapes are SQL (Q76)', async () => {
  const root = await repo();
  try {
    await reindex(root);
    const file = join(root, SQLITE_FILE);
    const db = new DatabaseSync(file);
    const names = db
      .prepare(`select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%'`)
      .all()
      .map((row) => row.name);
    for (const name of ['sources', 'nodes', 'edges', 'vectors', 'meta', 'fts']) {
      assert.ok(names.includes(name), `the ${name} table is present`);
    }
    assert.equal(Number(db.prepare('pragma user_version').get().user_version), 5, 'the schema is stamped v5');
    const ftsSql = db.prepare(`select sql from sqlite_master where name = 'fts'`).get().sql;
    assert.ok(ftsSql.includes('node_id'), 'fts rows point at the file node, not a path string');
    const kinds = db.prepare(`select distinct kind from nodes`).all().map((row) => row.kind);
    assert.ok(kinds.includes('symbol'), 'symbols are nodes in the entity layout');
    db.close();
    const rows = await readFiles(root);
    assert.equal(rows.find((row) => row.path === 'apps/web/src/a.ts').pkg, 'apps/web');
    const symbols = await readSymbols(root);
    assert.ok(symbols.length > 0, 'symbol rows are read back');
    assert.deepEqual(Object.keys(symbols[0]).sort(), ['exported', 'kind', 'line', 'name', 'path', 'sig']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openIndex answers with pure data and a structured error when closed (Q76)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.mjs'), 'export const alpha = 1;\n');
    await writeFile(join(root, 'a.test.mjs'), "import { alpha } from './src/a.mjs';\nconsole.log(alpha);\n");
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const ix = await openIndex(root);
    assert.equal(ix.ok, true, 'the index opened');
    const status = await ix.status();
    assert.equal(status.ok, true);
    assert.equal(status.data.stale, false);
    assert.equal(status.data.counts.files, 2);
    const search = await ix.search('alpha');
    assert.equal(search.ok, true);
    assert.ok(search.data.some((row) => row.path === 'src/a.mjs'), 'the BM25 row names the file');
    const ranked = await ix.rank('');
    assert.equal(ranked.ok, true);
    assert.equal(ranked.data.length, 2, 'every file ranks, best first');
    assert.deepEqual(Object.keys(ranked.data[0]).sort(), ['path', 'rank', 'score'], 'the SDK answer keeps its documented shape');
    const cov = await ix.coverage(['src/a.mjs']);
    assert.equal(cov.ok, true);
    assert.deepEqual(cov.data, ['a.test.mjs']);
    const imp = await ix.impact('src/a.mjs');
    assert.equal(imp.ok, true);
    assert.deepEqual(imp.data.importers, [], 'a test importer is not an importer');
    assert.deepEqual(imp.data.tests, ['a.test.mjs']);
    const gov = await ix.governs('src/a.mjs', { ctx: { files: new Set(), commands: new Set(), roots: [] } });
    assert.equal(gov.ok, true);
    assert.deepEqual(gov.data, []);
    ix.close();
    const afterClose = await ix.status();
    assert.equal(afterClose.ok, false);
    assert.equal(afterClose.error.code, 'E_CLOSED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an added, deleted or renamed import destination re-resolves an unchanged importer (PR23)', async () => {
  // Resolution reads the tracked path set, not the importer's bytes. An unchanged
  // importer kept an edge naming a destination that no longer existed (or kept
  // missing one that had arrived), and no build ever looked again.
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '.simt/\n');
    await writeFile(join(root, 'src', 'a.mjs'), "import { b } from './b.mjs';\nexport const a = b;\n");
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);
    assert.deepEqual(
      (await readEdges(root)).filter((edge) => edge.src === 'src/a.mjs').map((edge) => edge.dst),
      ['./b.mjs'],
      'an unresolved specifier is stored as itself',
    );

    // The destination arrives. The importer's blob does not change.
    await writeFile(join(root, 'src', 'b.mjs'), 'export const b = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'add b']);
    const added = await reindex(root);
    assert.equal(added.updated, 1, 'only the new destination needed extraction');
    assert.equal(added.edgesRefreshed, 1, 'the unchanged importer took part in the re-resolution');
    assert.deepEqual(
      (await readEdges(root)).filter((edge) => edge.src === 'src/a.mjs').map((edge) => edge.dst),
      ['src/b.mjs'],
      'the edge still names the specifier after the destination arrived',
    );

    // The destination is renamed: the old edge must go, not linger.
    await git(['-C', root, 'mv', 'src/b.mjs', 'src/c.mjs']);
    await git(['-C', root, 'commit', '-qm', 'rename b']);
    const renamed = await reindex(root);
    assert.equal(renamed.updated, 1, 'only the renamed destination was extracted');
    assert.deepEqual(
      (await readEdges(root)).filter((edge) => edge.src === 'src/a.mjs').map((edge) => edge.dst),
      ['./b.mjs'],
      'a renamed destination left the old resolved edge behind',
    );

    // A destination that existed and is deleted is the same case from the other side.
    await writeFile(join(root, 'src', 'b.mjs'), 'export const b = 2;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'b again']);
    await reindex(root);
    assert.deepEqual(
      (await readEdges(root)).filter((edge) => edge.src === 'src/a.mjs').map((edge) => edge.dst),
      ['src/b.mjs'],
    );
    await git(['-C', root, 'rm', '-q', 'src/b.mjs']);
    await git(['-C', root, 'commit', '-qm', 'drop b']);
    const deleted = await reindex(root);
    assert.equal(deleted.updated, 0);
    assert.deepEqual(
      (await readEdges(root)).filter((edge) => edge.src === 'src/a.mjs').map((edge) => edge.dst),
      ['./b.mjs'],
      'a deleted destination left the resolved edge behind',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a changed importer and a changed path set in one build insert its edges once (PR23 regression)', async () => {
  // The re-resolution loop walks `previous`, and a changed row is in it. With the
  // blob and the path set both moving - the ordinary case for a working tree that
  // gained a file - the changed importer was extracted AND re-resolved from its
  // stored specifiers, so every edge it owns was inserted twice and the whole
  // build died on the edges unique key (seen through `slice start`, which maps the
  // repository first).
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '.simt/\n');
    await writeFile(join(root, 'src', 'a.mjs'), "import { b } from './b.mjs';\nexport const a = b;\n");
    await writeFile(join(root, 'src', 'b.mjs'), 'export const b = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);

    // One blob changes and one path arrives in the same build.
    await writeFile(join(root, 'src', 'a.mjs'), "import { b } from './b.mjs';\nexport const a = b + 1;\n");
    await writeFile(join(root, 'src', 'c.mjs'), 'export const c = 3;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'edit a, add c']);
    const rebuilt = await reindex(root);
    assert.equal(rebuilt.updated, 2);
    assert.equal(rebuilt.edgesRefreshed, 0, 'a changed importer was re-resolved a second time');
    assert.deepEqual(
      (await readEdges(root)).filter((edge) => edge.src === 'src/a.mjs').map((edge) => edge.dst),
      ['src/b.mjs'],
      'the changed importer carries its edge exactly once',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unchanged source is re-extracted when the parser reading changes (PR23)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);
    assert.ok((await readSymbols(root)).some((row) => row.name === 'a'), 'the built-in reading ran');

    const changed = await reindex(root, {
      adapter: {
        extract() {
          return {
            symbols: [{ name: 'Exact', kind: 'function', line: 1, sig: 'exact', exported: 1 }],
            edges: [],
          };
        },
      },
    });
    assert.equal(changed.updated, 1, 'the unchanged blob was reused under a new parser');
    assert.deepEqual((await readSymbols(root)).map((row) => row.name), ['Exact']);

    const back = await reindex(root);
    assert.equal(back.updated, 1, 'a second parser change was not a rebuild');
    assert.ok((await readSymbols(root)).some((row) => row.name === 'a'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unchanged source is rebuilt under a new package root (PR23)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '.simt/\n');
    await writeFile(join(root, 'apps', 'web', 'src', 'a.js'), 'export const a = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);
    assert.equal((await readFiles(root)).find((row) => row.path === 'apps/web/src/a.js').pkg, '');

    await writeFile(join(root, 'apps', 'web', 'package.json'), '{ "name": "web" }\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'package root']);
    await reindex(root);
    assert.equal(
      (await readFiles(root)).find((row) => row.path === 'apps/web/src/a.js').pkg,
      'apps/web',
      'an unchanged source kept the package it had before the marker existed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('freshness is a state, and a failed git read is unknown rather than current (PR23)', async () => {
  const root = await repo();
  try {
    assert.equal((await indexFreshness(root)).state, 'cold', 'no build yet is cold');
    await reindex(root);
    assert.equal((await indexFreshness(root)).state, 'current');

    await git(['-C', root, 'rm', '-q', 'README']);
    assert.equal((await indexFreshness(root)).state, 'stale');
    await git(['-C', root, 'commit', '-qm', 'drop readme']);
    await reindex(root);
    assert.equal((await indexFreshness(root)).state, 'current');

    // The cache is intact and the repository is what cannot be read. Reporting
    // `not stale` here was the conflation this state removes.
    await rm(join(root, '.git'), { recursive: true, force: true });
    const unknown = await indexFreshness(root);
    assert.equal(unknown.state, 'unknown');
    assert.match(unknown.reason, /git/);
    assert.equal(await isIndexStale(root), false, 'the boolean helper reports only a known stale index');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('simultaneous incremental builders agree with a clean rebuild (PR23)', async () => {
  const root = await repo();
  try {
    await reindex(root);
    await writeFile(join(root, 'apps', 'web', 'src', 'f1.js'), 'export const n = 101;\n');
    await writeFile(join(root, 'README'), 'hello again\n');
    await git(['-C', root, 'add', 'README', 'apps/web/src/f1.js']);

    const runs = await Promise.all([reindex(root), reindex(root), reindex(root)]);
    for (const run of runs) assert.ok(run.files > 0, 'a concurrent builder answered no files');
    const incremental = await readGraph(root);
    assert.equal(incremental.files.error, undefined, 'the graph read failed after concurrent writes');

    await rm(join(root, SQLITE_FILE));
    await reindex(root);
    assert.deepEqual(await readFiles(root), incremental.files, 'files differ from a clean rebuild');
    assert.deepEqual(await readSymbols(root), incremental.symbols, 'symbols differ from a clean rebuild');
    assert.deepEqual(await readEdges(root), incremental.edges, 'edges differ from a clean rebuild');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unstaged edit belongs to the overlay, and the index keeps the staged blob (PR23)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);
    const staged = await readFiles(root);

    await writeFile(join(root, 'src', 'a.mjs'), 'export const a = 99;\n');
    assert.equal((await indexFreshness(root)).state, 'current', 'an unstaged edit made the cache look stale');
    assert.deepEqual(await readFiles(root), staged, 'the unstaged bytes reached the cached row');

    const overlay = await buildOverlay({
      changes: [{ path: 'src/a.mjs' }],
      read: () => readFile(join(root, 'src', 'a.mjs'), 'utf8'),
    });
    assert.match(overlay.nodes[0].revision, /^worktree:/, 'the edit is labelled as the working tree, not a blob');
    assert.notEqual(overlay.nodes[0].revision, `staged:${staged[0].blob}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openIndex names the build, the overlay and the staged basis of every answer (PR23)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.mjs'), 'export const alpha = 1;\n');
    await writeFile(join(root, 'a.test.mjs'), "import { alpha } from './src/a.mjs';\nconsole.log(alpha);\n");
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const ix = await openIndex(root);
    assert.equal(ix.ok, true);
    const status = await ix.status();
    assert.equal(status.data.freshness.state, 'current');
    assert.equal(status.data.basis.rows.source, 'git-index');
    assert.equal(status.data.basis.rows.label, 'staged');
    assert.equal(status.data.basis.overlay.applied, false);
    assert.match(status.data.basis.index.build, /^[0-9a-f]{40}$/);

    const answers = [
      await ix.search('alpha'),
      await ix.rank(''),
      await ix.coverage(['src/a.mjs']),
      await ix.impact('src/a.mjs'),
      await ix.governs('src/a.mjs'),
    ];
    for (const answer of answers) {
      assert.equal(answer.ok, true);
      assert.equal(answer.data.basis.index.build, status.data.basis.index.build, 'an answer came from another build');
      assert.equal(answer.data.basis.overlay.applied, false);
      assert.equal(answer.data.basis.rows.label, 'staged');
    }
    const basis = await ix.basis();
    assert.equal(basis.ok, true);
    assert.equal(basis.data.index.tree, status.data.basis.index.tree);
    ix.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openIndex in a directory that is not a repository answers E_BUILD (Q76)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  try {
    const ix = await openIndex(root);
    assert.equal(ix.ok, false);
    assert.equal(ix.error.code, 'E_BUILD');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
