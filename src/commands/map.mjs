// `simt map` ranks the files a task is most likely to touch (ADR-091).
// The cache is refreshed from the git index on every read: `reindex` skips unchanged
// blobs, so a current repository pays for one `git ls-files -s`, not a walk of the
// tree. A map of stale files is a wrong answer, and the commands that read with
// `build` on are ones a person typed at a terminal, where a few hundred
// milliseconds is not a bar to meet.

import { EXIT, emit, emitJson, fail, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { indexFreshness } from '../index/freshness.mjs';
import { readEmbeddings, readFts, readGraph, reindex, searchFtsBm25 } from '../index/store.mjs';
import {
  DEFAULT_BUDGET,
  formatRecall,
  measureRecall,
  rankFiles,
  renderMap,
} from '../index/map.mjs';
import { embedTaskQuery } from '../index/vectors.mjs';
import { commandRoot } from '../repo-root.mjs';

const LEVELS = new Set(['outline', 'names', 'signatures']);

export async function mapCommand(args, flags) {
  if (args.length > 0) return fail(`unknown map argument ${args[0]}`, EXIT.USAGE, `run: ${CLI} map`);
  const root = commandRoot(flags);
  if (flags.recall === true) return recall(root, flags);
  const level = flags.level ?? 'outline';
  if (!LEVELS.has(level)) {
    return fail(`unknown level ${level}`, EXIT.USAGE, 'use outline, names or signatures');
  }
  const budget = flags.budget === undefined ? DEFAULT_BUDGET : Number(flags.budget);
  if (!Number.isInteger(budget) || budget < 0) {
    return fail(`budget must be a non-negative integer`, EXIT.USAGE, `run: ${CLI} map --budget 2048`);
  }
  const task = typeof flags.task === 'string' ? flags.task : '';
  const loaded = await loadGraph(root, { task, embed: flags.embed === true });
  if (loaded.error) return loaded.error;
  const bm25 = task.trim().length > 0 ? await searchFtsBm25(root, task, { fts: loaded.fts }) : [];
  const queryVector =
    flags.embed === true && loaded.embeddings.length > 0
      ? await embedTaskQuery(root, task, {
          embed: true,
          allowRemote: flags.allowRemote === true,
        })
      : null;
  const ranked = rankFiles({ ...loaded, bm25, queryVector, task });
  const rendered = renderMap(ranked, loaded.symbols, { level, budget });
  // What the ranking is an answer to. `unmatched` says no path or symbol mentioned the
  // task; the list can then be the graph hub or BM25 body hits, both context rather than
  // a match. Reading a fused score as a hit is how `map --task zebracorn` looked useful,
  // because that score is positive for a body hit and for every graph neighbour. The
  // match is the resolver score the brief filters on.
  const matched = ranked.filter((row) => row.resolver > 0).length;
  const basis = task.trim().length === 0 ? 'no-task' : matched > 0 ? 'matched' : 'unmatched';
  const payload = {
    ok: true,
    command: 'map',
    root,
    level,
    budget,
    matched,
    basis,
    freshness: loaded.freshness?.state ?? 'unknown',
    shown: rendered.shown,
    total: rendered.total,
    truncated: rendered.truncated,
    files: rendered.files,
    text: rendered.text,
  };
  if (isJson(flags)) {
    emitJson(payload);
    return EXIT.OK;
  }
  const lines = [
    `level    ${level}`,
    `basis    ${basis}${basis === 'unmatched' ? ' (no path or symbol mentions this task; the ranking is context, not a match)' : ''}`,
    `shown    ${rendered.shown}`,
    `total    ${rendered.total}`,
    `budget   ${budget}`,
  ];
  if (loaded.freshness && loaded.freshness.state !== 'current') {
    lines.push(`freshness ${loaded.freshness.state}${loaded.freshness.reason ? ` - ${loaded.freshness.reason}` : ''}`);
  }
  if (rendered.text) lines.push(rendered.text);
  emit(lines.join('\n'));
  return EXIT.OK;
}

async function recall(root, flags) {
  let result;
  try {
    result = await measureRecall(root, {
      embed: flags.embed === true,
      allowRemote: flags.allowRemote === true,
    });
  } catch (error) {
    return fail(`could not measure recall (${error.message})`, EXIT.UNSUPPORTED, `run ${CLI} index in a git repository`);
  }
  const payload = { ok: true, command: 'map', root, recall: result };
  present(payload, () => formatRecall(result), flags);
  return EXIT.OK;
}

/**
 * The files, symbols, edges, FTS rows and stored vector embeddings the index holds.
 *
 * With `build` (the default) the index is refreshed from the git index before it is
 * read. The refresh is incremental — a blob that has not changed is not re-read — so
 * the cost of a current repository is one `git ls-files -s`, not a walk of the tree.
 * The callers that build are commands a person typed: `map`, `brief`, `slice`.
 *
 * `build: false` refuses the refresh and answers with `cold: true` when the index is
 * empty. The callers that pass it are the prompt-submit hook  and the MCP
 * surface: a delivered packet that walked the whole repository would make a person's
 * first prompt in a fresh clone wait, and a prompt that takes a minute to appear is
 * how a hook gets uninstalled. The next prompt gets the packet, and a command a
 * person typed at a terminal always builds what it needs.
 *
 * FTS bodies and stored vectors load only when the caller names them
 *: BM25 runs in SQLite, so the graph read pays for files, symbols and edges
 * and nothing more.
 */
export async function loadGraph(root, { build = true, task = '', embed = false } = {}) {
  if (build) {
    try {
      await reindex(root);
    } catch (error) {
      return {
        error: fail(
          `could not map this repository (${error.message})`,
          EXIT.UNSUPPORTED,
          'run this inside a git repository',
        ),
      };
    }
  }
  const wantFts = String(task ?? '').trim().length > 0;
  // One read transaction for the graph: three opens could span a concurrent build.
  const graph = await readGraph(root);
  const [fts, embeddings] = await Promise.all([
    wantFts ? readFts(root) : Promise.resolve([]),
    embed === true ? readEmbeddings(root) : Promise.resolve([]),
  ]);
  const { files, symbols, edges } = graph;
  // A present index that cannot be read is named, not served as empty
  //: `cold` is "nothing here", `broken` is "something is
  // here and the read failed".
  const broken = !build && Boolean(files.error);
  if (!build && files.length === 0) {
    return { files: [], symbols: [], edges: [], fts: [], embeddings: [], cold: true, broken, stale: false, freshness: { state: 'cold' } };
  }
  // A caller that may not build still learns the index is old or unreadable
  //: the digest compare costs one `git ls-files -s`, and the freshness
  // signal is what lets a UI distrust the packet instead of quoting it.
  const freshness = build ? { state: 'current' } : await indexFreshness(root);
  return { files, symbols, edges, fts, embeddings, stale: freshness.state === 'stale', broken, freshness };
}
