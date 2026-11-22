import { createImportResolver, extract } from '../index/extract.mjs';
import { withImportDatabase } from '../index/import-database.mjs';
import { readWorktreeFile } from '../index/overlay.mjs';
import { BLOB_CAP } from '../index/store.mjs';
import { scanSource } from '../index/syntax.mjs';
import { matchesGlob } from '../resolve/resolve.mjs';
import { cmp } from '../util/sort.mjs';

const direct = `select src, dst from imports
  where src in (select value from json_each(?)) and dst in (select value from json_each(?))
  order by src, dst`;

const transitive = `with recursive reachable(src, dst) as (
  select src, dst from imports where src in (select value from json_each(?))
  union
  select reachable.src, imports.dst from reachable join imports on imports.src = reachable.dst
)
select src, dst from reachable where dst in (select value from json_each(?)) order by src, dst`;

export function adjacency(edges) {
  const bySource = new Map();
  for (const { src, dst } of edges) {
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(dst);
  }
  for (const destinations of bySource.values()) destinations.sort(cmp);
  return bySource;
}

export function shortestPath(adjacency, src, dst) {
  const parents = new Map();
  const queue = [src];
  for (let i = 0; i < queue.length && !parents.has(dst); i += 1) {
    for (const next of adjacency.get(queue[i]) ?? []) {
      if (parents.has(next)) continue;
      parents.set(next, queue[i]);
      if (next !== src) queue.push(next);
    }
  }
  const path = [dst];
  do path.push(parents.get(path.at(-1)));
  while (path.at(-1) !== src);
  return path.reverse();
}

function architectureQueries(files, architecture) {
  const paths = [...files.keys()];
  const layers = (architecture.layers ?? []).map((layer) => ({
    ...layer, files: paths.filter((path) => layer.paths.some((glob) => matchesGlob(path, glob))),
  }));
  const queries = layers.flatMap(({ id, files, mayImport }) => {
    const to = [...new Set(layers.filter((layer) => layer.id !== id && !mayImport.includes(layer.id))
      .flatMap((layer) => layer.files))];
    return [{ from: files, to, reason: `layer ${id} does not allow this dependency` }];
  });
  for (const rule of architecture.forbid ?? []) {
    queries.push({
      from: paths.filter((path) => matchesGlob(path, rule.from)),
      to: paths.filter((path) => matchesGlob(path, rule.to)),
      reason: rule.reason || `architecture.forbid disallows imports from ${rule.from} to ${rule.to}`,
      transitive: rule.transitive,
    });
  }
  return queries.filter(({ from, to }) => from.length && to.length);
}

export async function sourceImports(root, path, lang) {
  const bytes = await readWorktreeFile(root, path, BLOB_CAP).catch(() => null);
  if (bytes === null) return [];
  const body = bytes.toString('utf8');
  const { imports, namedImports, reexports } = extract(path, body, lang);
  const specifiers = new Set(imports);
  const evidence = [...namedImports, ...reexports].filter(({ spec }) => spec);
  if (lang === 'javascript' || lang === 'typescript') {
    const tokens = scanSource(body, lang);
    for (const [index, token] of tokens.entries()) {
      if (token.kind !== 'string' || !specifiers.has(token.value)) continue;
      const before = tokens[index - 1];
      const caller = tokens[index - 2];
      if (before?.value === 'import' || (before?.value === '(' && ['import', 'require'].includes(caller?.value))) {
        evidence.push({ spec: token.value, line: token.line });
      }
    }
  }
  for (const spec of imports) {
    if (!evidence.some((row) => row.spec === spec)) evidence.push({ spec });
  }
  return evidence.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || cmp(a.spec, b.spec));
}

export async function architectureFindings(graph, architecture) {
  const { root, files, edges } = graph;
  const queries = architectureQueries(files, architecture);
  if (!edges.length || !queries.length) return [];
  const neighbors = adjacency(edges);
  const violations = await withImportDatabase(edges, (db) => queries.flatMap(({ from, to, reason, transitive: recursive }) => {
    const rows = db.prepare(recursive ? transitive : direct).all(JSON.stringify(from), JSON.stringify(to));
    return rows.map(({ src, dst }) => ({ src, reason, witness: recursive ? shortestPath(neighbors, src, dst) : [src, dst] }));
  }));
  if (!violations.length) return [];
  const resolve = createImportResolver(new Set(files.keys()));
  const notes = new Map();
  const findings = [];
  for (const { src, reason, witness } of violations) {
    if (!notes.has(src)) notes.set(src, await sourceImports(root, src, files.get(src)));
    const origin = notes.get(src).find(({ spec }) => resolve(src, spec, files.get(src)) === witness[1]);
    findings.push({
      file: src,
      status: 'import-direction-violation',
      detail: `${origin?.spec ? `import ${JSON.stringify(origin.spec)}${origin.line ? ` at line ${origin.line}` : ''}: ` : ''}${witness.join(' -> ')} (${reason})`,
      remedy: 'remove the dependency or update the matching policy in simt.json if the direction is intentional',
      ...(origin?.line ? { line: origin.line } : {}),
      ...(origin?.spec ? { specifier: origin.spec } : {}),
      witness,
    });
  }
  return findings;
}
