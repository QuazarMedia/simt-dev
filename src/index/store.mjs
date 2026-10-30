// The local index (ADR-089).
//
// `node:sqlite` when this Node has it, including FTS5, and a JSON-lines file
// otherwise. Either one is a cache: `git ls-files -s` can rebuild it, so a missing
// file is not a lost database. A blob that has not changed is not read again.

import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readManifest } from '../projection/manifest.mjs';
import { readLocalConfig } from '../local/config.mjs';
import { localEmbed } from '../local/client.mjs';
import { extract, resolveImports } from './extract.mjs';
import {
  JSONL_FILE,
  SCHEMA_V,
  SQLITE_FILE,
  countSqlite,
  decodeVectorBlob,
  encodeVectorBlob,
  readJsonl,
  readSchema,
  readSqliteRows,
  readTreeDigest,
  treeDigest,
  writeJsonl,
  writeSqlite,
} from './persist.mjs';

export { JSONL_FILE, SQLITE_FILE, decodeVectorBlob, encodeVectorBlob };

const MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', kt: 'kotlin', kts: 'kotlin', java: 'java',
  py: 'python', go: 'go', rs: 'rust', swift: 'swift', dart: 'dart', rb: 'ruby', cs: 'csharp',
};

/** `sqlite` when this process can open a database and create an FTS5 table. */
async function probeBackend() {
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

export function ftsKindOf(filePath, lang = '') {
  if (filePath.startsWith('docs/decisions/')) return 'decisions';
  if (filePath.startsWith('docs/lessons/')) return 'lessons';
  if (filePath.includes('skills') && (filePath.endsWith('.md') || filePath.endsWith('.json'))) return 'skills';
  if (lang) return 'code';
  return 'docs';
}

export function buildFtsBody(filePath, symbolsForPath = [], text = null) {
  const tokens = [];
  for (const part of String(filePath ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 2) tokens.push(part);
  }
  for (const s of symbolsForPath) {
    if (s?.name) tokens.push(s.name, s.name);
    if (s?.sig) tokens.push(s.sig);
  }
  if (typeof text === 'string' && text.length > 0) {
    const head = text.slice(0, 24000);
    const seen = new Map();
    for (const m of head.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
      const w = m[0].toLowerCase();
      const c = (seen.get(w) ?? 0) + 1;
      if (c <= 6) {
        seen.set(w, c);
        tokens.push(w);
      }
      if (seen.size >= 600) break;
    }
  }
  return tokens.join(' ');
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
  return [
    ...new Set(
      String(task ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !FTS_STOP.has(w)),
    ),
  ].slice(0, 48);
}

/**
 * Rebuild the index from the git index. Unchanged blobs are left as they are.
 *
 * @param {string} root
 * @param {{backend?: 'sqlite'|'jsonl', embed?: boolean, allowRemote?: boolean, fetchImpl?: typeof fetch}} [opts]
 */
export async function reindex(root, opts = {}) {
  const started = Date.now();
  const backend = opts.backend ?? await probeBackend();
  const listed = await lsFiles(root);
  const version = await readSchema(root, backend);
  // A cache written before symbols existed has the right blobs and the wrong
  // tables. Re-extract once, then an unchanged blob stays untouched.
  const force = version !== SCHEMA_V;
  const previous = await readFiles(root, { backend });
  const prior = new Map(previous.map((row) => [row.path, row]));
  const cache = new Map();
  const changed = [];
  for (const entry of listed) {
    const old = prior.get(entry.path);
    if (!force && old && old.blob === entry.blob) continue;
    changed.push(entry);
  }
  const sizes = await blobSizes(root, changed.map((entry) => entry.blob));
  const texts = await blobTexts(root, changed.map((entry) => entry.blob));
  const adapter = await resolveAdapter(root, opts);
  const paths = new Set(listed.map((entry) => entry.path));
  const next = [];
  const symbols = [];
  const edges = [];
  const fts = [];
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
    const body = buildFtsBody(entry.path, pulled.symbols, text);
    if (body.length > 0) {
      fts.push({ kind: ftsKindOf(entry.path, lang), ref: entry.path, body });
    }
  }
  const removed = previous.filter((row) => !paths.has(row.path)).map((row) => row.path);
  // The tree this build vouches for, stored beside the rows so a later read
  // can compare digests instead of re-reading blobs (review 0003 Q42).
  const embedBuild = await buildEmbeddings(root, listed, fts, {
    backend,
    force,
    embed: opts.embed === true,
    allowRemote: opts.allowRemote === true,
    fetchImpl: opts.fetchImpl,
  });
  const tree = treeDigest(listed);
  let stored;
  if (backend === 'sqlite') {
    await writeSqlite(root, next, removed, symbols, edges, fts, embedBuild.rows, tree);
    stored = await countSqlite(root);
  } else {
    stored = await writeJsonl(root, previous, next, removed, symbols, edges, fts, force, embedBuild.rows, tree);
  }
  return {
    backend,
    files: listed.length,
    updated: next.length,
    removed: removed.length,
    symbols: stored.symbols,
    edges: stored.edges,
    embeddings: stored.embeddings ?? 0,
    embedState: embedBuild.state,
    parsers: adapter.state,
    ms: Date.now() - started,
  };
}

/**
 * Whether the stored index predates the current tree (review 0003 Q42).
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
  const backend = opts.backend ?? await probeBackend();
  const stored = await readTreeDigest(root, backend);
  if (!stored) return false;
  let listed;
  try {
    listed = await lsFiles(root);
  } catch {
    return false;
  }
  return treeDigest(listed) !== stored;
}

async function buildEmbeddings(root, listed, changedFts, { backend, force, embed, allowRemote, fetchImpl }) {
  if (!embed) return { state: 'off', rows: [] };
  const localCfg = await readLocalConfig(root, { allowRemote });
  if (!localCfg.embed) return { state: 'off', rows: [] };
  if (localCfg.embed.blocked) return { state: 'refused-remote', rows: [] };

  const existingEmbeds = force ? [] : await readEmbeddings(root, { backend });
  const embedByPath = new Map(existingEmbeds.map((row) => [row.path, row]));
  const ftsByPath = new Map(changedFts.map((row) => [row.ref, row.body]));
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
    const storedFts = await readFts(root, { backend });
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

/** File rows, sorted by path. The same blobs read back as the same rows. */
export async function readFiles(root, opts = {}) {
  const backend = opts.backend ?? await probeBackend();
  if (backend === 'sqlite') return readSqliteRows(root, 'select path, blob, lang, bytes, pkg from files order by path');
  return readJsonl(root, 'files');
}

/** Symbol rows for the blobs currently indexed. */
export async function readSymbols(root, opts = {}) {
  const backend = opts.backend ?? await probeBackend();
  if (backend === 'sqlite') return readSqliteRows(root, 'select path, name, kind, line, sig, exported from symbols order by path, line, name, kind');
  return readJsonl(root, 'symbols');
}

/** Edges currently indexed. An import edge's src is the file that imports. */
export async function readEdges(root, opts = {}) {
  const backend = opts.backend ?? await probeBackend();
  if (backend === 'sqlite') return readSqliteRows(root, 'select src, dst, kind, weight from edges order by src, dst, kind');
  return readJsonl(root, 'edges');
}

/** FTS rows currently indexed. */
export async function readFts(root, opts = {}) {
  const backend = opts.backend ?? await probeBackend();
  if (backend === 'sqlite') return readSqliteRows(root, 'select kind, ref, body from fts order by ref, kind');
  return readJsonl(root, 'fts');
}

/** Stored vector embeddings, decoded as Float32Array per path. */
export async function readEmbeddings(root, opts = {}) {
  const backend = opts.backend ?? await probeBackend();
  if (backend === 'sqlite') {
    const raw = await readSqliteRows(root, 'select path, blob, model, dims, vec from embeddings order by path');
    return raw.map((row) => {
      const vec = decodeVectorBlob(row.vec);
      return {
        path: row.path,
        blob: row.blob ?? '',
        model: row.model ?? '',
        dims: Number.isInteger(row.dims) ? row.dims : vec.length,
        vec,
      };
    });
  }
  return readJsonl(root, 'embeddings');
}

/**
 * Rank indexed documents against a task string using BM25.
 *
 * Uses SQLite FTS5 `bm25(fts)` when the sqlite backend is active on disk, and
 * falls back to an identical Okapi BM25 computation over `fts` rows otherwise.
 */
export async function searchFtsBm25(root, task, opts = {}) {
  const terms = ftsQueryTerms(task);
  if (terms.length === 0) return [];
  const backend = opts.backend ?? await probeBackend();
  if (backend === 'sqlite') {
    const matchExpr = terms.map((t) => `"${t}"`).join(' OR ');
    const rows = await readSqliteRows(
      root,
      'select kind, ref as path, -bm25(fts) as score from fts where fts match ? order by score desc, path asc',
      [matchExpr],
    );
    if (rows.length > 0) {
      return rows.map((row) => ({ kind: row.kind, path: row.path, score: Number(row.score) || 0 }));
    }
  }
  const ftsRows = opts.fts ?? await readFts(root, { backend });
  return scoreFtsBm25(ftsRows, task);
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
    const words = `${row.kind ?? ''} ${path} ${row.body ?? ''}`
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean);
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
  return out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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

function git(root, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  const stdout = await git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], `${unique.join('\n')}\n`);
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    sizes.set(line.slice(0, sp), Number(line.slice(sp + 1)));
  }
  return sizes;
}
