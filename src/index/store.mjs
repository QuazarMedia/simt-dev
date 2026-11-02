// The local index (ADR-089, ADR-135).
//
// `node:sqlite` with FTS5, and nothing else: the Node floor carries both, which is
// what ADR-135 waited for before retiring the JSON-lines file. The index is a cache:
// `git ls-files -s` can rebuild it, so a missing file is not a lost database. A blob
// that has not changed is not read again.

import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { git as gitRaw } from '../sys/git.mjs';

import { readManifest } from '../projection/manifest.mjs';
import { readLocalConfig } from '../local/config.mjs';
import { localEmbed } from '../local/client.mjs';
import { extract, resolveImports } from './extract.mjs';
// the extension-to-language map is the records' `languages[]` (ADR-013). `canonical`
// names the extensions that RESOLVE to a language (JavaScript claims `.ts` for extraction
// but not for resolution), so a record's extraction and resolution cannot desynchronize.
import { languageResolver } from '../ecosystem/records.mjs';
import {
  FTS_SCHEMA,
  FTS_TRI_SCHEMA,
  SCHEMA_V,
  SQLITE_FILE,
  countSqlite,
  decodeVectorBlob,
  encodeVectorBlob,
  readSchema,
  readSqliteRows,
  readTreeDigest,
  treeDigest,
  writeSqlite,
} from './persist.mjs';

export { SQLITE_FILE, decodeVectorBlob, encodeVectorBlob };

const MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

// A tracked blob larger than this is recorded with its size and counted in
// `skipped`, not streamed and tokenized: a 65 MiB file is indexed as a row, and
// tokenizing it would buy nothing . The cap sits under that file on purpose
// so the 65 MiB test exercises the skip, not the tokenize path.
const BLOB_CAP = 16 * 1024 * 1024;

const LANG = languageResolver();

const INDEX_NODE_FLOOR = '22.20.0';

/**
 * Fail, naming the floor, when this Node cannot open the index's tables.
 *
 * ADR-135 retired the JSON-lines fallback once the floor carried both
 * `node:sqlite` and FTS5 (the CJK table needs the `trigram` tokenizer). A Node
 * below it now says which one it needs, instead of writing a second format every
 * other version reads differently. Checked once per process: the probe builds
 * both FTS schemas in a memory database and every read path used to pay for it.
 */
let floorChecked;
async function ensureIndexSupport() {
  floorChecked ??= (async () => {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec(FTS_SCHEMA);
      db.exec(FTS_TRI_SCHEMA);
      db.close();
    } catch (error) {
      throw new Error(
        `the index needs node:sqlite with FTS5, which Node ${INDEX_NODE_FLOOR} carries: ${error.message}`,
      );
    }
  })();
  await floorChecked;
}

export function ftsKindOf(filePath, lang = '') {
  if (filePath.startsWith('docs/decisions/')) return 'decisions';
  if (filePath.startsWith('docs/lessons/')) return 'lessons';
  if (filePath.includes('skills') && (filePath.endsWith('.md') || filePath.endsWith('.json'))) return 'skills';
  if (lang) return 'code';
  return 'docs';
}

/**
 * The one fold for the FTS pipeline
 *
 * NFKC before NFKD so compatibility variants fold first (half-width katakana
 * to full-width) and combining marks strip after (München -> munchen), then
 * lowercase. That is what FTS5 `unicode61 remove_diacritics 2` does to the
 * same text on the sqlite side: ß stays ß on both (this SQLite build does
 * not fold it), and a run the fold keeps whole matches a run it keeps whole.
 *
 * The strip spares the combining dakuten and handakuten (U+3099 U+309A): NFKD
 * splits ド into ト plus a mark, and dropping that mark would voice every
 * がぎぐげご to かきくけこ. unicode61 never strips them either, so the final
 * NFKC recomposes what the strip spared.
 */
function foldText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/\p{M}/gu, (mark) => (mark === '゙' || mark === '゚' ? mark : ''))
    .normalize('NFKC')
    .toLowerCase();
}

const FOLD_RUN = /[\p{L}\p{N}]+/gu;
const CJK_SEG = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Whether a token is a single CJK character (kept at any length). */
function isCjkToken(token) {
  return typeof token === 'string' && [...token].length === 1 && CJK_CHAR.test(token);
}

/** Maximal CJK runs in raw text: the substrings the trigram table resolves. */
function cjkRuns(text) {
  return [...new Set(String(text ?? '').match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [])];
}

/**
 * The one tokenizer for the FTS pipeline: index side and task side.
 *
 * Non-CJK runs keep the caller's floor; CJK runs emit single characters
 * because unicode61 has no CJK segmentation - a run kept whole here would
 * never match there. CamelCase is deliberately not split: `magictoken` in a
 * task matches `magicToken` in a body because both sides only lowercase.
 */
export function tokenizeText(text, { min = 2 } = {}) {
  const out = [];
  for (const run of foldText(text).match(FOLD_RUN) ?? []) {
    for (const seg of run.match(CJK_SEG) ?? []) {
      if (CJK_CHAR.test(seg[0])) {
        for (const ch of seg) out.push(ch);
      } else if (seg.length >= min) {
        out.push(seg);
      }
    }
  }
  return out;
}

/** Line-aligned sections: whole documents stay indexed, and a term deep in a
 * long file matches its own section instead of falling past a byte cap. */
const SECTION_CHARS = 8000;

function splitSections(text) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur.length > 0 && cur.length + 1 + line.length > SECTION_CHARS) {
      out.push(cur);
      cur = '';
    }
    cur = cur.length === 0 ? line : `${cur}\n${line}`;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function hasCjk(text) {
  return CJK_CHAR.test(String(text ?? ''));
}

/**
 * One FTS row per section, `{ kind, ref, body }`, with `raw` (folded section
 * text for the trigram table) on CJK-bearing sections only. Symbol names and
 * signatures ride on the first section: they describe the file, not the
 * section, and repeating them would weight long files by section count. Path
 * tokens are gone on purpose - kind and ref are UNINDEXED now, and file-name
 * matching is the resolver signal in scoreFiles, not a body term that matches
 * every row of that kind.
 */
export function buildFtsBodies(filePath, symbolsForPath = [], text = null) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const kind = ftsKindOf(filePath, langOf(filePath));
  const symTokens = [];
  for (const s of symbolsForPath) {
    if (s?.name) symTokens.push(s.name, s.name);
    if (s?.sig) symTokens.push(s.sig);
  }
  const head = tokenizeText(symTokens.join('\n'), { min: 1 }).join(' ');
  const rows = [];
  for (const section of splitSections(text)) {
    const body = (rows.length === 0 && head.length > 0
      ? `${head} ${tokenizeText(section).join(' ')}`
      : tokenizeText(section).join(' ')
    ).trim();
    if (body.length === 0) continue;
    const row = { kind, ref: filePath, body };
    if (hasCjk(section)) row.raw = foldText(section);
    rows.push(row);
  }
  return rows;
}

export function buildFtsBody(filePath, symbolsForPath = [], text = null) {
  const rows = buildFtsBodies(filePath, symbolsForPath, text);
  return rows.length > 0 ? rows[0].body : '';
}

const FTS_STOP = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'into', 'only', 'when', 'what',
  'which', 'their', 'about', 'after', 'before', 'where', 'there', 'these', 'those',
  'would', 'could', 'should', 'every', 'other', 'than', 'then', 'them', 'they',
  'your', 'will', 'does', 'file', 'files', 'test', 'tests', 'line', 'lines', 'code',
  'also', 'just', 'more', 'some', 'such', 'each', 'same', 'over', 'used', 'using',
  'the', 'and', 'for', 'not', 'are', 'was', 'were', 'has', 'had', 'but', 'can', 'one', 'two',
]);

export function ftsQueryTerms(task) {
  const seen = new Set();
  for (const tok of tokenizeText(task, { min: 1 })) {
    if (seen.has(tok)) continue;
    if (!isCjkToken(tok) && (tok.length < 3 || FTS_STOP.has(tok))) continue;
    seen.add(tok);
  }
  return [...seen].slice(0, 48);
}

/**
 * Rebuild the index from the git index. Unchanged blobs are left as they are.
 *
 * @param {string} root
 * @param {{embed?: boolean, allowRemote?: boolean, fetchImpl?: typeof fetch}} [opts]
 */
export async function reindex(root, opts = {}) {
  const started = Date.now();
  await ensureIndexSupport();
  const listed = await lsFiles(root);
  const version = await readSchema(root);
  // A cache written before symbols existed has the right blobs and the wrong
  // tables. Re-extract once, then an unchanged blob stays untouched.
  const force = version !== SCHEMA_V;
  const previous = await readFiles(root);
  const prior = new Map(previous.map((row) => [row.path, row]));
  const cache = new Map();
  const changed = [];
  for (const entry of listed) {
    const old = prior.get(entry.path);
    if (!force && old && old.blob === entry.blob) continue;
    changed.push(entry);
  }
  const sizes = await blobSizes(root, changed.map((entry) => entry.blob));
  // Over-cap blobs are recorded with their size and counted in `skipped`, not
  // streamed and tokenized: their row is written, their text is never read.
  const textBlobs = changed.map((entry) => entry.blob).filter((blob) => (sizes.get(blob) ?? 0) <= BLOB_CAP);
  const texts = await blobTexts(root, textBlobs);
  const adapter = await resolveAdapter(root, opts);
  const paths = new Set(listed.map((entry) => entry.path));
  const next = [];
  const symbols = [];
  const edges = [];
  const fts = [];
  let skipped = 0;
  for (const entry of changed) {
    const lang = langOf(entry.path);
    next.push({
      path: entry.path,
      blob: entry.blob,
      lang,
      bytes: sizes.get(entry.blob) ?? 0,
      pkg: await packageOf(root, entry.path, cache),
    });
    const text = texts.get(entry.blob);
    const pulled = text == null
      ? { symbols: [], imports: [], edges: null }
      : await runExtract(entry.path, text, lang, adapter.module);
    symbols.push(...pulled.symbols);
    edges.push(...(pulled.edges ?? resolveImports(entry.path, pulled.imports, paths, lang)));
    // A null blob is binary: recorded in `skipped`, never tokenized.
    if (text == null) {
      skipped += 1;
      continue;
    }
    fts.push(...buildFtsBodies(entry.path, pulled.symbols, text));
  }
  const removed = previous.filter((row) => !paths.has(row.path)).map((row) => row.path);
  // The tree this build vouches for, stored beside the rows so a later read
  // can compare digests instead of re-reading blobs.
  const embedBuild = await buildEmbeddings(root, listed, fts, {
    force,
    embed: opts.embed === true,
    allowRemote: opts.allowRemote === true,
    fetchImpl: opts.fetchImpl,
  });
  const tree = treeDigest(listed);
  await writeSqlite(root, next, removed, symbols, edges, fts, embedBuild.rows, tree);
  const stored = await countSqlite(root);
  return {
    files: listed.length,
    updated: next.length,
    removed: removed.length,
    symbols: stored.symbols,
    edges: stored.edges,
    embeddings: stored.embeddings ?? 0,
    embedState: embedBuild.state,
    parsers: adapter.state,
    skipped,
    ms: Date.now() - started,
  };
}

/**
 * Whether the stored index predates the current tree.
 *
 * One `git ls-files -s` and one meta read: no blob is re-read, so the check
 * costs ~100 ms and every read path can afford it. False when no build has
 * vouched for a tree (that is cold, not stale) and when git cannot answer -
 * a cache of blobs is still a cache when the worktree tool is missing, and
 * refusing to serve it would turn every offline read into an error.
 *
 * @returns {Promise<boolean>}
 */
export async function isIndexStale(root, opts = {}) {
  await ensureIndexSupport();
  const stored = await readTreeDigest(root);
  if (!stored) return false;
  let listed;
  try {
    listed = await lsFiles(root);
  } catch {
    return false;
  }
  return treeDigest(listed) !== stored;
}

async function buildEmbeddings(root, listed, changedFts, { force, embed, allowRemote, fetchImpl }) {
  if (!embed) return { state: 'off', rows: [] };
  const localCfg = await readLocalConfig(root, { allowRemote });
  if (!localCfg.embed) return { state: 'off', rows: [] };
  if (localCfg.embed.blocked) return { state: 'refused-remote', rows: [] };

  const existingEmbeds = force ? [] : await readEmbeddings(root);
  const embedByPath = new Map(existingEmbeds.map((row) => [row.path, row]));
  // Sections share a ref; the embedding input is the file's first section.
  const ftsByPath = new Map();
  for (const row of changedFts) {
    if (!ftsByPath.has(row.ref)) ftsByPath.set(row.ref, row.body);
  }
  const missingEntries = [];
  for (const entry of listed) {
    const prev = embedByPath.get(entry.path);
    if (prev && prev.blob === entry.blob && prev.model === localCfg.embed.model && prev.vec.length > 0) {
      continue;
    }
    missingEntries.push(entry);
  }
  if (missingEntries.length === 0) return { state: 'cached', rows: [] };

  // Ensure FTS summaries are available for any entry that did not change in this pass.
  const needFts = missingEntries.some((entry) => !ftsByPath.has(entry.path));
  if (needFts) {
    const storedFts = await readFts(root);
    for (const row of storedFts) {
      if (!ftsByPath.has(row.ref)) ftsByPath.set(row.ref, row.body);
    }
  }

  const rows = [];
  const batchSize = 32;
  for (let i = 0; i < missingEntries.length; i += batchSize) {
    const slice = missingEntries.slice(i, i + batchSize);
    const inputs = slice.map((entry) => {
      const summary = ftsByPath.get(entry.path) ?? entry.path;
      return `${entry.path}\n${summary}`.slice(0, 4096);
    });
    const res = await localEmbed(localCfg.embed, { input: inputs, allowRemote, fetchImpl });
    if (!res.ok || res.embeddings.length !== slice.length) {
      return { state: 'failed', rows };
    }
    for (let j = 0; j < slice.length; j += 1) {
      const vec = res.embeddings[j];
      rows.push({
        path: slice[j].path,
        blob: slice[j].blob,
        model: res.model ?? localCfg.embed.model,
        dims: vec.length,
        vec: encodeVectorBlob(vec),
      });
    }
  }
  return { state: 'embedded', rows };
}

/**
 * Read wrappers return arrays with the read error attached:
 * callers that iterate are untouched, and callers that report - map among
 * them - can tell a broken index from an empty one.
 */
function withReadError(rows, error) {
  if (error) rows.error = error;
  return rows;
}/** File rows, sorted by path. The same blobs read back as the same rows. */
export async function readFiles(root) {
  // The v5 layout keys files as `sources` rows; the git blob sha is `revision`
  // and the package directory rides in `props`, which the v4 `files` table
  // named `pkg`.
  const { rows, error } = await readSqliteRows(
    root,
    `select s.path as path, s.revision as blob, s.lang as lang, s.bytes as bytes,
      json_extract(s.props, '$.pkg') as pkg from sources s where s.kind = 'blob' order by s.path`,
  );
  return withReadError(rows, error);
}

/** Symbol rows for the blobs currently indexed. */
export async function readSymbols(root) {
  const { rows, error } = await readSqliteRows(
    root,
    `select s.path as path, n.name as name, json_extract(n.props, '$.kind') as kind,
      n.line as line, json_extract(n.props, '$.sig') as sig,
      json_extract(n.props, '$.exported') as exported
      from nodes n join sources s on s.id = n.source_id and s.kind = 'blob'
      where n.kind = 'symbol' order by s.path, n.line, n.name, n.kind`,
  );
  return withReadError(rows, error);
}

/** Edges currently indexed. An import edge's src is the file that imports. */
export async function readEdges(root) {
  // Paths come back from the node key (`file:<path>`) and the stable `dst_key`:
  // node ids are regenerated when a file changes, so a path is the only key
  // that survives a reindex of one endpoint.
  const { rows, error } = await readSqliteRows(
    root,
    `select substr(ns.key, 6) as src, e.dst_key as dst, e.kind as kind, e.weight as weight
      from edges e join nodes ns on ns.id = e.src_id order by src, dst, kind`,
  );
  return withReadError(rows, error);
}

/** FTS rows currently indexed: one row per section, first section first. */
export async function readFts(root) {
  const { rows, error } = await readSqliteRows(
    root,
    `select f.kind as kind, substr(n.key, 6) as ref, f.body as body
      from fts f join nodes n on n.id = f.node_id order by ref, kind, f.rowid`,
  );
  return withReadError(rows, error);
}

/** Stored vector embeddings, decoded as Float32Array per path. */
export async function readEmbeddings(root) {
  const { rows: raw, error } = await readSqliteRows(
    root,
    `select substr(n.key, 6) as path, s.revision as blob, v.model as model, v.dims as dims, v.vec as vec
      from vectors v join nodes n on n.id = v.node_id
      join sources s on s.id = n.source_id and s.kind = 'blob' order by path`,
  );
  const rows = raw.map((row) => {
    const vec = decodeVectorBlob(row.vec);
    return {
      path: row.path,
      blob: row.blob ?? '',
      model: row.model ?? '',
      dims: Number.isInteger(row.dims) ? row.dims : vec.length,
      vec,
    };
  });
  return withReadError(rows, error);
}

/** Result rows per query branch: many sections share a path. */
const FTS_LIMIT = 200;

function dedupePaths(rows) {
  const best = new Map();
  for (const row of rows) {
    const prev = best.get(row.path);
    if (!prev || row.score > prev.score) best.set(row.path, row);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Rank indexed documents against a task string using BM25.
 *
 * Uses SQLite FTS5 `bm25(fts)` when there are hits. A caller that hands in its
 * own row set (`opts.fts`) is ranked by the identical Okapi BM25 computation, so
 * the fold can be exercised without a database.
 * A query with CJK also consults the trigram table - unicode61 has no CJK
 * segmentation, so those runs are unqueryable there - and a mixed query
 * unions both tables, trigram hits first, because an ASCII-only table cannot
 * hold a CJK run and a trigram table cannot hold an ASCII-only file.
 */
export async function searchFtsBm25(root, task, opts = {}) {
  const terms = ftsQueryTerms(task);
  if (terms.length === 0) return [];
  await ensureIndexSupport();
  const ascii = terms.filter((t) => !isCjkToken(t));
  const runs = [...new Set(cjkRuns(foldText(task)))];
  const hits = [];
  let error = null;
  if (runs.length > 0) {
    const tri = await ftsBranch(root, 'fts_tri', [...runs, ...ascii]);
    hits.push(...tri.rows);
    error = tri.error;
  }
  if (ascii.length > 0) {
    const seen = new Set(hits.map((row) => row.path));
    const fts = await ftsBranch(root, 'fts', ascii);
    for (const row of fts.rows) {
      if (!seen.has(row.path)) {
        seen.add(row.path);
        hits.push(row);
      }
    }
    error = error ?? fts.error;
  }
  if (hits.length > 0) return withReadError(dedupePaths(hits).slice(0, FTS_LIMIT), error);
  const ftsRows = opts.fts ?? await readFts(root);
  return withReadError(scoreFtsBm25(ftsRows, task).slice(0, FTS_LIMIT), ftsRows.error);
}

async function ftsBranch(root, table, terms) {
  if (terms.length === 0) return { rows: [], error: null };
  const matchExpr = terms.map((t) => `"${t}"`).join(' OR ');
  // `fts` is the v5 node-keyed table: the path comes back through the node key.
  // `fts_tri` keeps its v4 (kind, ref, body) shape for the CJK trigram path ,
  // so it is queried the old way.
  const sql = table === 'fts'
    ? `select f.kind as kind, substr(n.key, 6) as path, -bm25(f) as score
       from fts f join nodes n on n.id = f.node_id
       where f match ? order by score desc, path asc limit ?`
    : `select kind, ref as path, -bm25(${table}) as score from ${table} where ${table} match ? order by score desc, path asc limit ?`;
  const { rows, error } = await readSqliteRows(root, sql, [matchExpr, FTS_LIMIT]);
  return {
    rows: rows.map((row) => ({ kind: row.kind, path: row.path, score: Number(row.score) || 0 })),
    error,
  };
}

/**
 * Deterministic Okapi BM25 ranking over FTS rows (`{ kind, ref, body }`).
 */
export function scoreFtsBm25(ftsRows, task) {
  const terms = ftsQueryTerms(task);
  if (terms.length === 0 || !Array.isArray(ftsRows) || ftsRows.length === 0) return [];
  const k1 = 1.2;
  const b = 0.75;
  const N = ftsRows.length;
  const docs = ftsRows.map((row) => {
    const path = row.ref ?? row.path ?? '';
    // Body only: kind and ref are UNINDEXED on the sqlite side, so scoring
    // them here would rank what the index cannot see either.
    const words = tokenizeText(row.body ?? '', { min: 1 });
    const tf = new Map();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { kind: row.kind ?? 'code', path, len: words.length, tf };
  });
  const avgdl = docs.reduce((sum, d) => sum + d.len, 0) / N || 1;
  const df = new Map();
  for (const term of terms) {
    let n = 0;
    for (const d of docs) if (d.tf.has(term)) n += 1;
    df.set(term, n);
  }
  const out = [];
  for (const d of docs) {
    let score = 0;
    for (const term of terms) {
      const f = d.tf.get(term) ?? 0;
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.max(1e-6, Math.log((N - n + 0.5) / (n + 0.5)));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / avgdl))));
    }
    if (score > 0) out.push({ kind: d.kind, path: d.path, score });
  }
  // Sections share a path; the file keeps its best section.
  return dedupePaths(out);
}

export function langOf(filePath) {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return LANG[base.slice(dot + 1)] ?? '';
}

export async function packageOf(root, filePath, cache) {
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



async function lsFiles(root) {
  const stdout = await gitRaw(root, ['ls-files', '-s', '-z']);
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

async function resolveAdapter(root, opts) {
  if (opts.adapter) return { module: opts.adapter, state: 'loaded' };
  let manifest = null;
  try {
    const read = await readManifest(root);
    if (!read.error) manifest = read.manifest;
  } catch {
    return { module: null, state: 'off' };
  }
  const name = manifest?.index?.parsers;
  if (typeof name !== 'string' || name === '') return { module: null, state: 'off' };
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(join(root, 'package.json'));
    return { module: req(name), state: 'loaded' };
  } catch {
    return { module: null, state: 'missing' };
  }
}

async function runExtract(filePath, text, lang, adapter) {
  if (adapter && typeof adapter.extract === 'function') {
    try {
      const got = await adapter.extract(filePath, text, lang);
      if (got && Array.isArray(got.symbols)) return normalise(filePath, got);
    } catch {
      // A parser that throws does not sink the index. The built-in rows are the cache.
    }
  }
  return extract(filePath, text, lang);
}

function normalise(filePath, got) {
  const symbols = [];
  for (const row of got.symbols) {
    if (!row || typeof row.name !== 'string' || row.name === '') continue;
    symbols.push({
      path: filePath,
      name: row.name,
      kind: typeof row.kind === 'string' ? row.kind : 'symbol',
      line: Number.isInteger(row.line) ? row.line : 0,
      sig: typeof row.sig === 'string' ? row.sig.slice(0, 200) : '',
      exported: row.exported ? 1 : 0,
    });
  }
  symbols.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let edges = null;
  if (Array.isArray(got.edges)) {
    edges = [];
    for (const row of got.edges) {
      if (!row || typeof row.dst !== 'string') continue;
      edges.push({
        src: filePath,
        dst: row.dst,
        kind: typeof row.kind === 'string' ? row.kind : 'import',
        weight: typeof row.weight === 'number' ? row.weight : 1,
      });
    }
    edges.sort((a, b) => (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  }
  return { symbols, imports: Array.isArray(got.imports) ? got.imports : [], edges };
}

/**
 * The body of each listed blob, read as one `cat-file --batch` stream.
 *
 * Streamed and parsed incrementally rather than buffered: the combined output of a
 * repository whose tracked content exceeds execFile's maxBuffer (64 MiB) used to
 * reject the whole index with "stdout maxBuffer length exceeded" — an ~82 MiB
 * Android checkout died on first run for exactly that reason.
 */
export async function blobTexts(root, blobs) {
  const unique = [...new Set(blobs)];
  const texts = new Map();
  if (unique.length === 0) return texts;
  const child = spawn('git', ['cat-file', '--batch'], { cwd: root });
  child.stdin.end(`${unique.join('\n')}\n`);
  let pending = null;
  const onChunk = (chunk) => {
    pending = pending === null ? chunk : Buffer.concat([pending, chunk]);
    let consumed = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, consumed);
      if (nl < 0) break;
      const parts = pending.toString('utf8', consumed, nl).split(' ');
      const size = Number(parts[2]);
      if (parts[1] !== 'blob' || !Number.isFinite(size)) {
        consumed = nl + 1;
        continue;
      }
      const end = nl + 1 + size + 1;
      if (pending.length < end) break; // the body is not fully arrived yet
      const start = nl + 1;
      const body = pending.subarray(start, start + size);
      consumed = end;
      texts.set(parts[0], body.includes(0) ? null : body.toString('utf8'));
    }
    // Drop the consumed prefix. Copy the tail once it has grown past a MiB, so the
    // released bytes are actually freed instead of staying alive behind a view into
    // the buffer they came from.
    if (consumed > 0) {
      const tail = pending.subarray(consumed);
      pending = tail.length === 0 ? null : consumed >= 1 << 20 ? Buffer.from(tail) : tail;
    }
  };
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`git cat-file --batch exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      else resolve(texts);
    });
  });
}

async function blobSizes(root, blobs) {
  const unique = [...new Set(blobs)];
  const sizes = new Map();
  if (unique.length === 0) return sizes;
  const stdout = await gitRaw(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
    input: `${unique.join('\n')}\n`,
  });
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    sizes.set(line.slice(0, sp), Number(line.slice(sp + 1)));
  }
  return sizes;
}
