// The one JSON document a read-only door interrogates.
//
// Four doors take a document instead of deriving one from the tree, and each needs the same
// four answers: where the bytes come from, whether `-` means stdin, what a parse failure says,
// and what a document that is not an object means. Answered once, the doors cannot disagree
// about it, and a reader learns the convention a single time.

import { readFile } from 'node:fs/promises';

/** A knowledge or journal document larger than this is a mistake, not an input. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/**
 * Read stdin as text, refusing anything past `limit` rather than buffering it.
 *
 * @param {number} [limit]
 * @returns {Promise<{text?: string, error?: string}>}
 */
async function readStdinText(limit = MAX_DOCUMENT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) return { error: `the input on stdin is over the ${limit} byte ceiling` };
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Read and parse the object a flag names. `-` is stdin.
 *
 * @param {object} flags
 * @param {string} flag
 * @returns {Promise<{doc?: object, error?: string}>}
 */
export async function readJsonDocument(flags, flag) {
  const named = flags[flag];
  if (named === undefined) return { error: `--${flag} needs a file, or - for stdin` };
  let text;
  if (named === '-') {
    const read = await readStdinText();
    if (read.error !== undefined) return { error: read.error };
    text = read.text;
  } else {
    try {
      text = await readFile(named, 'utf8');
    } catch (error) {
      return { error: `cannot read --${flag} ${named}: ${error.code ?? error.message}` };
    }
  }
  if (text.length > MAX_DOCUMENT_BYTES) {
    return { error: `--${flag} ${named === '-' ? 'on stdin' : named} is over the ${MAX_DOCUMENT_BYTES} byte ceiling` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { error: `--${flag} is not JSON (${error.message})` };
  }
  if (doc === null || typeof doc !== 'object') return { error: `--${flag} must hold a JSON object or array` };
  return { doc };
}
