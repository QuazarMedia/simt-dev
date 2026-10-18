// Who a change reaches (R23, ADR-096).
//
// Reverse dependents, the tests that import them, the owners a CODEOWNERS
// line names, and another repository that references a contract this change
// touches. The walk stops at a fixed count: an unbounded report is not an
// answer a reader can use.

import { isTestPath } from '../bench/mine.mjs';
import { selectTests } from './gate.mjs';

const IMPACT_LIMIT = 64;

const CONTRACT_EXT = new Set(['json', 'yaml', 'yml']);

/**
 * Non-test files that import `file`, directly or through other files, and the
 * tests that import that closure. Past the limit, the rest is reported as
 * truncated rather than dropped silently.
 *
 * @param {string} file
 * @param {{src: string, dst: string, kind?: string}[]} imports
 * @param {number} [limit]
 */
export function dependents(file, imports, limit = IMPACT_LIMIT) {
  const reverse = new Map();
  for (const edge of imports) {
    if (edge.kind && edge.kind !== 'import') continue;
    const list = reverse.get(edge.dst);
    if (list) list.push(edge.src);
    else reverse.set(edge.dst, [edge.src]);
  }
  const importers = [];
  const seen = new Set([file]);
  const queue = [file];
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    const next = reverse.get(current);
    if (!next) continue;
    for (const src of next) {
      if (seen.has(src)) continue;
      seen.add(src);
      if (isTestPath(src)) continue;
      if (importers.length >= limit) {
        truncated = true;
        continue;
      }
      importers.push(src);
      queue.push(src);
    }
  }
  importers.sort();
  const tests = selectTests([file], imports).filter((path) => path !== file);
  const shown = tests.length > limit ? tests.slice(0, limit) : tests;
  if (tests.length > limit) truncated = true;
  return { importers, tests: shown, truncated };
}

/** Files that export `name`. A private symbol is not an export. */
export function filesExporting(name, symbols) {
  const found = new Set();
  for (const symbol of symbols) {
    if (symbol.exported && symbol.name === name) found.add(symbol.path);
  }
  return [...found].sort();
}

/**
 * The last matching CODEOWNERS pattern wins, which is the rule the file is
 * read under. A pattern with no slash matches the file name in any directory.
 *
 * @param {string} text
 * @param {string} file
 * @returns {string[]}
 */
export function ownersOf(text, file) {
  let owners = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern || !matchPattern(pattern, file)) continue;
    owners = parts.slice(1).filter((part) => part.startsWith('@') || part.includes('@'));
  }
  return owners;
}

/** A path that is a contract by name: OpenAPI, or a JSON Schema file. */
export function isContractPath(file) {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'openapi.json' || base === 'openapi.yaml' || base === 'openapi.yml') return true;
  if (base.endsWith('.schema.json')) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return CONTRACT_EXT.has(base.slice(dot + 1)) && base.includes('schema');
}

/**
 * Contracts this change can reach: the file itself, a dependent, or a contract
 * whose text names the file or the export.
 *
 * @param {{path: string, text: string}[]} contracts
 * @param {{file: string, symbol: string, importers: string[]}} target
 */
export function relatedContracts(contracts, { file, symbol, importers }) {
  const reached = new Set([file, ...importers]);
  const related = [];
  for (const contract of contracts) {
    if (reached.has(contract.path) || names(contract.text, file, symbol)) related.push(contract.path);
  }
  related.sort();
  return related;
}

/**
 * Files in other repositories whose text contains a contract path. The path
 * has to include a directory, so a bare filename is not a reference.
 *
 * @param {string[]} contracts repo-relative contract paths
 * @param {string} repoName the repository that owns the contracts
 * @param {{repo: string, path: string, text: string}[]} files
 * @param {number} [limit]
 */
export function contractReferences(contracts, repoName, files, limit = IMPACT_LIMIT) {
  const needles = [];
  for (const contract of contracts) {
    if (!contract.includes('/')) continue;
    needles.push({ contract, needle: contract });
    if (repoName) needles.push({ contract, needle: `${repoName}/${contract}` });
  }
  const found = [];
  let truncated = false;
  const seen = new Set();
  for (const file of files) {
    for (const item of needles) {
      if (!file.text.includes(item.needle)) continue;
      const key = `${file.repo}\0${file.path}\0${item.contract}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (found.length >= limit) {
        truncated = true;
        continue;
      }
      found.push({ repo: file.repo, path: file.path, contract: item.contract });
    }
  }
  found.sort((a, b) => cmp(a.repo, b.repo) || cmp(a.path, b.path) || cmp(a.contract, b.contract));
  return { references: found, truncated };
}

function names(text, file, symbol) {
  if (file && text.includes(file)) return true;
  if (!symbol) return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function matchPattern(pattern, file) {
  let pat = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const directory = pat.endsWith('/');
  if (directory) pat = pat.slice(0, -1);
  if (pat === '') return false;
  if (!pat.includes('/')) {
    if (directory) return file === pat || file.startsWith(`${pat}/`) || file.split('/').includes(pat);
    const base = file.slice(file.lastIndexOf('/') + 1);
    return glob(pat, base);
  }
  if (directory) return file === pat || file.startsWith(`${pat}/`);
  return glob(pat, file);
}

function glob(pattern, text) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${body}$`).test(text);
}

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
