const WORD = /[\p{L}_$][\p{L}\p{M}\p{N}_$]*/uy;
const RUST_RAW = /(?:br|r)(#{0,16})"/y;
const HASH_COMMENT = new Set(['python', 'ruby']);
const REGEX_LITERAL = new Set(['javascript', 'typescript', 'ruby']);
const REGEX_PREFIX = new Set(['(', '[', '{', '=', ':', ',', 'return', 'throw', 'case', '=>', ';']);

function stringEnd(text, start, closing) {
  for (let cursor = start; cursor < text.length;) {
    if (text.startsWith(closing, cursor)) return cursor;
    cursor += text[cursor] === '\\' ? 2 : 1;
  }
  return text.length;
}

function regexEnd(text, start) {
  let bracket = false;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === '\n' || char === '\r') return start;
    if (char === '\\') cursor += 1;
    else if (char === '[') bracket = true;
    else if (char === ']') bracket = false;
    else if (char === '/' && !bracket) {
      cursor += 1;
      while (cursor < text.length && /[a-z]/i.test(text[cursor])) cursor += 1;
      return cursor;
    }
  }
  return start;
}

function templateEnd(text, start, nesting = 0) {
  if (nesting > 64) return text.length;
  for (let cursor = start; cursor < text.length;) {
    const ch = text[cursor];
    if (ch === '\x60') return cursor;
    if (ch === '\\') cursor += 2;
    else if (ch === '$' && text[cursor + 1] === '{') cursor = interpolationEnd(text, cursor + 2, nesting);
    else cursor += 1;
  }
  return text.length;
}

function interpolationEnd(text, start, nesting) {
  let depth = 1;
  for (let cursor = start; cursor < text.length;) {
    const ch = text[cursor];
    const next = text[cursor + 1];
    if (ch === '\x60') cursor = templateEnd(text, cursor + 1, nesting + 1) + 1;
    else if (ch === '"' || ch === "'") cursor = stringEnd(text, cursor + 1, ch) + 1;
    else if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', cursor + 2);
      cursor = end === -1 ? text.length : end + 1;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
    } else {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      cursor += 1;
      if (depth === 0) return cursor;
    }
  }
  return text.length;
}

/** Source tokens carry offsets and lines. Comments and literal contents never become words. */
export function scanSource(text, lang) {
  const tokens = [];
  let cursor = 0;
  let line = 1;
  let lineStart = 0;
  let previous = '';
  const hashComment = HASH_COMMENT.has(lang);
  const regexLiteral = REGEX_LITERAL.has(lang);
  const nestedComments = lang === 'rust' || lang === 'swift' || lang === 'kotlin';
  function advance(end) {
    for (let next = cursor; next < end; next += 1) {
      if (text.charCodeAt(next) !== 10) continue;
      line += 1;
      lineStart = next + 1;
    }
    cursor = end;
  }
  function push(kind, value, end) {
    tokens.push({ kind, value, start: cursor, end, line, column: cursor - lineStart });
    if (kind !== 'newline') previous = kind === 'word' || kind === 'punct' ? value : kind;
  }
  while (cursor < text.length) {
    const ch = text[cursor];
    const next = text[cursor + 1];
    if (ch === '\n') {
      push('newline', ch, cursor + 1);
      cursor += 1;
      line += 1;
      lineStart = cursor;
      continue;
    }
    if (text.charCodeAt(cursor) <= 32) {
      cursor += 1;
      continue;
    }
    if (hashComment ? ch === '#' : ch === '/' && next === '/') {
      const end = text.indexOf('\n', cursor);
      cursor = end === -1 ? text.length : end;
      continue;
    }
    if (!hashComment && ch === '/' && next === '*') {
      let depth = 1;
      let end = cursor + 2;
      while (end < text.length && depth > 0) {
        if (text.startsWith('*/', end)) {
          depth -= 1;
          end += 2;
        } else if (nestedComments && text.startsWith('/*', end)) {
          depth += 1;
          end += 2;
        } else end += 1;
      }
      advance(end);
      continue;
    }
    if (lang === 'ruby' && cursor === lineStart && /^=begin\b/.test(text.slice(cursor, cursor + 8))) {
      const end = text.indexOf('\n=end', cursor + 6);
      advance(end === -1 ? text.length : end + 5);
      continue;
    }
    if (lang === 'rust' && (ch === 'r' || ch === 'b')) {
      RUST_RAW.lastIndex = cursor;
      const raw = RUST_RAW.exec(text);
      if (raw) {
        const closing = '"' + raw[1];
        const stop = text.indexOf(closing, RUST_RAW.lastIndex);
        const end = stop === -1 ? text.length : stop + closing.length;
        push('string', '', end);
        advance(end);
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '\x60') {
      // A Rust lifetime is a quote plus an identifier without a closing quote.
      if (lang === 'rust' && ch === "'" && /^'[a-z_]\w*\b(?!')/i.test(text.slice(cursor, cursor + 64))) {
        push('punct', ch, cursor + 1);
        cursor += 1;
        continue;
      }
      const closing = ch !== '\x60' && text.startsWith(ch.repeat(3), cursor) ? ch.repeat(3) : ch;
      const start = cursor + closing.length;
      let stop;
      if (ch === '\x60' && lang === 'go') {
        const found = text.indexOf(closing, start);
        stop = found === -1 ? text.length : found;
      } else if (ch === '\x60' && regexLiteral && lang !== 'ruby') stop = templateEnd(text, start);
      else stop = stringEnd(text, start, closing);
      const end = Math.min(stop + closing.length, text.length);
      const value = ch === '\x60' && lang !== 'go' ? '' : text.slice(start, stop).replace(/\\([\\'"])/g, '$1');
      push('string', value, end);
      advance(end);
      continue;
    }
    if (ch === '/' && regexLiteral && (previous === '' || REGEX_PREFIX.has(previous))) {
      const end = regexEnd(text, cursor + 1);
      if (end > cursor + 1) {
        push('opaque', '', end);
        advance(end);
        continue;
      }
    }
    WORD.lastIndex = cursor;
    const word = WORD.exec(text);
    if (word) {
      push('word', word[0], WORD.lastIndex);
      cursor = WORD.lastIndex;
      continue;
    }
    const pair = ch + (next ?? '');
    const value = pair === '::' || pair === '=>' || pair === '+=' || pair === '?.' ? pair : ch;
    push('punct', value, cursor + value.length);
    cursor += value.length;
  }
  return tokens;
}
