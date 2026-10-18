// Which tests a change should run (R16, ADR-094).
//
// A test is selected when an import reaches a changed file, directly or through
// other files. The walk follows importers, so a test that imports a module that
// imports the change is included, and a cycle cannot. Naming and co-change are
// not imports, so they are not a selection.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isTestPath } from '../bench/mine.mjs';
import { importsOf } from './tests.mjs';

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', kt: 'kotlin', kts: 'kotlin', java: 'java',
  py: 'python', go: 'go', rs: 'rust', swift: 'swift', dart: 'dart', rb: 'ruby', cs: 'csharp',
};

/**
 * Test files that import one of `changed`, directly or through other files.
 * A changed file that is itself a test is included: the edit is the test.
 *
 * @param {Iterable<string>} changed
 * @param {{src: string, dst: string, kind?: string}[]} imports importer, then imported
 * @returns {string[]}
 */
export function selectTests(changed, imports) {
  const reverse = new Map();
  for (const edge of imports) {
    if (edge.kind && edge.kind !== 'import') continue;
    const list = reverse.get(edge.dst);
    if (list) list.push(edge.src);
    else reverse.set(edge.dst, [edge.src]);
  }
  const seen = new Set();
  const tests = [];
  const queue = [];
  for (const file of changed) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    queue.push(file);
  }
  while (queue.length > 0) {
    const file = queue.pop();
    if (isTestPath(file)) tests.push(file);
    const importers = reverse.get(file);
    if (!importers) continue;
    for (const importer of importers) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  tests.sort();
  return tests;
}

/** Import edges for the texts the caller already read. One pass, no second parse. */
export function importEdges(entries) {
  const files = new Set(entries.map((entry) => entry.path));
  const imports = [];
  for (const entry of entries) {
    if (!entry.lang || !entry.text) continue;
    imports.push(...importsOf(entry.path, entry.text, entry.lang, files));
  }
  return imports;
}

/** Import edges for tracked paths, read from the worktree. A missing file contributes none. */
export async function readImportEdges(root, files) {
  const entries = [];
  const paths = [...files].sort();
  const batch = 32;
  for (let i = 0; i < paths.length; i += batch) {
    const slice = paths.slice(i, i + batch);
    const read = await Promise.all(slice.map(async (path) => {
      const lang = langOf(path);
      if (!lang) return { path, text: '', lang: '' };
      try {
        return { path, text: await readFile(join(root, path), 'utf8'), lang };
      } catch {
        return { path, text: '', lang };
      }
    }));
    entries.push(...read);
  }
  return importEdges(entries);
}

function langOf(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return LANG[base.slice(dot + 1)] ?? '';
}
