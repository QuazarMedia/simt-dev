// Line extractors for the languages the index maps (plan 0003 R21, ADR-090).
//
// A structural parser is more accurate and is not a dependency. These read one
// line at a time: an export, a definition, an import. That is enough for a map
// and an import graph, and it is the same result on every machine.

const IDENT = '[A-Za-z_$][\\w$]*';

const EXTS = {
  javascript: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
  typescript: ['.ts', '.tsx', '.js', '.mjs', '.jsx'],
  kotlin: ['.kt', '.kts'],
  java: ['.java'],
  python: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  swift: ['.swift'],
  dart: ['.dart'],
  ruby: ['.rb'],
  csharp: ['.cs'],
};

/**
 * Symbols and import specifiers in one blob.
 *
 * @param {string} filePath
 * @param {string} text
 * @param {string} lang
 * @returns {{symbols: object[], imports: string[]}}
 */
export function extract(filePath, text, lang) {
  const fn = BY_LANG[lang];
  if (!fn || text.includes('\0')) return { symbols: [], imports: [] };
  const found = fn(text);
  const symbols = [];
  const seen = new Set();
  for (const row of found.symbols) {
    const key = `${row.name}\0${row.kind}\0${row.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push({
      path: filePath,
      name: row.name,
      kind: row.kind,
      line: row.line,
      sig: row.sig,
      exported: row.exported ? 1 : 0,
    });
  }
  symbols.sort(bySymbol);
  return { symbols, imports: found.imports };
}

/** Import specifiers become edges. A relative one points at a tracked file when one matches. */
export function resolveImports(filePath, imports, files, lang) {
  const have = files instanceof Set ? files : new Set(files);
  const edges = [];
  const seen = new Set();
  for (const spec of imports) {
    const dst = resolveOne(filePath, spec, have, lang);
    if (seen.has(dst)) continue;
    seen.add(dst);
    edges.push({ src: filePath, dst, kind: 'import', weight: 1 });
  }
  edges.sort(byEdge);
  return edges;
}

function resolveOne(filePath, spec, files, lang) {
  const rel = relativeSpec(spec);
  if (rel === null) return spec;
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const base = slash(dir, rel);
  const candidates = [base];
  const dot = base.lastIndexOf('.');
  const bare = dot > base.lastIndexOf('/') ? null : base;
  if (bare !== null) {
    for (const ext of EXTS[lang] ?? []) {
      candidates.push(bare + ext, `${bare}/index${ext}`);
    }
  }
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return spec;
}

function relativeSpec(spec) {
  if (spec.startsWith('./') || spec.startsWith('../')) return spec;
  if (!spec.startsWith('.')) return null;
  let dots = 0;
  while (spec[dots] === '.') dots += 1;
  const rest = spec.slice(dots).replaceAll('.', '/');
  let prefix = '.';
  for (let i = 1; i < dots; i += 1) prefix += '/..';
  return rest === '' ? prefix : `${prefix}/${rest}`;
}

function slash(dir, rel) {
  const parts = [];
  if (dir !== '') parts.push(...dir.split('/'));
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function bySymbol(a, b) {
  return a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
}

function byEdge(a, b) {
  return cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sigOf(line) {
  return line.trim().slice(0, 200);
}

function add(symbols, name, kind, line, raw, exported) {
  if (!name) return;
  symbols.push({ name, kind, line, sig: sigOf(raw), exported });
}

function skipLine(line) {
  return line === '' || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*');
}

function scan(text, onLine) {
  const symbols = [];
  const imports = [];
  const lines = text.split('\n');
  const state = {};
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (skipLine(line)) continue;
    onLine(line, raw, i + 1, symbols, imports, state);
  }
  return { symbols, imports };
}

function script(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const from = line.match(/^(?:import|export)\s[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/);
    const side = line.match(/^import\s+['"]([^'"]+)['"]/);
    const req = line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/);
    if (from) imports.push(from[1]);
    else if (side) imports.push(side[1]);
    else if (req) imports.push(req[1]);
    let m;
    if ((m = line.match(new RegExp(`^export\\s+(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`)))) {
      add(symbols, m[1], 'function', lineNo, raw, 1);
    } else if ((m = line.match(new RegExp(`^export\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`)))) {
      add(symbols, m[1], 'class', lineNo, raw, 1);
    } else if ((m = line.match(new RegExp(`^export\\s+(?:const|let|var)\\s+(${IDENT})`)))) {
      add(symbols, m[1], 'const', lineNo, raw, 1);
    } else if ((m = line.match(/^export\s+(type|interface|enum)\s+/))) {
      const name = line.match(new RegExp(`^export\\s+${m[1]}\\s+(${IDENT})`));
      if (name) add(symbols, name[1], m[1] === 'type' ? 'type' : m[1], lineNo, raw, 1);
    } else if (/^export\s+(?:type\s+)?\{/.test(line)) {
      const body = line.slice(line.indexOf('{') + 1, line.indexOf('}'));
      for (const part of body.split(',')) {
        const bit = part.trim();
        if (bit === '') continue;
        const sides = bit.split(/\s+as\s+/);
        const name = (sides[1] ?? sides[0]).trim();
        if (new RegExp(`^${IDENT}$`).test(name)) add(symbols, name, 'const', lineNo, raw, 1);
      }
    } else if ((m = line.match(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`)))) {
      add(symbols, m[1], 'function', lineNo, raw, line.startsWith('export ') ? 1 : 0);
    } else if ((m = line.match(new RegExp(`^(?:export\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`)))) {
      add(symbols, m[1], 'class', lineNo, raw, line.startsWith('export ') ? 1 : 0);
    }
  });
}

const KT_MOD = '(?:public|private|internal|protected|open|data|sealed|abstract|enum|inner|value|annotation|suspend|override|operator|inline)';

function kotlin(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const imp = line.match(/^import\s+([\w.]+)/);
    if (imp) imports.push(imp[1]);
    const m = line.match(new RegExp(`^(?:${KT_MOD}\\s+)*(class|interface|object|fun)\\s+(${IDENT})`));
    if (!m) return;
    const head = line.slice(0, line.indexOf(m[2]));
    const exported = !/\b(?:private|internal)\b/.test(head);
    add(symbols, m[2], m[1] === 'fun' ? 'function' : m[1], lineNo, raw, exported);
  });
}

function java(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const imp = line.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
    if (imp) imports.push(imp[1]);
    const m = line.match(new RegExp(`^(public\\s+)?(?:(?:abstract|final|sealed|static)\\s+)*(class|interface|enum|record)\\s+(${IDENT})`));
    if (!m) return;
    add(symbols, m[3], m[2], lineNo, raw, m[1] ? 1 : 0);
  });
}

function python(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    if (raw[0] === ' ' || raw[0] === '\t') return;
    const from = line.match(/^from\s+(\S+)\s+import\s+(.+)/);
    const imp = line.match(/^import\s+(\S+)/);
    if (from) {
      if (from[1] === '.') {
        for (const part of from[2].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name !== '' && name !== '*') imports.push(`./${name}`);
        }
      } else imports.push(from[1]);
    } else if (imp) imports.push(imp[1].replace(/,$/, ''));
    let m;
    if ((m = line.match(new RegExp(`^(?:async\\s+)?def\\s+(${IDENT})`)))) {
      add(symbols, m[1], 'function', lineNo, raw, m[1].startsWith('_') ? 0 : 1);
    } else if ((m = line.match(new RegExp(`^class\\s+(${IDENT})`)))) {
      add(symbols, m[1], 'class', lineNo, raw, m[1].startsWith('_') ? 0 : 1);
    }
  });
}

function go(text) {
  return scan(text, (line, raw, lineNo, symbols, imports, state) => {
    if (line === 'import (') {
      state.group = true;
      return;
    }
    if (state.group) {
      if (line === ')') state.group = false;
      else {
        const q = line.match(/"([^"]+)"/);
        if (q) imports.push(q[1]);
      }
      return;
    }
    const one = line.match(/^import\s+"([^"]+)"/);
    if (one) imports.push(one[1]);
    const fn = line.match(new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?(${IDENT})`));
    const type = line.match(new RegExp(`^type\\s+(${IDENT})`));
    const name = fn?.[1] ?? type?.[1];
    if (!name) return;
    const exported = name[0] !== name[0].toLowerCase();
    add(symbols, name, fn ? 'function' : 'type', lineNo, raw, exported);
  });
}

function rust(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const use = line.match(/^use\s+([^;{]+)/);
    if (use) imports.push(use[1].trim());
    if (/^pub\s*\(/.test(line)) return;
    const pub = line.match(new RegExp(`^pub\\s+(?:async\\s+)?(fn|struct|enum|trait|type|const|mod)\\s+(${IDENT})`));
    if (pub) {
      add(symbols, pub[2], pub[1] === 'fn' ? 'function' : pub[1], lineNo, raw, 1);
      return;
    }
    const fn = line.match(new RegExp(`^(?:async\\s+)?fn\\s+(${IDENT})`));
    if (fn) add(symbols, fn[1], 'function', lineNo, raw, 0);
  });
}

function swift(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const imp = line.match(/^import\s+(\S+)/);
    if (imp) imports.push(imp[1]);
    const m = line.match(new RegExp(`^(?:(public|open|internal|private|fileprivate)\\s+)?(?:(?:static|class|final|override)\\s+)*(func|class|struct|enum|protocol|actor)\\s+(${IDENT})`));
    if (!m) return;
    add(symbols, m[3], m[2] === 'func' ? 'function' : m[2], lineNo, raw, m[1] === 'public' || m[1] === 'open' ? 1 : 0);
  });
}

function dart(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const imp = line.match(/^import\s+['"]([^'"]+)['"]/);
    if (imp) imports.push(imp[1]);
    const type = line.match(new RegExp(`^(?:class|enum|mixin|extension|typedef)\\s+(${IDENT})`));
    if (type) {
      add(symbols, type[1], 'class', lineNo, raw, type[1].startsWith('_') ? 0 : 1);
      return;
    }
    const fn = line.match(new RegExp(`^(?!if\\b|for\\b|while\\b|switch\\b|catch\\b)(?:[\\w.?<>]+\\s+)+(${IDENT})\\s*\\(`));
    if (fn && raw[0] !== ' ' && raw[0] !== '\t') add(symbols, fn[1], 'function', lineNo, raw, fn[1].startsWith('_') ? 0 : 1);
  });
}

function ruby(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const req = line.match(/^require(?:_relative)?\s+['"]([^'"]+)['"]/);
    if (req) imports.push(req[1]);
    if (raw[0] === ' ' || raw[0] === '\t') return;
    const type = line.match(/^(class|module)\s+([A-Z]\w*)/);
    if (type) {
      add(symbols, type[2], type[1], lineNo, raw, 1);
      return;
    }
    const fn = line.match(/^def\s+(?:self\.)?([A-Za-z_][\w?!]*)/);
    if (fn) add(symbols, fn[1], 'function', lineNo, raw, 1);
  });
}

function csharp(text) {
  return scan(text, (line, raw, lineNo, symbols, imports) => {
    const use = line.match(/^using\s+([A-Za-z0-9_.]+)\s*;/);
    if (use) imports.push(use[1]);
    const m = line.match(new RegExp(`^(?:(public|private|internal|protected)\\s+)?(?:(?:static|sealed|abstract|partial|readonly)\\s+)*(class|interface|enum|record|struct)\\s+(${IDENT})`));
    if (!m) return;
    add(symbols, m[3], m[2], lineNo, raw, m[1] === 'public' ? 1 : 0);
  });
}

const BY_LANG = {
  javascript: script,
  typescript: script,
  kotlin,
  java,
  python,
  go,
  rust,
  swift,
  dart,
  ruby,
  csharp,
};
