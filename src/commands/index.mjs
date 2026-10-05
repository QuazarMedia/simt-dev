// Command registry and dispatch.
//
// Every command named in docs/plans/0002-simt-dev-cli.md section 5 is registered
// here from day one. A command that is declared but not yet implemented exits
// UNSUPPORTED with a pointer to its implementation step; it never silently
// succeeds. An agent that calls `simt compare` on an unreleased build must get a
// failure, not an empty result it will read as "no drift".

import { EXIT, emit, fail, isJson } from '../output/index.mjs';
import { help } from './help.mjs';
import { lintCommand } from './graph.mjs';
import { parse } from '../argv.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';

/** command path -> implementation sequence step (plan 0002 section 11). */
const STEPS = new Map([
  ['init', 7],
  ['check', 6],
  ['sync', 6],
  ['upgrade', 10],
  ['compare', 9],
  ['mcp', 10],
  ['skills index', 4],
  ['skills brief', 5],
  ['skills show', 5],
  ['skills why', 5],
  ['skills find', 4],
  ['skills install', 5],
  ['rules list', 6],
  ['rules show', 6],
  ['rules why', 6],
  ['hooks install', 8],
  ['hooks status', 8],
]);

/** groups whose subcommands may be omitted, and the default for each. */
const GROUPS = new Map([
  ['skills', 'index'],
  ['graph', 'lint'],
  ['rules', 'list'],
  ['hooks', 'status'],
]);

export async function dispatch(argv) {
  const { flags, positional } = parseOrExit(argv);

  // Help is shown only when explicitly asked for. An unknown command must fail with
  // a usage code, not print 40 lines of prose and exit 0 — an agent that mistyped
  // needs to be told so, not handed a wall of text it may misread as output.
  if (flags.help || flags.version || positional[0] === 'help') {
    return help(argv);
  }

  const [first, second] = positional;
  const path = commandPath(first, second);
  // Arguments after the command path. A group consumed two tokens (`graph lint`),
  // a bare command one, so the offset depends on the shape that resolved.
  const offset = GROUPS.has(first) && second !== undefined ? 2 : 1;

  if (path === null) {
    return fail(`unknown command \`${[first, second].filter(Boolean).join(' ')}\``, EXIT.USAGE);
  }

  const step = STEPS.get(path);
  if (step !== undefined) {
    return fail(
      `\`simt ${path}\` is declared but not implemented`,
      EXIT.UNSUPPORTED,
      `see docs/plans/0002-simt-dev-cli.md section 11, step ${step}`,
    );
  }
  const args = positional.slice(offset);
  if (path === 'doctor') return runDoctor(args, flags);
  if (path === 'graph lint') return lintCommand(args, flags);
  return fail(`unknown command \`${path}\``, EXIT.USAGE);
}

/**
 * Normalise argv into a registry key, or null when unrecognised.
 * A group with an omitted subcommand resolves to that group's default, so
 * `simt skills` is `simt skills index`.
 */
function commandPath(first, second) {
  if (first === undefined) return null;
  if (!GROUPS.has(first)) return first;

  const group = GROUPS.get(first);
  if (second === undefined) return `${first} ${group}`;
  // Reject a second token that is not a subcommand of this group, rather than
  // silently routing `simt skills nonsense` to the default subcommand.
  const key = `${first} ${second}`;
  if (!STEPS.has(key) && !KNOWN_SUBS.has(key)) {
    return null;
  }
  return key;
}

/**
 * Subcommands implemented now, so they must not be rejected as unknown.
 * Implemented paths live here; declared-but-unimplemented ones live in STEPS.
 */
const KNOWN_SUBS = new Set(['doctor', 'graph lint']);

function parseOrExit(argv) {
  const parsed = parse(argv);
  if (!parsed.ok) return { flags: {}, positional: [] };
  return parsed.value;
}

/**
 * Step 3 of the implementation sequence: classify a repo from marker files alone.
 * Deliberately shipped early — it needs no registry, no rules and no projection,
 * and it makes the tool useful before any content exists.
 */
async function runDoctor(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const result = await fingerprint(root);

  if (isJson(flags)) {
    emit(`${JSON.stringify({ ok: true, command: 'doctor', root, ...result }, null, 2)}\n`);
    return result.error ? EXIT.CONFIG : EXIT.OK;
  }
  if (result.error) {
    return fail(`${root}: ${result.error}`, EXIT.CONFIG);
  }
  emit(
    [
      `root     ${root}`,
      `stack    ${result.stack.length > 0 ? result.stack.join(', ') : '(undetected)'}`,
      `evidence ${result.evidence.length > 0 ? result.evidence.join(' ') : '(none)'}`,
      `manifest ${result.manifest ? (result.manifest.error ?? result.manifest.id ?? 'present') : '(absent)'}`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}
