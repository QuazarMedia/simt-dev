// `simt map` ranks the files a task is most likely to touch (R22, ADR-091).
// The cache is refreshed from the git index on every read: `reindex` skips unchanged
// blobs, so a current repository pays for one `git ls-files -s`, not a walk of the
// tree. A map of stale files is a wrong answer, and the commands that read with
// `build` on are ones a person typed at a terminal, where a few hundred
// milliseconds is not a bar to meet.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { isIndexStale, readEdges, readEmbeddings, readFiles, readFts, readSymbols, reindex, searchFtsBm25 } from '../index/store.mjs';
import {
  DEFAULT_BUDGET,
  embedTaskQuery,
  formatRecall,
  measureRecall,
  rankFiles,
  renderMap,
} from '../index/map.mjs';

const LEVELS = new Set(['outline', 'names', 'signatures']);

export async function mapCommand(args, flags) {
  if (args.length > 0) return fail(`unknown map argument ${args[0]}`, EXIT.USAGE, `run: ${CLI} map`);
  const root = flags.root ?? process.cwd();
  if (flags.recall === true) return recall(root, flags);
  const level = flags.level ?? 'outline';
  if (!LEVELS.has(level)) {
    return fail(`unknown level ${level}`, EXIT.USAGE, 'use outline, names or signatures');
  }
  const budget = flags.budget === undefined ? DEFAULT_BUDGET : Number(flags.budget);
  if (!Number.isInteger(budget) || budget < 0) {
    return fail(`budget must be a non-negative integer`, EXIT.USAGE, `run: ${CLI} map --budget 2048`);
  }
  const loaded = await loadGraph(root);
  if (loaded.error) return loaded.error;
  const task = typeof flags.task === 'string' ? flags.task : '';
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
  const payload = {
    ok: true,
    command: 'map',
    root,
    level,
    budget,
    shown: rendered.shown,
    total: rendered.total,
    truncated: rendered.truncated,
    files: rendered.files,
    text: rendered.text,
  };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const lines = [
    `level    ${level}`,
    `shown    ${rendered.shown}`,
    `total    ${rendered.total}`,
    `budget   ${budget}`,
  ];
  if (rendered.text) lines.push(rendered.text);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
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
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  emit(formatRecall(result), { maxBytes: flags.maxBytes ?? 0 });
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
 * empty. The callers that pass it are the prompt-submit hook (R29) and the MCP
 * surface: a delivered packet that walked the whole repository would make a person's
 * first prompt in a fresh clone wait, and a prompt that takes a minute to appear is
 * how a hook gets uninstalled. The next prompt gets the packet, and a command a
 * person typed at a terminal always builds what it needs.
 */
export async function loadGraph(root, { build = true } = {}) {
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
  const [files, symbols, edges, fts, embeddings] = await Promise.all([
    readFiles(root),
    readSymbols(root),
    readEdges(root),
    readFts(root),
    readEmbeddings(root),
  ]);
  // A present index that cannot be read is named, not served as empty
  // (review 0003 Q44): `cold` is "nothing here", `broken` is "something is
  // here and the read failed".
  const broken = !build && Boolean(files.error);
  if (!build && files.length === 0) {
    return { files: [], symbols: [], edges: [], fts: [], embeddings: [], cold: true, broken, stale: false };
  }
  // A caller that may not build still learns the index is old (review 0003
  // Q42): the digest compare costs one `git ls-files -s`, and the freshness
  // signal is what lets a UI distrust the packet instead of quoting it.
  const stale = !build && files.length > 0 && (await isIndexStale(root));
  return { files, symbols, edges, fts, embeddings, stale, broken };
}
