import { BM25F_FIELDS } from './bm25f.mjs';
import { BINDING_VERSION } from './bind.mjs';
import {
  COMMIT_FTS_LIMIT, commitIrQuery, scoreCommitMatches, scoreCommitRows,
} from './commit-ir.mjs';
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
const EDGES_SQL = `select substr(ns.key, 6) as src, e.dst_key as dst, e.kind as kind, e.weight as weight, 'committed' as provenance
  from edges e join nodes ns on ns.id = e.src_id where coalesce(e.props, '') = '' order by src, dst, kind`;

export async function readSourceLineFacts(root) {
  const { rows } = await readSqliteRows(root, `select s.path, s.revision as blob,
    json_extract(s.props, '$.lines') as lines, json_extract(s.props, '$.generated') as generated
    from sources s where s.kind = 'blob' and json_type(s.props, '$.lines') is not null`);
  return new Map(rows.map((row) => [row.path, row]));
}

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

export const STAGED_IMPORTS_SQL = `with recursive upstream(path, depth) as (
  select value, 0 from json_each(?)
  union
  select substr(n.key, 6), upstream.depth + 1
  from upstream join edges e on e.kind = 'import' and e.dst_key = upstream.path
  join nodes n on n.id = e.src_id where upstream.depth < 2
)
select substr(n.key, 6) as src, e.dst_key as dst, e.kind
from edges e join nodes n on n.id = e.src_id
where e.kind = 'import' and (
  e.dst_key in (select path from upstream where depth < 2)
  or n.key in (select 'file:' || path from upstream where depth = 0)
)`;

export async function readStagedImports(root, tree, paths) {
  const { results, error } = await readSqliteBatch(root, [
    ["select value from meta where key = 'tree'"],
    [STAGED_IMPORTS_SQL, [JSON.stringify(paths)]],
  ]);
  const [metadata, edges] = results ?? [[], []];
  return error || metadata[0]?.value !== tree ? null : edges;
}

export async function readSymbolGraph(root) {
  const { results, error } = await readSqliteBatch(root, symbolGraphQueries());
  const [edges, metadata] = results ?? [[], []];
  return decodeSymbolGraph(edges, metadata, error);
}

function decodeSymbolGraph(edges, metadata, error) {
  const values = new Map(metadata.map(({ key, value }) => [key, JSON.parse(value)]));
  return {
    edges: edges.map(({ src, kind, dst, path, props }) => ({
      src, kind, dst, path, provenance: 'committed',
      ...(props === null ? { viaBarrels: [], lines: [] } : JSON.parse(props)),
    })),
    bindingCoverage: values.get('binding_coverage') ?? null,
    version: values.get('binding_version') ?? null,
    unresolved: values.get('binding_unresolved') ?? [],
    starExports: values.get('binding_star_exports') ?? [],
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

export async function readNarrowBindings(root, paths) {
  if (!paths.length) return new Map();
  const { rows } = await readSqliteRows(root, `select s.path, json_extract(s.props, '$.imports') as imports,
    json_extract(s.props, '$.bindings') as bindings
    from sources s where s.kind = 'blob' and s.path in (select value from json_each(?))`, [JSON.stringify(paths)]);
  return new Map(rows.map(({ path, imports, bindings }) => [path, {
    imports: JSON.parse(imports ?? '[]'),
    ...(bindings ? JSON.parse(bindings) : {}),
  }]));
}

export async function readLiveSnapshot(root, {
  text, fielded, binding, tree, indexStat = null, bindingEdits = false, dirtyPaths = [], lightweight, rangePaths = [],
}) {
  const narrowBinding = Boolean(binding && lightweight && bindingEdits && dirtyPaths.length > 0 && dirtyPaths.length <= 16);
  const stampCheck = indexStat !== null;
  const chunks = !binding ? '' : narrowBinding
    ? `, case when (select value from meta where key = 'tree') is not ?
    or (select value from meta where key = 'binding_version') is not ?
    or s.path in (select value from json_each(?))
    or s.path in (select value from json_each(?))
    or s.path in (
      select substr(n.key, 6) from edges e join nodes n on n.id = e.src_id
      where e.kind = 'import' and e.dst_key in (select value from json_each(?))
    )
    or s.path in (
      select e.dst_key from edges e join nodes n on n.id = e.src_id
      where e.kind = 'import' and substr(n.key, 6) in (select value from json_each(?))
    )
    then json_extract(s.props, '$.bindings') end as bindings`
    : stampCheck
      ? `, case when (select value from meta where key = 'git_index_stat') is not ?
      or (select value from meta where key = 'binding_version') is not ?
      or s.path in (select value from json_each(?))
      then json_extract(s.props, '$.bindings') end as bindings`
      : `, case when ? or (select value from meta where key = 'tree') is not ?
      or (select value from meta where key = 'binding_version') is not ?
      or s.path in (select value from json_each(?))
      then json_extract(s.props, '$.bindings') end as bindings`;
  const dirtyJson = JSON.stringify(dirtyPaths);
  const lazyMetaCols = Boolean(stampCheck && lightweight);
  const metaColsSql = lazyMetaCols
    ? `case when (select value from meta where key = 'git_index_stat') is not ? then json_extract(s.props, '$.imports') end as imports,
      case when (select value from meta where key = 'git_index_stat') is not ? then json_extract(s.props, '$.resolution') end as resolution`
    : `json_extract(s.props, '$.imports') as imports,
      json_extract(s.props, '$.resolution') as resolution`;
  const metaParams = lazyMetaCols ? [indexStat, indexStat] : [];
  const fileParams = [
    ...metaParams,
    ...(!binding ? [] : narrowBinding
      ? [tree, String(BINDING_VERSION), JSON.stringify(rangePaths), dirtyJson, dirtyJson, dirtyJson]
      : stampCheck
        ? [indexStat, String(BINDING_VERSION), JSON.stringify(rangePaths)]
        : [Number(bindingEdits), tree, String(BINDING_VERSION), JSON.stringify(rangePaths)]),
  ];
  const queries = [
    [`select ${FILE_COLUMNS}, ${metaColsSql}
      ${chunks} ${FILE_SOURCE}`, fileParams],
    [SYMBOLS_SQL],
    [EDGES_SQL],
    ["select key, value from meta where key in ('tree', 'build', 'fts_fields', 'git_index_stat')"],
  ];
  if (text) queries.push([legacyFtsSql('fts_legacy')]);
  if (fielded) queries.push([`select f.kind, substr(n.key, 6) as ref, ${BM25F_FIELDS.map((field) => `f.${field}`).join(', ')}
    from fts f join nodes n on n.id = f.node_id where (select value from meta where key = 'fts_fields') = '1'
    order by ref, f.rowid`]);
  if (binding) queries.push(...symbolGraphQueries({ lightweight: lightweight && (!bindingEdits || narrowBinding) }));
  const { results, error } = await readSqliteBatch(root, queries);
  const [files, symbols, edges, meta, ...extra] = results ?? [[], [], [], []];
  const fts = text ? extra.shift() ?? [] : [];
  const fieldedRows = fielded ? extra.shift() ?? [] : [];
  return {
    files: lightweight ? files : files.map(({ imports, ...file }) => ({ ...file, imports: JSON.parse(imports ?? '[]') })),
    symbols, edges, fts, fieldedRows, meta: Object.fromEntries(meta.map(({ key, value }) => [key, value])),
    binding: binding ? decodeSymbolGraph(extra[0] ?? [], extra[1] ?? [], error) : null,
    error,
  };
}

export async function readCochangeBasis(root) {
  const { rows, error } = await readSqliteRows(root,
    "select key, value from meta where key in ('last_cochange_sha', 'cochange_commits', 'commit_ir_records')");
  if (error) return null;
  const values = new Map(rows.map(({ key, value }) => [key, value]));
  if (!values.has('last_cochange_sha') || !values.has('cochange_commits')) return null;
  try {
    const commits = JSON.parse(values.get('cochange_commits'));
    if (!Array.isArray(commits)) return null;
    const rawRecords = values.get('commit_ir_records');
    const commitRecords = rawRecords ? JSON.parse(rawRecords) : null;
    return {
      head: values.get('last_cochange_sha'),
      commits,
      ...(Array.isArray(commitRecords) ? { commitRecords } : {}),
    };
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

export async function searchCommitIr(root, task, { rows = null, allowPath = null, limit = 30 } = {}) {
  if (Array.isArray(rows)) return scoreCommitRows(rows, task, { allowPath, limit });
  const match = commitIrQuery(task);
  if (!match) return [];
  const { rows: matched, error } = await readSqliteRows(
    root,
    `select sha, age, file_count, files_json, -bm25(commit_fts, 0, 0, 0, 0, 2.0, 1.0) as score
     from commit_fts
     where commit_fts match ?
     order by score desc, age asc, sha asc
     limit ?`,
    [match, COMMIT_FTS_LIMIT],
  );
  if (error) return [];
  return scoreCommitMatches(matched, { allowPath, limit });
}
