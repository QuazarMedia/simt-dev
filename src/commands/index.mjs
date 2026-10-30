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
  isJson,
  jsonFailMode,
  jsonIndentDefault,
} from '../output/index.mjs';
import { help } from './help.mjs';
import { lintCommand } from './graph.mjs';
import {
  indexCommand as skillsIndex,
  findCommand as skillsFind,
  briefCommand as skillsBrief,
  showCommand as skillsShow,
  whyCommand as skillsWhy,
  evalCommand as skillsEval,
} from './skills.mjs';
import { briefCommand } from './brief.mjs';
import { syncCommand, checkCommand } from './sync.mjs';
import { initCommand } from './init.mjs';
import { ciCommand } from './ci.mjs';
import { hooksCommand } from './hooks.mjs';
import { agentHookCommand, agentHooksCommand } from './agenthook.mjs';
import { compareCommand } from './compare.mjs';
import { upgradeCommand } from './upgrade.mjs';
import { mcpCommand } from './mcp.mjs';
import { pluginCommand } from './plugin.mjs';
import { packCommand } from './pack.mjs';
import { installCommand } from './skillsinstall.mjs';
import { compileCommand } from './skillscompile.mjs';
import { decisionsCommand as rulesDecisions, listCommand as rulesList, showCommand as rulesShow, whyCommand as rulesWhy } from './rules.mjs';
import { tokensCommand } from './tokens.mjs';
import { harnessCommand, harnessLoadersCommand } from './harness.mjs';
import {
  benchMineCommand,
  benchRunCommand,
  benchReportCommand,
  benchAblateCommand,
  benchProbesCommand,
  benchVariantsCommand,
  benchCriticCommand,
} from './bench.mjs';
import { planCommand } from './plan.mjs';
import { sliceCommand } from './slice.mjs';
import { leaseCommand } from './lease.mjs';
import { sharedPlanCommand, sharedInstallCommand } from './shared.mjs';
import { runDoctor } from './doctor.mjs';
import { statusCommand } from './status.mjs';
import { evidenceCommand } from './evidence.mjs';
import { indexCommand } from './repoindex.mjs';
import { mapCommand } from './map.mjs';
import { testsCommand } from './tests.mjs';
import { whyCommand } from './why.mjs';
import { gateCommand } from './gate.mjs';
import { impactCommand } from './impact.mjs';
import { lessonsListCommand, lessonsReviewCommand } from './lessons.mjs';
import { decideCommand } from './decide.mjs';
import { explainCommand } from './explain.mjs';
import { undoCommand } from './undo.mjs';
import { prBodyCommand } from './prbody.mjs';
import { ignoreCommand } from './ignore.mjs';
import { completionsCommand } from './completions.mjs';
import { reviewCommand } from './review.mjs';
import { localDoctorCommand } from './local.mjs';
import { distillCommand } from './distill.mjs';
import { parse, rawJsonFlag } from '../argv.mjs';
import { CLI } from '../name.mjs';

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
  ['plan', 'status'],
  // Plan 0003 R53. Both halves write, so a bare `slice` has no read to default to.
  // `start` is the default because with the id it is missing it fails with a usage
  // error before anything is created — the one default here that cannot mutate.
  ['slice', 'start'],
  ['agent-hooks', 'status'],
  ['harness', 'detect'],
  ['bench', 'mine'],
  // ADR-084. `shared` is the one group whose default writes nothing, and it is `plan` for
  // the same reason `skills`'s is `index`: the read answers "what would this do, and
  // where", and `install` — the subcommand that touches a reader's home directory — is the
  // one that needs `--yes` before it does anything.
  ['shared', 'plan'],
  ['lessons', 'list'],
  ['local', 'doctor'],
  // Plan 0003 R45. The default is the read: `pack` alone lints the working
  // directory, the way `skills` alone indexes and `graph` alone lints.
  ['pack', 'lint'],
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
export const IMPLEMENTED = {
  brief: briefCommand,
  doctor: runDoctor,
  // Plan 0003 R48. A bare command: the only mode is `--line`, so there is no
  // group and no default subcommand to resolve.
  status: statusCommand,
  'graph lint': lintCommand,
  'skills index': skillsIndex,
  'skills find': skillsFind,
  'skills brief': skillsBrief,
  'skills show': skillsShow,
  'skills why': skillsWhy,
  'skills eval': skillsEval,
  'skills install': installCommand,
  'skills compile': compileCommand,
  'rules decisions': rulesDecisions,
  'rules list': rulesList,
  'rules show': rulesShow,
  'rules why': rulesWhy,
  sync: syncCommand,
  check: checkCommand,
  'plan status': (args, flags) => planCommand('status', args, flags),
  'plan next': (args, flags) => planCommand('next', args, flags),
  'plan done': (args, flags) => planCommand('done', args, flags),
  // Plan 0003 R53. A group: `start` isolates the work on a branch with its brief,
  // `finish` runs the gates, commits and records the evidence, and `abandon`
  // (review 0003 Q23) takes the slice back down. All three take the slice id
  // as a positional.
  'slice start': (args, flags) => sliceCommand('start', args, flags),
  'slice finish': (args, flags) => sliceCommand('finish', args, flags),
  'slice abandon': (args, flags) => sliceCommand('abandon', args, flags),
  'shared plan': sharedPlanCommand,
  'shared install': sharedInstallCommand,
  evidence: evidenceCommand,
  index: indexCommand,
  map: mapCommand,
  tests: testsCommand,
  why: (args, flags) => whyCommand(args, flags, COMMANDS),
  gate: gateCommand,
  impact: (args, flags) => impactCommand(args, flags, COMMANDS),
  'lessons list': lessonsListCommand,
  'lessons review': lessonsReviewCommand,
  decide: decideCommand,
  // Plan 0003 R46. A bare command: the code is a positional, so there is no
  // group and no default subcommand to resolve.
  explain: explainCommand,
  // Plan 0003 R49. A bare command: restoring the last journaled set needs no
  // subcommand, so there is no group and no default to resolve.
  undo: undoCommand,
  // Plan 0003 R55. A bare command: the body is derived from the tree, the
  // ledger and the last check, so there is no subcommand to resolve and no
  // write to confirm.
  'pr-body': prBodyCommand,
  // Plan 0003 R52. A bare command: the one list is `.simtignore`, so there is no
  // group and no default subcommand to resolve.
  ignore: ignoreCommand,
  // Plan 0003 R54. A bare command: paths claim, no paths list, so the argument itself
  // is the mode and there is no group to resolve.
  lease: leaseCommand,
  distill: distillCommand,
  // R25 machinery needs the runnable command names for Affects command tokens,
  // same wiring `why` and `impact` get through their lambdas.
  review: (args, flags) => reviewCommand(args, flags, COMMANDS),
  'local doctor': localDoctorCommand,
  'evidence check': (args, flags) => evidenceCommand(['check', ...args], flags),
  init: initCommand,
  ci: ciCommand,
  'hooks install': (args, flags) => hooksCommand('install', args, flags),
  'hooks status': (args, flags) => hooksCommand('status', args, flags),
  'hooks run': (args, flags) => hooksCommand('run', args, flags),
  'agent-hook': agentHookCommand,
  'agent-hooks install': (args, flags) => agentHooksCommand('install', args, flags),
  'agent-hooks status': (args, flags) => agentHooksCommand('status', args, flags),
  compare: compareCommand,
  tokens: tokensCommand,
  'harness detect': harnessCommand,
  'harness loaders': harnessLoadersCommand,
  'bench mine': benchMineCommand,
  'bench run': benchRunCommand,
  'bench report': benchReportCommand,
  'bench ablate': benchAblateCommand,
  'bench probes': benchProbesCommand,
  'bench variants': benchVariantsCommand,
  // plan 0003 R39. The critic's acceptance bench measures BLOCK-precision and
  // recall over a labelled set; until it reports its floor, the critic entries
  // stay advisory and no gate reads them. COMMANDS rides along so the brief
  // resolves Affects command tokens the way `simt why` does.
  'bench critic': (args, flags) => benchCriticCommand(args, flags, COMMANDS),
  upgrade: upgradeCommand,
  mcp: mcpCommand,
  // plan 0003 R43. A bare command: the kind is a positional, so there is no group and
  // no default subcommand to resolve.
  plugin: pluginCommand,
  // Plan 0003 R51. A bare command: the shell is a positional. `COMMANDS` rides in
  // from here so the engine keeps no second copy of the registry it completes.
  completions: (args, flags) => completionsCommand(args, flags, COMMANDS),
  // Plan 0003 R45. A group, not a bare command: `new` and `publish` write (or
  // publish) and `lint` reads, and the dispatcher routes all three through one
  // subcommand switch the way `hooks` does.
  'pack new': (args, flags) => packCommand('new', args, flags),
  'pack lint': (args, flags) => packCommand('lint', args, flags),
  'pack publish': (args, flags) => packCommand('publish', args, flags),
};

/**
 * The dispatchable command paths, sorted. The authoritative answer to "what can this
 * binary do", as opposed to the answer `--help` gives.
 */
export const COMMANDS = Object.keys(IMPLEMENTED).sort();

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
      `\`${CLI} ${path}\` is declared but not implemented`,
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
  if (!STEPS.has(key) && !(key in IMPLEMENTED)) {
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

