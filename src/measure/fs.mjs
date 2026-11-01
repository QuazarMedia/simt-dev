// The four filesystem answers both meters ask, in one place.
//
// `tokens` and `harness loaders` each carried a `bytes`, a `frontmatter`, a `filesUnder`
// and a `readText`, and they disagreed: one kept dotfiles and the other skipped them, one
// stopped a frontmatter block at `---` and the other at any line that trims to it, one
// walked six levels and the other eight. Each difference is a byte count that depends on
// which command produced it, in the two commands whose entire claim is that they count.
//
// A caller passes the behaviour it means rather than inheriting a copy: `skipDotfiles` is
// false for a loader walk (a `.md` inside `.agents/rules/` is a rule) and true for the
// surface walk (`tokens` never billed a dotfile), and both say so at the call site.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { extractFrontmatter } from '../projection/targets.mjs';

/** UTF-8 byte length. `String.length` counts UTF-16 units and undercounts every
 *  non-ASCII character, and a rule file with an em dash in it is ordinary. */
export function bytes(text) {
  return Buffer.byteLength(text);
}

/**
 * Frontmatter as a flat object. One block, no nesting — all a rule file carries.
 *
 * The closing fence is matched after trimming: `--- ` with a trailing space closes the
 * block, and treating it as content is how one meter came to read a YAML line as a key.
 */
export function frontmatter(text) {
  const block = extractFrontmatter(text);
  const out = {};
  if (!block) return out;
  for (const line of block.split('\n').slice(1)) {
    if (line.trim() === '---') break;
    const at = line.indexOf(':');
    if (at < 1) continue;
    out[line.slice(0, at).trim()] = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

/** The file's text, or null when it cannot be read.
 *
 *  Absence is the expected answer for a surface a repository selected but has not written
 *  yet, and a permission error is not a byte count either: both mean "nothing to measure
 *  here", which the caller states as zero rather than as a failure. */
export async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Files under an absolute directory, in a stable order, as paths relative to it.
 *
 * `maxDepth` bounds the recursion — a stray `node_modules` inside a tool-owned directory
 * must not turn a byte count into an unbounded walk — and `suffix` filters what counts as
 * a file of the kind being measured.
 */
export async function filesUnder(dir, { suffix = null, maxDepth = 8, skipDotfiles = false } = {}) {
  return walk(dir, '', 0, { suffix, maxDepth, skipDotfiles });
}

async function walk(dir, prefix, depth, { suffix, maxDepth, skipDotfiles }) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (skipDotfiles && entry.name.startsWith('.')) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth >= maxDepth) continue;
      out.push(...(await walk(join(dir, entry.name), rel, depth + 1, { suffix, maxDepth, skipDotfiles })));
    } else if (entry.isFile() && (suffix === null || entry.name.endsWith(suffix))) {
      out.push(rel);
    }
  }
  return out;
}
