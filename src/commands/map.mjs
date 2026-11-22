// `simt map` ranks the files a task is most likely to touch (ADR-091).
// The staged cache is combined with working-tree edits for the current answer.

import { EXIT, emit, emitJson, fail, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { loadLiveGraph } from '../index/live.mjs';
import { searchFtsBm25 } from '../index/store.mjs';
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
  const retrieval = flags.retrieval ?? (flags.explain === true ? 'v2' : 'v1');
  if (retrieval !== 'v1' && retrieval !== 'v2') {
    return fail(`unknown retrieval version ${retrieval}`, EXIT.USAGE, 'use --retrieval v1 or v2');
  }
  const experimental = retrieval === 'v2';
  const searching = task.trim().length > 0;
  let loaded;
  try {
    loaded = await loadLiveGraph(root, {
      text: !experimental && searching,
      fielded: experimental && searching,
      binding: experimental && searching,
      cochange: experimental && searching,
      embed: flags.embed === true,
    });
    if (loaded.broken) throw new Error(loaded.indexError?.message ?? 'the index cannot be read');
  } catch (error) {
    return fail(`could not map this repository (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a git repository');
  }
  const bm25 = !experimental && searching ? await searchFtsBm25(root, task, { fts: loaded.fts }) : [];
  const queryVector =
    flags.embed === true && loaded.embeddings.length > 0
      ? await embedTaskQuery(root, task, {
          embed: true,
          allowRemote: flags.allowRemote === true,
        })
      : null;
  const result = experimental
    ? await (await import('../index/map-v2.mjs')).rankMapV2(root, loaded, task, { explain: flags.explain === true, queryVector })
    : null;
  const ranked = result?.ranked ?? rankFiles({ ...loaded, bm25, queryVector, task });
  const rendered = renderMap(ranked, loaded.symbols, { level, budget });
  // What the ranking is an answer to. `unmatched` says no path or symbol mentioned the
  // task; the list can then be the graph hub or BM25 body hits, both context rather than
  // a match. Reading a fused score as a hit is how `map --task zebracorn` looked useful,
  // because that score is positive for a body hit and for every graph neighbour. The
  // match is the resolver score the brief filters on.
  const matched = result?.matched ?? ranked.filter((row) => row.resolver > 0).length;
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
    ...(loaded.basis.overlay.applied ? { provenance: loaded.basis } : {}),
    shown: rendered.shown,
    total: rendered.total,
    truncated: rendered.truncated,
    files: rendered.files,
    text: rendered.text,
    ...(experimental ? { retrieval } : {}),
    ...(result && flags.explain === true ? { evidence: result.evidence, feedback: result.feedback } : {}),
  };
  if (isJson(flags)) {
    emitJson(payload);
    return EXIT.OK;
  }
  const lines = [
    `level    ${level}`,
    `basis    ${basis}${basis === 'unmatched' ? " (no path or symbol matches this task's words; the ranking is context, not a match)" : ''}`,
    `shown    ${rendered.shown}`,
    `total    ${rendered.total}`,
    `budget   ${budget}`,
  ];
  if (loaded.freshness && loaded.freshness.state !== 'current') {
    lines.push(`freshness ${loaded.freshness.state}${loaded.freshness.reason ? ` - ${loaded.freshness.reason}` : ''}`);
  }
  if (rendered.text) lines.push(rendered.text);
  if (payload.evidence) {
    for (const row of payload.evidence) {
      const channels = Object.entries(row.channels).map(([name, channel]) => {
        const path = channel.witness?.steps.map(({ kind, dst }) => `${kind} ${dst}`).join(' → ');
        const fields = channel.matchedFields?.join(', ');
        const matches = channel.matches?.map(({ matched }) => matched).join(', ');
        return `${name} #${channel.rank} (${channel.score.toFixed(4)})${path ? ` [${channel.witness.seed} → ${path}]` : ''}${fields ? ` [${fields}]` : ''}${matches ? ` [${matches}]` : ''}`;
      });
      lines.push(`evidence  ${row.path}  ${channels.join('  ')}`);
    }
    const expansion = payload.feedback?.expansion ?? [];
    if (expansion.length) lines.push(`feedback  ${expansion.map(({ term, sources }) => `${term} (${sources.join(', ')})`).join(', ')}`);
  }
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
