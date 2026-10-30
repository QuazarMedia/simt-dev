// The two on-disk forms of the index (ADR-089, ADR-090).
//
// sqlite when this Node can open it, JSON-lines otherwise. Both store the same
// rows. This file is the format; store.mjs is the walk that fills it. They are
// split because the walk and the format together crossed the review trigger.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LOCAL_DIR } from '../state.mjs';

export const SQLITE_FILE = join(LOCAL_DIR, 'index.sqlite');
export const JSONL_FILE = join(LOCAL_DIR, 'index.jsonl');
const SQLITE_FILE_LEGACY = '.simt/index.sqlite';
const JSONL_FILE_LEGACY = '.simt/index.jsonl';
export const SCHEMA_V = '3';

const SCHEMA = `
create table if not exists files(path text primary key, blob text, lang text, bytes int, pkg text);
create table if not exists symbols(id integer primary key, path text, name text, kind text, line int, sig text, exported int);
create table if not exists edges(src text, dst text, kind text, weight real);
create virtual table if not exists fts using fts5(kind, ref, body);
create table if not exists embeddings(path text primary key, blob text, model text, dims int, vec blob);
create table if not exists meta(key text primary key, value text);
`;

export function encodeVectorBlob(vec) {
  if (!Array.isArray(vec) && !(vec instanceof Float32Array)) return Buffer.alloc(0);
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec, (v) => Number(v) || 0);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeVectorBlob(blob) {
  if (!blob) return new Float32Array(0);
  if (blob instanceof Float32Array) return blob;
  if (Array.isArray(blob)) return Float32Array.from(blob, (v) => Number(v) || 0);
  const buf = Buffer.isBuffer(blob)
    ? blob
    : blob instanceof Uint8Array
      ? Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
      : typeof blob === 'string'
        ? Buffer.from(blob, 'base64')
        : Buffer.alloc(0);
  const count = Math.floor(buf.byteLength / 4);
  if (count === 0) return new Float32Array(0);
  const copy = new Uint8Array(count * 4);
  copy.set(new Uint8Array(buf.buffer, buf.byteOffset, count * 4));
  return new Float32Array(copy.buffer);
}

let tmpSeq = 0;

/** A per-writer temp file: pid plus a sequence, so in-process concurrent writers meet on no shared path. */
function tmpFor(file) {
  tmpSeq += 1;
  return `${file}.${process.pid}.${tmpSeq}.tmp`;
}

/**
 * What the index was built from, so a reader can tell a current tree from an
 * old one without re-reading any blob (review 0003 Q42).
 *
 * The digest covers the `git ls-files -s` listing the build consumed: same
 * bytes in, same digest out. Stored beside `schema` in `meta`, written on every
 * build including the no-change one, so a build that changed nothing still
 * vouches for the tree it saw.
 */
export function treeDigest(listed) {
  const rows = [...(listed ?? [])]
    .map((entry) => `${entry.blob ?? ''} ${entry.path ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha1').update(rows, 'utf8').digest('hex');
}

export async function writeSqlite(root, next, removed, symbols, edges, fts, embeddings = [], tree = '') {
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(root, SQLITE_FILE);
  await mkdir(dirname(file), { recursive: true });
  // A cold build goes to a temp file that is renamed over the target: three
  // concurrent cold runs used to interleave schema creation and leave a locked,
  // table-less database behind (Q08). Each writer builds its own complete file
  // and the rename is atomic, so the last writer wins with a whole index.
  let cold = false;
  try {
    await stat(file);
  } catch {
    cold = true;
  }
  const target = cold ? tmpFor(file) : file;
  if (cold) {
    try {
      await stat(target);
      const { unlink } = await import('node:fs/promises');
      await unlink(target);
    } catch {
      // No stale temp file: build fresh.
    }
  }
  const db = new DatabaseSync(target);
  try {
    db.exec('pragma journal_mode = WAL');
    db.exec('pragma busy_timeout = 5000');
    db.exec('pragma synchronous = normal');
    db.exec(SCHEMA);
    db.exec('begin immediate');
    const upsert = db.prepare(`insert into files(path, blob, lang, bytes, pkg) values (?, ?, ?, ?, ?)
      on conflict(path) do update set blob = excluded.blob, lang = excluded.lang, bytes = excluded.bytes, pkg = excluded.pkg`);
    const dropSymbols = db.prepare('delete from symbols where path = ?');
    // An importer owns its outgoing edges: re-extracting a changed file drops
    // only `src = ?`, so the unchanged importers' edges pointing into it survive
    // (Q07). A removed file's incoming edges dangle, so they drop with it.
    const dropEdges = db.prepare('delete from edges where src = ?');
    const dropIncoming = db.prepare('delete from edges where dst = ?');
    const dropFts = db.prepare('delete from fts where ref = ?');
    const dropEmbed = db.prepare('delete from embeddings where path = ?');
    const dropFile = db.prepare('delete from files where path = ?');
    const addSymbol = db.prepare('insert into symbols(path, name, kind, line, sig, exported) values (?, ?, ?, ?, ?, ?)');
    const addEdge = db.prepare('insert into edges(src, dst, kind, weight) values (?, ?, ?, ?)');
    const addFts = db.prepare('insert into fts(kind, ref, body) values (?, ?, ?)');
    const upsertEmbed = db.prepare(`insert into embeddings(path, blob, model, dims, vec) values (?, ?, ?, ?, ?)
      on conflict(path) do update set blob = excluded.blob, model = excluded.model, dims = excluded.dims, vec = excluded.vec`);
    for (const row of next) {
      upsert.run(row.path, row.blob, row.lang, row.bytes, row.pkg);
      dropSymbols.run(row.path);
      dropEdges.run(row.path);
      dropFts.run(row.path);
      dropEmbed.run(row.path);
    }
    for (const path of removed) {
      dropFile.run(path);
      dropSymbols.run(path);
      dropEdges.run(path);
      dropIncoming.run(path);
      dropFts.run(path);
      dropEmbed.run(path);
    }
    for (const row of symbols) addSymbol.run(row.path, row.name, row.kind, row.line, row.sig, row.exported);
    for (const row of edges) addEdge.run(row.src, row.dst, row.kind, row.weight);
    for (const row of fts) addFts.run(row.kind, row.ref, row.body);
    for (const row of embeddings) {
      const vecBlob = Buffer.isBuffer(row.vec) || row.vec instanceof Uint8Array ? row.vec : encodeVectorBlob(row.vec);
      const dims = Number.isInteger(row.dims) ? row.dims : Math.floor(vecBlob.byteLength / 4);
      upsertEmbed.run(row.path, row.blob ?? '', row.model ?? '', dims, vecBlob);
    }
    const upsertMeta = db.prepare(
      'insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
    );
    upsertMeta.run('schema', SCHEMA_V);
    upsertMeta.run('tree', tree);
    db.exec('commit');
  } catch (error) {
    try { db.exec('rollback'); } catch { /* a failed begin has nothing to undo */ }
    throw asIndexError(error);
  } finally {
    db.close();
  }
  if (cold) await rename(target, file);
}

/**
 * A contended index write is a retryable race, not a broken repository: name it
 * so the command maps its own remedy instead of blaming the git checkout (Q08).
 */
function asIndexError(error) {
  const code = error?.code ?? error?.errno;
  if (code === 'SQLITE_BUSY' || code === 5 || /database is locked/i.test(error?.message ?? '')) {
    const busy = new Error('another index run is writing; wait a moment and run again');
    busy.code = 'INDEX_BUSY';
    busy.cause = error;
    return busy;
  }
  return error;
}

export async function writeJsonl(root, previous, next, removed, symbols, edges, fts, force, embeddings = [], tree = '') {
  const gone = new Set(removed);
  const replaced = new Map(next.map((row) => [row.path, row]));
  const drop = new Set([...replaced.keys(), ...gone]);
  const files = [];
  for (const row of previous) {
    if (gone.has(row.path)) continue;
    files.push(replaced.get(row.path) ?? row);
    replaced.delete(row.path);
  }
  for (const row of replaced.values()) files.push(row);
  files.sort(byPath);
  const keptSymbols = force ? [] : (await readJsonl(root, 'symbols')).filter((row) => !drop.has(row.path));
  // Edge ownership mirrors the sqlite backend: a changed file loses only the edges
  // it owns (src), while a removed file also drops the edges that pointed at it.
  const keptEdges = force ? [] : (await readJsonl(root, 'edges')).filter((row) => !drop.has(row.src) && !gone.has(row.dst));
  const keptFts = force ? [] : (await readJsonl(root, 'fts')).filter((row) => !drop.has(row.ref));
  const newEmbedPaths = new Set(embeddings.map((row) => row.path));
  const keptEmbeddings = force
    ? []
    : (await readJsonl(root, 'embeddings')).filter((row) => !drop.has(row.path) && !newEmbedPaths.has(row.path));
  const allSymbols = [...keptSymbols, ...symbols].sort(bySymbol);
  const allEdges = [...keptEdges, ...edges].sort(byEdge);
  const allFts = [...keptFts, ...fts].sort((a, b) => cmp(a.ref, b.ref));
  const allEmbeddings = [...keptEmbeddings, ...embeddings].sort(byPath);
  const file = join(root, JSONL_FILE);
  await mkdir(dirname(file), { recursive: true });
  // Written atomically: a concurrent reader never sees a half-written file.
  const tmp = tmpFor(file);
  const lines = [
    JSON.stringify({ table: 'meta', key: 'schema', value: SCHEMA_V }),
    JSON.stringify({ table: 'meta', key: 'tree', value: tree }),
    ...files.map((row) => JSON.stringify({ table: 'files', path: row.path, blob: row.blob, lang: row.lang, bytes: row.bytes, pkg: row.pkg })),
    ...allSymbols.map((row) => JSON.stringify({ table: 'symbols', path: row.path, name: row.name, kind: row.kind, line: row.line, sig: row.sig, exported: row.exported })),
    ...allEdges.map((row) => JSON.stringify({ table: 'edges', src: row.src, dst: row.dst, kind: row.kind, weight: row.weight })),
    ...allFts.map((row) => JSON.stringify({ table: 'fts', kind: row.kind, ref: row.ref, body: row.body })),
    ...allEmbeddings.map((row) => {
      const vecBlob = Buffer.isBuffer(row.vec) || row.vec instanceof Uint8Array ? Buffer.from(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength) : encodeVectorBlob(row.vec);
      const dims = Number.isInteger(row.dims) ? row.dims : Math.floor(vecBlob.byteLength / 4);
      return JSON.stringify({
        table: 'embeddings',
        path: row.path,
        blob: row.blob ?? '',
        model: row.model ?? '',
        dims,
        vec: vecBlob.toString('base64'),
      });
    }),
  ];
  await writeFile(tmp, `${lines.join('\n')}\n`);
  await rename(tmp, file);
  return { symbols: allSymbols.length, edges: allEdges.length, embeddings: allEmbeddings.length };
}

export async function readJsonl(root, table) {
  // The pre-move path is a fallback for one release (review 0003 Q19).
  let text;
  try {
    text = await readFile(join(root, JSONL_FILE), 'utf8');
  } catch {
    try {
      text = await readFile(join(root, JSONL_FILE_LEGACY), 'utf8');
    } catch {
      return [];
    }
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const row = JSON.parse(line);
    if (row.table !== table) continue;
    if (table === 'meta') rows.push({ key: row.key, value: row.value });
    else if (table === 'files') rows.push({ path: row.path, blob: row.blob, lang: row.lang, bytes: row.bytes, pkg: row.pkg });
    else if (table === 'symbols') rows.push({ path: row.path, name: row.name, kind: row.kind, line: row.line, sig: row.sig, exported: row.exported });
    else if (table === 'edges') rows.push({ src: row.src, dst: row.dst, kind: row.kind, weight: row.weight });
    else if (table === 'fts') rows.push({ kind: row.kind, ref: row.ref, body: row.body });
    else if (table === 'embeddings') {
      const vec = decodeVectorBlob(row.vec);
      rows.push({
        path: row.path,
        blob: row.blob ?? '',
        model: row.model ?? '',
        dims: Number.isInteger(row.dims) ? row.dims : vec.length,
        vec,
      });
    }
  }
  if (table === 'symbols') rows.sort(bySymbol);
  else if (table === 'edges') rows.sort(byEdge);
  else if (table === 'fts') rows.sort((a, b) => cmp(a.ref, b.ref));
  else rows.sort(byPath);
  return rows;
}

export async function readSqliteRows(root, sql, params = []) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return [];
  }
  // The pre-move path is a fallback for one release (review 0003 Q19).
  let file = join(root, SQLITE_FILE);
  try {
    await stat(file);
  } catch {
    file = join(root, SQLITE_FILE_LEGACY);
    try {
      await stat(file);
    } catch {
      return [];
    }
  }
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function readSchema(root, backend) {
  if (backend === 'sqlite') {
    const rows = await readSqliteRows(root, "select value from meta where key = 'schema'");
    return rows[0]?.value ?? '';
  }
  const rows = await readJsonl(root, 'meta');
  return rows.find((row) => row.key === 'schema')?.value ?? '';
}

/** The tree the stored index was built from, or '' when no build has vouched for one. */
export async function readTreeDigest(root, backend) {
  if (backend === 'sqlite') {
    const rows = await readSqliteRows(root, "select value from meta where key = 'tree'");
    return rows[0]?.value ?? '';
  }
  const rows = await readJsonl(root, 'meta');
  return rows.find((row) => row.key === 'tree')?.value ?? '';
}

export async function countSqlite(root) {
  const symbols = await readSqliteRows(root, 'select count(*) as n from symbols');
  const edges = await readSqliteRows(root, 'select count(*) as n from edges');
  const embeddings = await readSqliteRows(root, 'select count(*) as n from embeddings');
  return {
    symbols: Number(symbols[0]?.n ?? 0),
    edges: Number(edges[0]?.n ?? 0),
    embeddings: Number(embeddings[0]?.n ?? 0),
  };
}

function byPath(a, b) {
  return cmp(a.path, b.path);
}

function bySymbol(a, b) {
  return cmp(a.path, b.path) || a.line - b.line || cmp(a.name, b.name) || cmp(a.kind, b.kind);
}

function byEdge(a, b) {
  return cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
