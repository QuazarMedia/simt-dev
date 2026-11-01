// The two on-disk forms of the index (ADR-089, ADR-090).
//
// sqlite when this Node can open it, JSON-lines otherwise. Both store the same
// rows. This file is the format; store.mjs is the walk that fills it. They are
// split because the walk and the format together crossed the review trigger.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LOCAL_DIR } from '../state.mjs';
import { cmp } from '../util/sort.mjs';

export const SQLITE_FILE = join(LOCAL_DIR, 'index.sqlite');
export const JSONL_FILE = join(LOCAL_DIR, 'index.jsonl');
const SQLITE_FILE_LEGACY = '.simt/index.sqlite';
const JSONL_FILE_LEGACY = '.simt/index.jsonl';
export const SCHEMA_V = '5';

// The FTS tables carry their tokenizer in their definition, so `if not exists`
// cannot migrate them: a v3 database would keep tokenizing new rows the v3 way
// (ASCII fold, kind and ref searchable), and a v4 `fts` table cannot grow the
// node_id column the v5 layout needs. The preamble creates them only when they
// are missing (a cold build); the 3 -> 4 and 4 -> 5 migrations below drop and
// recreate them, which is the versioned replacement for the per-write wipe (Q44).
export const FTS_SCHEMA = 'create virtual table if not exists fts using fts5(body, node_id UNINDEXED, kind UNINDEXED, tokenize = "unicode61 remove_diacritics 2")';
export const FTS_TRI_SCHEMA = 'create virtual table if not exists fts_tri using fts5(kind UNINDEXED, ref UNINDEXED, body, tokenize = "trigram")';

// The v4 `fts` shape. The 3 -> 4 step recreates the table with THIS shape so a
// v3 database emerges looking exactly like a genuine v4 one - the 4 -> 5 step
// then copies its `ref` column, which the v5 shape no longer has.
const FTS_V4_SCHEMA = 'create virtual table fts using fts5(kind UNINDEXED, ref UNINDEXED, body, tokenize = "unicode61 remove_diacritics 2")';

// A database written by a *newer* simt is never opened for write, and never
// read blind: the mismatched canonical file stays with its
// owner, and this version reads and writes a sidecar named after itself, so
// two pinned versions stop rewriting one file past each other (the ADR-059
// flip-flop). An *older* database is read and written in place, and the
// migration brings it current.
export function indexFileFor(root, backend, version) {
  const base = backend === 'sqlite' ? SQLITE_FILE : JSONL_FILE;
  if (version === '' || version === SCHEMA_V) return join(root, base);
  const dot = base.lastIndexOf('.');
  return join(root, `${base.slice(0, dot)}.v${SCHEMA_V}${base.slice(dot)}`);
}

// The canonical file is opened for write when the stored version is this one
// or older - the ordered migration upgrades the older one in place. A newer
// version owns its file, and opening it here would demote the stamp.
function canonicalForWrite(version) {
  const at = Number(version);
  return Number.isInteger(at) && at <= Number(SCHEMA_V);
}

// Ordered schema migrations: each step upgrades a database written at `from`
// to `to`, applied in list order. A database at a version past the last step
// is not opened for write at all (indexFileFor routes it to a sidecar).
const MIGRATIONS = [
  {
    from: 3,
    to: 4,
    apply: (db) => {
      db.exec('drop table if exists fts');
      db.exec(FTS_V4_SCHEMA);
      db.exec('drop table if exists fts_tri');
      db.exec(FTS_TRI_SCHEMA);
    },
  },
  // v4 is per-kind tables (files/symbols/edges/embeddings); v5 is the entity
  // layout (sources/nodes/edges/vectors) with the read shapes restored as SQL
  // in the store. `edges` and `fts` are built under `_v5` names and swapped in
  // after the copy, because the v4 tables of those names still hold data.
  // fts_tri keeps its (kind, ref, body) shape - the CJK trigram path is
  // untouched (Q43).
  {
    from: 4,
    to: 5,
    apply: (db) => {
      db.exec(TABLES);
      db.exec(EDGES_DDL.replaceAll('edges(', 'edges_v5('));
      db.exec(FTS_SCHEMA.replaceAll('exists fts ', 'exists fts_v5 '));
      db.exec(`insert into sources(kind, path, revision, lang, bytes, status, props)
        select 'blob', path, blob, lang, bytes, 'indexed', json_object('pkg', coalesce(pkg, '')) from files`);
      db.exec(`insert into nodes(key, kind, source_id)
        select 'file:' || path, 'file', id from sources where kind = 'blob'`);
      db.exec(`insert into nodes(key, kind, source_id, name, line, props)
        select 'sym:' || s.path || '#' || s.name || '@' || coalesce(s.line, 0), 'symbol', src.id,
               s.name, s.line, json_object('kind', coalesce(s.kind, 'symbol'), 'sig', coalesce(s.sig, ''), 'exported', coalesce(s.exported, 0))
        from symbols s join sources src on src.kind = 'blob' and src.path = s.path`);
      db.exec(`insert into edges_v5(src_id, kind, dst_key, dst_id, weight, owner_source_id, trust)
        select sn.id, e.kind, e.dst, dn.id, e.weight, src.id, 'observed'
        from edges e
        join sources src on src.kind = 'blob' and src.path = e.src
        join nodes sn on sn.source_id = src.id and sn.kind = 'file'
        left join sources dst on dst.kind = 'blob' and dst.path = e.dst
        left join nodes dn on dn.source_id = dst.id and dn.kind = 'file'`);
      db.exec(`insert into vectors(node_id, model, dims, vec)
        select n.id, em.model, em.dims, em.vec
        from embeddings em
        join sources s on s.kind = 'blob' and s.path = em.path
        join nodes n on n.source_id = s.id and n.kind = 'file'`);
      db.exec(`insert into fts_v5(body, node_id, kind)
        select f.body, n.id, f.kind
        from fts f
        join sources s on s.kind = 'blob' and s.path = f.ref
        join nodes n on n.source_id = s.id and n.kind = 'file'`);
      db.exec('drop table files');
      db.exec('drop table symbols');
      db.exec('drop table embeddings');
      db.exec('drop table edges');
      db.exec('drop table fts');
      db.exec('alter table edges_v5 rename to edges');
      db.exec('alter table fts_v5 rename to fts');
    },
  },
];

/**
 * Bring an open database up to the current schema and stamp it. `user_version`
 * 0 means "written before the stamp existed": those databases carried the
 * version in meta only, so every step at or below the current schema runs -
 * each is idempotent on an already-migrated table set.
 */
function migrateDb(db) {
  let at = Number(db.prepare('pragma user_version').get()?.user_version ?? 0);
  // `user_version 0` is ambiguous: a cold build has no legacy tables at all,
  // and a pre-stamp database still holds the v3 shape. The 4 -> 5 step copies
  // FROM the v4 tables (`files`, `symbols`, ...), so a cold build must not run
  // it - the 3 -> 4 step would leave its `fts` in the v4 shape behind.
  const legacy =
    at !== 0 ||
    db.prepare(`select count(*) as n from sqlite_master where type = 'table' and name in ('files', 'symbols', 'embeddings')`).get().n > 0;
  if (legacy) {
    for (const step of MIGRATIONS) {
      if (at === 0 || (at >= step.from && at < step.to)) {
        step.apply(db);
        at = step.to; // the next step sees the version this one left behind
      }
    }
  }
  db.exec(`pragma user_version = ${Number(SCHEMA_V)}`);
}

const TABLES = `
create table if not exists sources(
  id integer primary key,
  kind text not null default 'blob',
  path text not null,
  revision text,
  lang text,
  bytes integer,
  status text not null default 'indexed',
  props text,
  unique(kind, path)
);
create table if not exists nodes(
  id integer primary key,
  key text not null unique,
  kind text,
  source_id integer,
  name text,
  line integer,
  span_start integer,
  span_end integer,
  digest text,
  trust text not null default 'observed',
  props text
);
create table if not exists vectors(
  node_id integer primary key,
  model text,
  dims integer,
  vec blob
);
create table if not exists meta(key text primary key, value text);
`;

// The v5 edges table. Named `edges_v5` in the 4 -> 5 migration, because the
// v4 database still holds an `edges` table of a different shape until the
// copy below is done.
const EDGES_DDL = `create table if not exists edges(
  src_id integer,
  kind text,
  dst_key text,
  dst_id integer,
  weight real,
  owner_source_id integer,
  trust text,
  props text,
  primary key(src_id, kind, dst_key)
);`;

// Q76: the v4 layout had no index on the edge endpoints or the node owners -
// the dependent, impact and coverage walks each paid a full scan per file.
// Executed after `migrateDb`, not in the preamble: on a v3 database the v3
// `edges` table survives `if not exists` until the 4 -> 5 step swaps in the
// v5 shape, and `idx_edges_dst` needs the `dst_id` column that only the v5
// table has.
const INDEXES = `
create index if not exists idx_edges_dst on edges(dst_id, kind);
create index if not exists idx_edges_owner on edges(owner_source_id);
create index if not exists idx_nodes_source on nodes(source_id);
create index if not exists idx_nodes_kind_name on nodes(kind, name);
`;

const SCHEMA = `${TABLES}\n${EDGES_DDL}\n`;

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
 * old one without re-reading any blob.
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
  // The canonical file is written when it is this version's or older (the
  // migration upgrades the older one in place, review 0003 Q44): a database at
  // a newer version stays with its owner, and the build goes to the sidecar
  // this version owns.
  let file = join(root, SQLITE_FILE);
  try {
    await stat(file);
  } catch {
    file = join(root, SQLITE_FILE_LEGACY);
    try {
      await stat(file);
    } catch {
      file = null;
    }
  }
  if (file) {
    let version = SCHEMA_V;
    try {
      version = await storedVersion(file);
    } catch {
      version = SCHEMA_V; // unreadable: rebuild it in place, as a cold build would
    }
    file = canonicalForWrite(version) ? file : indexFileFor(root, 'sqlite', version);
  } else {
    file = join(root, SQLITE_FILE);
  }
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
    db.exec(FTS_SCHEMA);
    db.exec(FTS_TRI_SCHEMA);
    db.exec('begin immediate');
    migrateDb(db);
    // The `edges` table is v5-shaped now on every path: the preamble created
    // it on a cold build, the migration swapped it in on a legacy one.
    db.exec(INDEXES);
    // One source row per file, keyed (kind, path): the revision is the git blob
    // sha, so an unchanged blob keeps its row, and the file's node, vectors,
    // edges and fts rows all hang off it. `props` carries what the v5 columns
    // do not name - the package directory, which the files read shape serves.
    const upsertSource = db.prepare(`insert into sources(kind, path, revision, lang, bytes, status, props)
      values('blob', ?, ?, ?, ?, 'indexed', ?)
      on conflict(kind, path) do update set revision = excluded.revision, lang = excluded.lang,
        bytes = excluded.bytes, props = excluded.props`);
    const sourceIdOf = db.prepare(`select id from sources where kind = 'blob' and path = ?`);
    // `prepare` compiles only the FIRST statement in a string (Q76): a
    // multi-statement delete prepared as one ran only its head, and the
    // surviving `file:` node collided with the next insert on `nodes.key`.
    const dropDependents = [
      db.prepare('delete from vectors where node_id in (select id from nodes where source_id = ?)'),
      db.prepare('delete from fts where node_id in (select id from nodes where source_id = ?)'),
      db.prepare('delete from edges where owner_source_id = ?'),
      db.prepare('delete from nodes where source_id = ?'),
    ];
    const addFileNode = db.prepare(`insert into nodes(key, kind, source_id, trust) values('file:' || ?, 'file', ?, 'observed')`);
    const addSymbol = db.prepare(`insert into nodes(key, kind, source_id, name, line, props)
      values('sym:' || ? || '#' || ? || '@' || ?, 'symbol', ?, ?, ?, ?)`);
    const addEdge = db.prepare(`insert into edges(src_id, kind, dst_key, dst_id, weight, owner_source_id, trust)
      values (?, ?, ?, ?, ?, ?, 'observed')`);
    const addFts = db.prepare('insert into fts(body, node_id, kind) values (?, ?, ?)');
    const addTri = db.prepare('insert into fts_tri(kind, ref, body) values (?, ?, ?)');
    const upsertVector = db.prepare(`insert into vectors(node_id, model, dims, vec) values (?, ?, ?, ?)
      on conflict(node_id) do update set model = excluded.model, dims = excluded.dims, vec = excluded.vec`);
    const dropSource = [
      db.prepare(`delete from vectors where node_id in (select id from nodes where source_id in (select id from sources where kind = 'blob' and path = ?))`),
      db.prepare(`delete from fts where node_id in (select id from nodes where source_id in (select id from sources where kind = 'blob' and path = ?))`),
      db.prepare(`delete from edges where owner_source_id in (select id from sources where kind = 'blob' and path = ?)`),
      db.prepare('delete from edges where dst_key = ?'),
      db.prepare(`delete from nodes where source_id in (select id from sources where kind = 'blob' and path = ?)`),
      db.prepare(`delete from sources where kind = 'blob' and path = ?`),
    ];
    for (const row of next) {
      const sourceId = sourceIdOf.get(row.path)?.id;
      if (sourceId !== undefined) for (const st of dropDependents) st.run(sourceId);
      upsertSource.run(row.path, row.blob, row.lang, row.bytes, JSON.stringify({ pkg: row.pkg ?? '' }));
    }
    for (const path of removed) {
      for (const st of dropSource) st.run(path);
      // fts_tri is still path-keyed: the trigram table keeps its v4 shape (Q43).
      db.prepare('delete from fts_tri where ref = ?').run(path);
    }
    for (const row of next) {
      addFileNode.run(row.path, sourceIdOf.get(row.path).id);
    }
    // The ids a changed file's rows hang off were just rebuilt; an unchanged
    // file's rows keep their old ids. One query maps every path to both.
    const ids = new Map();
    for (const r of db.prepare(`select s.path, s.id as source_id, n.id as node_id
      from sources s join nodes n on n.source_id = s.id and n.kind = 'file'
      where s.kind = 'blob'`).all()) {
      ids.set(r.path, { sourceId: r.source_id, nodeId: r.node_id });
    }
    for (const row of symbols) {
      const entry = ids.get(row.path);
      if (!entry) continue;
      addSymbol.run(row.path, row.name, row.line, entry.sourceId, row.name, row.line,
        JSON.stringify({ kind: row.kind ?? 'symbol', sig: row.sig ?? '', exported: row.exported ? 1 : 0 }));
    }
    for (const row of edges) {
      const src = ids.get(row.src);
      if (!src) continue;
      const dst = ids.get(row.dst);
      addEdge.run(src.nodeId, row.kind, row.dst, dst ? dst.nodeId : null, row.weight, src.sourceId);
    }
    for (const row of fts) {
      const entry = ids.get(row.ref);
      if (!entry) continue;
      addFts.run(row.body, entry.nodeId, row.kind);
      // The trigram table carries folded raw text for CJK-bearing sections
      // only; an ASCII-only section is already reachable through `fts`.
      if (row.raw) addTri.run(row.kind, row.ref, row.raw);
    }
    for (const row of embeddings) {
      const entry = ids.get(row.path);
      if (!entry) continue;
      const vecBlob = Buffer.isBuffer(row.vec) || row.vec instanceof Uint8Array ? row.vec : encodeVectorBlob(row.vec);
      const dims = Number.isInteger(row.dims) ? row.dims : Math.floor(vecBlob.byteLength / 4);
      upsertVector.run(entry.nodeId, row.model ?? '', dims, vecBlob);
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
 * The version a database declares: `PRAGMA user_version` when stamped, else the
 * meta `schema` row databases written before the stamp carried it in. Throws
 * when the file cannot be read as a database - the caller decides whether that
 * is a cold start or a corrupt one.
 */
async function storedVersion(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const user = Number(db.prepare('pragma user_version').get()?.user_version ?? 0);
    if (user > 0) return String(user);
    return db.prepare("select value from meta where key = 'schema'").get()?.value ?? '';
  } finally {
    db.close();
  }
}

/** A damaged index file is named, not silent. */
function corruptIndexError(cause) {
  const corrupt = new Error('the index file is corrupt; run the index build to replace it');
  corrupt.code = 'INDEX_CORRUPT';
  corrupt.cause = cause;
  return corrupt;
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
  if (/file is not a database|database disk image|malformed|corrupt/i.test(error?.message ?? '')) {
    return corruptIndexError(error);
  }
  return error;
}

/**
 * The jsonl file this version writes to: the canonical file when it is this
 * version's or unreadable, the sidecar when it belongs to another version
 */
async function jsonlTargetFile(root) {
  const base = join(root, JSONL_FILE);
  let text = null;
  try {
    text = await readFile(base, 'utf8');
  } catch {
    try {
      text = await readFile(join(root, JSONL_FILE_LEGACY), 'utf8');
    } catch {
      return base; // no file: cold build goes to the canonical path
    }
  }
  try {
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const row = JSON.parse(line);
      if (row.table !== 'meta' || row.key !== 'schema') continue;
      const value = row.value ?? '';
      // Older files are rewritten in place at the current schema; a newer one
      // stays with its owner and the build goes to the sidecar.
      return canonicalForWrite(value) ? base : indexFileFor(root, 'jsonl', value);
    }
  } catch {
    return base; // unreadable: rebuild it in place
  }
  return base;
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
  const keptSymbols = force ? [] : (await readJsonl(root, 'symbols')).rows.filter((row) => !drop.has(row.path));
  // Edge ownership mirrors the sqlite backend: a changed file loses only the edges
  // it owns (src), while a removed file also drops the edges that pointed at it.
  const keptEdges = force ? [] : (await readJsonl(root, 'edges')).rows.filter((row) => !drop.has(row.src) && !gone.has(row.dst));
  const keptFts = force ? [] : (await readJsonl(root, 'fts')).rows.filter((row) => !drop.has(row.ref));
  const newEmbedPaths = new Set(embeddings.map((row) => row.path));
  const keptEmbeddings = force
    ? []
    : (await readJsonl(root, 'embeddings')).rows.filter((row) => !drop.has(row.path) && !newEmbedPaths.has(row.path));
  const allSymbols = [...keptSymbols, ...symbols].sort(bySymbol);
  const allEdges = [...keptEdges, ...edges].sort(byEdge);
  const allFts = [...keptFts, ...fts].sort((a, b) => cmp(a.ref, b.ref));
  const allEmbeddings = [...keptEmbeddings, ...embeddings].sort(byPath);
  const file = await jsonlTargetFile(root);
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
  // The pre-move path is a fallback for one release.
  let text;
  try {
    text = await readFile(join(root, JSONL_FILE), 'utf8');
  } catch {
    try {
      text = await readFile(join(root, JSONL_FILE_LEGACY), 'utf8');
    } catch {
      return { rows: [], error: null };
    }
  }
  let schema = '';
  try {
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const row = JSON.parse(line);
      if (row.table === 'meta' && row.key === 'schema') schema = row.value ?? '';
    }
  } catch (error) {
    return { rows: [], error: corruptIndexError(error) };
  }
  // A file a newer version owns is not read blind: this
  // version's sidecar is read instead, and a sidecar that has not been built
  // yet is cold, not broken. An older file is read in place; the next write
  // rewrites it at the current schema.
  if (!canonicalForWrite(schema)) {
    try {
      text = await readFile(indexFileFor(root, 'jsonl', schema), 'utf8');
    } catch {
      return { rows: [], error: null };
    }
  }
  const rows = [];
  try {
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
  } catch (error) {
    return { rows: [], error: corruptIndexError(error) };
  }
  if (table === 'symbols') rows.sort(bySymbol);
  else if (table === 'edges') rows.sort(byEdge);
  else if (table === 'fts') rows.sort((a, b) => cmp(a.ref, b.ref));
  else rows.sort(byPath);
  return { rows, error: null };
}

/**
 * The sqlite file a read opens: the canonical file when it is this version's
 * or older, the sidecar when it belongs to a newer one,
 * null when no index for this version exists. Throws when a present file
 * cannot be read as a database - corrupt, not cold.
 */
async function resolveSqliteFile(root) {
  // The pre-move path is a fallback for one release.
  let file = join(root, SQLITE_FILE);
  try {
    await stat(file);
  } catch {
    file = join(root, SQLITE_FILE_LEGACY);
    try {
      await stat(file);
    } catch {
      return null;
    }
  }
  const version = await storedVersion(file);
  // An older database is readable in place: its tables carry the same columns,
  // and the next write migrates it. Only a newer one is routed to a sidecar.
  if (canonicalForWrite(version)) return file;
  const sidecar = indexFileFor(root, 'sqlite', version);
  try {
    await stat(sidecar);
    return sidecar;
  } catch {
    return null; // this version has not built its sidecar yet: cold
  }
}

/**
 * Read rows from the index. Returns `{ rows, error }`: a missing index is
 * `{ rows: [], error: null }` (cold), a present index that cannot be read is
 * an empty row set with a named error - "locked", "no such column" and
 * "corrupt" used to all look like "no results".
 */
export async function readSqliteRows(root, sql, params = []) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { rows: [], error: null };
  }
  let file;
  try {
    file = await resolveSqliteFile(root);
  } catch (error) {
    return { rows: [], error: asIndexError(error) };
  }
  if (!file) return { rows: [], error: null };
  const db = new DatabaseSync(file);
  try {
    return { rows: db.prepare(sql).all(...params), error: null };
  } catch (error) {
    return { rows: [], error: asIndexError(error) };
  } finally {
    db.close();
  }
}

export async function readSchema(root, backend) {
  if (backend === 'sqlite') {
    const { rows } = await readSqliteRows(root, "select value from meta where key = 'schema'");
    return rows[0]?.value ?? '';
  }
  const { rows } = await readJsonl(root, 'meta');
  return rows.find((row) => row.key === 'schema')?.value ?? '';
}

/** The tree the stored index was built from, or '' when no build has vouched for one. */
export async function readTreeDigest(root, backend) {
  if (backend === 'sqlite') {
    const { rows } = await readSqliteRows(root, "select value from meta where key = 'tree'");
    return rows[0]?.value ?? '';
  }
  const { rows } = await readJsonl(root, 'meta');
  return rows.find((row) => row.key === 'tree')?.value ?? '';
}

export async function countSqlite(root) {
  // One open, three counts: the v4 layout paid a full open/close per metric,
  // and a read that only wants the counts was buying three connections (Q76).
  const { rows } = await readSqliteRows(
    root,
    `select
      (select count(*) from nodes where kind = 'symbol') as symbols,
      (select count(*) from edges) as edges,
      (select count(*) from vectors) as embeddings`,
  );
  const row = rows[0] ?? {};
  return {
    symbols: Number(row.symbols ?? 0),
    edges: Number(row.edges ?? 0),
    embeddings: Number(row.embeddings ?? 0),
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

