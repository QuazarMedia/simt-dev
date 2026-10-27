// The package generator (plan 0003 R43): one command builds a Claude Code plugin, a
// Gemini CLI extension, or a Cursor bundle, and all three are generated from the same
// tables `agent-hooks install` writes into a repository. A package and a repository
// install therefore cannot drift apart: the hooks document, the MCP registration and
// (for Cursor) the kernel rules are all read from the one source, and only the entry
// point differs — a package ships its own copy of the runtime rather than the binary on
// PATH, so it installs into a clean profile that has never seen this tool.
//
// Each package is self-contained in the way its vendor requires:
//
//   claude   a directory with .claude-plugin/plugin.json, hooks/hooks.json and the
//            runtime at its root; Claude names the root ${CLAUDE_PLUGIN_ROOT} and the
//            project ${CLAUDE_PROJECT_DIR}.
//   gemini   a directory with gemini-extension.json, hooks/hooks.json and the runtime at
//            its root; the extension names its own directory ${extensionPath} and the
//            workspace ${workspacePath}. The manifest's name must equal the directory's,
//            so it is taken from the destination rather than fixed.
//   cursor   a repository drop-in: .cursor/ with rules/kernel.mdc, hooks.json and
//            mcp.json, and the runtime under .cursor/simt/. Cursor names the project
//            ${CURSOR_PROJECT_DIR}.
//
// The skill registry is not shipped in any of them: it is workspace data (ADR-061), and
// a package that carried one snapshot would ship a registry that is stale the moment it
// leaves the machine it was built on. The command says so rather than pretending.

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readBefore } from './diff.mjs';
import { hookDocument } from './agenthooks/render.mjs';
import { desiredRegion } from './projection/rules.mjs';
import { PACKAGE_NAME, BIN_REL } from './name.mjs';

/** The kinds `simt plugin` builds, in the order the help line names them. */
export const PLUGIN_KINDS = ['claude', 'gemini', 'cursor'];

/** Where the runtime copy lands inside a package, relative to the package root. */
function runtimeDir(kind) {
  return kind === 'cursor' ? join('.cursor', 'simt') : '.';
}

/** The entry point a package's config names: its own copy of the runtime, not PATH. */
function entryPoint(kind) {
  const bin = join(runtimeDir(kind), BIN_REL);
  // The vendor's own variables must survive as literal text in the generated config, so
  // they are escaped here: an unescaped ${...} would interpolate a JS binding that does
  // not exist and ship the string "undefined" into the package.
  if (kind === 'claude') return `node "\${CLAUDE_PLUGIN_ROOT}/${bin}"`;
  if (kind === 'gemini') return `node "\${extensionPath}/${bin}"`;
  // Cursor runs from the repository root, so a relative path is the honest one.
  return `node ${bin}`;
}

/** The project root a package's hook resolves against, from the vendor's env var. */
function rootFlag(kind) {
  if (kind === 'claude') return ` --root "$CLAUDE_PROJECT_DIR"`;
  if (kind === 'cursor') return ` --root "$CURSOR_PROJECT_DIR"`;
  // Gemini documents no project-dir env var, but its base input carries cwd, which the
  // adapter reads; passing a flag the vendor never sets would only expand to "".
  return '';
}

/** Where the hooks document lands inside a package, relative to the package root. */
function hooksPath(kind) {
  return kind === 'cursor' ? join('.cursor', 'hooks.json') : join('hooks', 'hooks.json');
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The generated files of one package, relative to the package root: the manifest, the
 * hooks document and the MCP registration. The runtime copy is planned separately because
 * it is many files; this returns only the handful that are authored here.
 */
async function packageFiles(kind, { root = process.cwd(), out } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const command = `${entryPoint(kind)} agent-hook pre-tool-use --harness ${kind}${rootFlag(kind)}`;
  const files = [];

  if (kind === 'claude') {
    files.push({
      path: join('.claude-plugin', 'plugin.json'),
      text: json({
        name: PACKAGE_NAME,
        version: pkg.version,
        description: pkg.description,
        mcpServers: { [PACKAGE_NAME]: { command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/${BIN_REL}`, 'mcp'] } },
      }),
    });
  }

  if (kind === 'gemini') {
    // The vendor requires the manifest's name to equal the directory's, so it is the
    // destination's basename rather than a fixed string: a package installed under any
    // name is a valid extension, and the name travels with it.
    files.push({
      path: 'gemini-extension.json',
      text: json({
        name: basename(out),
        version: pkg.version,
        description: pkg.description,
        mcpServers: { [PACKAGE_NAME]: { command: 'node', args: [`\${extensionPath}/${BIN_REL}`, 'mcp'], cwd: '${workspacePath}' } },
      }),
    });
  }

  if (kind === 'cursor') {
    const kernel = await desiredRegion(root, { mode: 'kernel' });
    files.push({
      path: join('.cursor', 'rules', 'kernel.mdc'),
      text: `---\ndescription: the kernel rules this repository enforces\nalwaysApply: true\n---\n${kernel.body}`,
    });
    files.push({
      path: join('.cursor', 'mcp.json'),
      text: json({ mcpServers: { [PACKAGE_NAME]: { command: 'node', args: [join('.cursor', 'simt', BIN_REL), 'mcp'] } } }),
    });
  }

  files.push({ path: hooksPath(kind), text: hookDocument(kind, { command }) });
  return files;
}

/**
 * Build one package into `out`. With `apply` false it returns the plan and writes
 * nothing; with true it copies the runtime and writes every generated file. The plan is
 * the same in both cases, so a dry run and an apply agree on what will land.
 */
export async function buildPackage(kind, { root = process.cwd(), out, apply = false } = {}) {
  if (!PLUGIN_KINDS.includes(kind)) {
    throw new Error(`unknown package kind \`${kind}\`; one of: ${PLUGIN_KINDS.join(', ')}`);
  }

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const files = await packageFiles(kind, { root, out });
  const notes = [
    'the skill registry is workspace data (ADR-061) and is not shipped; run `simt skills index` in the profile to list what a workspace would offer',
  ];

  // The `--diff` before-sides, read before anything is written so the diff is
  // true in preview and in apply alike (R50). Always captured: the files are a
  // handful of small generated configs. The runtime copy below is excluded — it
  // is a mechanical copy of this tool's own sources, not planned content, and
  // diffing it would reprint the tool into the review.
  for (const f of files) {
    f.before = await readBefore(join(out, f.path));
  }

  if (apply) {
    const runtimeTarget = join(out, runtimeDir(kind));
    await mkdir(runtimeTarget, { recursive: true });
    // The runtime is the same set of paths npm publishes (the `files` field) plus
    // package.json. Copying anything less ships a binary that answers the hook and then
    // dies on the first MCP call: the server reads templates/ and rules/, which a
    // bin+src-only copy leaves behind. The `files` field is the definition of "a working
    // copy of this tool", so it is the set a package ships.
    for (const part of pkg.files) {
      await cp(join(root, part), join(runtimeTarget, part), { recursive: true });
    }
    await cp(join(root, 'package.json'), join(runtimeTarget, 'package.json'));
    for (const f of files) {
      const target = join(out, f.path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, f.text);
    }
  }

  return {
    kind,
    out,
    apply,
    runtime: { target: runtimeDir(kind), parts: [...pkg.files, 'package.json'] },
    files,
    notes,
  };
}
