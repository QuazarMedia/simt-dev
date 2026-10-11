import { MANIFEST_FILE } from '../name.mjs';
// Gate definitions for the shared hook dispatcher.
//
// A gate has one of three kinds, and the choice is not cosmetic:
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
//            and something else in another. Plan 0001 section 3.2 keeps repo
//            commands and paths local; this is that ruling in code.
//
// ADR-010 note: no gate invokes `npx` or `npm exec`. Script gates go through
// `npm run`, and staged gates resolve the formatter from the project's own
// `node_modules/.bin`, which is the declared dependency's binary rather than
// one fetched at hook time.

export const GATE_KINDS = new Set(['staged', 'script', 'command']);

/** Extensions a `staged` formatter gate will hand to the tool. */
export const FORMATTABLE = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonc',
  '.css', '.less', '.scss', '.html', '.md', '.yml', '.yaml', '.graphql',
]);

/**
 * @typedef {{name: string, kind: 'staged'|'script'|'command', adr: string,
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
};

export function getGate(name) {
  return GATES[name] ?? null;
}

/**
 * A gate a repo cannot run is a FAILURE, never a skip.
 *
 * This is the load-bearing decision of the whole dispatcher. A gate that
 * silently does nothing is indistinguishable from a gate that passed, and the
 * documented consequence in this estate is an agent reaching for
 * `--no-verify` - a repository removed its tests from pre-commit precisely
 * because they were slow, and slow-plus-silent is what teaches everyone that
 * hooks are advisory.
 */
export function unresolved(name, { hasScript, binary, command, stack }) {
  const gate = getGate(name);
  if (gate === null) {
    return {
      gate: name,
      reason: `unknown gate; the shared dispatcher knows: ${Object.keys(GATES).sort().join(', ')}`,
      remedy: `remove "${name}" from ${MANIFEST_FILE} gates`,
    };
  }
  if (gate.kind === 'script' && !hasScript(gate.script)) {
    return {
      gate: name,
      reason: `no "${gate.script}" script in package.json`,
      remedy: `add the script, or remove "${name}" from ${MANIFEST_FILE} gates`,
    };
  }
  if (gate.kind === 'command' && !command) {
    return {
      gate: name,
      reason: `no command declared for this gate in ${MANIFEST_FILE}`,
      remedy: `set gates.commands["${name}"] to the command that proves it, or remove "${name}" from ${MANIFEST_FILE} gates`,
    };
  }
  if (gate.kind === 'staged' && !binary) {
    return {
      gate: name,
      reason: `${gate.tools.join('/')} is not installed in node_modules/.bin`,
      remedy: `run the repo install command, or remove "format" from ${MANIFEST_FILE} gates`,
    };
  }
  return null;
}

export function gateNames() {
  return Object.keys(GATES).sort();
}

export const __internals = { FORMATTABLE, GATES };