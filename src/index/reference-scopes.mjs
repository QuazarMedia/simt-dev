const OPEN = Object.freeze({ '(': ')', '[': ']', '{': '}' });
const CLOSE = new Set(Object.values(OPEN));
const TYPES = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'record', 'object', 'protocol']);
const FUNCTIONS = new Set(['function', 'def', 'fn', 'func', 'fun']);
const MEMBERS = new Set(['javascript', 'typescript', 'java', 'csharp', 'dart']);
const CONTROLS = new Set(['if', 'else', 'for', 'while', 'switch', 'catch', 'with', 'return', 'new', 'synchronized']);
const VARIABLES = new Set(['let', 'var', 'const']);

export function bracketPairs(tokens) {
  const pairs = new Int32Array(tokens.length).fill(-1);
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const { kind, value } = tokens[index];
    if (kind !== 'punct') continue;
    if (Object.hasOwn(OPEN, value)) stack.push(index);
    else if (CLOSE.has(value)) {
      const opening = stack.at(-1);
      if (opening !== undefined && OPEN[tokens[opening].value] === value) {
        pairs[opening] = index;
        pairs[index] = opening;
        stack.pop();
      }
    }
  }
  return pairs;
}

function indentationEnds(tokens) {
  const end = new Map();
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (tokens[index - 1]?.line === token.line) continue;
    while (stack.length && tokens[stack.at(-1)].column >= token.column) end.set(stack.pop(), index);
    stack.push(index);
  }
  for (const index of stack) end.set(index, tokens.length);
  return end;
}

function functionName(tokens, pairs, index, lang) {
  let cursor = index + 1;
  if (tokens[cursor]?.value === '*') cursor += 1;
  if (lang === 'go' && tokens[cursor]?.value === '(' && pairs[cursor] >= 0) cursor = pairs[cursor] + 1;
  while (tokens[cursor]?.kind === 'word' && tokens[cursor + 1]?.value === '.') cursor += 2;
  return tokens[cursor]?.kind === 'word' ? cursor : -1;
}

function bodyStart(tokens, pairs, index, lang, hasParams) {
  const first = tokens[index]?.line;
  for (let cursor = index; cursor < tokens.length && cursor - index < 128; cursor += 1) {
    const token = tokens[cursor];
    const { value } = token;
    if (value === '{' || (lang === 'python' && value === ':') || (lang === 'kotlin' && hasParams && value === '=')) return cursor;
    if ([';', '}', '=', '=>'].includes(value) || token.line > first + 3) return -1;
    if ((value === '(' || value === '[') && pairs[cursor] >= 0) cursor = pairs[cursor];
  }
  return -1;
}

function parameters(tokens, pairs, begin, end, lang, declarations) {
  const locals = new Set();
  if (begin < 0 || end < 0) return locals;
  let words = [];
  function finish() {
    if (words.length) {
      const index = lang === 'java' || lang === 'csharp' ? words.at(-1) : words[0];
      locals.add(tokens[index].value);
      declarations.add(index);
    }
    words = [];
  }
  for (let cursor = begin + 1; cursor < end; cursor += 1) {
    const token = tokens[cursor];
    if (token.value === ',') finish();
    else if (token.kind === 'word' && !['final', 'vararg', 'ref', 'out', 'mut', 'in'].includes(token.value)) words.push(cursor);
    else if (Object.hasOwn(OPEN, token.value) && pairs[cursor] > cursor) cursor = pairs[cursor];
  }
  finish();
  return locals;
}

function variableNames(tokens, index) {
  const following = tokens[index + 1];
  return VARIABLES.has(tokens[index].value) && following?.kind === 'word' ? index + 1 : -1;
}

export function referenceScopes(tokens, pairs, lang) {
  const definitions = [];
  const declarations = new Set();
  const indents = lang === 'python' ? indentationEnds(tokens) : new Map();
  const members = MEMBERS.has(lang);
  let firstOnLine = 0;

  function add(nameIndex, body, kind, begin = -1, first = nameIndex) {
    if (body < 0 || declarations.has(nameIndex)) return;
    const open = tokens[body];
    let end;
    if (open.value === '{') end = pairs[body] >= 0 ? pairs[body] : tokens.length;
    else if (lang === 'python') end = indents.get(firstOnLine) ?? tokens.length;
    else {
      end = body + 1;
      while (end < tokens.length && tokens[end].line === open.line && ![';', '}'].includes(tokens[end].value)) end += 1;
    }
    if (end <= body) return;
    declarations.add(nameIndex);
    const local = parameters(tokens, pairs, begin, pairs[begin] ?? -1, lang, declarations);
    const definition = { nameIndex, first, body, end, kind, local };
    definitions.push(definition);
    return definition;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (tokens[index - 1]?.line !== token.line) firstOnLine = index;
    if (token.kind !== 'word') continue;
    const next = tokens[index + 1]?.value;
    if (FUNCTIONS.has(token.value)) {
      const name = functionName(tokens, pairs, index, lang);
      if (name >= 0) {
        let begin = name + 1;
        if (tokens[begin]?.value === '<') {
          while (begin < name + 80 && tokens[begin] && tokens[begin].value !== '(') begin += 1;
        }
        if (tokens[begin]?.value === '(' && pairs[begin] >= 0) {
          add(name, bodyStart(tokens, pairs, pairs[begin] + 1, lang, true), 'function', begin, index);
        }
      }
    } else if (TYPES.has(token.value) && tokens[index + 1]?.kind === 'word') {
      add(index + 1, bodyStart(tokens, pairs, index + 2, lang, false), 'type', -1, index);
    } else if (members && next === '(' && pairs[index + 1] >= 0 && !CONTROLS.has(token.value)) {
      const prior = tokens[index - 1]?.value;
      const after = pairs[index + 1] + 1;
      if (!['.', '?.', '::', '@', 'new'].includes(prior) && (tokens[after]?.value === '{' || tokens[after]?.value === 'throws')) {
        add(index, bodyStart(tokens, pairs, after, lang, true), 'function', index + 1);
      }
    }
    const variable = variableNames(tokens, index);
    if (variable < 0 || tokens[variable + 1]?.value !== '=') continue;
    const start = variable + 2;
    const arrow = tokens[start]?.value === '(' ? pairs[start] + 1 : start + 1;
    if (tokens[arrow]?.value === '=>' && tokens[arrow + 1]?.value === '{') {
      const definition = add(variable, arrow + 1, 'function', tokens[start].value === '(' ? start : -1, index);
      if (tokens[start].kind === 'word') {
        definition?.local.add(tokens[start].value);
        declarations.add(start);
      }
    }
  }
  return { definitions: definitions.sort((a, b) => a.first - b.first || b.end - a.end), declarations };
}
