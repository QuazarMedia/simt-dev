// Command registry and dispatch.
//
// Every command named in docs/plans/0002-simt-dev-cli.md section 5 is registered
// here from day one. A command that is declared but not yet implemented exits
// UNSUPPORTED with a pointer to its implementation step; it never silently
// succeeds. An agent that calls `simt compare` on an unreleased build must get a
// failure, not an empty result it will read as "no drift".

import {
  EXIT,
  emit,
  emitJson,
  fail,
  note,
  warn,
  isJson,
  jsonFailMode,
  jsonIndentDefault,
} from '../output/index.mjs';
import { help } from './help.mjs';
import { GROUP_DEFAULTS, SPEC, SPEC_PATHS } from './spec.mjs';
import { parse, rawJsonFlag } from '../argv.mjs';
import { CLI } from '../name.mjs';


/**
 * Groups whose subcommand may be omitted, and the default for each. Read from the spec
 * (review 0003 Q60) rather than kept here: this was the second copy of a fact the spec
 * owns, and the reason for each default now sits on the row that declares it.
 */
export const GROUPS = GROUP_DEFAULTS;

/** path -> the flags the spec declares for it. The parser knows every flag; this is
 * what one command reads, and the difference is what the caller is told (Q62). */
const DECLARED = new Map(SPEC.map((row) => [row.path, new Set(row.flags ?? [])]));

/** Flags dispatch reads for every command: the envelope and the guard rails. */
const GLOBAL_FLAGS = new Set(['root', 'json', 'pretty', 'help', 'version', 'maxBytes']);

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
 * Module scope so `test/cli.test.mjs` can assert help against it. Each value is a
 * loader rather than a handler: dispatch awaits the one the matched path names, so a
 * command pays for its own module graph and not for the other seventy-five (review 0003
 * Q64). A loader that never resolves is a command that cannot run, and `test/spec.test.mjs`
 * still holds the key set against the spec.
 */
export const IMPLEMENTED = {
  brief: async () => {
    const { briefCommand } = await import('./brief.mjs');
    return (args, flags) => briefCommand(args, flags, COMMANDS);
  },
  doctor: async () => (await import('./doctor.mjs')).runDoctor,
  // Plan 0003 R48. A bare command: the only mode is `--line`, so there is no
  // group and no default subcommand to resolve.
  status: async () => (await import('./status.mjs')).statusCommand,
  'graph lint': async () => (await import('./graph.mjs')).lintCommand,
  'skills index': async () => (await import('./skills.mjs')).indexCommand,
  'skills find': async () => (await import('./skills.mjs')).findCommand,
  'skills brief': async () => (await import('./skills.mjs')).briefCommand,
  'skills show': async () => (await import('./skills.mjs')).showCommand,
  'skills why': async () => (await import('./skills.mjs')).whyCommand,
  'skills eval': async () => (await import('./skills.mjs')).evalCommand,
  'skills install': async () => (await import('./skillsinstall.mjs')).installCommand,
  'skills compile': async () => (await import('./skillscompile.mjs')).compileCommand,
  'rules decisions': async () => (await import('./rules.mjs')).decisionsCommand,
  'rules list': async () => (await import('./rules.mjs')).listCommand,
  'rules show': async () => (await import('./rules.mjs')).showCommand,
  'rules why': async () => (await import('./rules.mjs')).whyCommand,
  sync: async () => (await import('./sync.mjs')).syncCommand,
  check: async () => (await import('./sync.mjs')).checkCommand,
  'plan status': async () => {
    const { planCommand } = await import('./plan.mjs');
    return (args, flags) => planCommand('status', args, flags);
  },
  'plan next': async () => {
    const { planCommand } = await import('./plan.mjs');
    return (args, flags) => planCommand('next', args, flags);
  },
  'plan done': async () => {
    const { planCommand } = await import('./plan.mjs');
    return (args, flags) => planCommand('done', args, flags);
  },
  // Plan 0003 R53. A group: `start` isolates the work on a branch with its brief,
  // `finish` runs the gates, commits and records the evidence, and `abandon`
  // (review 0003 Q23) takes the slice back down. All three take the slice id
  // as a positional.
  'slice start': async () => {
    const { sliceCommand } = await import('./slice.mjs');
    return (args, flags) => sliceCommand('start', args, flags);
  },
  'slice finish': async () => {
    const { sliceCommand } = await import('./slice.mjs');
    return (args, flags) => sliceCommand('finish', args, flags);
  },
  'slice abandon': async () => {
    const { sliceCommand } = await import('./slice.mjs');
    return (args, flags) => sliceCommand('abandon', args, flags);
  },
  'shared plan': async () => (await import('./shared.mjs')).sharedPlanCommand,
  'shared install': async () => (await import('./shared.mjs')).sharedInstallCommand,
  evidence: async () => (await import('./evidence.mjs')).evidenceCommand,
  index: async () => (await import('./repoindex.mjs')).indexCommand,
  map: async () => (await import('./map.mjs')).mapCommand,
  tests: async () => (await import('./tests.mjs')).testsCommand,
  why: async () => {
    const { whyCommand } = await import('./why.mjs');
    return (args, flags) => whyCommand(args, flags, COMMANDS);
  },
  gate: async () => (await import('./gate.mjs')).gateCommand,
  impact: async () => {
    const { impactCommand } = await import('./impact.mjs');
    return (args, flags) => impactCommand(args, flags, COMMANDS);
  },
  'lessons capture': async () => (await import('./lessons.mjs')).lessonsCaptureCommand,
  'lessons list': async () => (await import('./lessons.mjs')).lessonsListCommand,
  'lessons review': async () => (await import('./lessons.mjs')).lessonsReviewCommand,
  decide: async () => (await import('./decide.mjs')).decideCommand,
  // Plan 0003 R46. A bare command: the code is a positional, so there is no
  // group and no default subcommand to resolve.
  explain: async () => (await import('./explain.mjs')).explainCommand,
  // Plan 0003 R49. A bare command: restoring the last journaled set needs no
  // subcommand, so there is no group and no default to resolve.
  undo: async () => (await import('./undo.mjs')).undoCommand,
  // Plan 0003 R55. A bare command: the body is derived from the tree, the
  // ledger and the last check, so there is no subcommand to resolve and no
  // write to confirm.
  'pr-body': async () => (await import('./prbody.mjs')).prBodyCommand,
  // Plan 0003 R52. A bare command: the one list is `.simtignore`, so there is no
  // group and no default subcommand to resolve.
  ignore: async () => (await import('./ignore.mjs')).ignoreCommand,
  // Plan 0003 R54. A bare command: paths claim, no paths list, so the argument itself
  // is the mode and there is no group to resolve.
  lease: async () => (await import('./lease.mjs')).leaseCommand,
  distill: async () => (await import('./distill.mjs')).distillCommand,
  // R25 machinery needs the runnable command names for Affects command tokens,
  // same wiring `why` and `impact` get through their lambdas.
  review: async () => {
    const { reviewCommand } = await import('./review.mjs');
    return (args, flags) => reviewCommand(args, flags, COMMANDS);
  },
  'local doctor': async () => (await import('./local.mjs')).localDoctorCommand,
  'evidence check': async () => {
    const { evidenceCommand } = await import('./evidence.mjs');
    return (args, flags) => evidenceCommand(['check', ...args], flags);
  },
  init: async () => (await import('./init.mjs')).initCommand,
  ci: async () => (await import('./ci.mjs')).ciCommand,
  'hooks install': async () => {
    const { hooksCommand } = await import('./hooks.mjs');
    return (args, flags) => hooksCommand('install', args, flags);
  },
  'hooks status': async () => {
    const { hooksCommand } = await import('./hooks.mjs');
    return (args, flags) => hooksCommand('status', args, flags);
  },
  'hooks run': async () => {
    const { hooksCommand } = await import('./hooks.mjs');
    return (args, flags) => hooksCommand('run', args, flags);
  },
  'agent-hook': async () => (await import('./agenthook.mjs')).agentHookCommand,
  'agent-hooks install': async () => {
    const { agentHooksCommand } = await import('./agenthook.mjs');
    return (args, flags) => agentHooksCommand('install', args, flags);
  },
  'agent-hooks status': async () => {
    const { agentHooksCommand } = await import('./agenthook.mjs');
    return (args, flags) => agentHooksCommand('status', args, flags);
  },
  // ADR-111. The one agent this tool ships, written into each harness's own agents
  // directory. A group like `agent-hooks`: `install` writes, `status` reads.
  'agents install': async () => {
    const { agentsCommand } = await import('./agent.mjs');
    return (args, flags) => agentsCommand('install', args, flags);
  },
  'agents status': async () => {
    const { agentsCommand } = await import('./agent.mjs');
    return (args, flags) => agentsCommand('status', args, flags);
  },
  compare: async () => (await import('./compare.mjs')).compareCommand,
  tokens: async () => (await import('./tokens.mjs')).tokensCommand,
  'harness detect': async () => (await import('./harness.mjs')).harnessCommand,
  'harness loaders': async () => (await import('./harness.mjs')).harnessLoadersCommand,
  'bench mine': async () => (await import('./bench.mjs')).benchMineCommand,
  'bench run': async () => (await import('./bench.mjs')).benchRunCommand,
  'bench report': async () => (await import('./bench.mjs')).benchReportCommand,
  'bench ablate': async () => (await import('./bench.mjs')).benchAblateCommand,
  'bench probes': async () => (await import('./bench.mjs')).benchProbesCommand,
  'bench variants': async () => (await import('./bench.mjs')).benchVariantsCommand,
  // plan 0003 R39. The critic's acceptance bench measures BLOCK-precision and
  // recall over a labelled set; until it reports its floor, the critic entries
  // stay advisory and no gate reads them. COMMANDS rides along so the brief
  // resolves Affects command tokens the way `simt why` does.
  'bench critic': async () => {
    const { benchCriticCommand } = await import('./bench.mjs');
    return (args, flags) => benchCriticCommand(args, flags, COMMANDS);
  },
  // review 0003 Q48. Sealed corpus transfer: export writes one signed JSON
  // document carrying every task and both hidden patches; import verifies the
  // seal before it touches the vault.
  'bench export': async () => (await import('./bench.mjs')).benchExportCommand,
  'bench import': async () => (await import('./bench.mjs')).benchImportCommand,
  upgrade: async () => (await import('./upgrade.mjs')).upgradeCommand,
  mcp: async () => (await import('./mcp.mjs')).mcpCommand,
  // plan 0003 R43. A bare command: the kind is a positional, so there is no group and
  // no default subcommand to resolve.
  plugin: async () => (await import('./plugin.mjs')).pluginCommand,
  // Plan 0003 R51. A bare command: the shell is a positional. `COMMANDS` rides in
  // from here so the engine keeps no second copy of the registry it completes.
  completions: async () => {
    const { completionsCommand } = await import('./completions.mjs');
    return (args, flags) => completionsCommand(args, flags, COMMANDS);
  },
  // Plan 0003 R45. A group, not a bare command: `new` and `publish` write (or
  // publish) and `lint` reads, and the dispatcher routes all three through one
  // subcommand switch the way `hooks` does.
  'pack new': async () => {
    const { packCommand } = await import('./pack.mjs');
    return (args, flags) => packCommand('new', args, flags);
  },
  'pack lint': async () => {
    const { packCommand } = await import('./pack.mjs');
    return (args, flags) => packCommand('lint', args, flags);
  },
  'pack publish': async () => {
    const { packCommand } = await import('./pack.mjs');
    return (args, flags) => packCommand('publish', args, flags);
  },
};

/**
 * The dispatchable command paths, sorted. The authoritative answer to "what can this
 * binary do", as opposed to the answer `--help` gives - and the same list the spec
 * declares, so a command cannot be dispatchable and undeclared.
 */
export const COMMANDS = SPEC_PATHS;

export async function dispatch(argv) {
  const { flags, positional, parseError } = parseOrExit(argv);

  // The JSON shape is decided once, here, and every command inherits it. Threading a
  // `--pretty` through twenty-five call sites would mean twenty-five places to forget,
  // and the one that forgot would be the one a reader pipes into a script.
  //
  // Both halves are set before anything can fail, because a command that fails under
  // `--json` has still produced a result: the reason it failed. Set here, an unknown
  // command answers in the same shape a working one does, and the caller's parse
  // never sees an empty document.
  jsonIndentDefault(flags.pretty === true);
  jsonFailMode(flags.json === true);

  // A parse failure is already the whole answer: report it once, in the asked-for
  // shape, rather than falling through to `unknown command` on the empty path.
  if (parseError !== undefined) return fail(parseError.message, parseError.code);

  // Help is shown only when explicitly asked for. An unknown command must fail with
  // a usage code, not print 40 lines of prose and exit 0 — an agent that mistyped
  // needs to be told so, not handed a wall of text it may misread as output.
  // `-h` is the alias a reader types first, and it used to reach `unknown command '-h'`.
  if (flags.help || flags.version || positional[0] === 'help' || positional[0] === '-h') {
    // The argv is parsed once, here, and help renders what that parse produced: it used
    // to parse the same argv again, so `simt --help` paid for two parses and could in
    // principle answer a different question than the dispatcher asked (review 0003 Q83).
    return help(argv, { flags, positional, parseError });
  }

  const [first, second] = positional;
  const path = commandPath(first, second);
  // Arguments after the command path. A group consumed two tokens (`graph lint`),
  // a bare command one, so the offset depends on the shape that resolved.
  const offset = GROUPS.has(first) && second !== undefined ? 2 : 1;

  if (path === null) {
    return fail(`unknown command \`${[first, second].filter(Boolean).join(' ')}\``, EXIT.USAGE);
  }

  const args = positional.slice(offset);

  // Review 0003 Q62, deprecation window. The parser accepts every flag for every
  // command, so `status --frozen` ran, ignored the flag and reported success - the
  // caller's intent discarded with nothing to notice. A flag the spec does not declare
  // for this path is named on stderr and still runs for one release; the next release
  // makes it EXIT.USAGE. `--json` has no warnings array yet, so the JSON half of the
  // window waits on the envelope (Q65).
  const declared = DECLARED.get(path);
  for (const key of Object.keys(flags)) {
    if (!declared || GLOBAL_FLAGS.has(key)) continue;
    const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    if (declared.has(name)) continue;
    const message = `--${name} is not a flag of \`${path}\`; it was ignored, and naming one this command does not take will be a usage error in the next release`;
    warn(message);
    if (!isJson(flags)) note(message);
  }
  const load = IMPLEMENTED[path];
  if (!load) return fail(`unknown command \`${path}\``, EXIT.USAGE);
  // Import only the module the matched path needs. The registry used to pull every
  // command's module graph - detection, projection, the bench corpus - before dispatch
  // began, which cost 36.5 ms on a `status --line` that reads one file (review 0003 Q64).
  const run = await load();
  return run(args, flags);
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
  //
  // Read from IMPLEMENTED rather than from a second list. The list existed because
  // there was no way to enumerate what dispatch could run — `IMPLEMENTED` was an
  // object literal inside `dispatch()` — and a hand-kept copy of it had already
  // drifted: it carried `doctor`, which `commandPath` can never match, because
  // `doctor` is not a group and this branch is only reached when `GROUPS.has(first)`.
  // Two lists of the same fact is the defect S15 was about in the help text.
  const key = `${first} ${second}`;
  if (!(key in IMPLEMENTED)) {
    return null;
  }
  return key;
}

function parseOrExit(argv) {
  // Unreachable from `bin` (it renders the failure itself and exits), but `dispatch`
  // is also called directly: carry the failure as data so the dispatcher reports it
  // once, in the asked-for shape, instead of printing here and again below.
  const parsed = parse(argv);
  if (!parsed.ok) {
    const json = rawJsonFlag(argv);
    return { flags: { json }, positional: [], parseError: parsed.error };
  }
  return parsed.value;
}

