// One reader's view of one repository: which files it loads before the first message,
// in what order, and what the cap leaves out.
//
// This is the consumer R14 was built for. Before the loader table, `simt tokens` counted
// the files a surface WRITES — which is why it recursed six levels into `.agents/rules/`
// and reported bytes Antigravity never reads, and why it could not see a repository that
// is inside 32 KiB in every file and past it once Codex merges the chain.
//
// What it deliberately does not do:
//
//   1. Walk the user's home. A reader's global instructions are the reader's, not the
//      repository's, and a per-repository report that carried them would change because
//      somebody installed something. `scopes` reports that a user scope exists; the bytes
//      are the repository's.
//   2. Decide whether a file matches. `frontmatter` in the table is an equality filter
//      on parsed frontmatter, which is all any of these vendors document. Cursor's
//      `alwaysApply: true` and Antigravity's `trigger: always_on` are exactly that.
//   3. Expand imports. Claude's `@path` and Antigravity's `@[label](path)` are recorded
//      with their depth, and `imports` reports what the reader would pull in — a
//      measurement of the syntax, not a recursive parse of the file that would need a
//      frontmatter-aware Markdown parser this package does not have (ADR-012).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { LOADERS, caps } from '../projection/loaders.mjs';
import { extractFrontmatter } from '../projection/targets.mjs';
import { BYTES_PER_TOKEN } from './context.mjs';

/**
 * The longest directory walk any of these readers documents.
 *
 * A bound, not a guess about nesting: a stray `node_modules` inside a tool-owned
 * directory must not turn a byte count into an unbounded walk.
 */
const MAX_DEPTH = 8;

/** UTF-8 byte length. `String.length` counts UTF-16 units and undercounts every
 *  non-ASCII character, and a rule file with an em dash in it is ordinary. */
function bytes(text) {
  return Buffer.byteLength(text);
}

/** Frontmatter as a flat object. One block, no nesting — all a rule file carries. */
function frontmatter(text) {
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

/**
 * Files under a directory in a stable order.
 *
 * `depth` bounds the recursion. Nothing here filters dotfiles: a reader that documented
 * ignoring them is not one whose docs were read, and a `.md` inside `.agents/rules/` is
 * a rule.
 */
async function filesUnder(dir, depth = 0, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth >= MAX_DEPTH) continue;
      out.push(...(await filesUnder(join(dir, entry.name), depth + 1, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Absence is the expected answer for a reader configured in a repository that has
    // not written the file yet, and a permission error is not a byte count either.
    return null;
  }
}

async function exists(root, rel) {
  try {
    return (await stat(join(root, rel))).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve one `start` entry into the repository files it loads.
 *
 * `chain` is the case that needs care and gets it: Codex takes at most one file per
 * directory in precedence order, and the entries are the precedence list. Each entry is
 * resolved separately and the first one present wins per directory, which is the rule as
 * documented rather than as inferred — but the entries carry the same root, so the merge
 * is over the same directory set and the winner is the entry order in the table.
 *
 * Returns `[]` for an entry whose documented precondition fails: `absent` names paths
 * that must not exist, so `CLAUDE.md` beside `AGENTS.md` is exactly what makes Claude
 * Code skip the latter.
 */
async function resolveEntry(root, entry) {
  if (entry.scope !== 'project' || !entry.atStart) return [];
  if (entry.absent && (await Promise.all(entry.absent.map((p) => exists(root, p)))).some(Boolean)) {
    return [];
  }

  const hit = async (rel, note) => {
    const text = await readText(join(root, rel));
    if (text === null) return [];
    if (entry.frontmatter) {
      const meta = frontmatter(text);
      const matches = Object.entries(entry.frontmatter).every(([k, v]) => meta[k] === v);
      if (!matches) return [];
    }
    return [{ file: rel, text, note: note ?? null }];
  };

  switch (entry.tree) {
    case 'single':
      return hit(entry.path);
    case 'chain': {
      // The repository root is the only directory measured: these readers walk between
      // the project root and the working directory, and a repository's own files are
      // what it controls. A nested AGENTS.md is picked up by the nested reads below.
      return hit(entry.path);
    }
    case 'flat': {
      const out = [];
      for (const rel of await filesUnder(join(root, entry.dir))) {
        if (rel.includes('/')) continue;
        if (entry.suffix && !rel.endsWith(entry.suffix)) continue;
        out.push(...(await hit(`${entry.dir}/${rel}`)));
      }
      return out;
    }
    case 'nested': {
      const out = [];
      for (const rel of await filesUnder(join(root, entry.dir))) {
        if (entry.suffix && !rel.endsWith(entry.suffix)) continue;
        out.push(...(await hit(`${entry.dir}/${rel}`)));
      }
      return out;
    }
    default:
      return [];
  }
}

/** One measured file: what it weighs, what it costs a turn, and what the caps did to it. */
function rowFor(found, entry, channel) {
  return {
    file: found.file,
    scope: entry.scope,
    channel,
    bytes: bytes(found.text),
    // A skill's frontmatter is what costs a turn; its body is opened later. Charging the
    // body here is the error the `metadata` flag exists to prevent.
    countedBytes: entry.metadata ? bytes(skillHead(found.text)) : bytes(found.text),
    overCap: false,
    beyondCap: false,
    why: entry.why,
  };
}

/**
 * What one reader loads from one repository, at session start.
 *
 * `chainBytes` is the sum in load order, and `cap` is what that reader does to it: a
 * chain-scoped cap truncates the chain, a file-scoped cap truncates each file. Both
 * report `droppedBytes`, because "over the limit" without "by how much and which file"
 * is the number that started this slice.
 *
 * `overCap` on a row means THIS FILE is truncated; `beyondCap` means the chain stopped
 * before reaching it. They are different failures with the same visible symptom, and the
 * one that costs a repository its deepest instructions is the second.
 */
export async function viewOf(root, row, options = {}) {
  const cwd = options.cwd ? relative(root, options.cwd).split(sep).join('/') : '';
  const files = [];

  // The chain is walked directory by directory — project root down to the working
  // directory, which is the order Codex and Antigravity document and the reverse of what
  // a reader that walks *up* from the working directory sees. Inside one directory the
  // entries are the precedence list and the first one present wins: two AGENTS.md files
  // in the same directory are one of them not loaded, not both concatenated.
  //
  // With no `cwd` this is the root alone, which is the honest default: a repository's
  // own root document is what the tool can measure without knowing where the agent is
  // standing, and `--at` is how a reader asks about a subdirectory.
  const chainEntries = row.start.filter((e) => e.tree === 'chain');
  const parts = cwd === '' || cwd.startsWith('..') ? [] : cwd.split('/').filter(Boolean);
  const dirs = ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
  for (const dir of dirs) {
    let taken = false;
    for (const entry of chainEntries) {
      if (taken) break;
      const scoped = {
        ...entry,
        path: dir === '' ? entry.path : `${dir}/${entry.path}`,
        absent: entry.absent?.map((p) => join(dir, p)),
      };
      const found = await resolveEntry(root, scoped);
      if (found.length > 0) {
        taken = true;
        files.push(rowFor(found[0], entry, 'documents'));
      }
    }
  }

  for (const entry of row.start) {
    if (entry.tree === 'chain') continue;
    for (const found of await resolveEntry(root, entry)) {
      files.push(
        rowFor(found, entry, entry.metadata ? 'skills' : entry.tree === 'single' ? 'documents' : 'rules'),
      );
    }
  }

  const limits = caps(row);
  const chainCap = limits.find((c) => c.scope === 'chain') ?? null;
  // A token budget is a budget, but it is not a byte count: 20,000 tokens is 80,000
  // bytes at the four-bytes-per-token approximation, and comparing raw bytes to it
  // would trip on a repository that has not come close. So the token figure is
  // converted here and reported in the unit it was documented in.
  const tokenCap = limits.find((c) => c.scope === 'tokens') ?? null;
  const tokenCapBytes = tokenCap ? tokenCap.bytes * BYTES_PER_TOKEN : null;
  const fileCap = limits.find((c) => c.scope === 'file') ?? null;

  // Both caps are checked, not either-or: Antigravity has a per-file byte cap and an
  // aggregate token budget, and a rule can trip the first without tripping the second.
  // Which one fired is reported separately, because the remedy differs.
  let running = 0;
  for (const file of files) {
    running += file.countedBytes;
    if (chainCap && running > chainCap.bytes) file.beyondCap = true;
    if (fileCap && file.countedBytes > fileCap.bytes) file.overCap = true;
  }
  const totalBytes = files
    .filter((f) => !f.beyondCap && !f.overCap)
    .reduce((n, f) => n + f.countedBytes, 0);

  return {
    reader: row.id,
    label: row.label,
    root,
    order: row.order,
    nested: row.nested,
    imports: row.imports,
    files,
    totalBytes,
    droppedBytes: files.reduce((n, f) => n + (f.beyondCap || f.overCap ? f.countedBytes : 0), 0),
    // Reported, not measured: the user's global instructions are the reader's bytes.
    // A per-repository total that included them would change when the reader installed
    // something, which is the reason `--user` is a flag on `harness detect` and not a
    // default anywhere in this tool.
    userScope: row.start.filter((e) => e.scope === 'user').map((e) => e.path),
    cap: chainCap
      ? {
          bytes: chainCap.bytes,
          scope: chainCap.scope,
          appliesTo: chainCap.appliesTo,
          config: chainCap.config,
          why: chainCap.why,
          totalBytes: running,
          over: running > chainCap.bytes,
        }
      : null,
    budget: tokenCap
      ? {
          tokens: tokenCap.bytes,
          bytes: tokenCapBytes,
          appliesTo: tokenCap.appliesTo,
          config: tokenCap.config ?? null,
          why: tokenCap.why,
          over: running > tokenCapBytes,
        }
      : null,
    perFileCap: fileCap
      ? {
          bytes: fileCap.bytes,
          appliesTo: fileCap.appliesTo,
          config: fileCap.config,
          why: fileCap.why,
          over: files.some((f) => f.overCap),
        }
      : null,
    skills: row.skills,
    hooks: row.hooks,
    mcp: row.mcp,
    verified: row.verified,
    note: row.note ?? null,
  };
}

/** Name and description, which is what a reader loads before it opens a skill body. */
function skillHead(text) {
  const meta = frontmatter(text);
  const name = meta.name ?? '';
  const description = meta.description ?? '';
  if (description) return `${name}\n${description}`;
  return name;
}

/** Every reader's view of one repository, in table order. */
export async function viewAll(root, rows = LOADERS, options = {}) {
  const out = [];
  for (const row of rows) out.push(await viewOf(root, row, options));
  return out;
}