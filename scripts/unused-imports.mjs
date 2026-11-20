#!/usr/bin/env node
// A zero-install detector for unused imports, the import-side twin of
// test/deadcode.test.mjs (which guards exports). It walks the same trees the
// package ships and names any imported binding that nothing in its own file
// reads. It is a guard, not a fixer: it reports and exits non-zero so a test can
// hold the line, and the precise repair is `npm run lint:imports` (ESLint, a
// devDependency that runs in a checkout and never in the shipped bytes, so
// ADR-012's zero-runtime-dependency rule is untouched).
//
// The check is deliberately conservative in the direction that keeps a clean
// tree green: a binding counts as used if its name appears anywhere in the file
// body outside the import statements — including in a string. That trades a few
// misses for no false alarms; a name this tool only ever passes to a string is
// rarer than the drift an import nobody reads, and ESLint catches the former
// precisely when it is run.
//
// Comments are stripped *before* the import statements are located, because a
// comment that says "an import from a file" would otherwise open a bogus
// statement match that swallows the code between it and the next real
// `from '…'` — which is how a used binding reads as dead.

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const TREES = ['src', 'packages', 'bin', 'test', 'scripts'];

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      await walk(path, out);
    } else if (entry.name.endsWith('.mjs')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The source with its comments removed. Walking the characters rather than
 * regexing keeps a `//` inside a string from being read as a comment, and a quote
 * inside a comment from closing a string. With `blankStrings` the string
 * contents are reduced to an empty literal — leaving the delimiters so an import
 * statement's shape survives — so an `import … from '…'` that merely appears
 * *inside* a string (the test fixtures do this) is no longer mistaken for one.
 */
function stripComments(text, blankStrings = false) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < text.length) i++;
      out += blankStrings ? quote + quote : text.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The local names a single import clause binds. `type` prefixes are stripped; an
 * `a as b` binds `b`; a leading bare identifier is a default import.
 */
function parseClause(clause) {
  const names = [];
  clause = clause.replace(/^type\s+/, '').trim();
  const named = clause.match(/\{([\s\S]*?)\}/);
  if (named) {
    for (const part of named[1].split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const m = t.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (m) names.push(m[2] || m[1]);
    }
  }
  const ns = clause.match(/^\*\s*as\s+([\w$]+)$/);
  if (ns) names.push(ns[1]);
  const rest = clause
    .replace(/\{[\s\S]*?\}/, ' ')
    .replace(/\*\s*as\s+[\w$]+/, ' ')
    .trim();
  if (/^[\w$]+$/.test(rest)) names.push(rest);
  return names;
}

/**
 * The imported bindings of comment-free source: the local name of each binding in
 * each `import … from '…'`. `import '…'` on its own carries no binding.
 */
function importedBindings(code) {
  const names = [];
  const withClause = /import\b\s+([\s\S]*?)\s*from\s*(['"][^'"]*['"])/g;
  for (const m of code.matchAll(withClause)) {
    for (const name of parseClause(m[1])) names.push(name);
  }
  return names;
}

/**
 * A binding is used if its name occurs more than once in the file: once in its
 * own import, at least once in the code or a string. Counting occurrences
 * rather than parsing the body keeps an import referenced only from a fixture
 * string from reading as dead; counting the comment-stripped text (strings
 * intact) keeps a name that is merely *mentioned* in a comment from hiding a
 * dead import.
 */
function useCount(name, code) {
  return [...code.matchAll(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'))].length;
}

async function main() {
  // With a path argument the script checks just that file, which is how a test
  // exercises the dirty case against a throwaway file instead of the tree.
  const files = [];
  if (process.argv[2]) {
    files.push(resolve(ROOT, process.argv[2]));
  } else {
    for (const tree of TREES) await walk(join(ROOT, tree), files);
  }

  const unused = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // Bindings are enumerated from a skeleton whose strings are blanked, so an
    // import that lives only inside a fixture string is not counted; uses are
    // counted against the comment-stripped text, where those strings are real
    // but a comment's mention of a name is not a use of it.
    const skeleton = stripComments(text, true);
    const code = stripComments(text);
    const seen = new Set();
    for (const name of importedBindings(skeleton)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (useCount(name, code) < 2) unused.push(`${file.replace(`${ROOT}/`, '')}: ${name}`);
    }
  }

  if (unused.length > 0) {
    for (const line of unused) console.log(line);
    console.log(`${unused.length} unused import${unused.length === 1 ? '' : 's'}. Repair with: npm run lint:imports`);
    process.exitCode = 1;
  } else {
    console.log(`clean: ${files.length} file${files.length === 1 ? '' : 's'}, no unused imports`);
  }
}

await main();
