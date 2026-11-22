import { cmp } from '../util/sort.mjs';
import { scanSource } from './syntax.mjs';

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const CONTINUATION = new Set([',', '.', '::', 'as', 'from', '\\']);
const words = (tokens) => tokens.map(({ value }) => value);
const joined = (tokens, separator = '') => words(tokens).join(separator);

function statement(tokens, index) {
  const rows = [];
  let depth = 0;
  let end = index + 1;
  for (; end < tokens.length && end - index < 4096; end += 1) {
    const token = tokens[end];
    if (token.kind === 'newline') {
      const next = tokens[end + 1]?.value;
      if (rows.length && !depth && !CONTINUATION.has(rows.at(-1)?.value) && next !== 'from' && next !== 'as') return { rows, end };
      continue;
    }
    if (token.kind === 'punct') {
      if (OPEN.has(token.value)) depth += 1;
      if (CLOSE.has(token.value)) depth -= 1;
      if (depth < 0 || (!depth && token.value === ';')) return { rows, end: end - Number(depth < 0) };
    }
    rows.push(token);
  }
  return { rows, end: end - 1 };
}

function groups(tokens) {
  const lists = [[]];
  let nested = 0;
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (OPEN.has(token.value)) nested += 1;
      if (CLOSE.has(token.value)) nested -= 1;
      if (token.value === ',' && nested === 0) {
        lists.push([]);
        continue;
      }
    }
    lists.at(-1).push(token);
  }
  return lists.filter((group) => group.length > 0);
}

function aliased(tokens) {
  const at = tokens.findIndex((token) => token.kind === 'word' && token.value === 'as');
  return at < 0
    ? { original: joined(tokens), alias: null }
    : { original: joined(tokens.slice(0, at)), alias: joined(tokens.slice(at + 1)) };
}

function unwrap(tokens, opening, closing) {
  return tokens[0]?.value === opening && tokens.at(-1)?.value === closing ? tokens.slice(1, -1) : tokens;
}

function scriptImports(keyword, rows, line, add, reexport) {
  if (rows[0]?.value === 'type' && rows[1]?.value !== 'from' && rows[1]?.value !== ',') rows = rows.slice(1);
  const exportList = keyword === 'export';
  if (exportList && rows[0]?.value !== '*' && rows[0]?.value !== '{') return;
  const from = rows.findIndex((token, index) => token.kind === 'word' && token.value === 'from' && rows[index + 1]?.kind === 'string');
  const spec = from < 0 ? '' : rows[from + 1].value;
  if (!exportList && !spec) return;
  const list = from < 0 ? rows : rows.slice(0, from);

  function record(original, alias, star = false) {
    if (exportList) reexport(spec, alias ?? original, original, star && alias === null, line);
    else add(spec, original, alias ?? original, line);
  }

  for (const group of groups(list)) {
    if (group[0].value === '{') {
      for (let item of groups(unwrap(group, '{', '}'))) {
        if (item[0].value === 'type' && item.length > 1 && item[1].value !== 'as') item = item.slice(1);
        const { original, alias } = aliased(item);
        if (original) record(original, alias);
      }
    } else if (group[0].value === '*') {
      const { alias } = aliased(group);
      record('*', alias, true);
    } else if (!exportList && group.length === 1 && group[0].kind === 'word') {
      record('default', group[0].value);
    }
  }
}

function pythonImports(keyword, rows, line, add) {
  if (keyword === 'import') {
    for (const group of groups(rows.filter(({ value }) => value !== '\\'))) {
      const { original: spec, alias } = aliased(group);
      if (spec) add(spec, '*', alias ?? spec.split('.')[0], line);
    }
    return;
  }
  const at = rows.findIndex(({ value }) => value === 'import');
  if (at < 1) return;
  const spec = joined(rows.slice(0, at));
  const named = unwrap(rows.slice(at + 1).filter(({ value }) => value !== '\\'), '(', ')');
  for (const group of groups(named)) {
    const { original, alias } = aliased(group);
    if (original) add(spec, original, original === '*' ? '' : alias ?? original, line);
  }
}

function rustUse(tokens, prefix, line, add, reexport, isPublic, depth = 0) {
  if (depth > 64 || !tokens.length) return;
  const brace = tokens.findIndex(({ kind, value }) => kind === 'punct' && value === '{');
  if (brace >= 0) {
    const scope = prefix + joined(tokens.slice(0, brace));
    for (const group of groups(unwrap(tokens.slice(brace), '{', '}'))) {
      rustUse(group, scope, line, add, reexport, isPublic, depth + 1);
    }
    return;
  }
  const { original, alias } = aliased(tokens);
  const bits = (prefix + original).split('::');
  const name = bits.pop();
  let spec = bits.join('::');
  let imported = name;
  let local = alias ?? name;
  if (name === 'self' && spec) {
    imported = '*';
    local = alias ?? bits.at(-1);
  } else if (name === '*') local = '';
  else if (!spec) spec = name;
  if (!name) return;
  add(spec, imported, local, line);
  if (isPublic) reexport(spec, local || '*', imported, local === '', line);
}

function publicRustUse(tokens, index) {
  if (tokens[index - 1]?.value === 'pub') return true;
  if (tokens[index - 1]?.value !== ')') return false;
  let start = index - 2;
  while (start >= 0 && tokens[start].kind !== 'newline' && tokens[start].value !== '(') start -= 1;
  return tokens[start - 1]?.value === 'pub';
}

function goImports(rows, add) {
  const list = unwrap(rows, '(', ')');
  let alias;
  for (const token of list) {
    if (token.kind === 'string') {
      const spec = token.value;
      const local = alias === '.' || alias === '_' ? '' : alias ?? spec.split('/').at(-1);
      add(spec, '*', local, token.line);
      alias = undefined;
    } else if (token.kind === 'word' || token.value === '.') alias = token.value;
  }
}

function dottedImport(lang, rows, line, add) {
  let mode;
  if (rows[0]?.value === 'static' || (lang === 'swift' && ['class', 'struct', 'enum', 'protocol', 'func', 'let', 'var', 'typealias'].includes(rows[0]?.value))) {
    mode = rows[0].value;
    rows = rows.slice(1);
  }
  if (lang === 'csharp' && rows[1]?.value === '=') {
    const spec = joined(rows.slice(2));
    if (/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(spec)) add(spec, '*', rows[0].value, line);
    return;
  }
  const { original, alias } = aliased(rows);
  if (!/^[\p{L}_][\p{L}\p{N}_.$]*(?:\.\*)?$/u.test(original)) return;
  const parts = original.split('.');
  const last = parts.at(-1);
  if (lang === 'csharp') return add(original, '*', '', line);
  if (lang === 'swift' && !mode) return add(original, '*', parts[0], line);
  if (last === '*') return add(parts.slice(0, -1).join('.'), '*', '', line);
  const spec = mode === 'static' || lang === 'swift' ? parts.slice(0, -1).join('.') : original;
  add(spec, last, alias ?? last, line);
}

function dartBindings(keyword, rows, line, add, reexport) {
  if (rows[0]?.kind !== 'string') return;
  const spec = rows[0].value;
  const as = rows.findIndex(({ value }) => value === 'as');
  const show = rows.findIndex(({ value }) => value === 'show');
  const hide = rows.findIndex(({ value }) => value === 'hide');
  const alias = as >= 0 ? rows[as + 1]?.value : '';
  const until = hide > show ? hide : rows.length;
  const names = show >= 0 ? rows.slice(show + 1, until).filter(({ kind }) => kind === 'word').map(({ value }) => value) : [];
  const except = hide >= 0 ? rows.slice(hide + 1).filter(({ kind }) => kind === 'word').map(({ value }) => value) : [];
  if (keyword === 'export') {
    if (names.length) for (const name of names.filter((name) => !except.includes(name))) reexport(spec, name, name, false, line);
    else reexport(spec, '*', '*', true, line, except);
  } else if (alias || !names.length) {
    add(spec, '*', alias, line, except, names);
  } else {
    for (const name of names.filter((name) => !except.includes(name))) add(spec, name, name, line);
  }
}

function rubyImports(keyword, rows, line, add) {
  rows = unwrap(rows, '(', ')');
  const literal = keyword === 'autoload' ? rows.find(({ kind }) => kind === 'string') : rows[0];
  if (literal?.kind !== 'string' || !literal.value) return;
  const relative = keyword === 'require_relative' && !literal.value.startsWith('.');
  const spec = relative ? './' + literal.value : literal.value;
  const name = keyword === 'autoload'
    ? rows[0]?.value === ':' ? rows[1]?.value : rows[0]?.value : '';
  add(spec, name || '*', name ?? '', line);
}

const KEYWORDS = Object.freeze({
  javascript: new Set(['import', 'export']),
  typescript: new Set(['import', 'export']),
  python: new Set(['from', 'import', '__all__']),
  rust: new Set(['use']),
  go: new Set(['import']),
  java: new Set(['import']),
  kotlin: new Set(['import']),
  csharp: new Set(['using']),
  swift: new Set(['import']),
  dart: new Set(['import', 'export']),
  ruby: new Set(['require', 'require_relative', 'autoload']),
});

export function extractBindings(path, text, lang, sourceTokens) {
  const namedImports = [];
  const reexports = [];
  if (!Object.hasOwn(KEYWORDS, lang)) return { namedImports, reexports };
  const tokens = sourceTokens ?? scanSource(text, lang);
  const explicit = new Set();
  const topLevel = new Set();
  let explicitExports = false;
  const script = lang === 'javascript' || lang === 'typescript';

  function add(spec, imported, local, line, except = [], only = []) {
    if (!spec || !imported) return;
    namedImports.push({
      spec, imported, local, isNamespace: imported === '*', isDefault: script && imported === 'default', line,
      ...(except.length ? { except } : {}), ...(only.length ? { only } : {}),
    });
  }
  function reexport(spec, exported, original, isStar, line, except = []) {
    reexports.push({ spec, exported, original, isStar, line, ...(except.length ? { except } : {}) });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const { value, kind, line, column } = tokens[index];
    if (kind !== 'word' || !KEYWORDS[lang].has(value)) continue;
    const next = tokens[index + 1]?.value;
    if (script && (value === 'import' ? next === '(' || next === '.'
      : next !== '*' && next !== '{' && next !== 'type')) continue;
    const { rows, end } = statement(tokens, index);
    if (script) scriptImports(value, rows, line, add, reexport);
    else if (lang === 'python' && value === '__all__') {
      if (column === 0 && ['=', '+='].includes(rows[0]?.value) && ['[', '('].includes(rows[1]?.value)) {
        if (rows[0].value === '=') explicit.clear();
        explicitExports = true;
        for (const token of rows.filter(({ kind: tokenKind }) => tokenKind === 'string')) explicit.add(token.value);
      }
    } else if (lang === 'python') {
      if (column === 0) topLevel.add(line);
      pythonImports(value, rows, line, add);
    }
    else if (lang === 'rust') rustUse(rows, '', line, add, reexport, publicRustUse(tokens, index));
    else if (lang === 'go') goImports(rows, add);
    else if (lang === 'dart') dartBindings(value, rows, line, add, reexport);
    else if (lang === 'ruby') rubyImports(value, rows, line, add);
    else dottedImport(lang, rows, line, add);
    index = end;
  }

  if (lang === 'python') {
    const initializer = path === '__init__.py' || path.endsWith('/__init__.py');
    for (const row of namedImports) {
      if (topLevel.has(row.line) && (explicit.has(row.local) || (!explicitExports && initializer && !row.local.startsWith('_')))) {
        reexport(row.spec, row.local || '*', row.imported, row.isNamespace && !row.local, row.line);
      }
    }
  }

  function unique(rows, field) {
    return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()]
      .sort((a, b) => a.line - b.line || cmp(a.spec, b.spec) || cmp(a[field], b[field]));
  }
  return { namedImports: unique(namedImports, 'local'), reexports: unique(reexports, 'exported') };
}
