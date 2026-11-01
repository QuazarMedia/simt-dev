// The one frontmatter block: an opening `---` line, a body, a closing `---` line,
// at the top of a document.
//
// Eleven call sites carried their own copy of the regex, and the copies disagreed
// about CRLF: two tolerated `\r\n`, nine assumed `\n`, so a document checked out
// with CRLF line endings parsed in one command and came back with the block glued
// to the body in another. The shape here is the superset: it tolerates CRLF, and it
// fixes what "the block" is, so a caller that asks for the block, the body or the
// stripped document gets all three from one match.

/** The block as written: the two `---` lines and what is between them. The line
 *  ending after the closing `---` is NOT part of the block, because a caller that
 *  swaps the block in place must leave that newline where the file had it. */
const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Split a leading frontmatter block from its document.
 *
 * @param {string} text
 * @returns {{front: string|null, body: string, block: string|null}}
 *   `front` is the interior between the `---` lines, `block` is the block as written,
 *   and `body` is the document after the block and the one line ending that follows
 *   it. All three are null-or-unchanged when the document carries no block.
 */
export function parseFrontmatter(text) {
  const raw = String(text ?? '');
  const m = BLOCK.exec(raw);
  if (!m) return { front: null, body: raw, block: null };
  const rest = raw.slice(m[0].length);
  const body = rest.startsWith('\r\n') ? rest.slice(2) : rest.startsWith('\n') ? rest.slice(1) : rest;
  return { front: m[1], body, block: m[0] };
}

/** The block as written, or null when the document carries none. */
export function frontmatterBlock(text) {
  const m = BLOCK.exec(String(text ?? ''));
  return m ? m[0] : null;
}

/**
 * The document without its block, and without the line endings that followed it.
 *
 * The trailing-newline swallow lives here rather than in BLOCK on purpose: a strip
 * that left the blank lines in place would send a following `^`-anchored strip (the
 * H1 a region renderer drops) at a bare newline, and it would silently match nothing.
 */
export function stripFrontmatter(text) {
  return String(text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/, '');
}
