// Command registry and dispatch.
//
// Every command named in docs/plans/0002-simt-dev-cli.md section 5 is registered
// here from day one. A command that is declared but not yet implemented exits
// UNSUPPORTED with a pointer to its implementation step; it never silently
// succeeds. An agent that calls `simt-dev compare` on an unreleased build must get a
// failure, not an empty result it will read as "no drift".

import { EXIT, emit, fail, isJson } from '../output/index.mjs';
import { help } from './help.mjs';
import { lintCommand } from './graph.mjs';
import {
  indexCommand as skillsIndex,
  findCommand as skillsFind,
  briefCommand as skillsBrief,
  showCommand as skillsShow,
  whyCommand as skillsWhy,
} from './skills.mjs';
import { syncCommand, checkCommand } from './sync.mjs';
import { initCommand } from './init.mjs';
import { ciCommand } from './ci.mjs';
import { hooksCommand } from './hooks.mjs';
import { compareCommand } from './compare.mjs';
import { upgradeCommand } from './upgrade.mjs';
import { mcpCommand } from './mcp.mjs';
import { installCommand } from './skillsinstall.mjs';
import { listCommand as rulesList, showCommand as rulesShow, whyCommand as rulesWhy } from './rules.mjs';
import { parse } from '../argv.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { resolveWorkspace } from '../workspace.mjs';

/** command path -> implementation sequence step (plan 0002 section 11). */
// Every command named in plan 0002 section 5 is now implemented, so this map is empty.
// It stays, rather than being deleted, because the next command should be added here
// first: a declared-but-unimplemented command must exit UNSUPPORTED with a pointer to
// its step, never silently succeed with empty output an agent will read as a result.
const STEPS = new Map([]);

/** groups whose subcommands may be omitted, and the default for each. */
const GROUPS = new Map([
  ['skills', 'index'],
  ['graph', 'lint'],
  ['rules', 'list'],
  ['hooks', 'status'],
]);

/**
 * Every command this binary dispatches, in one place.
 *
 * It was a literal inside `dispatch`, which is why `help` and the CLI could disagree:
 * nothing could enumerate the real list, so `--help` was a hand-maintained template and
 * three working commands (`graph lint`, `hooks status`, `hooks run`) were never written
 * into it. A list that cannot be read cannot be checked, and the reader of `--help` is
 * an agent choosing a command — the one consumer with no way to discover the omission
 * except by guessing.
 *
 * Module scope so `test/cli.test.mjs` can assert help against it. Module scope is also
 * just correct: nothing in the map depends on the call.
 */
const IMPLEMENTED = {
  doctor: runDoctor,
  'graph lint': lintCommand,
  'skills index': skillsIndex,
  'skills find': skillsFind,
  'skills brief': skillsBrief,
  'skills show': skillsShow,
  'skills why': skillsWhy,
  'skills install': installCommand,
  'rules list': rulesList,
  'rules show': rulesShow,
  'rules why': rulesWhy,
  sync: syncCommand,
  check: checkCommand,
  init: initCommand,
  ci: ciCommand,
  'hooks install': (args, flags) => hooksCommand('install', args, flags),
  'hooks status': (args, flags) => hooksCommand('status', args, flags),
  'hooks run': (args, flags) => hooksCommand('run', args, flags),
  compare: compareCommand,
  upgrade: upgradeCommand,
  mcp: mcpCommand,
};

/**
 * The dispatchable command paths, sorted. The authoritative answer to "what can this
 * binary do", as opposed to the answer `--help` gives.
 */
export const COMMANDS = Object.keys(IMPLEMENTED).sort();

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
    // Two things a reader must be able to act on, and neither may name a path inside
    // simt-dev: they run this tool, not its source tree. The step number is the
    // stable handle; the file that documents it is an implementation detail.
    return fail(
      `\`simt-dev ${path}\` is declared but not implemented`,
      EXIT.UNSUPPORTED,
      `implementation step ${step} is not built yet`,
    );
  }
  const args = positional.slice(offset);
  const run = IMPLEMENTED[path];
  if (run) return run(args, flags);
  return fail(`unknown command \`${path}\``, EXIT.USAGE);
}

/**
 * Normalise argv into a registry key, or null when unrecognised.
 * A group with an omitted subcommand resolves to that group's default, so
 * `simt-dev skills` is `simt-dev skills index`.
 */
function commandPath(first, second) {
  if (first === undefined) return null;
  if (!GROUPS.has(first)) return first;

  const group = GROUPS.get(first);
  if (second === undefined) return `${first} ${group}`;
  // Reject a second token that is not a subcommand of this group, rather than
  // silently routing `simt-dev skills nonsense` to the default subcommand.
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
const KNOWN_SUBS = new Set([
  'doctor',
  'graph lint',
  'skills index',
  'skills find',
  'skills brief',
  'skills show',
  'skills why',
  'skills install',
  'rules list',
  'rules show',
  'rules why',
  'hooks install',
  'hooks status',
  'hooks run',
]);

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
  // Which source answered the workspace question, and where it looked. A tool
  // that silently fell back to the wrong directory would make every downstream
  // answer confidently wrong, so the answer is reported rather than inferred
  // (ADR-014).
  const ws = await resolveWorkspace(flags);

  // Under `--json` the document is the whole report, so it has to carry both
  // failures the text path reports AND the workspace answer the text path prints.
  // This branch used to return before either check, with `ok` hardcoded true: a
  // caller asking whether their config is readable was told yes, and given exit
  // 0, while the same command in a terminal exited 3 and named the file. A
  // scripted consumer has only this document to go on, so `ok` is derived from
  // the exit code rather than written as a constant (S10).
  const failure = result.error
    ? { error: `${root}: ${result.error}`, remedy: null }
    : ws.error
      ? {
          error: `workspace config ${ws.detail}: ${ws.error}`,
          remedy: 'fix the JSON, or remove the file',
        }
      : null;
  const code = failure ? EXIT.CONFIG : EXIT.OK;

  if (isJson(flags)) {
    emit(
      `${JSON.stringify(
        {
          ok: code === EXIT.OK,
          command: 'doctor',
          root,
          ...result,
          // The workspace answer is a fact about which directory the tool would
          // act on next (ADR-014). It is printed in the text report; leaving it
          // out of the JSON meant a machine-readable caller could not see it at
          // all, which is the one-question-two-answers defect again.
          workspace: {
            root: ws.root ?? null,
            source: ws.source,
            detail: ws.detail,
            error: ws.error ?? null,
          },
          ...(failure ?? {}),
        },
        null,
        2,
      )}\n`,
    );
    return code;
  }
  if (result.error) {
    return fail(`${root}: ${result.error}`, EXIT.CONFIG);
  }
  emit(
    [
      `root     ${root}`,
      `stack    ${result.stack.length > 0 ? result.stack.join(', ') : '(undetected)'}`,
      `evidence ${result.evidence.length > 0 ? result.evidence.join(' ') : '(none)'}`,
      // Facts are what a profile selects on when it wants to survive the
      // framework being replaced, so they are reported with the path that proved
      // each one rather than as a bare list (ADR-013).
      `facts    ${
        result.facts.length > 0
          ? result.facts.map((f) => `${f}(${result.factEvidence[f] ?? '?'})`).join(' ')
          : '(none)'
      }`,
      `manifest ${result.manifest ? (result.manifest.error ?? result.manifest.id ?? 'present') : '(absent)'}`,
      `workspace ${ws.root ?? '(none)'}  (${ws.source}: ${ws.detail})`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  // An unconfigured workspace is a fact, not a failure: a single repo with no
  // workspace around it is a normal, supported case. A config file that EXISTS and
  // does not parse is a real mistake, and that does fail - with the parse error,
  // because naming the file without saying what is wrong with it sends the reader
  // to the file and gives them nothing to look for.
  if (ws.error) {
    return fail(`workspace config ${ws.detail}: ${ws.error}`, EXIT.CONFIG, 'fix the JSON, or remove the file');
  }
  return EXIT.OK;
}
