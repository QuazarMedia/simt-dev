import { cmp } from '../util/sort.mjs';
import { createImportResolver } from './extract.mjs';

const SCRIPT = new Set(['javascript', 'typescript']);
const SHADOWED = Symbol('shadowed');

function collect(map, key, value) {
  const entries = map.get(key);
  if (entries) entries.push(value);
  else map.set(key, [value]);
}

export function symbolKey(path, name, line) {
  return `sym:${path}#${name}@${line}`;
}

function fileKey(path) {
  return `file:${path}`;
}

function fileInfo(file, symbols) {
  const direct = new Map();
  const locals = new Map();
  const scopes = new Map();
  const nodes = new Map();
  const scopeSymbols = new Map();
  const scopeById = new Map();
  for (const scope of file.chunk?.scopes ?? []) {
    const key = scope.parent ? `${symbolKey(file.path, scope.qualifiedName, scope.line)}:${scope.id}`
      : symbolKey(file.path, scope.symbol, scope.line);
    scopes.set(scope.id, key);
    scopeById.set(scope.id, scope);
    nodes.set(key, { key, name: scope.qualifiedName, line: scope.line });
    if (!scope.parent) collect(scopeSymbols, scope.symbol, { key, scope });
  }
  for (const symbol of symbols) {
    const key = symbolKey(file.path, symbol.name, symbol.line);
    const matching = scopeSymbols.get(symbol.name)?.some(({ scope }) => scope.line === symbol.line);
    if (!matching && file.reexports?.some(({ line, exported }) => line === symbol.line && exported === symbol.name)) continue;
    nodes.set(key, { key, name: symbol.name, line: symbol.line });
    collect(locals, symbol.name, key);
    if (!symbol.exported) continue;
    const isDefault = SCRIPT.has(file.lang) && /^export\s+default\s/u.test(symbol.sig);
    collect(direct, isDefault ? 'default' : symbol.name, key);
  }
  for (const [name, entries] of scopeSymbols) {
    for (const { key } of entries) {
      if (!locals.get(name)?.includes(key)) collect(locals, name, key);
    }
  }
  const imports = new Map();
  for (const row of file.namedImports ?? []) {
    if (row.local) collect(imports, row.local, row);
  }
  const named = new Map();
  const stars = [];
  for (const row of file.reexports ?? []) {
    if (row.isStar) stars.push(row);
    else collect(named, row.exported, row);
  }
  return { ...file, direct, locals, scopes, nodes, imports, named, stars, scopeById };
}

function distinctDestinations(destinations) {
  const found = new Map();
  for (const row of destinations) {
    const previous = found.get(row.dst);
    if (!previous || row.viaBarrels.length < previous.viaBarrels.length) found.set(row.dst, row);
  }
  return [...found.values()];
}

export function bindSymbols(files, symbols) {
  const byFile = new Map();
  for (const row of symbols) collect(byFile, row.path, row);
  const orderedFiles = [...files].sort((a, b) => cmp(a.path, b.path));
  const info = new Map(orderedFiles.map((file) => [file.path, fileInfo(file, byFile.get(file.path) ?? [])]));
  const resolve = createImportResolver(new Set(info.keys()));
  const cache = new Map();
  const coverage = new Map();
  const unresolved = [];
  const ownerRows = new Map();

  function importDest(from, row, name, trace, depth) {
    const path = resolve(from.path, row.spec, from.lang);
    if (!path) return [];
    return exported(info.get(path), name, trace, depth + 1);
  }

  function exported(file, name, trace, depth = 0) {
    const identity = `${file.path}\0${name}`;
    if (trace.has(identity) || depth >= 128) return [];
    trace.add(identity);
    const dot = name.indexOf('.');
    const head = dot < 0 ? name : name.slice(0, dot);
    const named = file.named.get(head);
    const destinations = [];
    if (named) {
      for (const row of named) {
        const tail = dot < 0 ? '' : name.slice(dot + 1);
        let resolved = [];
        if (row.spec && (row.original !== '*' || tail)) {
          resolved = importDest(file, row, row.original === '*' ? tail : `${row.original}${tail ? `.${tail}` : ''}`, trace, depth);
        } else if (!row.spec && !tail) {
          const imports = file.imports.get(row.original);
          resolved = imports?.length === 1 && !imports[0].isNamespace
            ? importDest(file, imports[0], imports[0].imported, trace, depth)
            : (file.locals.get(row.original) ?? []).map((dst) => ({ dst, viaBarrels: [] }));
        }
        destinations.push(...resolved.map(({ dst, viaBarrels }) => ({ dst, viaBarrels: [file.path, ...viaBarrels] })));
      }
    } else if (file.direct.has(name)) {
      for (const dst of file.direct.get(name)) destinations.push({ dst, viaBarrels: [] });
    } else if (name !== 'default') {
      for (const row of file.stars) {
        if (row.except?.includes(head)) continue;
        const resolved = importDest(file, row, name, trace, depth);
        destinations.push(...resolved.map(({ dst, viaBarrels }) => ({ dst, viaBarrels: [file.path, ...viaBarrels] })));
      }
    }
    return distinctDestinations(destinations);
  }

  function query(file, name) {
    const key = `${file.path}\0${name}`;
    if (!cache.has(key)) cache.set(key, exported(file, name, new Set()));
    const rows = cache.get(key);
    return rows.length === 1 ? rows[0] : null;
  }

  function exportNames(file) {
    const names = new Set(file.direct.keys());
    for (const key of file.named.keys()) names.add(key);
    const visited = new Set([file.path]);
    const queue = [file];
    for (const candidate of queue) {
      for (const row of candidate.stars) {
        const path = resolve(candidate.path, row.spec, candidate.lang);
        if (!path || visited.has(path)) continue;
        visited.add(path);
        const target = info.get(path);
        queue.push(target);
        for (const key of [...target.direct.keys(), ...target.named.keys()]) {
          if (key !== 'default') names.add(key);
        }
      }
    }
    return names;
  }

  function referenceTarget(file, ref) {
    if (ref.shadowed) return SHADOWED;
    const imports = file.imports.get(ref.localName);
    if (!imports) return null;
    const scopes = file.chunk?.scopes ?? [];
    const viable = file.lang === 'python' ? imports.filter(({ line }) => {
      const owner = scopes.findLast((scope) => scope.line < line && line <= scope.endLine);
      if (!owner) return true;
      if (line > ref.line) return false;
      for (let scope = file.scopeById.get(ref.callerScope); scope; scope = file.scopeById.get(scope.parent)) {
        if (scope.id === owner.id) return true;
      }
      return false;
    }) : imports;
    if (viable.length !== 1) return null;
    const row = viable[0];
    const member = ref.memberName;
    if ((row.isNamespace && !member) || (member && !row.isNamespace && !['java', 'kotlin'].includes(file.lang))) return null;
    const name = row.isNamespace ? member : member ? `${row.imported}.${member}` : row.imported;
    if ((row.only?.length && !row.only.includes(name)) || row.except?.includes(name)) return null;
    const path = resolve(file.path, row.spec, file.lang);
    if (!path) return null;
    return query(info.get(path), name);
  }

  for (const file of info.values()) {
    const owner = file.path;
    const origin = fileKey(owner);
    const edges = new Map();
    const stats = coverage.get(file.lang) ?? { bound: 0, total: 0, unresolved: 0 };
    if (file.chunk?.available) coverage.set(file.lang, stats);
    function edge(src, kind, dst, viaBarrels = [], line) {
      const key = JSON.stringify([src, kind, dst]);
      const previous = edges.get(key);
      const row = previous ?? { src, kind, dst, viaBarrels, lines: [] };
      if (line !== undefined && !row.lines.includes(line)) row.lines.push(line);
      if (viaBarrels.length < row.viaBarrels.length) row.viaBarrels = viaBarrels;
      edges.set(key, row);
    }
    for (const node of file.nodes.values()) edge(origin, 'contains', node.key);
    if (file.stars.length || file.named.size) {
      for (const name of exportNames(file)) {
        if (!file.named.has(name) && file.direct.has(name)) continue;
        const target = query(file, name);
        if (target) edge(origin, 'reexports_symbol', target.dst, target.viaBarrels);
      }
    }
    for (const ref of file.chunk?.references ?? []) {
      if (!file.imports.has(ref.localName)) continue;
      const target = referenceTarget(file, ref);
      if (target === SHADOWED) continue;
      stats.total += 1;
      if (!target) {
        stats.unresolved += 1;
        unresolved.push({ path: owner, ...ref, reason: 'unbound-import' });
        continue;
      }
      stats.bound += 1;
      const src = file.scopes.get(ref.callerScope) ?? origin;
      const kind = ref.kind === 'call' ? 'calls_symbol' : ref.kind === 'inherits' ? 'inherits' : 'refs_symbol';
      edge(src, kind, target.dst, target.viaBarrels, ref.line);
      edge(origin, 'imports_symbol', target.dst, target.viaBarrels, ref.line);
    }
    for (const ref of file.chunk?.unresolved ?? []) {
      unresolved.push({ path: owner, ...ref });
      if (ref.kind === 'computed-member') stats.total += 1;
    }
    stats.unresolved += file.chunk?.unresolved?.length ?? 0;
    ownerRows.set(owner, { nodes: [...file.nodes.values()], edges: [...edges.values()] });
  }
  const bindingCoverage = Object.fromEntries([...coverage].sort(([a], [b]) => cmp(a, b)).map(([lang, stats]) => [
    lang, { ...stats, ratio: stats.total ? stats.bound / stats.total : null },
  ]));
  return { ownerRows, bindingCoverage, unresolved };
}
