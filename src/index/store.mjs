// The local index (ADR-089).
//
// `node:sqlite` when this Node has it, including FTS5, and a JSON-lines file
// otherwise. Either one is a cache: `git ls-files -s` can rebuild it, so a missing
// file is not a lost database. A blob that has not changed is not read again.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readManifest } from '../projection/manifest.mjs';
import { extract, resolveImports } from './extract.mjs';
import {
  JSONL_FILE,
  SCHEMA_V,
  SQLITE_FILE,
  countSqlite,
  readJsonl,
  readSchema,
  readSqliteRows,
  writeJsonl,
  writeSqlite,
} from './persist.mjs';

export { JSONL_FILE, SQLITE_FILE };

const MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', kt: 'kotlin', kts: 'kotlin', java: 'java',
  py: 'python', go: 'go', rs: 'rust', swift: 'swift', dart: 'dart', rb: 'ruby', cs: 'csharp',
};

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
    const names = [...new Set(pulled.symbols.map((row) => row.name))].sort();
    if (names.length > 0) fts.push({ kind: 'code', ref: entry.path, body: names.join(' ') });
  }
  const removed = previous.filter((row) => !paths.has(row.path)).map((row) => row.path);
  let stored;
  if (backend === 'sqlite') {
    await writeSqlite(root, next, removed, symbols, edges, fts);
    stored = await countSqlite(root);
  } else {
    stored = await writeJsonl(root, previous, next, removed, symbols, edges, fts, force);
  }
  return {
    backend,
    files: listed.length,
    updated: next.length,
    removed: removed.length,
    symbols: stored.symbols,
    edges: stored.edges,
    parsers: adapter.state,
    ms: Date.now() - started,
  };
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

function git(root, args, input, binary = false) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: root, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
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

async function blobTexts(root, blobs) {
  const unique = [...new Set(blobs)];
  const texts = new Map();
  if (unique.length === 0) return texts;
  const stdout = await git(root, ['cat-file', '--batch'], `${unique.join('\n')}\n`, true);
  let offset = 0;
  while (offset < stdout.length) {
    const nl = stdout.indexOf(0x0a, offset);
    if (nl < 0) break;
    const header = stdout.toString('utf8', offset, nl);
    const parts = header.split(' ');
    const size = Number(parts[2]);
    if (parts[1] !== 'blob' || !Number.isFinite(size)) {
      offset = nl + 1;
      continue;
    }
    const start = nl + 1;
    const body = stdout.subarray(start, start + size);
    offset = start + size + 1;
    texts.set(parts[0], body.includes(0) ? null : body.toString('utf8'));
  }
  return texts;
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
