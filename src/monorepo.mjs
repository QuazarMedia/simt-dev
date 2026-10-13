// Packages inside a repository, from the files that declare them.
//
// A monorepo is one repository with several packages in it, and every tool that
// reads a repository reads only the root: `fingerprint(root)` sees the root's
// markers, `plan(root)` writes the root's region, and a reader working in
// `apps/web` inherits whatever the root happened to be. The fix is not "a
// monorepo is two repositories" — it is one root projection plus a nested one
// per package, each carrying the profiles that package selects and the root does
// not (ADR-066).
//
// Detection is a table, not code per ecosystem (ADR-013): each row names the
// files that DECLARE members and how to read the member list out of them. Two
// rows are deliberately absent and their reason is recorded in ADR-066: `nx.json`
// declares no member list at all (its projects are computed by running `nx`), and
// a Gradle `include(...)` is written in the settings file rather than a manifest
// this table already parses. A row that could only be read by executing the
// toolchain is not a row: a projection that depended on running the build would
// be a projection this repository cannot reproduce.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Packaged trees are not packages: their directories are dependencies. */
const SKIP_DIRS = new Set(['node_modules', 'target', 'vendor', 'dist', 'build', '.git', '.venv', 'venv']);

/** What makes a directory a package once a pattern has matched it. */
const PACKAGE_MARKERS = ['package.json', 'Cargo.toml', 'go.mod', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'mix.exs'];

/**
 * The declarations this tool reads. `patterns` reads a list of repo-relative
 * directory patterns out of the named file.
 *
 * `read` returns patterns in the order the file lists them, because the reader
 * reviewing the generated files is entitled to see them in the order they wrote
 * them, and a sort would hide a duplicate that the reader can act on.
 */
const DECLARATIONS = [
  {
    ecosystem: 'node',
    file: 'package.json',
    evidence: 'workspaces field',
    read: async (text) => {
      let pkg;
      try {
        pkg = JSON.parse(text);
      } catch {
        return [];
      }
      const w = pkg.workspaces;
      if (Array.isArray(w)) return w;
      if (w && Array.isArray(w.packages)) return w.packages;
      return [];
    },
  },
  {
    ecosystem: 'node',
    file: 'pnpm-workspace.yaml',
    evidence: 'packages list',
    read: async (text) => {
      // A YAML list under `packages:`. Only the flat list form is read: a pnpm
      // workspace that needs a full YAML parser to declare its members is a
      // workspace whose declaration this tool must not guess at, and
      // `packages:` with nothing under it declares none.
      const lines = text.split('\n');
      const out = [];
      let inside = false;
      for (const line of lines) {
        if (/^packages:\s*$/.test(line)) {
          inside = true;
          continue;
        }
        if (!inside) continue;
        const item = /^\s+-\s*(.+?)\s*$/.exec(line);
        if (item) out.push(stripQuotes(item[1]));
        else if (/^\S/.test(line)) inside = false;
      }
      return out;
    },
  },
  {
    ecosystem: 'node',
    file: 'turbo.json',
    evidence: 'workspaces.packages list',
    read: async (text) => {
      let cfg;
      try {
        cfg = JSON.parse(text);
      } catch {
        return [];
      }
      const w = cfg.workspaces;
      return w && Array.isArray(w.packages) ? w.packages : [];
    },
  },
  {
    ecosystem: 'rust',
    file: 'Cargo.toml',
    evidence: '[workspace] members list',
    read: async (text) => {
      const members = tomlList(text, 'workspace', 'members');
      return members;
    },
  },
  {
    ecosystem: 'go',
    file: 'go.work',
    evidence: 'use list',
    read: async (text) => {
      const use = tomlList(text, '', 'use');
      return use;
    },
  },
  {
    ecosystem: 'jvm',
    file: 'settings.gradle',
    evidence: 'include list',
    read: async (text) => gradleIncludes(text),
  },
  {
    ecosystem: 'jvm',
    file: 'settings.gradle.kts',
    evidence: 'include list',
    read: async (text) => gradleIncludes(text),
  },
];

/**
 * `include(":apps:web", ":core")` and its multi-line form, as paths.
 *
 * Gradle project paths are colon-separated and rooted at a colon, so `:apps:web`
 * names the directory `apps/web`. That translation is all this reads: the arguments
 * are literals, and a build that computes its includes from a variable is a build
 * this tool does not evaluate - a directory with a marker file and no include is
 * simply not discovered, which is the same honest absence every other unreadable
 * declaration produces.
 */
function gradleIncludes(text) {
  const out = [];
  for (const match of text.matchAll(/\binclude\s*\(([^)]*)\)/g)) {
    for (const quoted of match[1].matchAll(/["']([^"']+)["']/g)) {
      const path = quoted[1].replace(/^:/, '').split(':').filter(Boolean).join('/');
      if (path !== '') out.push(path);
    }
  }
  return out;
}

function stripQuotes(value) {
  return value.replace(/^["']/, '').replace(/["']$/, '');
}

/**
 * One table's key, read as a list of paths.
 *
 * Every shape this tool needs is a flat list — `members = ["a", "b"]`,
 * `members = [\n "a",\n]`, `use (\n ./api\n ./cmd/x\n)` — so the reader is a
 * line scan with two states rather than a parser. Paths are quoted in TOML and
 * bare in a `go.work`, so both are accepted; a comment is stripped, because
 * `use ./api # the api` declares one path and not two.
 *
 * `table` is `''` for a file with no tables (go.work), or the table name. A key
 * this shape does not find returns an empty list: a declaration this tool cannot
 * read is one it does not guess at.
 */
function tomlList(text, table, key) {
  const out = [];
  let inTable = table === '';
  let collecting = false;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    if (/^\s*\[/.test(line)) {
      inTable = table !== '' && line.trim() === `[${table}]`;
      collecting = false;
      continue;
    }
    if (!inTable) continue;
    if (collecting) {
      out.push(...pathTokens(line));
      if (line.includes(']') || line.includes(')')) collecting = false;
      continue;
    }
    // Two spellings, because `go.work` uses one and `Cargo.toml` the other:
    // `members = ["crates/a"]` and a bare `use (` opening a list of paths.
    const assigned = /^\s*([A-Za-z_.-]+)\s*=\s*(.*)$/.exec(line);
    const opened = /^\s*([A-Za-z_.-]+)\s*\((.*)$/.exec(line);
    const kv = assigned ?? opened;
    if (kv === null || kv[1] !== key) continue;
    const rest = (assigned !== null ? kv[2] : `(${kv[2]}`).trim();
    if (rest === '[]' || rest === '') continue;
    // `use (` and `members = [` both open a list that ends on a later line.
    if (/[[(]$/.test(rest)) {
      out.push(...pathTokens(rest));
      collecting = true;
      continue;
    }
    out.push(...pathTokens(rest));
  }
  return out;
}

function stripComment(line) {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/** The paths on one line of a list, quoted or bare, comma-separated. */
function pathTokens(line) {
  const quoted = [...line.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (quoted.length > 0) return quoted;
  return line
    .replace(/[[\]()]/g, ' ')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('='));
}

/**
 * Expand one declaration pattern into the directories it names.
 *
 * `*` matches within a path segment and `**` matches any depth. Both are what
 * every one of these ecosystems writes, and a pattern syntax narrower than the
 * declarations it reads is a detector that silently finds fewer packages than
 * the repository has.
 */
async function expand(root, pattern) {
  const segments = pattern.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return [];
  let dirs = [root];
  for (const seg of segments) {
    const next = [];
    for (const dir of dirs) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        if (matches(seg, entry.name)) next.push(join(dir, entry.name));
        // `**` also admits what is below it, so a member pattern like
        // `packages/**` finds `packages/a` and `packages/a/inner`.
        if (seg === '**') {
          next.push(join(dir, entry.name));
          next.push(...(await expand(join(dir, entry.name), '**')));
        }
      }
    }
    dirs = [...new Set(next)];
  }
  return dirs;
}

/** One segment's match: `*` is any run of characters, everything else is literal. */
function matches(segment, name) {
  if (segment === '**') return true;
  if (!segment.includes('*')) return segment === name;
  const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Every package this repository declares, in the order the declarations name
 * them and then in path order, deduplicated.
 *
 * A pattern that names a directory with no package marker in it is not a
 * package, and neither is a pattern that escapes the repository: a declaration
 * like `../other-repo/packages/*` is a path this tool must refuse to follow,
 * because everything this tool projects has to resolve inside the repository
 * that received it.
 *
 * @returns {Promise<{packages: {path: string, ecosystem: string, evidence: string}[],
 *   notes: string[]}>}
 */
export async function discoverPackages(root) {
  const found = new Map();
  const notes = [];

  const declared = [];
  for (const decl of DECLARATIONS) {
    let text;
    try {
      text = await readFile(join(root, decl.file), 'utf8');
    } catch {
      continue;
    }
    const patterns = await decl.read(text);
    if (patterns.length === 0) continue;
    declared.push(`${decl.file} (${decl.evidence})`);
    for (const pattern of patterns) {
      const negated = stripQuotes(pattern).startsWith('!');
      const clean = stripQuotes(pattern).replace(/^!/, '').replace(/\/+$/, '');
      if (clean === '') {
        notes.push(`${decl.file} names "${pattern}", which is not a path; ignored`);
        continue;
      }
      if (clean.startsWith('..')) {
        notes.push(`${decl.file} names "${pattern}", which is outside this repository; ignored`);
        continue;
      }
      for (const dir of await expand(root, clean)) {
        const rel = relativeTo(root, dir);
        if (rel === '') continue;
        // `!apps/legacy` excludes what an earlier pattern admitted, which is the
        // only way pnpm and yarn express "this member is not built any more".
        if (negated) {
          found.delete(rel);
          continue;
        }
        if (!(await isPackage(dir))) continue;
        if (found.has(rel)) continue;
        found.set(rel, { path: rel, ecosystem: decl.ecosystem, evidence: decl.evidence });
      }
    }
  }

  return {
    packages: [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    notes,
  };
}

/** A directory is a package when something a build tool would install lives in it. */
async function isPackage(dir) {
  for (const marker of PACKAGE_MARKERS) {
    try {
      await readFile(join(dir, marker));
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

function relativeTo(root, dir) {
  return dir.slice(root.length).replace(/^\//, '');
}