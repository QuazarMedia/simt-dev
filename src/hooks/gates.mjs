import { MANIFEST_FILE } from '../name.mjs';
// Gate definitions for the shared hook dispatcher.
//
// A gate has one of four kinds, and the choice is not cosmetic:
//
//   staged   run a formatter over the STAGED FILES ONLY, then re-stage them.
//            Whole-repo formatting from a pre-commit hook would rewrite
//            unstaged work the author did not ask to touch.
//   script   run a script the repo already declares. Correct for anything
//            global: tests, typecheck, coverage.
//   command  run a command the MANIFEST declares. Correct for gates that are
//            genuinely repo-specific - ConnectIQ memory budgets, codegen
//            drift, i18n completeness - because the central dispatcher cannot
//            know what monkeyc or a Kotlin script path looks like in one repo
//            and something else in another. section 3.2 keeps repo
//            commands and paths local; this is that ruling in code.
//   builtin  run inside this binary, with nothing to resolve on disk. For a
//            check whose whole value is that a fresh clone has it: the staged-
//            diff secret scan needs no script, no command and no tool in
//            node_modules, and a gate that needed an install step would be a
//            gate the repository that most needs it does not have (ADR-100).
//
// ADR-010 note: no gate invokes `npx` or `npm exec`. Script gates go through
// `npm run`, and staged gates resolve the formatter from the project's own
// `node_modules/.bin`, which is the declared dependency's binary rather than
// one fetched at hook time.

export const GATE_KINDS = new Set(['staged', 'script', 'command', 'builtin']);

/** Extensions a `staged` formatter gate will hand to the tool. */
export const FORMATTABLE = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonc',
  '.css', '.less', '.scss', '.html', '.md', '.yml', '.yaml', '.graphql',
]);

/**
 * @typedef {{name: string, kind: 'staged'|'script'|'command'|'builtin', adr: string,
 *            script?: string, tools?: string[], why: string}} Gate
 */

/** @type {Record<string, Gate>} */
export const GATES = {
  format: {
    name: 'format',
    kind: 'staged',
    adr: 'ADR-004',
    tools: ['prettier'],
    why: 'the hook owns format for staged files, so an author never commits unformatted work',
  },
  lint: {
    name: 'lint',
    kind: 'script',
    adr: 'ADR-004',
    script: 'lint',
    why: 'the hook owns lint; re-running it by hand is what ADR-004 tells agents not to do',
  },
  typecheck: {
    name: 'typecheck',
    kind: 'script',
    adr: 'ADR-010',
    script: 'typecheck',
    why: 'not hook-covered evidence: a type error is not a style error',
  },
  test: {
    name: 'test',
    kind: 'script',
    adr: 'ADR-003',
    script: 'test',
    why: 'the focused gate every commit must pass before review',
  },
  coverage: {
    name: 'coverage',
    kind: 'script',
    adr: 'ADR-006',
    script: 'test:coverage',
    why: 'the numeric bar is declared per repo, so this gate is opt-in rather than assumed',
  },
  'i18n-completeness': {
    name: 'i18n-completeness',
    kind: 'command',
    adr: 'ADR-010',
    why: 'repo-specific: every repo spells this check differently, so the manifest declares the command',
  },
  memory: {
    name: 'memory',
    kind: 'command',
    adr: 'ADR-003',
    why: 'ConnectIQ memory budgets are a hard platform limit; the repo declares the script that proves it',
  },
  'codegen-drift': {
    name: 'codegen-drift',
    kind: 'command',
    adr: 'ADR-002',
    why: 'a protocol change is a two-repo change; the drift check is what makes half of it fail loudly',
  },
  'secret-scan': {
    name: 'secret-scan',
    kind: 'builtin',
    adr: 'ADR-100',
    why: 'a staged diff is the last moment a secret can still be kept out of history, and the scan must be runnable by a clone with nothing installed',
  },
};

/**
 * Split a scoped gate id, `test@go`, into the gate it runs and the scope it names.
 *
 * A polyglot repository has more than one `test`: Node's script and Go's package run.
 * Merging them by name kept whichever table was read last, so the manifest looked
 * complete while one half of the repository never ran. A scope is a
 * suffix on the id, which keeps `gates.prePush` an ordered list of names and leaves every
 * unscoped name meaning exactly what it meant before.
 *
 * @param {string} name
 * @returns {{base: string, scope: string}|null}
 */
function gateScope(name) {
  if (typeof name !== 'string') return null;
  const at = name.indexOf('@');
  if (at <= 0 || at === name.length - 1) return null;
  return { base: name.slice(0, at), scope: name.slice(at + 1) };
}

export function getGate(name, commands = {}) {
  const declared = GATES[name];
  if (declared) return declared;
  const scoped = gateScope(name);
  if (scoped) {
    const base = GATES[scoped.base];
    const cmd = commands?.[name];
    // A scoped id is only a gate when its own command is declared: falling back to the
    // unscoped command would run the Node script under the Go scope and report a pass for
    // a suite that never ran.
    if (base && typeof cmd === 'string' && cmd.trim() !== '') {
      return { ...base, name, scope: scoped.scope, kind: 'command', why: `${base.why} (scope: ${scoped.scope})` };
    }
    return null;
  }
  // a command the repository declared under gates.commands is a valid gate even when
  // no central row knows it. The manifest is the source of truth for a repo's gates, and
  // a name that resolves to a declared command must not read as unknown. Synthesized, not
  // added to GATES: the central table stays the estate's gates, the record supplies the rest.
  const cmd = commands?.[name];
  if (typeof cmd === 'string' && cmd.trim() !== '') {
    return { name, kind: 'command', adr: 'ADR-010', why: 'declared by the repository under gates.commands' };
  }
  return null;
}

export function gateNames() {
  return Object.keys(GATES).sort();
}
