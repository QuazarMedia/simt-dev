import { symbolKey } from '../index/bind.mjs';
import { fieldQueryTerms } from '../index/bm25f.mjs';
import { cmp } from '../util/sort.mjs';
import { DEFAULT_BRIEF_BYTES, packetLines, SECTIONS } from './packet.mjs';
import { packSubmodular } from './submodular.mjs';

const FACET_FLOORS = Object.freeze({ FILES: 0.6, TESTS: 0.8, DECISIONS: 0.8, CAUTIONS: 0.9 });
const bytes = (text) => Buffer.byteLength(text);

export function taggedLine(text, subtasks = []) {
  const ids = [...new Set(subtasks)].sort((a, b) => a - b);
  return ids.length ? '[' + ids.map((id) => 'T' + id).join(',') + '] ' + text : text;
}

export function symbolEntrypoints(edges) {
  const callers = new Map();
  for (const { kind, src, dst } of edges) {
    if (kind !== 'calls_symbol' && kind !== 'imports_symbol') continue;
    if (!callers.has(dst)) callers.set(dst, new Set());
    callers.get(dst).add(src);
  }
  return new Map([...callers].map(([key, sources]) => [key, sources.size]));
}

function visibleList(options, total, render, limit) {
  for (let count = options.length; count >= 0; count -= 1) {
    const row = render(options.slice(0, count), total - count);
    if (count === 0 || bytes(row) <= limit) return row;
  }
}

export function compactFileLine(path, symbols, task, { entrypoints = new Map(), subtasks = [], limit = 95 } = {}) {
  const terms = new Set(fieldQueryTerms(task));
  const rows = symbols.filter(({ name }) => name).map((symbol) => ({
    ...symbol,
    hits: fieldQueryTerms(symbol.name).filter((term) => terms.has(term)).length,
    degree: entrypoints.get(symbolKey(path, symbol.name, symbol.line)) ?? 0,
  }));
  const priority = (a, b) => b.hits - a.hits || b.degree - a.degree || Number(Boolean(b.exported)) - Number(Boolean(a.exported))
    || (a.line ?? 0) - (b.line ?? 0) || cmp(a.name, b.name);
  const all = [...new Map(rows.sort(priority).map((row) => [row.name, row]).reverse()).values()].sort(priority);
  const matched = all.filter(({ hits }) => hits > 0);
  const structural = all.filter(({ hits, degree, exported }) => hits === 0 && (degree > 0 || exported)).slice(0, 2);
  const options = [...matched, ...structural].slice(0, 4).map(({ name }) => name);
  return visibleList(options, all.length, (names, extra) =>
    taggedLine([path, ...names, ...(extra ? ['+' + extra] : [])].join(' '), subtasks), limit);
}

export function compactTestLine(path, tests, { subtasks = [], limit = 140 } = {}) {
  const targets = [...new Set(tests)].sort(cmp);
  return visibleList(targets.slice(0, 3), targets.length, (picked, extra) => {
    const witness = [...picked, ...(extra ? ['(+' + extra + ')'] : [])].join(' ');
    return taggedLine(witness ? path + ' -> ' + witness : path, subtasks);
  }, limit);
}

function headerBytes(items) {
  return [...new Set(items.map(({ section }) => section))].reduce((sum, section) => sum + bytes(section) + 1, 0);
}

function simpleFooter(items, cut, budget) {
  return cut.length ? 'cut ' + cut.length + ' of ' + items.length + ' items to fit ' + budget : '';
}

function optionCost({ text }) {
  return text.split('\n').reduce((sum, line) => sum + bytes(line) + 3, 0);
}

export function buildCompactPacket(items, { budget = DEFAULT_BRIEF_BYTES, footer = simpleFooter } = {}) {
  const ordered = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || cmp(a.id, b.id));
  const candidates = ordered.map((item) => {
    if (!SECTIONS.includes(item.section)) throw new Error('unknown brief section ' + item.section);
    return { ...item, bytes: optionCost(item) };
  });
  const full = packetLines(ordered).join('\n');
  const before = bytes(full);
  if (budget === 0 || before <= budget) {
    const selection = packSubmodular(candidates, { budget: 0, facetFloors: FACET_FLOORS });
    return { text: full, before, after: before, cut: [], floorHeld: false, trace: selection.trace };
  }

  function render(selection, includeFooter = true) {
    const lines = packetLines(ordered, new Set(selection.cut));
    const tail = includeFooter ? footer(ordered, selection.cut, budget) : '';
    if (tail) lines.push(tail);
    const text = lines.join('\n');
    return { before, after: bytes(text), text, cut: selection.cut, trace: selection.trace, utility: selection.utility };
  }

  const footEstimate = bytes(simpleFooter(ordered, ordered, budget));
  const reserved = headerBytes(candidates) + footEstimate;
  const capacity = Math.max(1, budget - reserved);
  const choose = (value) => packSubmodular(candidates, { budget: Math.max(1, value), facetFloors: FACET_FLOORS });
  let selection = choose(capacity);
  let result = render(selection);
  const extra = budget - result.after;
  if (extra > 0 && selection.cut.length) {
    const trial = choose(capacity + extra);
    const packed = render(trial);
    if (packed.after <= budget && packed.utility > result.utility) {
      selection = trial;
      result = packed;
    }
  }
  if (result.after > budget) {
    // A longer custom footer must fit in the same ceiling as the chosen evidence.
    const trial = choose(capacity - (result.after - budget));
    const packed = render(trial);
    if (packed.after <= budget) result = packed;
    else {
      selection = choose(1);
      result = render(selection, false);
    }
  }
  const { utility, ...output } = result;
  return { ...output, floorHeld: output.after > budget };
}
