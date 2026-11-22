export const MAX_SUBTASKS = 12;

const VERBS = 'add|audit|build|change|check|compare|create|delete|deploy|design|document|enable|ensure|explain|extract|fix|implement|improve|inspect|investigate|list|migrate|move|optimize|pin|profile|refactor|remove|rename|repair|replace|report|review|run|split|support|test|trace|update|validate|verify|write';
const ACTION = '(?:please\\s+)?(?:' + VERBS + ')\\b|(?:we\\s+)?(?:must|should|need\\s+to|have\\s+to)\\s+(?:' + VERBS + ')\\b';
const GUARD = /^(?:if|unless|only\s+when)\b/iu;
const LEADING = new RegExp('^(?:(?:first|next|finally|also|then)[, ]+)?(?:' + ACTION + '|if\\b|unless\\b|only\\s+when\\b)', 'iu');
const ACTION_AT = new RegExp('(?:' + ACTION + '|if\\b|unless\\b|only\\s+when\\b)', 'iuy');
const SEPARATOR = /(?:[;.!?]\s+|,\s*|\s+)(?:(and|then|also|plus|finally)\s+)?(?:(then|also|finally)\s+)?/giu;
const HEADING = /^[\t ]*(#{1,6})[\t ]+(.*)$/u;
const LIST = /^[\t ]*(?:\d{1,4}[.)]|[-*+•])[\t ]+(?:\[[ xX]\][\t ]+)?/u;
const FENCE = /^[\t ]{0,3}(\x60{3,}|~{3,})(.*)$/u;
const INLINE_CODE = /(\x60+)[^\r\n]*?\1(?!\x60)/gu;
const QUOTE = /"[^"\\\r\n]*(?:\\.[^"\\\r\n]*)*"|“[^”\r\n]*”|(?<![\p{L}\p{N}])'[^'\\\r\n]*(?:\\.[^'\\\r\n]*)*'|‘[^’\r\n]*’/gu;
const LOCATOR = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>\x60"']+|(?:\.{1,2}\/|\/)?[\p{L}\p{N}_.$@+~\-]+(?:\/[\p{L}\p{N}_.$@+~%#()[\]\-]+)+|[\p{L}\p{N}_$@+\-]+(?:\.[\p{L}\p{N}_$@+\-]+)+)/gu;
const REGEX_LITERAL = /(?<![\p{L}\p{N}_/])\/(?:\\.|[^/\r\n\\])+\/[dgimsuvy]*(?=[\s.,;!?)]|$)/gu;
const DIRECTORY = /(?:[\p{L}\p{N}_.$@+\-]+\/)+/u;

export function maskPrompt(source) {
  const chars = source.split('');
  function cover(start, end) {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = '\u0001';
    }
  }
  const fencedLines = new Set();
  let fence = null;
  for (const line of source.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!line[0]) continue;
    const marker = FENCE.exec(line[0].trimEnd());
    if (!fence && !marker) continue;
    fencedLines.add(line.index);
    cover(line.index, line.index + line[0].length);
    if (!fence) fence = marker[1];
    else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') fence = null;
  }
  for (const pattern of [INLINE_CODE, QUOTE, LOCATOR, REGEX_LITERAL]) {
    for (const match of chars.join('').matchAll(pattern)) {
      let value = match[0];
      if (pattern === LOCATOR) value = value.replace(/[.,;!?]+$/u, '');
      cover(match.index, match.index + value.length);
    }
  }
  return { masked: chars.join(''), fencedLines };
}

function blocksOf(source, masked, fencedLines) {
  const blocks = [];
  const headings = [];
  let preamble = [];
  let block;

  function flush(beforeStructure = false) {
    if (!block) return;
    const text = source.slice(block.start, block.end).trim();
    if (text) {
      if (!block.list && !LEADING.test(text) && (text.endsWith(':') || (beforeStructure && !blocks.length))) {
        preamble = [...preamble, text.replace(/:$/u, '')];
      } else blocks.push(block);
    }
    block = undefined;
  }

  function begin(start, end, list = false) {
    block = { start, end, list, context: [...preamble, ...headings.map(({ text }) => text)] };
  }

  for (const line of masked.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const value = line[0].trimEnd();
    const start = line.index;
    const end = start + value.length;
    if (fencedLines.has(start)) {
      if (block) block.end = end;
      else begin(start, end);
      continue;
    }
    const heading = HEADING.exec(value);
    const list = LIST.exec(value);
    if (heading) {
      flush(true);
      const level = heading[1].length;
      while (headings.length && headings.at(-1).level >= level) headings.pop();
      const content = /^[\t ]*#+[\t ]+/u.exec(value)[0].length;
      const label = /^(?:task|step)\s+\d+\s*(?:[.:\-–—]\s*)?/iu.exec(value.slice(content))?.[0].length ?? 0;
      const text = source.slice(start + content + label, end);
      if (LEADING.test(text)) begin(start + content + label, end, true);
      else if (text) headings.push({ text, level });
    } else if (list) {
      flush(true);
      begin(start + list[0].length, end, true);
    } else if (value.trim() === '') flush();
    else if (block) block.end = end;
    else begin(start, end);
  }
  flush();
  return blocks;
}

function clauseOffsets(source, masked, block) {
  const bounds = [];
  const view = masked.slice(block.start, block.end);
  let start = block.start;
  let sequence = /^(first|next|then|finally)\b/iu.exec(view)?.[1].toLowerCase() ?? null;
  function push(end) {
    const raw = source.slice(start, end);
    const text = raw.trim();
    if (!text) return;
    const from = start + raw.length - raw.trimStart().length;
    bounds.push({ text, start: from, end: from + text.length, context: block.context, sequence });
  }
  for (const match of view.matchAll(SEPARATOR)) {
    const separator = match[0];
    // Bare whitespace within prose does not make the following verb an imperative.
    if (!/[,;.!?\n]/u.test(separator) && !match[1] && !match[2]) continue;
    ACTION_AT.lastIndex = match.index + separator.length;
    if (!ACTION_AT.test(view)) continue;
    const from = block.start + match.index;
    // A leading guard and its first unprotected comma belong to the same action.
    const prefix = masked.slice(start, from).trimStart();
    if (separator.startsWith(',') && !match[1] && !match[2] && GUARD.test(prefix) && !prefix.includes(',')) continue;
    push(from);
    start = from + separator.length;
    sequence = (match[2] ?? match[1] ?? '').toLowerCase();
    if (!['then', 'finally'].includes(sequence)) sequence = null;
  }
  push(block.end);
  return bounds;
}

function cluster(clauses) {
  const groups = [];
  const scope = clauses.map(({ text, context }) => JSON.stringify([context, DIRECTORY.exec(text)?.[0] ?? '']));
  let start = 0;
  while (start < clauses.length) {
    const remaining = MAX_SUBTASKS - groups.length;
    const ideal = Math.ceil((clauses.length - start) / remaining);
    let end = start + ideal;
    if (remaining > 1 && ideal > 1) {
      const earliest = start + 1;
      const latest = Math.min(clauses.length - remaining + 1, end + 1);
      const candidates = [];
      for (let cut = earliest; cut <= latest; cut += 1) {
        if (scope[cut - 1] !== scope[cut]) candidates.push(cut);
      }
      const boundary = candidates.sort((a, b) => Math.abs(a - end) - Math.abs(b - end) || a - b)[0];
      if (boundary !== undefined) end = boundary;
    }
    groups.push(clauses.slice(start, end));
    start = end;
  }
  return groups;
}

/** A bounded task list with stable IDs and the original spans of every clause. */
export function decomposePrompt(prompt) {
  const source = String(prompt ?? '');
  const { masked, fencedLines } = maskPrompt(source);
  const clauses = blocksOf(source, masked, fencedLines).flatMap((block) => clauseOffsets(source, masked, block))
    .map((clause, index) => ({ id: index + 1, ...clause }));
  const groups = clauses.length <= MAX_SUBTASKS ? clauses.map((clause) => [clause]) : cluster(clauses);
  return groups.map((group, index) => ({
    id: index + 1,
    text: group.map(({ text }) => text).join('\n'),
    context: [...new Set(group.flatMap(({ context }) => context))],
    clauseIds: group.map(({ id }) => id),
    clauses: group,
  }));
}
