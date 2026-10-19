// `simt map` ranks the files a task is most likely to touch (R22, ADR-091).
// The cache is read, and rebuilt once when it is empty, because a map of no
// files is not an answer. The rebuild writes the gitignored index, which is
// the same cache `simt index` writes.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { readEdges, readEmbeddings, readFiles, readFts, readSymbols, reindex, searchFtsBm25 } from '../index/store.mjs';
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
 * The files, symbols, edges, FTS rows and stored vector embeddings the index holds,
 * building the index once when it is empty.
 *
 * `build: false` refuses that rebuild and answers with `cold: true` instead. The one
 * caller that passes it is the prompt-submit hook (R29), and the reason is the bar that
 * hook has to meet: a delivered packet that built an index would make a person's first
 * prompt in a fresh clone wait on a walk of the whole repository, and a prompt that takes
 * a minute to appear is how a hook gets uninstalled. The next prompt gets the packet, and
 * a command a person typed at a terminal always builds what it needs.
 */
export async function loadGraph(root, { build = true } = {}) {
  let files = await readFiles(root);
  if (files.length === 0) {
    if (!build) return { files: [], symbols: [], edges: [], fts: [], embeddings: [], cold: true };
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
    files = await readFiles(root);
  }
  const [symbols, edges, fts, embeddings] = await Promise.all([
    readSymbols(root),
    readEdges(root),
    readFts(root),
    readEmbeddings(root),
  ]);
  return { files, symbols, edges, fts, embeddings };
}
