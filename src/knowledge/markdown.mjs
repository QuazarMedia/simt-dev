// Markdown structure: lines, headings, fences, tables, links and the byte-ranged units a
// retriever ranks. Extracted from the section index so the parser can be tested on its
// own and the index stays about assembling the document.

import { createHash } from 'node:crypto';

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const SETEXT = /^ {0,3}(=+|-{2,})[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_SEQUENCE = /\s+#+\s*$/;
const LINK = /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;
const REFERENCE = /^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/;
const TOKEN = /[\p{L}\p{N}_]+/gu;
const DIVIDER_CELL = /^:?-{2,}:?$/;

/**
 * The anchor a heading title produces.
 *
 * NFKC first, so a title typed with a full-width or combining form matches the one a
 * reader links to. Letters and digits of any script survive: a non-Latin heading needs an
 * anchor as much as an ASCII one, and transliterating it would invent a spelling.
 *
 * @param {string} title
 * @returns {string}
 */
export function anchorOf(title) {
  const slug = normalise(String(title ?? ''))
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function normalise(text) {
  return String(text ?? '').normalize('NFKC');
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.length;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '\n' || text[i] === '\r') {
        end = i;
        break;
      }
    }
    lines.push({ text: text.slice(start, end), charStart: start, charEnd: end, byteStart: 0, byteEnd: 0 });
    if (end >= text.length) break;
    start = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1;
  }
  let bytes = 0;
  for (let i = 0; i < lines.length; i += 1) {
    lines[i].byteStart = bytes;
    lines[i].byteEnd = bytes + Buffer.byteLength(lines[i].text, 'utf8');
    bytes = lines[i].byteEnd + (i + 1 < lines.length ? lines[i + 1].charStart - lines[i].charEnd : 0);
  }
  return lines;
}

function atxTitle(raw) {
  return normalise(raw).replace(CLOSING_SEQUENCE, '').trim();
}

function isProse(text, fenced) {
  const trimmed = text.trim();
  if (fenced || trimmed === '') return false;
  return !/^(?:#{1,6}\s|[-*+>]\s|\d+[.)]\s|\|)/.test(trimmed);
}

/**
 * Structure in one pass per kind: fences decide what the other passes may look at.
 *
 * A heading inside a fence is code, which is why the fence pass runs first and the
 * heading, table and link passes skip every line it marked.
 */
function scanLines(lines) {
  const fenced = new Set();
  const headings = [];
  const tables = [];
  const links = [];
  const tableRows = new Set();
  const used = new Set();
  let open = null;

  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE.exec(lines[i].text);
    if (open) {
      fenced.add(i);
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length && fence[2].trim() === '') open = null;
      continue;
    }
    if (fence) {
      open = { char: fence[1][0], length: fence[1].length };
      fenced.add(i);
      continue;
    }
    const atx = ATX.exec(lines[i].text);
    if (atx) {
      headings.push({ level: atx[1].length, title: atxTitle(atx[2]), lineStart: i, lineEnd: i });
      continue;
    }
    const setext = SETEXT.exec(lines[i].text);
    if (setext && i > 0 && !used.has(i - 1) && isProse(lines[i - 1].text, fenced.has(i - 1))) {
      used.add(i - 1);
      headings.push({ level: setext[1][0] === '=' ? 1 : 2, title: normalise(lines[i - 1].text).trim(), lineStart: i - 1, lineEnd: i });
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (fenced.has(i)) continue;
    const text = lines[i].text;
    if (!tableRows.has(i) && i + 1 < lines.length && !fenced.has(i + 1) && isTableHeader(text, lines[i + 1].text)) {
      let end = i + 1;
      while (end + 1 < lines.length && !fenced.has(end + 1) && lines[end + 1].text.includes('|') && lines[end + 1].text.trim() !== '') end += 1;
      tables.push({ header: cells(text), lineStart: i, lineEnd: end, byteStart: lines[i].byteStart, byteEnd: lines[end].byteEnd });
      for (let row = i; row <= end; row += 1) tableRows.add(row);
    }
    LINK.lastIndex = 0;
    let match;
    while ((match = LINK.exec(text)) !== null) {
      links.push({
        text: normalise(match[2]),
        target: match[3] ?? match[4],
        image: match[1] === '!',
        kind: 'inline',
        line: i,
        byteStart: lines[i].byteStart + Buffer.byteLength(text.slice(0, match.index), 'utf8'),
      });
    }
    const reference = REFERENCE.exec(text);
    if (reference) {
      links.push({
        text: normalise(reference[1]),
        target: reference[2] ?? reference[3],
        image: false,
        kind: 'definition',
        line: i,
        byteStart: lines[i].byteStart + Buffer.byteLength(text.slice(0, reference.index), 'utf8'),
      });
    }
  }
  return { fenced, headings, tables, links };
}

function cells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableHeader(header, divider) {
  if (!header.includes('|') || !divider.includes('|')) return false;
  const own = cells(header);
  const rule = cells(divider);
  if (own.length < 2 || own.length !== rule.length) return false;
  return rule.every((cell) => DIVIDER_CELL.test(cell));
}

/** Anchors, parents and heading paths, in one forward pass with a level stack. */
function withAnchors(headings, lines) {
  const seen = new Map();
  const stack = [];
  return headings.map((heading) => {
    const base = anchorOf(heading.title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const anchor = count === 0 ? base : `${base}-${count}`;
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    const record = {
      level: heading.level,
      title: heading.title,
      anchor,
      parent: parent ? parent.anchor : null,
      path: [...(parent ? parent.path : []), heading.title],
      line: heading.lineStart,
      lineStart: heading.lineStart,
      lineEnd: heading.lineEnd,
      byteStart: lines[heading.lineStart].byteStart,
      byteEnd: lines[heading.lineEnd].byteEnd,
    };
    stack.push(record);
    return record;
  });
}

function sectionsOf(headings, lines, bytes) {
  const sections = [];
  const contentOf = (heading) => (heading.lineEnd + 1 < lines.length ? lines[heading.lineEnd + 1].byteStart : bytes);
  if (headings.length === 0) {
    return [section('', '', 0, null, [], 0, lines.length, 0, bytes, 0, bytes)];
  }
  if (headings[0].byteStart > 0 && lines.slice(0, headings[0].lineStart).some((line) => line.text.trim() !== '')) {
    sections.push(section('', '', 0, null, [], 0, headings[0].lineStart, 0, headings[0].byteStart, 0, headings[0].byteStart));
  }
  // One span per heading, ending at the next heading of any level. A section that also
  // carried its children would index those bytes twice and every retrieval would answer
  // with the parent as well; ancestry is `parent` and `path`, not bytes.
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const next = headings[i + 1];
    const end = next ? next.byteStart : bytes;
    const endLine = next ? next.lineStart : lines.length;
    sections.push(
      section(heading.anchor, heading.title, heading.level, heading.parent, heading.path, heading.lineStart, endLine, heading.byteStart, end, contentOf(heading), end),
    );
  }
  return sections;
}

function section(anchor, title, level, parent, path, lineStart, lineEnd, byteStart, byteEnd, contentByteStart, contentByteEnd) {
  return { id: anchor || 'preamble', anchor, title, level, parent, path, lineStart, lineEnd, byteStart, byteEnd, contentByteStart, contentByteEnd };
}

function attribute(links, sections) {
  return links.map((link) => {
    let anchor = sections.length > 0 ? sections[0].anchor : '';
    for (const section of sections) {
      if (section.byteStart <= link.byteStart) anchor = section.anchor;
      else break;
    }
    return { ...link, section: anchor };
  });
}

/** Paragraph-sized pieces of one section, split further only where a line is too big. */
function blocksOf(lines, from, to, fenced) {
  const blocks = [];
  let current = null;
  for (let i = from; i < to; i += 1) {
    const blank = lines[i].text.trim() === '' && !fenced.has(i);
    if (blank) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { lineStart: i, lineEnd: i };
      blocks.push(current);
    } else {
      current.lineEnd = i;
    }
  }
  return blocks;
}

function piecesOf(block, lines, unitBytes) {
  const pieces = [];
  let groupStart = null;
  const flush = (endLine) => {
    if (groupStart !== null && endLine >= groupStart) pieces.push(pieceOf(lines, groupStart, endLine, 0, null));
    groupStart = null;
  };
  for (let i = block.lineStart; i <= block.lineEnd; i += 1) {
    const line = lines[i];
    if (line.byteEnd - line.byteStart > unitBytes) {
      flush(i - 1);
      splitLongLine(lines, i, unitBytes, pieces);
      continue;
    }
    if (groupStart !== null && line.byteEnd - lines[groupStart].byteStart > unitBytes) flush(i - 1);
    if (groupStart === null) groupStart = i;
  }
  flush(block.lineEnd);
  return pieces;
}

/**
 * One line longer than a unit, cut at a character boundary.
 *
 * A byte offset in the middle of a UTF-8 sequence is not a string anybody can re-encode,
 * and a reported range that cannot be sliced is not an anchor.
 */
function splitLongLine(lines, index, unitBytes, pieces) {
  const line = lines[index];
  let offset = 0;
  while (offset < line.text.length) {
    let end = offset + 1;
    while (end < line.text.length && Buffer.byteLength(line.text.slice(offset, end + 1), 'utf8') <= unitBytes) end += 1;
    pieces.push(pieceOf(lines, index, index, offset, end));
    offset = end;
  }
}

function pieceOf(lines, lineStart, lineEnd, charFrom, charTo) {
  const first = lines[lineStart];
  const last = lines[lineEnd];
  const charStart = first.charStart + charFrom;
  const charEnd = charTo === null ? last.charEnd : last.charStart + charTo;
  const byteStart = first.byteStart + Buffer.byteLength(first.text.slice(0, charFrom), 'utf8');
  const byteEnd = charTo === null ? last.byteEnd : last.byteStart + Buffer.byteLength(last.text.slice(0, charTo), 'utf8');
  return { lineStart, lineEnd, charStart, charEnd, byteStart, byteEnd };
}

function unitsOf(section, { lines, source, fenced, tables, unitBytes, overlapBytes }) {
  const blocks = blocksOf(lines, section.lineStart, section.lineEnd, fenced);
  const pieces = blocks.flatMap((block) => piecesOf(block, lines, unitBytes));
  const units = [];
  let index = 0;
  while (index < pieces.length) {
    const group = [pieces[index]];
    index += 1;
    // Measured as one span, not as a sum of piece sizes: the separator between two
    // paragraphs is a byte like any other, and a budget that ignores it is overrun.
    while (index < pieces.length && pieces[index].byteEnd - group[0].byteStart <= unitBytes) {
      group.push(pieces[index]);
      index += 1;
    }
    const first = group[0];
    const last = group[group.length - 1];
    const text = source.slice(first.charStart, last.charEnd);
    units.push({
      id: `${section.id}#${units.length}`,
      anchor: section.anchor,
      title: section.title,
      headings: section.path,
      lineStart: first.lineStart,
      lineEnd: last.lineEnd,
      byteStart: first.byteStart,
      byteEnd: last.byteEnd,
      bytes: Buffer.byteLength(text, 'utf8'),
      digest: `sha256-${createHash('sha256').update(text, 'utf8').digest('hex')}`,
      tableHeaders: tables.filter((table) => table.byteStart < first.byteStart && table.byteEnd > first.byteStart).map((table) => table.header),
      text,
    });
    const next = pieces[index];
    if (next && last.byteEnd - last.byteStart <= overlapBytes && next.byteEnd - last.byteStart <= unitBytes) {
      index -= 1;
    }
  }
  return units;
}

export { TOKEN, normalise, splitLines, scanLines, withAnchors, sectionsOf, unitsOf, attribute };
