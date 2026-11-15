// The one place a JSON result becomes the document a caller sees.
//
// `dispatch` added `exitCode`, `ok` and `deprecated` at one call site; `run` returned the
// sink's documents untouched, so a library caller saw a document with no exit code and
// no record that a flag it passed was superseded. Two code paths for one envelope is how
// the CLI and the library disagree about the same command.
//
// A stream of documents keeps its shape: there is no single place for one exit code, and
// collapsing it would silently drop rows. The process exit still carries the code.

import { EXIT } from './index.mjs';

/**
 * @param {unknown[]} documents the values the command produced, in order
 * @param {{code: number, deprecated?: Record<string, string>}} ctx `code` is what the
 *   command returned; `deprecated` maps a superseded flag to what answers it now
 * @returns {{documents: unknown[], code: number, single: boolean}}
 */
export function finaliseJson(documents, { code, deprecated } = {}) {
  const only = documents[0];
  const single = documents.length === 1 && only !== null && typeof only === 'object' && !Array.isArray(only);
  if (!single) return { documents, code, single: false };

  const doc = { ...only, ok: only.ok ?? code === EXIT.OK, exitCode: code };
  if (deprecated !== undefined && Object.keys(deprecated).length > 0) doc.deprecated = deprecated;

  // A document that could not fit its own ceiling says so and the handler still returns
  // EXIT.OK: emitting it changed the answer, so the process must not claim success.
  const exit = doc.ok === false && doc.error?.code === 'MAX_BYTES' ? EXIT.FAIL : code;
  return { documents: [{ ...doc, exitCode: exit }], code: exit, single: true };
}
