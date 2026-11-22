// Ranked repo map and hybrid retrieval (ADR-091).
//
// PageRank over import and call edges, personalised to the task, fused with
// FTS5 BM25 (`bm25()`) and resolver signals via reciprocal-rank fusion (RRF).
// Optional local vector embeddings (stored as SQLite blobs via) are scored
// by brute-force cosine similarity and stay off by default unless they raise
// gold-file recall@10 by at least 10 percentage points (+0.10).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isTestPath } from '../testing/paths.mjs';
import { resolveVaultDir } from '../testing/vault.mjs';
import { embedTaskQuery, rankByCosine } from './vectors.mjs';
import {
  readEdges,
  readEmbeddings,
  readFiles,
  readFts,
  readSymbols,
  scoreFtsBm25,
  searchFtsBm25,
} from './store.mjs';
import { cmp } from '../util/sort.mjs';
import { INDEX_STOP as STOP } from '../text/tokens.mjs';
import { gitText } from '../sys/git.mjs';

export const ITERATIONS = 20;
export const DAMPING = 0.85;
export const RRF_K = 40;
export const EMBED_RECALL_GAIN_BAR = 0.1;

/**
 * What turns embeddings on, and what the bar decides.
 *
 * The accept bar reads "embeddings stay off by default unless they raise recall@10 by at
 * least 10 points". That is a release gate: it was applied when the shipped default was
 * chosen (off, because no measurement has cleared it), and `measureRecall` reports whether
 * a later measurement would justify changing it.
 *
 * It is not a runtime switch, and it does not gate `--embed`: the measurement reads mined
 * tasks and gold patches from a vault outside the worktree, so a verdict kept as state would
 * rank the same tree differently on the machine that measured it and in CI. ADR-131 ruling 2
 * also keeps the vector path out of every run that did not name it, and a default that
 * flipped on an accepted arm would send a query embedding on every prompt submit — a model
 * call no run asked for. `--embed` stays the switch, and the report says both (ADR-224).
 */
export const EMBEDDINGS_SWITCH = '--embed';
export const EMBEDDINGS_DEFAULT = 'off';
/** The bar, spelled once, for the verdict and its explanation. */
export const EMBED_RECALL_GAIN_LABEL = `+${Math.round(EMBED_RECALL_GAIN_BAR * 100)}-point`;
export const EMBEDDINGS_DEFAULT_REASON = `off — ${EMBEDDINGS_SWITCH} is the only switch, and the bar gates opting in, never the default (ADR-131 ruling 2, ADR-224)`;
const TOP = 10;
export const DEFAULT_BUDGET = 2048;

/**
 * Reciprocal-rank fusion (RRF) over multiple ranked lists.
 *
 * Each list entry may be a path string or `{ path }`. Ties break by path ascending
 * so fusion is strictly deterministic.
 *
 * @param {{items: ({path: string}|string)[], weight?: number}[]} lists
 * @param {number} [k]
 * @returns {{path: string, rank: number}[]}
 */
export function rrfFuse(lists, k = RRF_K) {
  const fused = new Map();
  const bestScore = new Map();
  for (const { items = [], weight = 1 } of lists) {
    if (!Array.isArray(items) || weight <= 0) continue;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i];
      const path = typeof entry === 'string' ? entry : entry?.path;
      if (!path) continue;
      fused.set(path, (fused.get(path) ?? 0) + weight / (k + i + 1));
      if (typeof entry === 'object' && typeof entry?.score === 'number') {
        bestScore.set(path, Math.max(bestScore.get(path) ?? 0, entry.score));
      }
    }
  }
  return [...fused.entries()]
    .map(([path, rank]) => ({ path, rank, score: bestScore.get(path) ?? 0 }))
    .sort((a, b) => (a.rank !== b.rank ? (a.rank < b.rank ? 1 : -1) : cmp(a.path, b.path)));
}

/**
 * Rank files for one task. No task text ranks the whole graph. A task ranks the
 * files it mentions and the files one import or call away from those, and when
 * FTS / BM25 rows or optional vector embeddings are supplied, fuses BM25 +
 * graph proximity + resolver signals via reciprocal-rank fusion .
 *
 * @param {{
 *   files: {path: string}[],
 *   edges: {src: string, dst: string, kind: string, weight?: number}[],
 *   symbols: {path: string, name: string}[],
 *   fts?: {kind?: string, ref?: string, path?: string, body?: string}[],
 *   bm25?: {path: string, score?: number}[],
 *   embeddings?: {path: string, vec: Float32Array|number[]|Buffer}[],
 *   queryVector?: Float32Array|number[]|Buffer|null,
 *   task?: string
 * }} input
 * @returns {{path: string, rank: number, score: number}[]}
 */
export function rankFiles({
  files,
  edges,
  symbols,
  fts = undefined,
  bm25 = undefined,
  embeddings = undefined,
  queryVector = null,
  task = '',
}) {
  const nodes = [...new Set(files.map((file) => file.path))].sort();
  const symbolsByPath = groupSymbols(symbols);
  const scores = scoreFiles(nodes, symbolsByPath, task);
  const kept = closure(nodes, edges, scores);
  const index = new Map(kept.map((path, i) => [path, i]));
  const links = buildLinks(kept, edges, index);
  const rank = pageRank(kept, links, scores);
  // A file the task mentions stays ahead of a file it does not. PageRank on
  // this graph otherwise returns the file every module imports, and the files
  // the task named never reach the top 10.
  const baseRanked = kept
    .map((path, i) => ({ path, rank: rank[i], score: scores.get(path) ?? 0, resolver: scores.get(path) ?? 0 }))
    .sort(byRank);

  if (String(task ?? '').trim().length === 0) return baseRanked;

  const knownPaths = new Set(nodes);
  const rawBm25 = Array.isArray(bm25)
    ? bm25
    : Array.isArray(fts) && fts.length > 0
      ? scoreFtsBm25(fts, task)
      : [];
  const bm25Ranked = rawBm25
    .filter((row) => knownPaths.has(row.path) && !isTestPath(row.path))
    .slice(0, 30);

  const embedRanked =
    queryVector && Array.isArray(embeddings) && embeddings.length > 0
      ? rankByCosine(embeddings, queryVector)
          .filter((row) => knownPaths.has(row.path) && !isTestPath(row.path))
          .slice(0, 30)
      : [];

  if (bm25Ranked.length === 0 && embedRanked.length === 0) {
    return baseRanked;
  }

  const resolverRanked = baseRanked.filter((row) => (row.score ?? 0) > 0);
  const graphRanked = [...baseRanked].sort((a, b) => (a.rank !== b.rank ? (a.rank < b.rank ? 1 : -1) : cmp(a.path, b.path)));
  const lists = [
    { items: resolverRanked, weight: 2.0 },
    { items: graphRanked, weight: 1.0 },
    { items: bm25Ranked, weight: 1.0 },
  ];
  if (embedRanked.length > 0) {
    lists.push({ items: embedRanked, weight: 1.5 });
  }
  // Carry the resolver score beside the fused rank. A caller that wants "the files this
  // task actually names" cannot read that off the fused number - every graph neighbour
  // has one - and treating each fused row as a match listed the hub as task files.
  return rrfFuse(lists, RRF_K).map((row) => ({ ...row, resolver: scores.get(row.path) ?? 0 }));
}

/**
 * Render the ranking within a byte budget.
 * `outline` is paths, `names` adds exported symbols, `signatures` adds the line.
 * A budget of 0 does not truncate. The first file is kept even when it alone
 * exceeds the budget, so the map is never empty while the ranking is not.
 *
 * @param {{path: string, rank: number}[]} ranked
 * @param {{path: string, name: string, sig?: string, exported?: number|boolean}[]} symbols
 * @param {{level?: string, budget?: number}} [opts]
 */
export function renderMap(ranked, symbols, { level = 'outline', budget = DEFAULT_BUDGET } = {}) {
  const byPath = groupSymbols(symbols);
  const blocks = [];
  let used = 0;
  for (const row of ranked) {
    const block = renderEntry(row.path, byPath.get(row.path) ?? [], level);
    const gap = blocks.length === 0 ? 0 : 1;
    const bytes = Buffer.byteLength(block);
    if (blocks.length > 0 && budget > 0 && used + gap + bytes > budget) break;
    blocks.push(block);
    used += gap + bytes;
    if (budget > 0 && used >= budget) break;
  }
  return {
    text: blocks.join('\n'),
    shown: blocks.length,
    total: ranked.length,
    truncated: blocks.length < ranked.length,
    files: ranked.slice(0, blocks.length).map((row) => ({ path: row.path, rank: round6(row.rank) })),
  };
}

/** Fraction of gold paths that sit in the top 10. Null when there is nothing to recall. */
export function recallAt10(ranked, gold) {
  const relevant = [...new Set(gold)];
  if (relevant.length === 0) return null;
  const top = new Set(ranked.slice(0, TOP).map((row) => row.path));
  let hit = 0;
  for (const path of relevant) if (top.has(path)) hit += 1;
  return hit / relevant.length;
}

/** Paths a unified diff changes. The destination side is the file after the patch. */
export function goldPaths(patch) {
  const out = [];
  for (const line of String(patch).split('\n')) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match || match[2] === '/dev/null') continue;
    out.push(match[2]);
  }
  return [...new Set(out)].sort();
}

/**
 * Mean recall@10 over mined tasks whose gold patch is in the vault.
 * A missing vault is unmeasured, not a zero: the absence of a hidden patch is
 * not evidence the map missed the file (ADR-076).
 *
 * When `embed: true` (or stored embeddings are provided), also evaluates recall@10
 * with embeddings fused in and reports the acceptance gate: embeddings stay off by
 * default unless they raise gold-file recall@10 by at least 10 percentage points
 * (`EMBED_RECALL_GAIN_BAR = 0.1`). `recall` stays the default ranking's figure; the
 * arm's is in `embedRecall` (ADR-224).
 *
 * @param {string} root
 * @param {{
 *   vaultRoot?: string,
 *   embed?: boolean,
 *   allowRemote?: boolean,
 *   fetchImpl?: typeof fetch,
 *   embeddings?: {path: string, vec: Float32Array|number[]|Buffer}[],
 *   taskVectors?: Record<string, Float32Array|number[]>|Map<string, Float32Array|number[]>
 * }} [opts]
 */
export async function measureRecall(root, opts = {}) {
  // A figure without the tree it measured is read as a statement about the code, not
  // about the checkout it ran in (ADR-225 ruling 2). Read the commit, the file count and
  // the worktree state together with the rows so every answer, measured or not, can name
  // them; a commit and a count are identical before and after an uncommitted edit.
  const [commit, dirty, files] = await Promise.all([
    gitText(root, ['rev-parse', 'HEAD']).then((out) => out?.trim() || null).catch(() => null),
    gitText(root, ['status', '--porcelain=v1', '--untracked-files=normal'], { allowFailure: true })
      .then((out) => (out === null ? null : out.length > 0))
      .catch(() => null),
    readFiles(root, opts),
  ]);
  const tree = { commit, files: files.length, dirty };
  const tasksDir = join(root, '.simt', 'bench', 'tasks');
  let names;
  try {
    names = (await readdir(tasksDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return { measured: false, reason: 'no tasks', tasks: 0, missing: 0, recall: null, tree };
  }
  if (files.length === 0) {
    return { measured: false, reason: 'no index', tasks: 0, missing: 0, recall: null, tree };
  }
  const [symbols, edges, fts] = await Promise.all([
    readSymbols(root, opts),
    readEdges(root, opts),
    readFts(root, opts),
  ]);
  const storedEmbeddings =
    opts.embeddings ?? (opts.embed ? await readEmbeddings(root, opts) : []);
  const checkEmbed = storedEmbeddings.length > 0 || opts.embed === true;

  const vault = opts.vaultRoot ?? resolveVaultDir(root);
  let sum = 0;
  let embedSum = 0;
  let embedEvaluated = 0;
  let tasks = 0;
  let missing = 0;
  for (const name of names) {
    const task = JSON.parse(await readFile(join(tasksDir, name), 'utf8'));
    let patch;
    try {
      patch = await readFile(join(vault, task.id, 'gold.patch'), 'utf8');
    } catch {
      missing += 1;
      continue;
    }
    const gold = goldPaths(patch);
    if (gold.length === 0) {
      missing += 1;
      continue;
    }
    const prompt = task.prompt ?? '';
    const bm25 = await searchFtsBm25(root, prompt, { ...opts, fts });
    const ranked = rankFiles({ files, edges, symbols, fts, bm25, task: prompt });
    sum += recallAt10(ranked, gold);
    tasks += 1;

    if (checkEmbed && storedEmbeddings.length > 0) {
      const providedVec =
        opts.taskVectors instanceof Map
          ? opts.taskVectors.get(task.id)
          : opts.taskVectors?.[task.id];
      const queryVector =
        providedVec ??
        (await embedTaskQuery(root, prompt, {
          embed: opts.embed === true,
          allowRemote: opts.allowRemote === true,
          fetchImpl: opts.fetchImpl,
        }));
      if (queryVector) {
        const embedRanked = rankFiles({
          files,
          edges,
          symbols,
          fts,
          bm25,
          embeddings: storedEmbeddings,
          queryVector,
          task: prompt,
        });
        embedSum += recallAt10(embedRanked, gold);
        embedEvaluated += 1;
      } else {
        embedSum += recallAt10(ranked, gold);
      }
    }
  }
  if (tasks === 0) return { measured: false, reason: 'no gold patches', tasks: 0, missing, recall: null, tree };
  const baseRecall = sum / tasks;
  const embedRecall = checkEmbed && embedEvaluated > 0 ? embedSum / tasks : null;
  const embedDelta = embedRecall === null ? null : embedRecall - baseRecall;
  // The bar is a release gate, and `embedAccepted` reports it for the human deciding
  // whether to change the shipped default. It never flips it here: a verdict read from an
  // out-of-tree vault cannot be a default every machine agrees on (ADR-224).
  const embedAccepted = embedDelta !== null && embedDelta + 1e-9 >= EMBED_RECALL_GAIN_BAR;
  return {
    measured: true,
    reason: '',
    tasks,
    missing,
    // The headline is the ranking a default run gets. An accepted embedding arm is
    // reported beside it, never substituted for it (ADR-224).
    recall: baseRecall,
    baseRecall,
    embedRecall,
    embedDelta,
    embedAccepted,
    embeddingsDefault: EMBEDDINGS_DEFAULT,
    embeddingsDefaultReason: EMBEDDINGS_DEFAULT_REASON,
    tree,
  };
}

export function formatRecall(result) {
  const worktree =
    result?.tree?.dirty === true
      ? ', uncommitted changes'
      : result?.tree?.dirty === null
        ? ', working tree unknown'
        : '';
  const tree = result?.tree
    ? `\ntree     ${result.tree.commit ? result.tree.commit.slice(0, 8) : 'uncommitted'} (${result.tree.files} files${worktree})`
    : '';
  if (!result?.measured || result.recall === null) {
    return `recall@10 unmeasured (${result?.reason ?? 'not run'})${tree}`;
  }
  const line = `recall@10 ${(result.recall * 100).toFixed(1)}% of gold files, over ${result.tasks} mined tasks`;
  // Only an arm that was measured says anything about the switch. An unmeasured run has
  // no verdict to report, and a sentence about embeddings there would be an opinion.
  if (result.embedDelta === null || result.embedDelta === undefined) return `${line}${tree}`;
  const delta = `${result.embedDelta >= 0 ? '+' : ''}${(result.embedDelta * 100).toFixed(1)}`;
  const verdict = result.embedAccepted ? 'cleared' : 'did not clear';
  // The explanation has one owner, so the CLI and the JSON cannot drift apart.
  return `${line}\nembeddings ${verdict} the ${EMBED_RECALL_GAIN_LABEL} bar (${delta}); ${EMBEDDINGS_DEFAULT_REASON}${tree}`;
}

function pageRank(nodes, links, scores) {
  const n = nodes.length;
  const pers = new Array(n).fill(0);
  let mass = 0;
  for (let i = 0; i < n; i += 1) {
    pers[i] = scores.get(nodes[i]) ?? 0;
    mass += pers[i];
  }
  if (mass === 0) {
    for (let i = 0; i < n; i += 1) pers[i] = 1 / n;
  } else {
    for (let i = 0; i < n; i += 1) pers[i] /= mass;
  }
  let rank = pers.slice();
  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const next = pers.map((value) => (1 - DAMPING) * value);
    // Dangling nodes (no outgoing edges) spread their rank over the whole
    // distribution. Accumulating their mass first makes that one pass over j
    // instead of one pass per dangling node - the no-task rank of a 30k-file
    // repo used to go quadratic here .
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) {
      const outs = links[i];
      if (outs.length === 0) {
        danglingMass += rank[i];
      } else {
        let sum = 0;
        for (const [, weight] of outs) sum += weight;
        for (const [j, weight] of outs) next[j] += (DAMPING * rank[i] * weight) / sum;
      }
    }
    if (danglingMass > 0) {
      const share = DAMPING * danglingMass;
      for (let j = 0; j < n; j += 1) next[j] += share * pers[j];
    }
    rank = next;
  }
  return rank;
}

function buildLinks(nodes, edges, index) {
  const weight = new Map();
  const usable = edges.filter(
    (edge) =>
      (edge.kind === 'import' || edge.kind === 'call') &&
      index.has(edge.src) &&
      index.has(edge.dst) &&
      edge.src !== edge.dst,
  );
  usable.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
  for (const edge of usable) {
    const lo = edge.src < edge.dst ? edge.src : edge.dst;
    const hi = edge.src < edge.dst ? edge.dst : edge.src;
    const key = `${lo}\0${hi}`;
    const value = Number.isFinite(edge.weight) && edge.weight > 0 ? edge.weight : 1;
    weight.set(key, Math.max(weight.get(key) ?? 0, value));
  }
  const links = nodes.map(() => []);
  for (const [key, value] of [...weight.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const [lo, hi] = key.split('\0');
    const i = index.get(lo);
    const j = index.get(hi);
    links[i].push([j, value]);
    links[j].push([i, value]);
  }
  for (const list of links) list.sort((a, b) => a[0] - b[0]);
  return links;
}

function closure(nodes, edges, scores) {
  const seeds = new Set(nodes.filter((path) => (scores.get(path) ?? 0) > 0));
  if (seeds.size === 0) return nodes;
  const known = new Set(nodes);
  const keep = new Set(seeds);
  for (const edge of edges) {
    if (edge.kind !== 'import' && edge.kind !== 'call') continue;
    if (!known.has(edge.src) || !known.has(edge.dst)) continue;
    if (seeds.has(edge.src)) keep.add(edge.dst);
    if (seeds.has(edge.dst)) keep.add(edge.src);
  }
  return [...keep].sort();
}

/**
 * The paths a task spells whole. Shared with the brief, whose scope is the same question;
 * two copies of "did the task name this file" would answer it differently one day.
 * @param {string} task
 * @param {Iterable<string>} paths
 * @returns {string[]}
 */
export function spelledPaths(task, paths) {
  const text = String(task ?? '').toLowerCase();
  return [...paths].filter((path) => text.includes(path.toLowerCase()));
}

function scoreFiles(nodes, symbolsByPath, task) {
  const scores = new Map(nodes.map((path) => [path, 0]));
  const { text, terms } = termsOf(task);
  if (terms.size === 0) return scores;
  // A path the task spells is the strongest evidence there is: the reader already named
  // the file. Word overlap elsewhere is then a coincidence - `path` in
  // `src/testing/paths.mjs` was a candidate beside `src/commands/why.mjs` for a task that
  // named the latter - so a spelled path is the whole answer.
  const spelled = spelledPaths(text, nodes);
  if (spelled.length > 0) {
    const exact = new Map(nodes.map((path) => [path, 0]));
    for (const path of spelled) exact.set(path, 8);
    return exact;
  }
  const segFreq = new Map();
  for (const path of nodes) {
    for (const segment of segments(path)) segFreq.set(segment, (segFreq.get(segment) ?? 0) + 1);
  }
  const cap = Math.max(3, Math.floor(nodes.length * 0.15));
  // `pack` names `packs/`. The task's wording and the tree's directory name disagree by
  // a plural, and exact segment equality let the graph hub outrank the file the task was
  // about because `packs` is not `pack`.
  const singular = (word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
  const forms = new Set([...terms].flatMap((term) => [term, singular(term)]));
  // A term that labels every file ("src") is the tree, not the task. A long
  // word that sits inside dozens of paths ("decision") is the same thing, so
  // the substring count uses the same ceiling.
  const common = (freq) => freq > cap || (nodes.length > 1 && freq === nodes.length);
  const termFreq = new Map();
  for (const term of terms) {
    if (term.length < 6) continue;
    let count = 0;
    for (const path of nodes) if (path.toLowerCase().includes(term)) count += 1;
    termFreq.set(term, count);
  }
  const symFreq = new Map();
  for (const path of nodes) {
    const seen = new Set();
    for (const symbol of symbolsByPath.get(path) ?? []) {
      const name = String(symbol.name ?? '').toLowerCase();
      if (name.length >= 3) seen.add(name);
    }
    for (const name of seen) symFreq.set(name, (symFreq.get(name) ?? 0) + 1);
  }
  // A task naming a symbol rather than a file: `migrate` names `migratePack`, and camel
  // case is not a word boundary the term set carries. Computed once, not per symbol.
  const longTerms = [...terms].filter((term) => term.length >= 5);
  for (const path of nodes) {
    const lower = path.toLowerCase();
    let score = 0;
    const stem = stemOf(lower);
    if (stem.length >= 3 && terms.has(stem) && !common(segFreq.get(stem) ?? 0)) score += 4;
    for (const segment of segments(lower)) {
      // One plural step on either side, so `packs/` answers a task that says `pack` and
      // a task saying `packs` reaches `pack.mjs`. The frequency guard reads the segment
      // the path actually has, not the form the task happened to use.
      const word = forms.has(segment) ? segment : singular(segment);
      if (forms.has(word) && !common(segFreq.get(segment) ?? 0)) score += 2;
    }
    for (const term of terms) {
      const freq = termFreq.get(term) ?? 0;
      if (term.length < 6 || freq === 0 || !lower.includes(term) || common(freq)) continue;
      score += 3;
      // A record cited once is context. The record the task is about is named
      // again. A flat bonus ranked every citation with the subject, and the
      // files the patch actually changed fell out of the top 10.
      if (freq === 1 && /\d/.test(term)) score += 8 * Math.min(mentions(text, term), 3);
    }
    let hits = 0;
    for (const symbol of symbolsByPath.get(path) ?? []) {
      const name = String(symbol.name ?? '').toLowerCase();
      if (name.length >= 3 && terms.has(name) && (symFreq.get(name) ?? 0) <= 5) hits += 1;
      // The rare symbol that contains a long task term is evidence too; without it a
      // task naming only `readBench` left the file holding it out of the resolver list.
      else if ((symFreq.get(name) ?? 0) <= 2 && longTerms.some((term) => name.includes(term))) {
        hits += 1;
      }
    }
    scores.set(path, score + Math.min(hits, 8));
  }
  // A task that names one file in a small directory usually edits its
  // neighbours too. A large directory (every decision record, every command)
  // does not get that lift: one citation would pull the whole directory in.
  const dirMax = new Map();
  const dirCount = new Map();
  for (const path of nodes) {
    const dir = directoryOf(path);
    dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
    dirMax.set(dir, Math.max(dirMax.get(dir) ?? 0, scores.get(path) ?? 0));
  }
  for (const path of nodes) {
    const own = scores.get(path) ?? 0;
    if (own === 0) continue;
    const dir = directoryOf(path);
    if ((dirCount.get(dir) ?? 0) > 8) continue;
    const lifted = Math.floor((dirMax.get(dir) ?? 0) / 2);
    if (lifted > own) scores.set(path, lifted);
  }
  return scores;
}

function directoryOf(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function mentions(text, term) {
  let count = 0;
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(term, from);
    if (at < 0) return count;
    count += 1;
    from = at + term.length;
  }
  return count;
}

function termsOf(task) {
  const text = String(task ?? '').toLowerCase();
  const terms = new Set();
  for (const word of text.split(/[^a-z0-9./-]+/)) {
    // A path names its files as a whole - `text.includes` scores that below. Splitting it
    // into `src/commands/why.mjs` -> `src`, `commands`, `why` made every file in
    // `src/commands/` a match for a task that named one file.
    if (word.includes('/')) continue;
    if (word.length >= 3 && !STOP.has(word)) terms.add(word);
  }
  return { text, terms };
}

function segments(path) {
  const lower = path.toLowerCase();
  const out = [];
  for (const part of lower.split('/')) {
    const stem = stemOf(part);
    if (stem.length >= 3) out.push(stem);
  }
  return out;
}

function stemOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function groupSymbols(symbols) {
  const byPath = new Map();
  for (const symbol of symbols ?? []) {
    const list = byPath.get(symbol.path) ?? [];
    list.push(symbol);
    byPath.set(symbol.path, list);
  }
  return byPath;
}

function renderEntry(path, symbols, level) {
  const exported = symbols
    .filter((symbol) => symbol.exported === 1 || symbol.exported === true)
    .sort((a, b) => cmp(a.name, b.name) || a.line - b.line);
  if (level === 'names') {
    const names = exported.map((symbol) => symbol.name);
    return names.length === 0 ? path : `${path} ${names.join(' ')}`;
  }
  if (level === 'signatures') {
    const lines = [path];
    for (const symbol of exported) {
      const sig = String(symbol.sig ?? '').trim();
      lines.push(sig ? `  ${symbol.name} ${sig}` : `  ${symbol.name}`);
    }
    return lines.join('\n');
  }
  return path;
}

function byRank(a, b) {
  const score = (b.score ?? 0) - (a.score ?? 0);
  if (score !== 0) return score;
  if (a.rank !== b.rank) return a.rank < b.rank ? 1 : -1;
  return cmp(a.path, b.path);
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

