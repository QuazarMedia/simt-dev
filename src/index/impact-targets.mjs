import { bindSubtaskAnchors } from '../brief/anchors.mjs';
import { decomposePrompt } from '../brief/decompose.mjs';

function recordTarget(targets, row, file) {
  const found = targets.get(row.symbol);
  if (found) {
    if (!found.lines.includes(row.line)) found.lines.push(row.line);
  } else {
    targets.set(row.symbol, { file, symbol: row.symbol, lines: [row.line] });
  }
}

export function targetsForHunks(changes, graph) {
  return changes.flatMap(({ path, status, hunks }) => {
    const file = { file: path, symbol: '' };
    if (status !== 'M' || !hunks.length) return [file];
    const scopes = (graph.ranges?.get(path) ?? []).filter(({ parent }) => !parent);
    const targets = new Map();
    for (const { line, count } of hunks) {
      // A deletion sits between two lines in the current file. Both must
      // belong to the same scope before treating it as a local change.
      const lastLine = line + (count > 0 ? count - 1 : 1);
      const matching = scopes.filter((scope) => scope.line <= line && lastLine <= scope.endLine);
      if (matching.length !== 1) return [file];
      recordTarget(targets, matching[0], path);
    }
    return [...targets.values()];
  });
}

export function targetsForTask(task, graph) {
  const targets = new Map();
  for (const { anchors } of bindSubtaskAnchors(decomposePrompt(task), graph)) {
    for (const { path, kind, matched } of anchors) {
      const found = targets.get(path) ?? new Map();
      targets.set(path, found);
      if (kind === 'path' || kind === 'suffix') continue;
      for (const row of graph.symbols) {
        if (row.path === path && row.name === matched) recordTarget(found, { symbol: row.name, line: row.line }, path);
      }
    }
  }
  return [...targets].flatMap(([file, rows]) => rows.size ? [...rows.values()] : [{ file, symbol: '' }]);
}
