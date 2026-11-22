import { BM25F_FIELDS } from './bm25f.mjs';
import { readSqliteBatch, readSqliteRows } from './persist.mjs';
import { symbolGraphQueries } from './symbol-persist.mjs';

/**
 * Read wrappers return arrays with the read error attached:
 * callers that iterate are untouched, and callers that report - map among
 * them - can tell a broken index from an empty one.
 */
export function withReadError(rows, error) {
  if (error) rows.error = error;
  return rows;
}
// The v5 layout keys files as `sources` rows; the git blob sha is `revision`
// and the package directory rides in `props`, which the v4 `files` table named
// `pkg`. One spelling per read, shared by the single read and the batched one.
const FILE_COLUMNS = "s.path, s.revision as blob, s.lang, s.bytes, json_extract(s.props, '$.pkg') as pkg";
const FILE_SOURCE = "from sources s where s.kind = 'blob' order by s.path";
const FILES_SQL = `select ${FILE_COLUMNS} ${FILE_SOURCE}`;
const SYMBOLS_SQL = `select s.path as path, n.name as name, json_extract(n.props, '$.kind') as kind,
  n.line as line, json_extract(n.props, '$.sig') as sig,
  json_extract(n.props, '$.exported') as exported
  from nodes n join sources s on s.id = n.source_id and s.kind = 'blob'
  where n.kind = 'symbol' order by s.path, n.line, n.name, n.kind`;
// An import edge's src is the file that imports. Paths come back from the node
// key (`file:<path>`) and the stable `dst_key`: node ids are regenerated when a
// file changes, so a path is the only key that survives a reindex of one
// endpoint.
const EDGES_SQL = `select substr(ns.key, 6) as src, e.dst_key as dst, e.kind as kind, e.weight as weight
  from edges e join nodes ns on ns.id = e.src_id where coalesce(e.props, '') = '' order by src, dst, kind`;

/** File rows, sorted by path. The same blobs read back as the same rows. */
export async function readFiles(root) {
  const { rows, error } = await readSqliteRows(root, FILES_SQL);
  return withReadError(rows, error);
}

/** Symbol rows for the blobs currently indexed. */
export async function readSymbols(root) {
  const { rows, error } = await readSqliteRows(root, SYMBOLS_SQL);
  return withReadError(rows, error);
}

/** Edges currently indexed. */
export async function readEdges(root) {
  const { rows, error } = await readSqliteRows(root, EDGES_SQL);
  return withReadError(rows, error);
}

/**
 * Files, symbols and edges from one build.
 *
 * Three separate opens can straddle a concurrent write and answer with rows
 * from two builds; one read transaction answers with the rows of exactly one.
 */
export async function readGraph(root) {
  const { results, error } = await readSqliteBatch(root, [
    [FILES_SQL],
    [SYMBOLS_SQL],
    [EDGES_SQL],
    ["select value from meta where key = 'binding_coverage'"],
  ]);
  const [files, symbols, edges, coverage] = results ?? [[], [], [], []];
  return {
    files: withReadError(files, error),
    symbols: withReadError(symbols, error),
    edges: withReadError(edges, error),
    bindingCoverage: coverage.length ? JSON.parse(coverage[0].value) : null,
  };
}

export async function readSymbolGraph(root) {
  const { results, error } = await readSqliteBatch(root, symbolGraphQueries());
  const [edges, metadata] = results ?? [[], []];
  return decodeSymbolGraph(edges, metadata, error);
}

function decodeSymbolGraph(edges, metadata, error) {
  const values = new Map(metadata.map(({ key, value }) => [key, JSON.parse(value)]));
  return {
    edges: edges.map(({ src, kind, dst, path, props }) => ({ src, kind, dst, path, ...(props === null ? { viaBarrels: [], lines: [] } : JSON.parse(props)) })),
    bindingCoverage: values.get('binding_coverage') ?? null,
    unresolved: values.get('binding_unresolved') ?? [],
    error,
  };
}

const legacyFtsSql = (table) => `select f.kind as kind, substr(n.key, 6) as ref, f.body as body
    from ${table} f join nodes n on n.id = f.node_id order by ref, kind, f.rowid`;

/** Legacy FTS rows, in the original section order used by the baseline ranker. */
export async function readFts(root) {
  const { rows, error } = await readSqliteRows(root, legacyFtsSql('fts_legacy'), [], { legacySql: legacyFtsSql('fts') });
  return withReadError(rows, error);
}

export async function readLiveSnapshot(root, { text, fielded, binding, tree, bindingEdits }) {
  const chunks = !binding ? '' : tree === undefined ? ", json_extract(s.props, '$.bindings') as bindings"
    : ", case when ? or (select value from meta where key = 'tree') != ? then json_extract(s.props, '$.bindings') end as bindings";
  const queries = [
    [`select ${FILE_COLUMNS}, json_extract(s.props, '$.imports') as imports,
      json_extract(s.props, '$.resolution') as resolution
      ${binding ? ", json_extract(s.props, '$.bindings') as bindings" : ''} ${FILE_SOURCE}`],
    [SYMBOLS_SQL],
    [EDGES_SQL],
    ["select key, value from meta where key in ('tree', 'build', 'fts_fields')"],
  ];
  if (text) queries.push([legacyFtsSql('fts_legacy')]);
  if (fielded) queries.push([`select f.kind, substr(n.key, 6) as ref, ${BM25F_FIELDS.map((field) => `f.${field}`).join(', ')}
    from fts f join nodes n on n.id = f.node_id where (select value from meta where key = 'fts_fields') = '1'
    order by ref, f.rowid`]);
  if (binding) queries.push(...symbolGraphQueries({ lightweight: tree !== undefined && !bindingEdits }));
  const { results, error } = await readSqliteBatch(root, queries);
  const [files, symbols, edges, meta, ...extra] = results ?? [[], [], [], []];
  const fts = text ? extra.shift() ?? [] : [];
  const fieldedRows = fielded ? extra.shift() ?? [] : [];
  return {
    files: files.map(({ imports, ...file }) => ({ ...file, imports: JSON.parse(imports ?? '[]') })),
    symbols, edges, fts, fieldedRows, meta: Object.fromEntries(meta.map(({ key, value }) => [key, value])),
    binding: binding ? decodeSymbolGraph(extra[0] ?? [], extra[1] ?? [], error) : null,
    error,
  };
}

export async function readCochangeBasis(root) {
  const { rows, error } = await readSqliteRows(root,
    "select key, value from meta where key in ('last_cochange_sha', 'cochange_commits')");
  if (error) return null;
  const values = new Map(rows.map(({ key, value }) => [key, value]));
  if (!values.has('last_cochange_sha') || !values.has('cochange_commits')) return null;
  try {
    const commits = JSON.parse(values.get('cochange_commits'));
    return Array.isArray(commits) ? { head: values.get('last_cochange_sha'), commits } : null;
  } catch {
    return null;
  }
}

export async function readCochange(root) {
  const { rows, error } = await readSqliteRows(root,
    "select src_path as src, dst_path as dst, 'cochange' as kind, confidence, confidence as weight, "
      + 'lift, support, decayed_weight as decayedWeight from cochange order by src_path, confidence desc, lift desc, support desc, dst_path');
  return withReadError(rows, error?.message?.includes('no such table: cochange') ? null : error);
}
