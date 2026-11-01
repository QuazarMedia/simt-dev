// Small file and output helpers with two or more call sites, too small to earn
// a module apiece.

import { readFile } from 'node:fs/promises';

/** Read a file as UTF-8, answering null when it is not there. */
export async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** `1234567`, never `1,234,567`: two machines must print the same bytes (ADR-013).
 *  `toLocaleString` output is locale-dependent, and these commands exist so that two
 *  machines produce two numbers a pull request can compare. */
export function plainNumber(n) {
  return String(n);
}
