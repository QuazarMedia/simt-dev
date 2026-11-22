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
import { indexFreshness, readBasis } from './freshness.mjs';
import { readGraph, reindex, searchFtsBm25 } from './store.mjs';

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
 * The files, symbols and edges the index holds, from one build.
 *
 * The lazy projection of `loadGraph`: no FTS bodies, no vectors, because
 * nothing on this handle scores them - and one read transaction, because three
 * opens could answer from two builds.
 */
async function loadGraphData(root) {
  return readGraph(root);
}

/**
 * Attach the provenance without changing the value a caller already iterates.
 *
 * Non-enumerable on purpose: `Array.isArray` still holds, a JSON payload of the
 * rows is unchanged, and `result.data.basis` answers "which build was this".
 */
function withBasis(value, basis) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'basis')) return value;
  Object.defineProperty(value, 'basis', { value: basis, enumerable: false, configurable: true });
  return value;
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
  let cachedBasis = null;

  async function basis() {
    if (cachedBasis === null) cachedBasis = await readBasis(root);
    return cachedBasis;
  }

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

    /** What the index was built from: build, tree, inputs, resolution, overlay and row basis. */
    basis: () => answered(async () => ok(await basis())),

    /** Freshness and row counts of the open index. */
    status: () =>
      answered(async () => {
        const g = await graph();
        // A read failure is named before an emptiness is reported: a locked or
        // corrupt index used to answer "the index is empty", which is a fact
        // about a different index.
        if (g.files.error) {
          const code = typeof g.files.error.code === 'string' ? g.files.error.code : INDEX_CODES.READ;
          return fail(code, g.files.error.message ?? String(g.files.error));
        }
        if (g.files.length === 0) return fail(INDEX_CODES.NO_INDEX, 'the index is empty');
        const freshness = await indexFreshness(root);
        return ok({
          stale: freshness.state === 'stale',
          freshness,
          counts: { files: g.files.length, symbols: g.symbols.length, edges: g.edges.length },
          basis: await basis(),
          bindingCoverage: g.bindingCoverage,
        });
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
        if (rows.error) {
          const code = typeof rows.error.code === 'string' ? rows.error.code : INDEX_CODES.READ;
          return fail(code, rows.error.message ?? String(rows.error));
        }
        const answer = limit === undefined ? rows : rows.slice(0, limit);
        return ok(withBasis(answer, await basis()));
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
        if (bm25.error) {
          const code = typeof bm25.error.code === 'string' ? bm25.error.code : INDEX_CODES.READ;
          return fail(code, bm25.error.message ?? String(bm25.error));
        }
        const ranked = rankFiles({ ...g, bm25, task });
        // `resolver` is rankFiles' task-word score for internal filtering; this answer's
        // shape is `path`/`rank`/`score`, and a fourth field would be public API nobody
        // documented. The fused `score` stays what a caller reads as relevance.
        const answer = (limit === undefined ? ranked : ranked.slice(0, limit)).map(({ path, rank, score }) => ({ path, rank, score }));
        return ok(withBasis(answer, await basis()));
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
        return ok(withBasis(coverage({ files: g.files, imports: g.edges }, paths, options), await basis()));
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
        return ok(withBasis(dependents(file, g.edges, limit), await basis()));
      }),

    /**
     * What governs `file` : the records in `corpus` whose Affects line
     * names it, plus the rules, skills, gates and lessons whose path lists
     * match.
     * @param {string} file
     * @param {{records?: {id: string, title: string, text: string}[], ctx?: {files: Set<string>, commands: Set<string>, roots: string[]}}} [corpus]
     * @returns {Promise<{ok: true, data: {kind: string, id: string, detail?: string}[]}|{ok: false, error: {code: string, message: string}}>}
     */
    governs: (file, corpus) =>
      answered(async () => ok(withBasis(governs(file, corpus ?? {}), await basis()))),

    /** Release the handle. Calls after it answer `E_CLOSED`. */
    close() {
      closed = true;
      cached = null;
    },
  };

  return handle;
}
