// Resolve a gate to something executable, or explain precisely why it cannot be.
//
// Every failure mode returns a remedy the author can act on without reading
// this source. That is the difference between a hook people keep and a hook
// people disable: a hook that fails vaguely gets `--no-verify`, and once
// `--no-verify` is normal, no hook in the estate means anything.
//
// ADR-010: nothing here invokes `npx` or `npm exec`. Script gates go through
// `npm run`, and staged gates resolve the formatter from the project's own
// `node_modules/.bin` - the declared dependency's binary, not one fetched at
// hook time.

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { FORMATTABLE, GATES, GATES as _G } from './gates.mjs';
import { MANIFEST_FILE } from '../name.mjs';

/** Gate names the shared dispatcher knows, sorted. */
export function knownGates() {
  return Object.keys(GATES).sort();
}

export function gateKind(name) {
  return GATES[name]?.kind ?? null;
}

export function gateWhy(name) {
  return GATES[name]?.why ?? null;
}

export function gateAdr(name) {
  return GATES[name]?.adr ?? null;
}

/**
 * Is this path an executable file?
 * @param {string} path
 */
export async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the formatter binary a `staged` gate should invoke.
 *
 * Prettier is required because ADR-004 makes format a staged-files obligation
 * and the estate's single agreed formatter is prettier. A repo without it gets a
 * failure with a remedy, never a silent pass.
 */
export async function resolveStagedTool(root, gate) {
  const tools = gate.tools ?? [];
  const tried = [];
  for (const tool of tools) {
    const path = join(root, 'node_modules', '.bin', tool);
    if (await isExecutable(path)) return { tool, path, tried };
    tried.push(path);
  }
  return { tool: null, path: null, tried };
}

/** Does package.json declare this script? */
export function hasScript(pkg, script) {
  if (!pkg || typeof pkg.scripts !== 'object' || pkg.scripts === null) return false;
  return typeof pkg.scripts[script] === 'string' && pkg.scripts[script].length > 0;
}

/**
 * Build the argv for a gate, or return a structured refusal.
 *
 * @param {object} gate
 * @param {object} ctx
 * @param {string} ctx.root
 * @param {object|null} ctx.pkg parsed package.json, or null when absent
 * @param {string[]} ctx.staged staged paths (empty for pre-push)
 * @param {Record<string,string>|undefined} ctx.commands manifest gates.commands
 * @returns {Promise<{ok: true, argv: string[], kind: string, detail: string}
 *                  | {ok: false, gate: string, kind: string, reason: string, remedy: string}>}
 */
export async function resolveGate(gate, { root, pkg, staged, commands }) {
  const name = gate.name;
  const declared = commands?.[name];

  // A declared command wins for EVERY kind, not just `command` gates.
  //
  // This is what makes `gates.commands` the ecosystem escape hatch it is advertised as.
  // A Gradle repo has no `test` npm script and never will, so `test` is declared as
  // `command` kind instead — but the repo also has no `npm run lint` for a gate named
  // `lint`, or a prettier for `format`. In each case the reader is told, by this tool's
  // own remedy, to "name the program under gates.commands"; a dispatcher that then
  // ignored that declaration would contradict the remedy, and so would `check`.
  if (declared) {
    // The declaration is a SHELL COMMAND LINE, not an argv (ADR-019, ruling 8).
    //
    // It was split on whitespace, so every declaration a repository would plausibly
    // write was wrong: `npm run test -- --watch=false` became seven arguments with the
    // flag value as a separate one, and `sh -c "a && b"` became eleven, with the quotes
    // passed to the program. A repository had no way to write a gate with a quoted
    // argument, and nothing said so — the gate simply ran the wrong thing.
    //
    // Splitting is also a parse without an owner. `execFile` takes an argv because it
    // must not use a shell, which is right for a path this tool chose and wrong for a
    // line the repository wrote in full view of its own shell. The two cases are now
    // different types rather than one `argv` field carrying both.
    const line = declared.trim();
    if (line === '') {
      return {
        ok: false,
        gate: name,
        kind: gate.kind,
        reason: `gates.commands["${name}"] is empty`,
        remedy: `set gates.commands["${name}"] to the command that proves it, or remove "${name}" from ${MANIFEST_FILE} gates`,
      };
    }
    return {
      ok: true,
      kind: gate.kind,
      // Kept alongside `command` because the dispatcher prints and passes it to
      // `hooks status`, and two representations of one thing is how they drift.
      argv: line.split(/\s+/).filter(Boolean),
      command: line,
      shell: true,
      // The dispatcher has to know whether these argv entries are paths it chose or
      // words it was handed. Sniffing the detail string meant the safety guard on
      // partial stages would quietly stop working the day that wording changed.
      declared: true,
      detail: `declared command: ${line}`,
    };
  }

  if (gate.kind === 'staged') {
    const tool = await resolveStagedTool(root, gate);
    if (tool.path === null) {
      return {
        ok: false,
        gate: name,
        kind: gate.kind,
        reason: `no formatter binary in node_modules/.bin (looked for ${(gate.tools ?? []).join(', ')})`,
        remedy: `run the repo install command, or remove "format" from ${MANIFEST_FILE} gates`,
      };
    }
    const files = staged.filter((f) => FORMATTABLE.has(extname(f)));
    if (files.length === 0) {
      return {
        ok: true,
        kind: gate.kind,
        argv: null, // nothing to do; the dispatcher reports this as a pass with a count
        detail: `no staged files this gate handles (looked for ${[...FORMATTABLE].join(', ')})`,
      };
    }
    return {
      ok: true,
      kind: gate.kind,
      argv: [tool.path, '--write', ...files],
      detail: `${files.length} staged file(s) via node_modules/.bin/${tool.tool}`,
    };
  }

  if (gate.kind === 'script') {
    const script = gate.script;
    if (!hasScript(pkg, script)) {
      return {
        ok: false,
        gate: name,
        kind: gate.kind,
        reason: `package.json declares no "${script}" script`,
        remedy: `add "${script}" to scripts, or remove "${name}" from ${MANIFEST_FILE} gates`,
      };
    }
    return {
      ok: true,
      kind: gate.kind,
      argv: ['npm', 'run', '--silent', script],
      detail: `npm run ${script}`,
    };
  }

  if (gate.kind === 'command') {
    if (!declared) {
      return {
        ok: false,
        gate: name,
        kind: gate.kind,
        reason: `no command declared for this gate in ${MANIFEST_FILE}`,
        remedy: `set gates.commands["${name}"] to the command that proves it, or remove "${name}" from ${MANIFEST_FILE} gates`,
      };
    }
  }

  return {
    ok: false,
    gate: name,
    kind: 'unknown',
    reason: `unknown gate kind "${gate.kind}"`,
    remedy: `this is a bug in simt-dev; known gates: ${knownGates().join(', ')}`,
  };
}

function extname(path) {
  const dot = path.lastIndexOf('.');
  return dot > 0 ? path.slice(dot).toLowerCase() : '';
}

export const __internals = { extname, FORMATTABLE };