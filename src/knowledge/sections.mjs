// Sections, chunks and links of a document, as units a retriever can rank.
//
// The index samples a document's first 24,000 characters and up to 600 distinct ASCII
// tokens, so material after that point was unreachable, and a heading inside a fenced
// block was indistinguishable from a section boundary. Both are properties of the file,
// not of a budget, so they are parsed here once: the same bytes give the same units on
// every machine, with no dependency, no model and no network.
//
// Ranges are bytes, because the index stores bytes and a range that mixes characters with
// bytes names a different span on every non-ASCII document.
//
// A format this package cannot read is returned as `unindexed` with a reason. An empty
// unit list is not the same answer: a parser that says nothing looks exactly like a
// document with nothing in it, and only one of the two is safe to verify against.

import { createHash } from 'node:crypto';
import { TOKEN, anchorOf, attribute, normalise, scanLines, sectionsOf, splitLines, unitsOf, withAnchors } from './markdown.mjs';
export { anchorOf };

export const SECTIONS_SCHEMA_VERSION = 1;

const DEFAULT_UNIT_BYTES = 4096;
const DEFAULT_OVERLAP_BYTES = 256;

/** Formats no extractor here reads. Converters, when they exist, land as adapters. */
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.odt', '.ppt', '.pptx', '.xls', '.xlsx',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.wav',
]);



/**
 * The sections, chunks, tables and links of one document.
 *
 * @param {string} text
 * @param {{path?: string, unitBytes?: number, overlapBytes?: number}} [options]
 * @returns {object}
 */
export function extractDocument(text, options = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const path = String(options.path ?? '');
  const unitBytes = byteOption(options.unitBytes, DEFAULT_UNIT_BYTES, 'unitBytes');
  const overlapBytes = Math.min(byteOption(options.overlapBytes, DEFAULT_OVERLAP_BYTES, 'overlapBytes'), Math.max(0, unitBytes - 1));
  const bytes = Buffer.byteLength(source, 'utf8');
  const base = {
    version: SECTIONS_SCHEMA_VERSION,
    path,
    bytes,
    headings: [],
    sections: [],
    tables: [],
    links: [],
    units: [],
    unindexed: null,
  };
  const reason = unindexableReason(path, source);
  if (reason) return { ...base, unindexed: { reason, path } };

  const lines = splitLines(source);
  const scan = scanLines(lines);
  const headings = withAnchors(scan.headings, lines);
  const sections = sectionsOf(headings, lines, bytes);
  const units = sections.flatMap((section) => unitsOf(section, { lines, source, fenced: scan.fenced, tables: scan.tables, unitBytes, overlapBytes }));
  return {
    ...base,
    headings: headings.map(({ level, title, anchor, parent, path: headingPath, line, byteStart, byteEnd }) => ({
      level,
      title,
      anchor,
      parent,
      path: headingPath,
      line,
      byteStart,
      byteEnd,
    })),
    sections,
    tables: scan.tables.map(({ header, lineStart, lineEnd, byteStart, byteEnd }) => ({ header, lineStart, lineEnd, byteStart, byteEnd })),
    links: attribute(scan.links, sections),
    units,
  };
}

/**
 * Rank units against a query, deterministically.
 *
 * The score is the share of the query's distinct tokens the unit carries, and the ties
 * break on the shorter unit and then on position. There is no model in this path and no
 * corpus-wide statistic: a plan asks for an answer a pull request can diff, and an IDF
 * term makes every score move whenever any other document changes.
 *
 * @param {object[]} units
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {object[]} matching units, best first, each with its `score`
 */
export function searchUnits(units, query, { limit = 10 } = {}) {
  const wanted = [...new Set(tokensOf(query))];
  if (wanted.length === 0) return [];
  const scored = [];
  for (const unit of Array.isArray(units) ? units : []) {
    const own = new Set(tokensOf(haystackOf(unit)));
    let hits = 0;
    for (const token of wanted) if (own.has(token)) hits += 1;
    if (hits === 0) continue;
    scored.push({ ...unit, score: hits / wanted.length });
  }
  scored.sort((a, b) => b.score - a.score || a.bytes - b.bytes || a.byteStart - b.byteStart);
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : scored.length;
  return scored.slice(0, cap);
}

/** The heading path and table header travel with a unit, so a bare row can be read. */
function haystackOf(unit) {
  const headings = (unit.headings ?? []).join(' ');
  const tables = (unit.tableHeaders ?? []).map((header) => header.join(' ')).join(' ');
  return `${headings} ${tables} ${unit.text ?? ''}`;
}

function tokensOf(text) {
  return normalise(String(text ?? '')).toLowerCase().match(TOKEN) ?? [];
}


function byteOption(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number of bytes`);
  return Math.floor(number);
}

function unindexableReason(path, source) {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const extension = dot > slash ? path.slice(dot).toLowerCase() : '';
  if (BINARY_EXTENSIONS.has(extension)) return 'unsupported-binary';
  if (source.includes('\0')) return 'binary-content';
  return null;
}

/**
 * Lines with their character and byte offsets.
 *
 * A CRLF terminator counts once, in neither the line's text nor its range, so a document
 * checked out on Windows names the same bytes as the same document checked out on Linux.
 */
