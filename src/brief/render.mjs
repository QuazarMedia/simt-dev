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

export function compactFileLine(path, symbols, task, { entrypoints = new Map(), subtasks = [], limit = 95, maxSymbols = 4 } = {}) {
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
  const options = maxSymbols <= 0 ? [] : [...matched, ...structural].slice(0, maxSymbols).map(({ name }) => name);
  return visibleList(options, all.length, (names, extra) =>
    taggedLine([path, ...names, ...(extra ? ['+' + extra] : [])].join(' '), subtasks), limit);
}

export function compactScopedFileLine(path, scopes, symbols, task, {
  entrypoints = new Map(), subtasks = [], limit = 95, maxSymbols = 4,
} = {}) {
  if (!Array.isArray(scopes) || !scopes.length) {
    return compactFileLine(path, symbols, task, { entrypoints, subtasks, limit, maxSymbols });
  }
  const primary = scopes[0];
  const header = `${path}:${primary.startLine}-${primary.endLine}`;
  const scopeNames = [...new Set(scopes.map(({ name }) => name).filter(Boolean))];
  const symbolNames = [...new Set((symbols ?? []).map(({ name }) => name).filter((name) => name && !scopeNames.includes(name)))];
  const total = Math.max(scopeNames.length + symbolNames.length, (symbols ?? []).length);
  const options = maxSymbols <= 0 ? [] : [...scopeNames, ...symbolNames].slice(0, maxSymbols);
  return visibleList(options, total, (names, extra) =>
    taggedLine([header, ...names, ...(extra ? ['+' + extra] : [])].join(' '), subtasks), limit);
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

function hasUncoveredSubtask(ordered, cutSet) {
  const fileSubtasks = new Set();
  const keptFileSubtasks = new Set();
  const allSubtasks = new Set();
  const keptSubtasks = new Set();
  for (const item of ordered) {
    for (const rel of item.relevance ?? []) {
      if (Number.isFinite(rel.subtask) && rel.subtask > 0 && rel.score > 0) {
        allSubtasks.add(rel.subtask);
        if (!cutSet.has(item.id)) keptSubtasks.add(rel.subtask);
        if (item.section === 'FILES') {
          fileSubtasks.add(rel.subtask);
          if (!cutSet.has(item.id)) keptFileSubtasks.add(rel.subtask);
        }
      }
    }
  }
  const target = fileSubtasks.size ? fileSubtasks : allSubtasks;
  const covered = fileSubtasks.size ? keptFileSubtasks : keptSubtasks;
  for (const subtask of target) {
    if (!covered.has(subtask)) return true;
  }
  return false;
}

export function buildCompactPacket(items, {
  budget = DEFAULT_BRIEF_BYTES, footer = simpleFooter, footerBytes = null, algorithm = 'auto',
} = {}) {
  const ordered = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || cmp(a.id, b.id));
  const candidates = ordered.map((item) => {
    if (!SECTIONS.includes(item.section)) throw new Error('unknown brief section ' + item.section);
    return { ...item, bytes: optionCost(item) };
  });
  const full = packetLines(ordered).join('\n');
  const before = bytes(full);
  if (budget === 0 || before <= budget) {
    const selection = packSubmodular(candidates, { budget: 0, facetFloors: FACET_FLOORS, algorithm });
    return { text: full, before, after: before, cut: [], floorHeld: false, trace: selection.trace };
  }

  function packRows(rows) {
    function render(selection, includeFooter = true) {
      const lines = packetLines(rows, new Set(selection.cut));
      const tail = includeFooter ? footer(rows, selection.cut, budget) : '';
      if (tail) lines.push(tail);
      const text = lines.join('\n');
      return { before, after: bytes(text), text, cut: selection.cut, trace: selection.trace, utility: selection.utility };
    }

    const hardHeaders = headerBytes(rows.filter(({ priority }) => priority === 'hard'));
    const footSeed = footerBytes ?? bytes(footer(rows, rows, budget));
    let capacity = Math.max(1, budget - hardHeaders - footSeed);
    const choose = (value) => packSubmodular(rows, { budget: Math.max(1, value), facetFloors: FACET_FLOORS, algorithm });
    let selection = choose(capacity);
    let result = render(selection);
    for (let pass = 0; pass < 3; pass += 1) {
      const exactCapacity = Math.max(1, budget - (result.after - selection.bytes));
      if (result.after <= budget && (exactCapacity <= capacity || !selection.cut.length)) break;
      const trial = choose(exactCapacity);
      const packed = render(trial);
      if (result.after > budget || (packed.after <= budget && packed.utility > result.utility)) {
        selection = trial;
        result = packed;
        capacity = exactCapacity;
      } else {
        break;
      }
    }
    if (result.after > budget) {
      selection = choose(1);
      result = render(selection, false);
    }
    return result;
  }

  let currentRows = candidates;
  let result = packRows(currentRows);
  const maxVariants = currentRows.reduce((max, item) => Math.max(max, item.variants?.length ?? 0), 0);
  for (let tier = 0; tier < maxVariants && hasUncoveredSubtask(currentRows, new Set(result.cut)); tier += 1) {
    const nextRows = currentRows.map((item) => {
      const variant = item.variants?.[tier];
      if (!variant || bytes(variant) >= bytes(item.text)) return item;
      const updated = { ...item, text: variant };
      return { ...updated, bytes: optionCost(updated) };
    });
    const trial = packRows(nextRows);
    currentRows = nextRows;
    if (trial.after <= budget) result = trial;
  }

  const { utility, ...output } = result;
  return { ...output, floorHeld: output.after > budget };
}
