// Command registry and dispatch.
//
// Every command named in docs/research/0002-simt-dev-cli.md section 5 is registered
// here from day one. A command that is declared but not yet implemented exits
// UNSUPPORTED with a pointer to its implementation step; it never silently
// succeeds. An agent that calls `simt compare` on an unreleased build must get a
// failure, not an empty result it will read as "no drift".

import {
  EXIT,
  jsonCaptureStart,
  jsonCaptureTake,
  jsonCommand,
  emit,
  emitJson,
  fail,
  clearWarnings,
  note,
  warn,
  isJson,
  jsonFailMode,
  jsonIndentDefault,
  maxBytesLimit,
  withOutputState,
} from '../output/index.mjs';
import { help } from './help.mjs';
import { ALIASES, GROUP_DEFAULTS, SPEC, SPEC_PATHS } from './spec.mjs';
import { parse, rawJsonFlag } from '../argv.mjs';
import { CLI } from '../name.mjs';
import { packageVersion } from '../package-version.mjs';


/**
 * Groups whose subcommand may be omitted, and the default for each. Read from the spec
 * rather than kept here: this was the second copy of a fact the spec
 * owns, and the reason for each default now sits on the row that declares it.
 */
export const GROUPS = GROUP_DEFAULTS;

/** path -> the flags the spec declares for it. The parser knows every flag; this is
 * what one command reads, and the difference is what the caller is told . */
const DECLARED = new Map(SPEC.map((row) => [row.path, new Set(row.flags ?? [])]));

/** Flags dispatch reads for every command: the envelope and the guard rails. */
/** path -> the values a flag of that path accepts, where the set is closed. */
const VALUES = new Map(SPEC.map((row) => [row.path, row.values ?? {}]));

// `dashdash` is the parser's record that `--` appeared, not a flag any reader typed:
// it is an envelope fact like `root`, so the per-command declaration check skips it
// and lets the one command that reads it (slice start) act on it.
export const GLOBAL_FLAGS = new Set(['root', 'json', 'pretty', 'help', 'version', 'maxBytes', 'dashdash']);

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
 * command pays for its own module graph and not for the other seventy-five
 *. A loader that never resolves is a command that cannot run, and `test/spec.test.mjs`
 * still holds the key set against the spec.
 */
export const IMPLEMENTED = {
  brief: async () => {
    const { briefCommand } = await import('./brief.mjs');
    return (args, flags) => briefCommand(args, flags, COMMANDS);
  },
  doctor: async () => (await import('./doctor.mjs')).runDoctor,
  // A bare command: the only mode is `--line`, so there is no
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
  'plan labels': async () => {
    const { planCommand } = await import('./plan.mjs');
    return (args, flags) => planCommand('labels', args, flags);
  },
  'plan next': async () => {
    const { planCommand } = await import('./plan.mjs');
    return (args, flags) => planCommand('next', args, flags);
  },
  'plan done': async () => {
    const { planCommand } = await import('./plan.mjs');
    return (args, flags) => planCommand('done', args, flags);
  },
  // A group: `start` isolates the work on a branch with its brief,
  // `finish` runs the gates, commits and records the evidence, and `abandon`
  // takes the slice back down. All three take the slice id
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
  'decide new': async () => (await import('./decide.mjs')).decideCommand,
  // `decide lint` is the check that used to be `decide --check`. It routes through the
  // same handler with the flag set, so the two spellings cannot answer differently.
  'decide lint': async () => {
    const { decideCommand } = await import('./decide.mjs');
    return (args, flags) => decideCommand(args, { ...flags, check: true });
  },
  // A bare command: the code is a positional, so there is no
  // group and no default subcommand to resolve.
  explain: async () => (await import('./explain.mjs')).explainCommand,
  // A bare command: restoring the last journaled set needs no
  // subcommand, so there is no group and no default to resolve.
  undo: async () => (await import('./undo.mjs')).undoCommand,
  // A bare command: the body is derived from the tree, the
  // ledger and the last check, so there is no subcommand to resolve and no
  // write to confirm.
  'pr-body': async () => (await import('./prbody.mjs')).prBodyCommand,
  // A bare command: the one list is `.simtignore`, so there is no
  // group and no default subcommand to resolve.
  ignore: async () => (await import('./ignore.mjs')).ignoreCommand,
  // A bare command: paths claim, no paths list, so the argument itself
  // is the mode and there is no group to resolve.
  lease: async () => (await import('./lease.mjs')).leaseCommand,
  // The README's command list is the last copy of the command table
  // the spec owns; the renderer lives in src/docs so a test can hold the file to it.
  'docs readme': async () => {
    const { docsCommand } = await import('./docs.mjs');
    return (args, flags) => docsCommand('readme', args, flags);
  },
  distill: async () => (await import('./distill.mjs')).distillCommand,
  // machinery needs the runnable command names for Affects command tokens,
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
  // The alias spelling of `hooks install --agent` / `hooks status --agent`. It routes
  // through the same command so the two spellings cannot drift, and it says which one was
  // typed in the report and the remedy.
  'agent-hooks install': async () => {
    const { hooksCommand } = await import('./hooks.mjs');
    return (args, flags) =>
      hooksCommand('install', args, flags, {
        agent: true,
        command: 'agent-hooks install',
        install: 'agent-hooks install',
      });
  },
  'agent-hooks status': async () => {
    const { hooksCommand } = await import('./hooks.mjs');
    return (args, flags) =>
      hooksCommand('status', args, flags, {
        agent: true,
        command: 'agent-hooks status',
        install: 'agent-hooks install',
      });
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
  //. The critic's acceptance bench measures BLOCK-precision and
  // recall over a labelled set; until it reports its floor, the critic entries
  // stay advisory and no gate reads them. COMMANDS rides along so the brief
  // resolves Affects command tokens the way `simt why` does.
  'bench critic': async () => {
    const { benchCriticCommand } = await import('./bench.mjs');
    return (args, flags) => benchCriticCommand(args, flags, COMMANDS);
  },
  //. Sealed corpus transfer: export writes one signed JSON
  // document carrying every task and both hidden patches; import verifies the
  // seal before it touches the vault.
  'bench export': async () => (await import('./bench.mjs')).benchExportCommand,
  'bench import': async () => (await import('./bench.mjs')).benchImportCommand,
  upgrade: async () => (await import('./upgrade.mjs')).upgradeCommand,
  mcp: async () => (await import('./mcp.mjs')).mcpCommand,
  //. A bare command: the kind is a positional, so there is no group and
  // no default subcommand to resolve.
  plugin: async () => (await import('./plugin.mjs')).pluginCommand,
  // A bare command: the shell is a positional. `COMMANDS` rides in
  // from here so the engine keeps no second copy of the registry it completes.
  completions: async () => {
    const { completionsCommand } = await import('./completions.mjs');
    return (args, flags) => completionsCommand(args, flags, COMMANDS);
  },
  // A group, not a bare command: `new` and `publish` write (or
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
 * Resolve one command path to its handler, its declared flags and its closed value sets.
 *
 * The library surface needs the same answer `dispatch` gets and must not build a second
 * registry to get it: a command reachable from the CLI and absent from `run` is the drift
 * `test/spec.test.mjs` exists to catch, and it would be invisible here.
 */
export async function resolveCommand(path) {
  const load = IMPLEMENTED[path];
  if (!load) return null;
  return {
    run: await load(),
    declared: DECLARED.get(path) ?? new Set(),
    values: VALUES.get(path) ?? {},
  };
}

/** The release that turns the tolerated flag into a usage error. */
export const DEPRECATION_RELEASE = '0.9.0';

/**
 * Whether a tolerance that ends at `removedIn` has ended, comparing the way versions
 * are numbered rather than the way strings are ordered: 0.10.0 is later than 0.9.0, and
 * a string comparison says the opposite. An unreadable version refuses nothing - a build
 * whose version cannot be read has not outlived anything, and guessing would break it.
 */
export function refusesAt(removedIn, version) {
  const parse = (value) => {
    const parts = String(value ?? '').split('.');
    if (parts.length < 2 || parts.some((part) => !/^\d+$/.test(part))) return null;
    return parts.map(Number);
  };
  const limit = parse(removedIn);
  const current = parse(version);
  if (limit === null || current === null) return false;
  const [a, b] = [current[0] - limit[0], current[1] - limit[1]];
  if (a !== 0) return a > 0;
  return b >= 0;
}

/**
 * The dispatchable command paths, sorted. The authoritative answer to "what can this
 * binary do", as opposed to the answer `--help` gives - and the same list the spec
 * declares, so a command cannot be dispatchable and undeclared.
 */
export const COMMANDS = SPEC_PATHS;

/**
 * Dispatch one argv.
 *
 * The state is per call: an MCP server and the tests both dispatch more than once in a
 * process, and a shared envelope let one run's ceiling, notices and command path land in
 * another run's document.
 */
export async function dispatch(argv) {
  return withOutputState(() => dispatchInState(argv));
}

async function dispatchInState(argv) {
  const { flags, positional, parseError } = parseOrExit(argv);
  // One run, one set of notices: a process can dispatch repeatedly.
  clearWarnings();
  // Cleared per run for the same reason the notices are: a process can dispatch twice.
  jsonCommand(null);

  // The JSON shape is decided once, here, and every command inherits it. Threading a
  // `--pretty` through twenty-five call sites would mean twenty-five places to forget,
  // and the one that forgot would be the one a reader pipes into a script.
  //
  // Both halves are set before anything can fail, because a command that fails under
  // `--json` has still produced a result: the reason it failed. Set here, an unknown
  // command answers in the same shape a working one does, and the caller's parse
  // never sees an empty document.
  jsonIndentDefault(flags.pretty === true);
  // The envelope owns both presentation flags. A command that decided its own ceiling or
  // its own indentation could disagree with the flag the caller passed, and the caller has
  // no way to see which one won.
  maxBytesLimit(flags.maxBytes);
  jsonFailMode(flags.json === true);

  // A parse failure is already the whole answer: report it once, in the asked-for
  // shape, rather than falling through to `unknown command` on the empty path.
  if (parseError !== undefined) return fail(parseError.message, parseError.code);

  // Help is shown only when explicitly asked for. An unknown command must fail with
  // a usage code, not print 40 lines of prose and exit 0 — an agent that mistyped
  // needs to be told so, not handed a wall of text it may misread as output.
  // `-h` is the alias a reader types first. Matched anywhere in the positional words,
  // not just first: `simt check -h` used to run the check with `-h` as an argument and
  // `simt plan next -h` looked for a slice by that name, both instead of printing a page.
  if (flags.help || flags.version || positional[0] === 'help' || positional.includes('-h')) {
    // The argv is parsed once, here, and help renders what that parse produced: it used
    // to parse the same argv again, so `simt --help` paid for two parses and could in
    // principle answer a different question than the dispatcher asked.
    return help(argv, { flags, positional, parseError });
  }

  const [first, second] = positional;
  const resolution = resolveCommandPath(first, second);
  if (resolution === null) {
    return fail(`unknown command \`${[first, second].filter(Boolean).join(' ')}\``, EXIT.USAGE);
  }
  // Arguments after the command path. A group consumed two tokens (`graph lint`); a group
  // whose default reads the rest of the line (`decide "<title>"`) consumed one.
  const { path, consumed } = resolution;
  const offset = consumed;

  // One path, stated once, by the only code that knows which one resolved.
  jsonCommand(path);

  const args = positional.slice(offset);

  // deprecation window. The parser accepts every flag for every
  // command, so `status --frozen` ran, ignored the flag and reported success - the
  // caller's intent discarded with nothing to notice. A flag the spec does not declare
  // for this path is named on stderr and still runs for one release; the next release
  // makes it EXIT.USAGE. `--json` has no warnings array yet, so the JSON half of the
  // window waits on the envelope .
  const declared = DECLARED.get(path);
  const refusing = refusesAt(DEPRECATION_RELEASE, packageVersion());
  for (const key of Object.keys(flags)) {
    if (!declared || GLOBAL_FLAGS.has(key)) continue;
    const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    if (declared.has(name)) continue;
    if (refusing) {
      return fail(`--${name} is not a flag of \`${path}\`; it was tolerated until ${DEPRECATION_RELEASE} and is refused now`, EXIT.USAGE);
    }
    const message = `--${name} is not a flag of \`${path}\`; it was ignored, and naming one this command does not take is a usage error from ${DEPRECATION_RELEASE}`;
    warn(message);
    if (!isJson(flags)) note(message);
  }
  const load = IMPLEMENTED[path];
  if (!load) return fail(`unknown command \`${path}\``, EXIT.USAGE);
  // Import only the module the matched path needs. The registry used to pull every
  // command's module graph - detection, projection, the bench corpus - before dispatch
  // began, which cost 36.5 ms on a `status --line` that reads one file.
  // A closed set is refused before the command runs, so the caller learns the valid
  // values from the refusal and every reader of the spec sees the same set (review
  // Unset is not the same as invalid: the default stays the command's.
  for (const [flag, allowed] of Object.entries(VALUES.get(path) ?? {})) {
    const value = flags[flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    if (value !== undefined && !allowed.includes(value)) {
      return fail(`--${flag} takes ${allowed.join(', ')}; received ${value}`, EXIT.USAGE);
    }
  }

  const run = await load();
  if (!isJson(flags)) return run(args, flags);
  // Capture, then write once: the envelope names an exit code that does not exist until
  // the command returns, and a document written before it is a document that can lie.
  jsonCaptureStart();
  const code = await run(args, flags);
  const docs = jsonCaptureTake() ?? [];
  const [only] = docs;
  if (docs.length === 1 && only.value !== null && typeof only.value === 'object' && !Array.isArray(only.value)) {
    emitJson({ ...only.value, ok: only.value.ok ?? code === 0, exitCode: code });
    return code;
  }
  // A stream of documents (NDJSON) has no single place for one exit code; each is written
  // as the command produced it, and the process exit status still carries the code.
  for (const doc of docs) emitJson(doc.value);
  return code;
}

/**
 * Normalise argv into a registry key, or null when unrecognised.
 * A group with an omitted subcommand resolves to that group's default, so
 * `simt skills` is `simt skills index`.
 *
 * An alias resolves here rather than as a second registry entry: the spec path stays the
 * one dispatch key, so an alias cannot load a different handler or escape the flag
 * declaration the path carries.
 */
/**
 * Groups whose default subcommand reads the rest of the line as its own argument.
 *
 * `decide` scaffolds from a title, so `simt decide "<title>"` has to keep working now that
 * `decide lint` makes it a group. Naming the group here is the difference between a
 * declared shape and a guess: for every other group a second token that names no
 * subcommand stays the error it already was, so `simt skills nonsense` cannot silently
 * become `simt skills index`.
 */
const GROUP_DEFAULT_TAKES_ARGUMENTS = new Set(['decide']);

/**
 * The path a pair of positionals resolves to, and how many tokens that path consumed.
 *
 * The count is part of the answer: a group default that reads the rest of the line takes
 * one token (`decide "a title"`), every other form takes the tokens it matched. Deriving
 * the argument slice anywhere else would be a second opinion about which shape resolved.
 */
function resolveCommandPath(first, second) {
  if (first === undefined) return null;
  if (!GROUPS.has(first)) return { path: ALIASES.get(first) ?? first, consumed: 1 };

  const group = GROUPS.get(first);
  if (second === undefined) return { path: `${first} ${group}`, consumed: 1 };
  // Reject a second token that is not a subcommand of this group, rather than
  // silently routing `simt skills nonsense` to the default subcommand.
  //
  // Read from IMPLEMENTED rather than from a second list, because a hand-kept copy of it
  // had already drifted: one carried `doctor`, which this branch can never match, since
  // `doctor` is not a group. Two lists of the same fact is the defect the help text was
  // fixed for.
  const key = `${first} ${second}`;
  if (key in IMPLEMENTED) return { path: key, consumed: 2 };
  const alias = ALIASES.get(key);
  if (alias !== undefined) return { path: alias, consumed: 2 };
  if (GROUP_DEFAULT_TAKES_ARGUMENTS.has(first)) return { path: `${first} ${group}`, consumed: 1 };
  return null;
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

