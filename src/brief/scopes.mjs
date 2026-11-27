import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { symbolKey } from '../index/bind.mjs';
import { fieldQueryTerms } from '../index/bm25f.mjs';
import { readPathScopes } from '../index/graph-read.mjs';
import { extractReferences } from '../index/references.mjs';
import { langOf } from '../index/store.mjs';
import { cmp } from '../util/sort.mjs';

const LARGE_FILE_LINES = 200;

export async function resolveLiveScopes(root, paths, graph) {
  const unique = [...new Set(paths ?? [])].sort(cmp);
  const result = new Map();
  if (!unique.length) return result;

  const fileByPath = new Map((graph?.files ?? []).map((file) => [file.path, file]));
  const committedPaths = [];

  for (const path of unique) {
    const file = fileByPath.get(path);
    if (file?.provenance === 'worktree') {
      try {
        const text = await readFile(join(root, path), 'utf8');
        const lines = text.split('\n').length;
        const lang = file.lang || langOf(path, root);
        const extracted = extractReferences(path, text, lang);
        result.set(path, { lines, scopes: extracted.scopes ?? [] });
      } catch {
        // Unreadable overlay file falls back to no live scopes.
      }
    } else if (graph?.ranges?.has(path)) {
      const scopes = graph.ranges.get(path) ?? [];
      let lines = file?.lines ?? 0;
      if (!lines && scopes.length) {
        try {
          const text = await readFile(join(root, path), 'utf8');
          lines = text.split('\n').length;
        } catch {
          lines = 0;
        }
      }
      result.set(path, { lines, scopes });
    } else {
      committedPaths.push(path);
    }
  }

  if (committedPaths.length) {
    const cached = await readPathScopes(root, committedPaths);
    for (const path of committedPaths) {
      const info = cached.get(path);
      if (info) result.set(path, info);
    }
  }
  return result;
}

export function selectFileScopes(path, scopeInfo, task, {
  entrypoints = new Map(), minLines = LARGE_FILE_LINES, maxScopes = 2,
} = {}) {
  if (!scopeInfo || !(scopeInfo.lines > minLines) || !Array.isArray(scopeInfo.scopes) || !scopeInfo.scopes.length) {
    return [];
  }
  const terms = new Set(fieldQueryTerms(task));
  const scored = [];
  for (const scope of scopeInfo.scopes) {
    const startLine = Number(scope.line ?? 0);
    const endLine = Number(scope.endLine ?? startLine);
    const name = String(scope.symbol ?? '');
    if (!name || startLine < 1 || endLine < startLine) continue;
    const qualified = String(scope.qualifiedName ?? name);
    const overlap = fieldQueryTerms(qualified).filter((t) => terms.has(t)).length;
    const exact = terms.has(name.toLowerCase()) ? 1 : 0;
    const degree = entrypoints.get(symbolKey(path, name, startLine)) ?? 0;
    const score = exact * 3 + overlap * 2 + Math.min(3, degree) * 0.5;
    if (score <= 0) continue;
    scored.push({ name, startLine, endLine, score, degree });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.degree - a.degree || a.startLine - b.startLine || cmp(a.name, b.name))
    .slice(0, maxScopes)
    .map(({ name, startLine, endLine }) => ({ name, startLine, endLine }));
}
