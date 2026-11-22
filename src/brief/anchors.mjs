import { createEntityResolver } from '../index/entities.mjs';
import { cmp } from '../util/sort.mjs';
import { excludedPaths, extractConstraints } from './constraints.mjs';

const ADR = /\bADR-\d{3,}\b/giu;
const SCOPE = /\bscope(?:\s*:\s*|\s+)(?:\x60([^,\x60\r\n]+)\x60|([\p{L}\p{N}_][\p{L}\p{N}_.-]*))/giu;

function namedScopes(text, available) {
  return [...text.matchAll(SCOPE)]
    .map(([, code, name]) => (code ?? name).replace(/[.;]+$/u, ''))
    .filter((name) => available.has(name));
}

function pathOf(file) {
  return typeof file === 'string' ? file : file.path;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(cmp);
}

/**
 * Resolve each clause independently. Shared headings help disambiguate names
 * but do not become anchors in clauses that never asked for those paths.
 */
export function bindSubtaskAnchors(subtasks, graph, { paths = null, scopes = [] } = {}) {
  const known = graph.files.map(pathOf);
  const allowed = paths === null ? null : new Set(paths);
  const scopeIds = new Set(scopes.map((scope) => typeof scope === 'string' ? scope : scope.id));
  const resolve = createEntityResolver(graph);
  const parsedContext = new Map();

  function inherited(text) {
    if (!parsedContext.has(text)) parsedContext.set(text, extractConstraints(text));
    return parsedContext.get(text);
  }

  return subtasks.map((subtask) => {
    const anchors = new Map();
    const decisions = [];
    const scopes = [];
    const constraints = [];
    const cautions = [];
    const queries = [];
    const sourcePaths = new Set();
    for (const { id, text, context } of subtask.clauses) {
      const prior = context.map(inherited);
      const current = extractConstraints(text);
      const blocked = [...prior.flatMap((row) => row.constraints), ...current.constraints];
      const excluded = excludedPaths(blocked, known);
      for (const row of blocked) constraints.push({ ...row, clauseId: id });
      for (const row of [...prior, current]) cautions.push(...row.cautions);
      for (const path of excluded) sourcePaths.add(path);
      const shared = prior.map(({ query }) => query).filter(Boolean).join('\n');
      if (!current.query) continue;
      queries.push(current.query);
      for (const [path, hits] of resolve(current.query, { context: shared })) {
        if (excluded.has(path) || (allowed !== null && !allowed.has(path))) continue;
        for (const hit of hits) {
          const key = JSON.stringify([path, hit.kind, hit.query, hit.matched]);
          const found = anchors.get(key) ?? { path, ...hit, clauseIds: [] };
          found.clauseIds.push(id);
          anchors.set(key, found);
        }
      }
      decisions.push(...[...current.query.matchAll(ADR)].map(([id]) => id.toUpperCase()));
      scopes.push(...namedScopes(current.query, scopeIds));
    }

    return {
      ...subtask, query: queries.join('\n'),
      anchors: [...anchors.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.kind, b.kind) || cmp(a.matched, b.matched)),
      decisions: uniqueSorted(decisions), scopes: uniqueSorted(scopes),
      excludedPaths: uniqueSorted(sourcePaths),
      constraints, cautions: [...new Set(cautions)],
    };
  });
}
