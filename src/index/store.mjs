// The local index (ADR-089).
//
// `node:sqlite` when this Node has it, including FTS5, and a JSON-lines file
// otherwise. Either one is a cache: `git ls-files -s` can rebuild it, so a missing
// file is not a lost database. A blob that has not changed is not read again.

import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SQLITE_FILE = '.simt-dev/index.sqlite';
export const JSONL_FILE = '.simt-dev/index.jsonl';

const MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', kt: 'kotlin', kts: 'kotlin', java: 'java',
  py: 'python', go: 'go', rs: 'rust', swift: 'swift', dart: 'dart', rb: 'ruby', cs: 'csharp',
};

const SCHEMA = `
create table if not exists files(path text primary key, blob text, lang text, bytes int, pkg text);
create table if not exists symbols(id integer primary key, path text, name text, kind text, line int, sig text, exported int);
create table if not exists edges(src text, dst text, kind text, weight real);
create virtual table if not exists fts using fts5(kind, ref, body);
create table if not exists meta(key text primary key, value text);
`;

/** `sqlite` when this process can open a database and create an FTS5 table. */
export async function probeBackend() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create virtual table fts using fts5(kind, ref, body)');
    db.close();
    return 'sqlite';
  } catch {
    return 'jsonl';
  }
}

/**
 * Rebuild the index from the git index. Unchanged blobs are left as they are.
 *
 * @param {string} root
 * @param {{backend?: 'sqlite'|'jsonl'}} [opts]
 */
export async function reindex(root, opts = {}) {
  const started = Date.now();
  const backend = opts.backend ?? await probeBackend();
  const listed = await lsFiles(root);
  const previous = await readFiles(root, { backend });
  const prior = new Map(previous.map((row) => [row.path, row]));
  const cache = new Map();
  const changed = [];
  for (const entry of listed) {
    const old = prior.get(entry.path);
    if (old && old.blob === entry.blob) continue;
    changed.push(entry);
  }
  const sizes = await blobSizes(root, changed.map((entry) => entry.blob));
  const next = [];
  for (const entry of changed) {
    next.push({
      path: entry.path,
      blob: entry.blob,
      lang: langOf(entry.path),
      bytes: sizes.get(entry.blob) ?? 0,
      pkg: await packageOf(root, entry.path, cache),
    });
  }
  const keep = new Set(listed.map((entry) => entry.path));
  const removed = previous.filter((row) => !keep.has(row.path)).map((row) => row.path);
  if (backend === 'sqlite') await writeSqlite(root, next, removed);
  else await writeJsonl(root, previous, next, removed);
  return {
    backend,
    files: listed.length,
    updated: next.length,
    removed: removed.length,
    ms: Date.now() - started,
  };
}

/** File rows, sorted by path. The same blobs read back as the same rows. */
export async function readFiles(root, opts = {}) {
  const backend = opts.backend ?? await probeBackend();
  if (backend === 'sqlite') return readSqlite(root);
  return readJsonl(root);
}

async function writeSqlite(root, next, removed) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(root, SQLITE_FILE);
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    db.exec('begin');
    const upsert = db.prepare(`insert into files(path, blob, lang, bytes, pkg) values (?, ?, ?, ?, ?)
      on conflict(path) do update set blob = excluded.blob, lang = excluded.lang, bytes = excluded.bytes, pkg = excluded.pkg`);
    const dropSymbols = db.prepare('delete from symbols where path = ?');
    const dropEdges = db.prepare('delete from edges where src = ? or dst = ?');
    const dropFile = db.prepare('delete from files where path = ?');
    for (const row of next) {
      upsert.run(row.path, row.blob, row.lang, row.bytes, row.pkg);
      // The blob changed, so anything extracted from the old one is about a file
      // that is no longer there. R21 refills these tables; R20 only clears them.
      dropSymbols.run(row.path);
      dropEdges.run(row.path, row.path);
    }
    for (const path of removed) {
      dropFile.run(path);
      dropSymbols.run(path);
      dropEdges.run(path, path);
    }
    db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run('schema', '1');
    db.exec('commit');
  } catch (error) {
    try { db.exec('rollback'); } catch { /* a failed begin has nothing to undo */ }
    throw error;
  } finally {
    db.close();
  }
}

async function readSqlite(root) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return [];
  }
  const file = join(root, SQLITE_FILE);
  try {
    await stat(file);
  } catch {
    return [];
  }
  const db = new DatabaseSync(file);
  try {
    const table = db.prepare("select name from sqlite_master where type = 'table' and name = 'files'").get();
    if (!table) return [];
    return db.prepare('select path, blob, lang, bytes, pkg from files order by path').all();
  } finally {
    db.close();
  }
}

async function writeJsonl(root, previous, next, removed) {
  const gone = new Set(removed);
  const replaced = new Map(next.map((row) => [row.path, row]));
  const rows = [];
  for (const row of previous) {
    if (gone.has(row.path)) continue;
    rows.push(replaced.get(row.path) ?? row);
    replaced.delete(row.path);
  }
  for (const row of replaced.values()) rows.push(row);
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const file = join(root, JSONL_FILE);
  await mkdir(dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ table: 'meta', key: 'schema', value: '1' }),
    ...rows.map((row) => JSON.stringify({ table: 'files', ...row })),
  ];
  await writeFile(file, `${lines.join('\n')}\n`);
}

async function readJsonl(root) {
  let text;
  try {
    text = await readFile(join(root, JSONL_FILE), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const row = JSON.parse(line);
    if (row.table !== 'files') continue;
    rows.push({ path: row.path, blob: row.blob, lang: row.lang, bytes: row.bytes, pkg: row.pkg });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

function langOf(filePath) {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return LANG[base.slice(dot + 1)] ?? '';
}

async function packageOf(root, filePath, cache) {
  let dir = dirname(filePath);
  if (dir === '.') dir = '';
  const seen = [];
  for (;;) {
    if (cache.has(dir)) {
      const found = cache.get(dir);
      for (const prior of seen) cache.set(prior, found);
      return found;
    }
    seen.push(dir);
    let hit = false;
    for (const name of MARKERS) {
      try {
        await stat(join(root, dir, name));
        hit = true;
        break;
      } catch {
        // This directory is not that kind of package. The next marker may be.
      }
    }
    if (hit || dir === '') {
      const found = hit ? dir : '';
      for (const prior of seen) cache.set(prior, found);
      return found;
    }
    const parent = dirname(dir);
    dir = parent === '.' ? '' : parent;
  }
}

function git(root, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function lsFiles(root) {
  const stdout = await git(root, ['ls-files', '-s', '-z']);
  const rows = [];
  for (const rec of stdout.split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(' ');
    if (meta[2] !== '0') continue;
    rows.push({ blob: meta[1], path: rec.slice(tab + 1) });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

async function blobSizes(root, blobs) {
  const unique = [...new Set(blobs)];
  const sizes = new Map();
  if (unique.length === 0) return sizes;
  const stdout = await git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], `${unique.join('\n')}\n`);
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    sizes.set(line.slice(0, sp), Number(line.slice(sp + 1)));
  }
  return sizes;
}
