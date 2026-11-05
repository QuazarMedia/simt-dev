// The index as a handle.
//
// `openIndex` returns a handle whose methods answer with pure data — rows and
// counts, no exit codes, no formatted lines — and with a structured error,
// `{ ok: false, error: { code, message } }`, when they cannot. The methods are
// thin over the same primitives the commands use, so a handle and a command
// cannot disagree about the same index.
//
// The graph loads once at open: files, symbols, edges. FTS bodies run in
// SQLite (`search` delegates to `searchFtsBm25`) and stored vectors are not
// loaded at all: a map without `--embed` does not touch them .

import { coverage } from './coverage.mjs';
import { governs } from './govern.mjs';
import { dependents } from './impact.mjs';
import { rankFiles } from './map.mjs';
import { isIndexStale, readEdges, readFiles, readSymbols, reindex, searchFtsBm25 } from './store.mjs';

const INDEX_CODES = {
  BUILD: 'E_BUILD',
  CLOSED: 'E_CLOSED',
  NO_INDEX: 'E_NO_INDEX',
  READ: 'E_READ',
};

function ok(data) {
  return { ok: true, data };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * The files, symbols and edges the index holds. The lazy projection of
 * `loadGraph`: no FTS bodies, no vectors, because nothing on this handle
 * scores them.
 */
async function loadGraphData(root) {
  const [files, symbols, edges] = await Promise.all([
    readFiles(root),
    readSymbols(root),
    readEdges(root),
  ]);
  return { files, symbols, edges };
}

/**
 * Open the repository's index.
 *
 * @param {string} root
 * @param {{build?: boolean, refresh?: boolean}} [options]
 *   `build` (default true) refreshes the index from the git index before the
 *   first read — incrementally, so a current repository pays for one
 *   `git ls-files -s`, not a walk of the tree. `refresh` re-reads the graph on
 *   every call instead of caching it at open.
 * @returns {Promise<IndexHandle | {ok: false, error: {code: string, message: string}}>}
 */
export async function openIndex(root, { build = true, refresh = false } = {}) {
  if (build) {
    try {
      await reindex(root);
    } catch (error) {
      return fail(INDEX_CODES.BUILD, `could not build the index (${error.message})`);
    }
  }

  let closed = false;
  let cached = null;

  async function graph() {
    if (closed) throw new Error(INDEX_CODES.CLOSED);
    if (cached === null || refresh) cached = await loadGraphData(root);
    return cached;
  }

  async function answered(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error.message === INDEX_CODES.CLOSED) return fail(INDEX_CODES.CLOSED, 'the index is closed');
      return fail(INDEX_CODES.READ, error.message);
    }
  }

  const handle = {
    ok: true,

    /** Freshness and row counts of the open index. */
    status: () =>
      answered(async () => {
        const g = await graph();
        if (g.files.length === 0) return fail(INDEX_CODES.NO_INDEX, 'the index is empty');
        const stale = await isIndexStale(root);
        return ok({ stale, counts: { files: g.files.length, symbols: g.symbols.length, edges: g.edges.length } });
      }),

    /**
     * BM25 rows for a task string, best first.
     * @param {string} task
     * @param {{limit?: number}} [options]
     * @returns {Promise<{ok: true, data: {path: string, kind: string, score: number}[]}|{ok: false, error: {code: string, message: string}}>}
     */
    search: (task, { limit } = {}) =>
      answered(async () => {
        if (closed) throw new Error(INDEX_CODES.CLOSED);
        const rows = await searchFtsBm25(root, task);
        if (rows.error) return fail(INDEX_CODES.READ, rows.error?.message ?? String(rows.error));
        return ok(limit === undefined ? rows : rows.slice(0, limit));
      }),

    /**
     * Rank the repository's files for a task string : graph proximity
     * fused with the BM25 rows.
     * @param {string} task
     * @param {{limit?: number, embed?: boolean, allowRemote?: boolean}} [options]
     * @returns {Promise<{ok: true, data: {path: string, rank: number, score: number}[]}|{ok: false, error: {code: string, message: string}}>}
     */
    rank: (task, { limit, embed = false, allowRemote = false } = {}) =>
      answered(async () => {
        const g = await graph();
        if (g.files.length === 0) return fail(INDEX_CODES.NO_INDEX, 'the index is empty');
        const bm25 = String(task ?? '').trim().length > 0 ? await searchFtsBm25(root, task) : [];
        if (bm25.error) return fail(INDEX_CODES.READ, bm25.error?.message ?? String(bm25.error));
        const ranked = rankFiles({ ...g, bm25, task });
        return ok(limit === undefined ? ranked : ranked.slice(0, limit));
      }),

    /**
     * The tests that exercise `paths` : the import closure when
     * `transitive` (default true), the stored test edges otherwise.
     * @param {Iterable<string>} paths
     * @param {{transitive?: boolean, cochange?: boolean}} [options]
     * @returns {Promise<{ok: true, data: string[]}|{ok: false, error: {code: string, message: string}}>}
     */
    coverage: (paths, options) =>
      answered(async () => {
        const g = await graph();
        return ok(coverage({ files: g.files, imports: g.edges }, paths, options));
      }),

    /**
     * Who a change to `file` reaches : the reverse import closure and
     * the tests that import it.
     * @param {string} file
     * @param {{limit?: number}} [options]
     * @returns {Promise<{ok: true, data: {importers: string[], tests: string[], truncated: boolean}}|{ok: false, error: {code: string, message: string}}>}
     */
    impact: (file, { limit } = {}) =>
      answered(async () => {
        const g = await graph();
        return ok(dependents(file, g.edges, limit));
      }),

    /**
     * What governs `file` : the records in `corpus` whose Affects line
     * names it, plus the rules, skills, gates and lessons whose path lists
     * match.
     * @param {string} file
     * @param {{records?: {id: string, title: string, text: string}[], ctx?: {files: Set<string>, commands: Set<string>, roots: string[]}}} [corpus]
     * @returns {Promise<{ok: true, data: {kind: string, id: string, detail?: string}[]}|{ok: false, error: {code: string, message: string}}>}
     */
    governs: (file, corpus) => answered(() => ok(governs(file, corpus ?? {}))),

    /** Release the handle. Calls after it answer `E_CLOSED`. */
    close() {
      closed = true;
      cached = null;
    },
  };

  return handle;
}
