// The local index (ADR-089, ADR-135).
//
// `node:sqlite` with FTS5, and nothing else: the Node floor carries both, which is
// what ADR-135 waited for before retiring the JSON-lines file. The index is a cache:
// `git ls-files -s` can rebuild it, so a missing file is not a lost database. A blob
// that has not changed is not read again.

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { git as gitRaw } from '../sys/git.mjs';

import { PACKAGE_MARKERS } from '../monorepo.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { readLocalConfig } from '../local/config.mjs';
import { executionAllowed, trustPolicy } from '../trust/policy.mjs';
import { localEmbed } from '../local/client.mjs';
import { foldIdentifierText } from '../text/identifiers.mjs';
import { sourceLineFacts } from './source-lines.mjs';
import { buildCochange } from './cochange.mjs';
import { extractConceptFileTerms } from './concept-map.mjs';
import { CITATIONS_BASIS_SQL, prepareCitations } from './commit-citations.mjs';
import { readCochangeBasis, readFts, withReadError } from './graph-read.mjs';
export { readEdges, readFiles, readFts, readGraph, readSymbolGraph, readSymbols } from './graph-read.mjs';
import { extract, extractSymbolEvidence, resolveImports } from './extract.mjs';
export { nativeConceptualPartners, readFileSignatures, readLexicalStats } from './lexical-store.mjs';
import {
  BM25F_FIELDS, BM25F_WEIGHTS, bestFieldHits, fieldCandidateStatement, fieldQueryTerms,
  fieldSearchStatement, fieldTokens, ftsQuote, scoreFtsBm25F,
} from './bm25f.mjs';
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
  digestOfParts,
  digestOfText,
  encodeVectorBlob,
  gitIndexStamp,
  readBuildMeta,
  readSchema,
  readSqliteBatch,
  readSqliteRows,
  signalsStat,
  treeDigest,
  writeSqlite,
} from './persist.mjs';

export { BM25F_WEIGHTS, SQLITE_FILE, decodeVectorBlob, encodeVectorBlob, scoreFtsBm25F };

// A tracked blob larger than this is recorded with its size and counted in
// `skipped`, not streamed and tokenized: a 65 MiB file is indexed as a row, and
// tokenizing it would buy nothing . The cap sits under that file on purpose
// so the 65 MiB test exercises the skip, not the tokenize path.
export const BLOB_CAP = 16 * 1024 * 1024;

// What the built-in extractor and import resolver mean, separately from the
// database schema. Bump it when their reading changes: every cache built by the
// older reading is then re-extracted, which a schema migration is not for.
const INDEX_INPUT_REVISION = 5;

// The index's file scope. `git ls-files -s` is the whole tracked tree; a build
// that restricted it would be a second meaning of the cache, and the stamp says
// which one this is.
const INDEX_SCOPE = 'tracked-tree';

// Per root, because a repository may declare its own language in `.simt/ecosystems/`.
// The module-level table was the shipped set for every repository in the process.
const langByRoot = new Map();

function langTable(root) {
  const key = root ?? '';
  if (!langByRoot.has(key)) langByRoot.set(key, languageResolver(root));
  return langByRoot.get(key);
}

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
export async function ensureIndexSupport() {
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

function foldText(text) {
  return foldIdentifierText(text).toLowerCase();
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
export function buildFtsBodies(filePath, symbolsForPath = [], text = null, root = null) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const kind = ftsKindOf(filePath, langOf(filePath, root));
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

/** File metadata belongs to the first section. Repeating it in every section
 * would change document frequencies based on how long a file happens to be. */
export function buildFieldedFtsBodies(path, symbols = [], text = '', root = null) {
  const kind = ftsKindOf(path, langOf(path, root));
  const sections = splitSections(text);
  const metadata = {
    path_tokens: fieldTokens(path),
    symbol_names: fieldTokens(symbols.map((symbol) => symbol.name ?? '').join(' ')),
    qual_names: fieldTokens(symbols.map((symbol) => symbol.qualname ?? `${path}.${symbol.name ?? ''}`).join(' ')),
    signatures: fieldTokens(symbols.map((symbol) => symbol.sig ?? '').join(' ')),
  };
  return (sections.length ? sections : ['']).map((section, index) => ({
    kind,
    ref: path,
    ...Object.fromEntries(Object.entries(metadata).map(([field, value]) => [field, index === 0 ? value : ''])),
    headings: fieldTokens([...section.matchAll(/^ {0,3}#{1,6}[ 	]+(.+)$/gm)].map((match) => match[1]).join(' ')),
    body: fieldTokens(section),
  }));
}

export function buildFtsBody(filePath, symbolsForPath = [], text = null, root = null) {
  const rows = buildFtsBodies(filePath, symbolsForPath, text, root);
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
 * @param {{embed?: boolean, fielded?: boolean, allowRemote?: boolean, fetchImpl?: typeof fetch}} [opts]
 */
export async function reindex(root, opts = {}) {
  const started = Date.now();
  await ensureIndexSupport();
  const [indexStamp, sigStat, listed] = await Promise.all([gitIndexStamp(root), signalsStat(root), lsFiles(root)]);
  const version = await readSchema(root);
  // A cache written before symbols existed has the right blobs and the wrong
  // tables. Re-extract once, then an unchanged blob stays untouched.
  const forceSchema = version !== SCHEMA_V && version !== '5' && version !== '6';
  // The package layout is an input of the row, not decoration: an unchanged blob
  // under a new nearest package marker has a new `pkg`, and resolution can cross a
  // boundary it did not before.
  const packages = await packageLayout(root, listed);
  const adapter = await resolveAdapter(root, opts);
  const stored = await readBuildMeta(root);
  const hadFielded = stored.meta.fts_fields === '1';
  const fielded = hadFielded || opts.fielded !== false;
  const inputs = inputsDigest(root, { adapter, packages });
  const priorInputs = version === '5' || version === '6'
    ? inputsDigest(root, { adapter, packages, schema: version })
    : inputs;
  const resolution = resolutionDigest(root, listed);
  // A cache with no stamp was written by a reading this one cannot describe, so
  // it is rebuilt rather than partly reused.
  const force = forceSchema
    || (fielded && (stored.meta.lexical_terms !== '1' || stored.meta.concept_map !== '1'))
    || stored.error != null
    || stored.meta.inputs !== priorInputs;
  // Import resolution reads the tracked path set and the language table, not a
  // file's bytes. When either moves, an unchanged importer's edge can name a
  // destination that was added, deleted or renamed; its stored specifiers are
  // enough to re-resolve the edge without reading the blob again.
  const resolutionChanged = !force && Boolean(stored.meta.resolution) && stored.meta.resolution !== resolution;
  const previous = await readBuildRows(root);
  const prior = new Map(previous.map((row) => [row.path, row]));
  const changed = [];
  for (const entry of listed) {
    const old = prior.get(entry.path);
    if (!force && old && old.blob === entry.blob && old.hasLineFacts) continue;
    changed.push(entry);
  }
  const sizes = await blobSizes(root, changed.map((entry) => entry.blob));
  // Over-cap blobs are recorded with their size and counted in `skipped`, not
  // streamed and tokenized: their row is written, their text is never read.
  const textBlobs = changed.map((entry) => entry.blob).filter((blob) => (sizes.get(blob) ?? 0) <= BLOB_CAP);
  const texts = await blobTexts(root, textBlobs);
  const paths = new Set(listed.map((entry) => entry.path));
  const next = [];
  const symbols = [];
  const edges = [];
  const fts = [];
  const fieldedRows = [];
  const conceptRows = [];
  let skipped = 0;
  for (const entry of changed) {
    const lang = langOf(entry.path, root);
    const text = texts.get(entry.blob);
    const pulled = text == null
      ? { symbols: [], imports: [], edges: null }
      : await runExtract(entry.path, text, lang, adapter.module);
    const resolved = pulled.edges ?? resolveImports(entry.path, pulled.imports, paths, lang);
    next.push({
      path: entry.path,
      blob: entry.blob,
      lang,
      bytes: sizes.get(entry.blob) ?? 0,
      pkg: packages.get(entry.path) ?? '',
      ...(texts.has(entry.blob) ? sourceLineFacts(text) : {}),
      hasLineFacts: true,
      // Kept so a later build can re-resolve this file's edges without its bytes.
      imports: Array.isArray(pulled.imports) ? pulled.imports : [],
      bindings: { namedImports: pulled.namedImports ?? [], reexports: pulled.reexports ?? [], chunk: pulled.chunk },
      resolution: text == null ? 'none' : pulled.edges ? 'adapter' : 'builtin',
    });
    symbols.push(...pulled.symbols);
    edges.push(...resolved);
    // A null blob is binary: recorded in `skipped`, never tokenized.
    if (text == null) {
      skipped += 1;
      continue;
    }
    fts.push(...buildFtsBodies(entry.path, pulled.symbols, text, root));
    if (fielded) fieldedRows.push(...buildFieldedFtsBodies(entry.path, pulled.symbols, text, root));
    conceptRows.push({ path: entry.path, ...extractConceptFileTerms(entry.path, text, lang, pulled.symbols) });
  }
  const edgeOwners = [];
  if (resolutionChanged) {
    // ONLY the unchanged importers: a changed row was just extracted and its edges
    // are already in `edges`, so re-resolving its stored specifiers would add every
    // edge a second time (and from the imports the file no longer has). The two
    // conditions overlap whenever a blob and the tracked path set both move, which
    // is common - and the second insert of a key the first one claimed is a UNIQUE
    // constraint failure for the whole build (PR23 regression).
    const changedPaths = new Set(changed.map((entry) => entry.path));
    for (const row of previous) {
      if (!paths.has(row.path) || changedPaths.has(row.path)) continue;
      // An adapter's edges are its own reading; its identity is part of `inputs`,
      // so an adapter change already forced a re-extraction. A file that imported
      // nothing has no edge a new path set could change.
      if (row.resolution !== 'builtin' || !Array.isArray(row.imports) || row.imports.length === 0) continue;
      edgeOwners.push(row.path);
      edges.push(...resolveImports(row.path, row.imports, paths, row.lang));
    }
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
  const { prepareGovernance } = await import('./governance-store.mjs');
  const [cochange, governance, citations] = await Promise.all([
    readCochangeBasis(root).then((basis) => buildCochange(
      root,
      basis,
      paths,
      { refresh: force || resolutionChanged || stored.meta.commit_fts !== '1' || !Array.isArray(basis?.commitRecords) },
    )),
    prepareGovernance(root, listed),
    readSqliteRows(root, CITATIONS_BASIS_SQL).then(({ rows }) => prepareCitations(root, rows[0]?.value)),
  ]);
  const build = digestOfParts(['index-build-v1', tree, inputs, resolution]);
  await writeSqlite(root, next, removed, symbols, edges, fts, embedBuild.rows, tree, {
    inputs,
    resolution,
    build,
    edgeOwners,
    fielded,
    fieldedRows,
    conceptRows,
    conceptMapRefresh: stored.meta.concept_map !== '1',
    cochange,
    governance: governance?.snapshot ?? null,
    citations,
    gitIndexStat: indexStamp?.stamp ?? null,
    signalsStat: sigStat ?? null,
    governanceSignals: governance?.signals ?? null,
    embedBasis: embedBuild.basis ?? null,
  });
  const counts = await countSqlite(root);
  return {
    files: listed.length,
    updated: next.length,
    removed: removed.length,
    edgesRefreshed: edgeOwners.length,
    symbols: counts.symbols,
    edges: counts.edges,
    embeddings: counts.embeddings ?? 0,
    embedState: embedBuild.state,
    embedBasis: embedBuild.basis ?? null,
    parsers: adapter.state,
    inputs,
    resolution,
    build,
    skipped,
    ms: Date.now() - started,
  };
}

/** The nearest package directory for every listed path, computed once per build. */
async function packageLayout(root, listed) {
  const cache = new Map();
  const packages = new Map();
  for (const entry of listed) packages.set(entry.path, await packageOf(root, entry.path, cache));
  return packages;
}

const byEntryName = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * The parser, language table, package layout and scope a build's rows are a function of.
 *
 * The package layout is the set of package roots the tracked files resolve to, not
 * the path-to-package map: a file added inside an existing package changes neither
 * a row's `pkg` nor how a relative import resolves, and rebuilding the tree for it
 * would make every newly tracked file a full re-extraction.
 */
function inputsDigest(root, { adapter, packages, schema = SCHEMA_V }) {
  return digestOfParts({
    format: 'index-inputs-v1',
    schema,
    revision: INDEX_INPUT_REVISION,
    scope: INDEX_SCOPE,
    parser: {
      state: adapter.state,
      // The refusal's reason is not part of the reading, but the refusal is: a policy
      // change from refused to loaded must rebuild, and so must a different message
      // only when the message is what makes the state. The state and id carry that.
      id: adapter.id ?? '',
      file: adapter.file ?? '',
      digest: adapter.digest ?? '',
    },
    languages: Object.entries(langTable(root)).sort(byEntryName),
    packages: [...new Set(packages.values())].sort(),
  });
}

/** What import resolution reads: the tracked path set and the language table. */
function resolutionDigest(root, listed) {
  return digestOfParts({
    format: 'index-resolution-v1',
    languages: Object.entries(langTable(root)).sort(byEntryName),
    paths: listed.map((entry) => entry.path),
  });
}

async function buildEmbeddings(root, listed, changedFts, { force, embed, allowRemote, fetchImpl }) {
  if (!embed) return { state: 'off', rows: [], basis: null };
  const localCfg = await readLocalConfig(root, { allowRemote });
  if (!localCfg.embed) return { state: 'off', rows: [], basis: null };
  if (localCfg.embed.blocked) return { state: 'refused-remote', rows: [], basis: null };

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
  if (missingEntries.length === 0) return { state: 'cached', rows: [], basis: null };

  // Ensure FTS summaries are available for any entry that did not change in this pass.
  const needFts = missingEntries.some((entry) => !ftsByPath.has(entry.path));
  if (needFts) {
    const storedFts = await readFts(root);
    for (const row of storedFts) {
      if (!ftsByPath.has(row.ref)) ftsByPath.set(row.ref, row.body);
    }
  }

  const rows = [];
  // The exchange's basis, recorded once beside the rows: which model answered, where,
  // and how much crossed the socket. No content and no credential (ADR-204).
  let basis = null;
  const batchSize = 32;
  for (let i = 0; i < missingEntries.length; i += batchSize) {
    const slice = missingEntries.slice(i, i + batchSize);
    const inputs = slice.map((entry) => {
      const summary = ftsByPath.get(entry.path) ?? entry.path;
      return `${entry.path}\n${summary}`.slice(0, 4096);
    });
    const res = await localEmbed(localCfg.embed, { input: inputs, allowRemote, fetchImpl });
    if (!res.ok || res.embeddings.length !== slice.length) {
      return { state: 'failed', rows, basis };
    }
    basis = res.basis ?? basis;
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
  return { state: 'embedded', rows, basis };
}

/**
 * The build rows, including what a later build needs to re-resolve their edges.
 *
 * `imports` is stored as JSON in `props`; a row written before that field
existed has `null`, and a build that must re-resolve it re-extracts instead.
 */
async function readBuildRows(root) {
  const { rows, error } = await readSqliteRows(
    root,
    `select s.path as path, s.revision as blob, s.lang as lang, s.bytes as bytes,
      json_extract(s.props, '$.pkg') as pkg,
      json_extract(s.props, '$.hasLineFacts') as hasLineFacts,
      json_extract(s.props, '$.imports') as imports,
      json_extract(s.props, '$.resolution') as resolution
      from sources s where s.kind = 'blob' order by s.path`,
  );
  return withReadError(
    rows.map((row) => ({
      ...row,
      imports: parseImports(row.imports),
      resolution: row.resolution ?? null,
    })),
    error,
  );
}

function parseImports(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readFieldedFts(root) {
  const { rows, error } = await readSqliteRows(root,
    `select f.kind, substr(n.key, 6) as ref, ${BM25F_FIELDS.map((field) => `f.${field}`).join(', ')}
      from fts f join nodes n on n.id = f.node_id
      where (select value from meta where key = 'fts_fields') = '1'
      order by ref, f.rowid`, [], { legacySql: null });
  return withReadError(rows, error);
}

export async function searchFtsBm25FBundle(root, task, { fts, fields = BM25F_FIELDS, stats = null, limit = 160 } = {}) {
  if (!fields.length || fields.some((name) => !BM25F_FIELDS.includes(name))) throw new Error('unknown BM25F field');
  if (fts !== undefined) {
    return {
      hits: withReadError(scoreFtsBm25F(fts, task, { fields, stats }), fts.error),
      rows: fts,
      stats,
      error: fts.error ?? null,
    };
  }
  const terms = fieldQueryTerms(task);
  if (!terms.length) return { hits: [], rows: [], stats: null, error: null };
  const prefix = fields === BM25F_FIELDS ? '' : `{${fields.join(' ')}} : `;
  const dfQueries = terms.map((term) => [
    'select count(*) as df from fts where fts match ?',
    [`${prefix}${ftsQuote(term)}`],
  ]);
  const { results, error } = await readSqliteBatch(root, [
    ["select key, value from meta where key in ('fts_fields', 'fts_field_stats')"],
    fieldCandidateStatement(terms, fields, limit),
    ...dfQueries,
  ], { legacySql: null });
  if (error) {
    if (String(error.message ?? error).includes('no such column')) {
      return { hits: [], rows: [], stats: null, error: null };
    }
    return { hits: withReadError([], error), rows: [], stats: null, error };
  }
  const metaMap = new Map((results?.[0] ?? []).map(({ key, value }) => [key, value]));
  if (metaMap.get('fts_fields') !== '1') return { hits: [], rows: [], stats: null, error: null };
  const candidateRows = results?.[1] ?? [];
  if (!candidateRows.length) return { hits: [], rows: [], stats: null, error: null };
  const rawStats = metaMap.get('fts_field_stats');
  const parsedStats = rawStats ? JSON.parse(rawStats) : null;
  if (!parsedStats) {
    const [sql, params] = fieldSearchStatement(terms, fields);
    const fallback = await readSqliteRows(root, sql, params, { legacySql: null });
    return { hits: withReadError(bestFieldHits(fallback.rows), fallback.error), rows: candidateRows, stats: null, error: fallback.error ?? null };
  }
  const df = terms.map((_, index) => results?.[2 + index]?.[0]?.df ?? 0);
  const fullStats = { N: parsedStats.N, avgdl: parsedStats.avgdl, df };
  return {
    hits: scoreFtsBm25F(candidateRows, task, { fields, stats: fullStats }),
    rows: candidateRows,
    stats: fullStats,
    error: null,
  };
}

export async function searchFtsBm25F(root, task, { fts, fields = BM25F_FIELDS, stats = null } = {}) {
  const { hits } = await searchFtsBm25FBundle(root, task, { fts, fields, stats });
  return hits;
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

/** Rank with the baseline body scorer and its separate CJK trigram channel. */
export async function searchFtsBm25(root, task, opts = {}) {
  const terms = ftsQueryTerms(task);
  if (terms.length === 0) return [];
  await ensureIndexSupport();
  const runs = cjkRuns(foldText(task));
  if (runs.length > 0) {
    const matchExpr = [...runs, ...terms.filter((term) => !isCjkToken(term))].map(ftsQuote).join(' OR ');
    const { rows, error } = await readSqliteRows(root,
      `select kind, ref as path, -bm25(fts_tri) as score from fts_tri
        where fts_tri match ? order by score desc, path asc limit ?`,
      [matchExpr, FTS_LIMIT]);
    if (rows.length > 0 || error) {
      const hits = rows.map(({ kind, path, score }) => ({ kind, path, score }));
      return withReadError(dedupePaths(hits).slice(0, FTS_LIMIT), error);
    }
  }
  // The v5 body query used an FTS alias that SQLite rejected. Existing
  // consumers therefore ranked body rows with this scorer. Keep that ordering
  // while new consumers explicitly select the native fielded scorer.
  const ftsRows = opts.fts ?? await readFts(root);
  return withReadError(scoreFtsBm25(ftsRows, task).slice(0, FTS_LIMIT), ftsRows.error);
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

export function langOf(filePath, root = null) {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return langTable(root)[base.slice(dot + 1)] ?? '';
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
    for (const name of PACKAGE_MARKERS) {
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



export async function lsFiles(root) {
  const stdout = await gitRaw(root, ['ls-files', '-s', '-z']);
  const rows = [];
  for (const rec of stdout.split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(' ');
    if (meta[2] !== '0') continue;
    rows.push({ blob: meta[1], path: rec.slice(tab + 1), mode: meta[0] });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

async function resolveAdapter(root, opts) {
  if (opts.adapter) {
    // An injected parser is code this process was handed, not a file the
    // repository names. Its source is its identity, so a different reading is a
    // different input even at the same call site.
    return {
      module: opts.adapter,
      state: 'loaded',
      id: 'injected',
      file: '',
      digest: digestOfText(String(opts.adapter.extract ?? opts.adapter)),
    };
  }
  let manifest = null;
  try {
    const read = await readManifest(root);
    if (!read.error) manifest = read.manifest;
  } catch {
    return { module: null, state: 'off', id: '' };
  }
  const name = manifest?.index?.parsers;
  if (typeof name !== 'string' || name === '') return { module: null, state: 'off', id: '' };
  // Loading the parser RUNS it. A manifest is data a clone can carry, so the specifier
  // must also appear in the repository's explicit opt-in; missing or invalid policy is
  // closed, and the built-in extractors are the fallback (ADR-205).
  const allowed = executionAllowed(trustPolicy(manifest), name);
  if (!allowed.allowed) {
    return { module: null, state: 'refused', id: name, reason: allowed.reason };
  }
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(join(root, 'package.json'));
    // The resolved file's bytes are part of the input: a parser fix under the
    // same config name is still a different reading of the same blob.
    const file = req.resolve(name);
    let digest = '';
    try {
      digest = digestOfText(await readFile(file, 'utf8'));
    } catch {
      digest = '';
    }
    return {
      module: req(name),
      state: 'loaded',
      id: name,
      file: root && file.startsWith(root) ? file.slice(root.length + 1) : file,
      digest,
    };
  } catch {
    return { module: null, state: 'missing', id: name };
  }
}

async function runExtract(filePath, text, lang, adapter) {
  if (adapter && typeof adapter.extract === 'function') {
    try {
      const got = await adapter.extract(filePath, text, lang);
      if (got && Array.isArray(got.symbols)) {
        return { ...normalise(filePath, got), ...extractSymbolEvidence(filePath, text, lang, true) };
      }
    } catch {
      // A parser that throws does not sink the index. The built-in rows are the cache.
    }
  }
  return extract(filePath, text, lang, { references: true });
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

export async function blobSizes(root, blobs) {
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
