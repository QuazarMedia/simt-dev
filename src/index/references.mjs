import { extractBindings } from './bindings.mjs';
import { bracketPairs, referenceScopes } from './reference-scopes.mjs';
import { scanSource } from './syntax.mjs';

const LANGUAGES = new Set(['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'swift', 'dart']);
const SKIP_CALLS = new Set(['if', 'else', 'for', 'while', 'switch', 'match', 'catch', 'with', 'return',
  'throw', 'new', 'super', 'await', 'function', 'fn', 'fun', 'def', 'func', 'class', 'typeof', 'sizeof', 'assert']);
const MEMBER = new Set(['.', '?.', '::']);
const HERITAGE = new Set(['extends', 'implements']);
const LOCAL = new Set(['const', 'var', 'let']);

function publicScope(scope, tokens) {
  return {
    id: scope.id,
    parent: scope.parent,
    symbol: scope.symbol,
    qualifiedName: scope.qualifiedName,
    kind: scope.kind,
    line: tokens[scope.nameIndex].line,
    start: tokens[scope.first].start,
    end: tokens[scope.end - 1]?.end ?? tokens[scope.first].end,
  };
}

export function extractReferences(path, text, lang, { tokens, bindings, ranges = [] } = {}) {
  if (!LANGUAGES.has(lang) || text.includes('\0')) return { scopes: [], references: [], unresolved: [], available: false };
  tokens ??= scanSource(text, lang);
  const imports = bindings ?? extractBindings(path, text, lang, tokens, ranges).namedImports;
  const imported = new Map(imports.filter(({ local }) => local).map((row) => [row.local, row]));
  const code = [];
  for (const token of tokens) {
    if (token.kind === 'newline') continue;
    code.push(token.kind === 'string' ? { ...token, spec: token.value, value: '' } : token);
  }
  const pairs = bracketPairs(code);
  const { definitions, declarations } = referenceScopes(code, pairs, lang);
  const references = [];
  const unresolved = [];
  const scopes = [];
  const active = [];
  const blocks = [];
  let nextDefinition = 0;
  let nextRange = 0;
  let heritage = false;

  function pushReference(index, kind, localName, memberName = null) {
    const token = code[index];
    const scope = active.at(-1);
    const inherited = kind === 'inherits';
    const shadowed = active.some(({ local }) => local.has(localName))
      || blocks.some(({ local }) => local.has(localName));
    references.push({
      callerSym: scope?.symbol ?? null, callerScope: scope?.id ?? null,
      localName, memberName, calleeName: memberName ?? localName, kind,
      line: token.line, offset: token.start,
      ...(shadowed && !inherited ? { shadowed: true } : {}),
    });
  }

  for (let index = 0; index < code.length; index += 1) {
    const token = code[index];
    while (blocks.length && blocks.at(-1).end <= index) blocks.pop();
    while (active.length && active.at(-1).end <= index) active.pop();
    while (definitions[nextDefinition]?.first === index) {
      const definition = definitions[nextDefinition++];
      const parent = active.at(-1);
      const symbol = code[definition.nameIndex].value;
      const qualifiedName = parent ? `${parent.qualifiedName}.${symbol}` : symbol;
      const scope = { ...definition, symbol, qualifiedName, id: `s${token.start}`, parent: parent?.id ?? null };
      active.push(scope);
      scopes.push(publicScope(scope, code));
    }

    if (token.kind === 'punct' && token.value === '{') {
      if (pairs[index] > index) blocks.push({ end: pairs[index], local: new Set() });
      heritage = false;
    }
    const scope = active.at(-1);
    const typeHeader = scope?.kind === 'type' && index < scope.body;
    if (typeHeader && ((lang === 'python' && index === scope.nameIndex + 1 && token.value === '(')
      || (lang === 'kotlin' && token.value === ':'))) heritage = true;
    if (token.kind !== 'word' || declarations.has(index)) continue;
    while (ranges[nextRange]?.end <= token.start) nextRange += 1;
    if (ranges[nextRange]?.start <= token.start && token.start < ranges[nextRange].end) continue;

    const previous = code[index - 1]?.value;
    const next = code[index + 1]?.value;
    const name = token.value;
    if (LOCAL.has(name) && code[index + 1]?.kind === 'word') {
      const declarationsIn = name === 'var' ? scope?.local : blocks.at(-1)?.local ?? scope?.local;
      declarationsIn?.add(code[index + 1].value);
      declarations.add(index + 1);
      continue;
    }
    if (lang === 'python' && next === '=' && code[index + 2]?.value !== '=' && !MEMBER.has(previous)) {
      scope?.local.add(name);
      continue;
    }
    if ((name === 'import' || name === 'require') && next === '(' && !MEMBER.has(previous)) {
      const spec = code[index + 2]?.kind === 'string' ? code[index + 2].spec : null;
      unresolved.push({ kind: 'dynamic-import', line: token.line, offset: token.start, spec });
      continue;
    }
    if (HERITAGE.has(name)) {
      heritage = true;
      continue;
    }
    if (SKIP_CALLS.has(name) || MEMBER.has(previous) || (name.length < 2 && !imported.has(name))) continue;
    if (imported.get(name)?.isNamespace && next === '[') {
      unresolved.push({ kind: 'computed-member', line: token.line, offset: token.start, localName: name });
      continue;
    }

    const inherited = typeHeader && heritage && (HERITAGE.has(previous) || previous === ','
      || (lang === 'kotlin' && previous === ':') || (lang === 'python' && index === scope.nameIndex + 2));

    if (MEMBER.has(next) && code[index + 2]?.kind === 'word') {
      let last = index + 2;
      while (MEMBER.has(code[last + 1]?.value) && code[last + 2]?.kind === 'word') last += 2;
      const memberName = code.slice(index + 2, last + 1).filter(({ kind }) => kind === 'word').map(({ value }) => value).join('.');
      const call = code[last + 1]?.value === '(';
      if (inherited || call || imported.has(name) || name === 'this') {
        pushReference(index, inherited ? 'inherits' : call ? 'call' : 'member', name, memberName);
      }
      index = last;
      continue;
    }
    if (inherited) {
      pushReference(index, 'inherits', name);
    } else if (next === '(' && !LOCAL.has(previous)) pushReference(index, 'call', name);
    else if (previous === ':' && (/^\p{Lu}/u.test(name) || imported.has(name))) pushReference(index, 'type', name);
    else if (imported.has(name) && next !== ':') pushReference(index, 'ref', name);
  }

  return { scopes, references, unresolved, available: true };
}
