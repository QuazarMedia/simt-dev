// Ranked repo map (R22, ADR-091).
//
// PageRank over import and call edges, personalised to the task. An edge is
// followed in both directions: the file that imports a mentioned file is part of
// the task, and so is the file it imports. One direction would hide one of them.
// Iterations and the tie break are fixed so two runs of the same graph return
// the same order. A random walk, or a tie broken by insertion order, would not.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveVaultDir } from '../bench/mine.mjs';
import { readEdges, readFiles, readSymbols } from './store.mjs';

export const ITERATIONS = 20;
export const DAMPING = 0.85;
export const TOP = 10;
export const DEFAULT_BUDGET = 2048;

const STOP = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'into', 'only', 'when', 'what',
  'which', 'their', 'about', 'after', 'before', 'where', 'there', 'these', 'those',
  'would', 'could', 'should', 'every', 'other', 'than', 'then', 'them', 'they',
  'your', 'will', 'does', 'file', 'files', 'test', 'tests', 'line', 'lines', 'code',
  'also', 'just', 'more', 'some', 'such', 'each', 'same', 'over', 'used', 'using',
]);

/**
 * Rank files for one task. No task text ranks the whole graph. A task ranks the
 * files it mentions and the files one import or call away from those.
 *
 * @param {{files: {path: string}[], edges: {src: string, dst: string, kind: string, weight?: number}[], symbols: {path: string, name: string}[], task?: string}} input
 * @returns {{path: string, rank: number}[]}
 */
export function rankFiles({ files, edges, symbols, task = '' }) {
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
  return kept
    .map((path, i) => ({ path, rank: rank[i], score: scores.get(path) ?? 0 }))
    .sort(byRank);
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
 * @param {string} root
 * @param {{vaultRoot?: string, backend?: string}} [opts]
 */
export async function measureRecall(root, opts = {}) {
  const tasksDir = join(root, '.simt-dev', 'bench', 'tasks');
  let names;
  try {
    names = (await readdir(tasksDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return { measured: false, reason: 'no tasks', tasks: 0, missing: 0, recall: null };
  }
  const files = await readFiles(root, opts);
  if (files.length === 0) {
    return { measured: false, reason: 'no index', tasks: 0, missing: 0, recall: null };
  }
  const [symbols, edges] = await Promise.all([readSymbols(root, opts), readEdges(root, opts)]);
  const vault = opts.vaultRoot ?? resolveVaultDir(root);
  let sum = 0;
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
    const ranked = rankFiles({ files, edges, symbols, task: task.prompt ?? '' });
    sum += recallAt10(ranked, gold);
    tasks += 1;
  }
  if (tasks === 0) return { measured: false, reason: 'no gold patches', tasks: 0, missing, recall: null };
  return { measured: true, reason: '', tasks, missing, recall: sum / tasks };
}

export function formatRecall(result) {
  if (!result?.measured || result.recall === null) {
    return `recall@10 unmeasured (${result?.reason ?? 'not run'})`;
  }
  return `recall@10 ${(result.recall * 100).toFixed(1)}% of gold files, over ${result.tasks} mined tasks`;
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
    for (let i = 0; i < n; i += 1) {
      const outs = links[i];
      if (outs.length === 0) {
        for (let j = 0; j < n; j += 1) next[j] += DAMPING * rank[i] * pers[j];
      } else {
        let sum = 0;
        for (const [, weight] of outs) sum += weight;
        for (const [j, weight] of outs) next[j] += (DAMPING * rank[i] * weight) / sum;
      }
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

function scoreFiles(nodes, symbolsByPath, task) {
  const scores = new Map(nodes.map((path) => [path, 0]));
  const { text, terms } = termsOf(task);
  if (terms.size === 0) return scores;
  const segFreq = new Map();
  for (const path of nodes) {
    for (const segment of segments(path)) segFreq.set(segment, (segFreq.get(segment) ?? 0) + 1);
  }
  const cap = Math.max(3, Math.floor(nodes.length * 0.15));
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
  for (const path of nodes) {
    const lower = path.toLowerCase();
    let score = 0;
    if (lower.length >= 3 && text.includes(lower)) score += 8;
    const stem = stemOf(lower);
    if (stem.length >= 3 && terms.has(stem) && !common(segFreq.get(stem) ?? 0)) score += 4;
    for (const segment of segments(lower)) {
      if (terms.has(segment) && !common(segFreq.get(segment) ?? 0)) score += 2;
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
  for (const word of text.split(/[^a-z0-9-]+/)) {
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

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
