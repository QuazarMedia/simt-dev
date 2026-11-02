// The command spec: one row per path this binary dispatches.
//
// The list of commands existed in four places that disagreed - the dispatch map, a
// hand-written `--help` template, the completions table and the README - so a command
// could work and be undiscoverable, or be documented and absent. A row here is the one
// place a command is declared; `src/commands/index.mjs` derives its dispatchable paths
// and group defaults from it, and `test/spec.test.mjs` fails when the registry and the
// spec stop agreeing in either direction.
//
// The fields that only some consumers need (`tier`, `writes`, `args`, `flags`) arrive
// with the slices that read them: help , validation , MCP . A field no
// code reads is a field that drifts, and a wrong `writes` claim is worse than none.
//
// `defaultFor` marks the subcommand a bare group resolves to. It sits on the row that
// IS the default rather than on a separate map, so the reason for a default lives beside
// the command it names - `skills` alone indexes because the read is the safe default,
// `slice` alone starts because an id-less `start` fails before it writes anything.

/**
 * @typedef {object} SpecRow
 * @property {string} path the dispatch key: `status`, or `group subcommand`
 * @property {string} summary one phrase, printed by help and by the generated docs
 * @property {string} [defaultFor] the group whose bare form resolves to this row
 * @property {string[]} [aliases] spellings that resolve to this row, never listed in help
 * @property {string} [mcp] the MCP tool name that answers this row, when one does
 */

/** @type {SpecRow[]} */
export const SPEC = [
  { path: 'agent-hook', usage: '<event> --harness', summary: 'the harness entry point: decide one tool call, or deliver the prompt packet', aliases: ['harness hook'], flags: ["diff","harness"], },
  { path: 'agent-hooks install', usage: '--yes', summary: "write this repository's policies into each harness hooks file", writes: 'repo', aliases: ['harness install'], flags: ["yes","diff","harness"], },
  { path: 'agent-hooks status', summary: 'what each harness will run, and what is not trusted yet', defaultFor: 'agent-hooks', flags: ["diff","harness"], },
  { path: 'agents install', usage: '--yes', summary: 'write the Simt-Agent into each harness agents file', writes: 'repo', flags: ["yes","diff","harness"], },
  // A group like `agent-hooks`: `install` writes the agent file into each harness's own
  // directory and `status` reports what a harness carries. The default is the read.
  { path: 'agents status', summary: 'what each harness carries, and what is not installed yet', defaultFor: 'agents', flags: ["diff","harness"], },
  { path: 'bench ablate', usage: '--yes', summary: 'measure one arm of the brief against its ablation', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench critic', summary: 'score the review critic against the labelled bench set', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench export', usage: '--yes', summary: 'write the sealed bench corpus as one signed document', writes: 'repo', flags: ["yes","all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench import', summary: 'verify a sealed corpus and load it into the vault', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench mine', usage: '--yes', summary: 'mine tasks out of a repository history', writes: 'repo', flags: ["yes","all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench probes', usage: '--yes', summary: 'run the deterministic probes against a workspace', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench report', usage: '[--compare a b]', summary: 'summarise the runs recorded in the vault', defaultFor: 'bench', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench run', usage: '--yes', summary: 'run agents against the mined tasks', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'brief', usage: '"<task>"', mcp: { name: 'brief', flags: ['budget', 'paths', 'task'] }, summary: 'the packet for a task: rules, skills and the files it names, within a budget', flags: ["budget","explain","paths","task"], },
  { path: 'check', mcp: { name: 'check', flags: [] }, summary: 'report stale or missing generated regions and every check finding', flags: ["check","diff","dry-run","frozen"], },
  { path: 'workspace compare', mcp: { name: 'compare', flags: [] }, summary: 'the adoption and drift matrix across every sibling repository', aliases: ['compare'], flags: ["learn"], },
  { path: 'completions', usage: '<bash|zsh|fish>', summary: 'print a bash, zsh or fish completion script generated from this spec', flags: [], },
  { path: 'decide lint', summary: 'check every decision record for the structure a supersession needs', flags: ["check","diff"], },
  // The scaffold is the group's default, and it reads the rest of the line as its title:
  // `decide "a title"` is a title, never a subcommand, which is why the group declares
  // that its default takes arguments.
  { path: 'decide new', usage: '"<title>" --yes', summary: 'scaffold a numbered decision record with its frontmatter', writes: 'repo', defaultFor: 'decide', flags: ["yes","check","diff","dry-run","paths","supersedes","task"], },
  { path: 'distill', usage: '<skill|doc>', summary: 'turn a repository into a skill or rule proposal', flags: [], },
  { path: 'docs commands', summary: 'render the command reference in docs/commands from the spec', writes: 'repo', defaultFor: 'docs', flags: ["yes","diff"], },
  { path: 'doctor', usage: '[--fix]', mcp: { name: 'doctor', flags: [] }, summary: 'report what is wrong with this installation', writes: 'repo', flags: ["yes","diff","fix"], },
  { path: 'evidence', summary: 'the runs recorded against the tree on disk', aliases: ['evidence show'], flags: [], },
  { path: 'evidence check', usage: '<msg-file>', summary: 'a commit message claiming a run this tree does not have', flags: [], },
  { path: 'explain', usage: '<CODE>', summary: 'what one check finding code means, and how to fix it', flags: [], },
  { path: 'gate', usage: '--changed', summary: 'the tests a change reaches, and only those', flags: ["changed"], },
  { path: 'graph lint', usage: '[--spec agentskills]', summary: 'check the skill registry against the skills on disk', defaultFor: 'graph', aliases: ['skills lint'], flags: ["spec"], },
  { path: 'harness detect', usage: '[--user]', summary: 'which harness is installed, and what it carries', defaultFor: 'harness', flags: ["at","reader","table","user"], },
  { path: 'harness loaders', usage: '[--table]', summary: 'the instruction files each harness loads, and what they cost', flags: ["at","reader","table","user"], },
  { path: 'hooks install', usage: '--yes', summary: 'install the shared dispatcher; --agent writes each harness hooks file', writes: 'repo', flags: ["yes","agent","diff","dry-run"], },
  { path: 'hooks run', usage: '<event>', summary: "run one git event's gates now, as git would", writes: 'repo', flags: ["yes","diff","dry-run"], },
  { path: 'hooks status', summary: 'what each git event routes to; --agent reports each harness instead', defaultFor: 'hooks', flags: ["agent","diff","dry-run"], },
  { path: 'ignore', usage: '[--yes] [--diff]', summary: 'render the one ignore list into every harness ignore file', flags: ["diff"], },
  { path: 'impact', usage: '<file|symbol>', summary: 'who a change reaches: importers, their tests and the contract', flags: [], },
  { path: 'index', usage: '[--embed]', summary: 'rebuild the local file index from git blob hashes', flags: ["allow-remote","embed"], },
  { path: 'init', usage: '[path]', summary: 'adopt this repository: manifest, region, hooks, agents and agent-hooks', writes: 'repo', flags: ["yes","accept-conflicts","backup","baselines","diff","harness","agents","surfaces"], },
  { path: 'lease', usage: '[<paths>] --session', summary: 'claim files for one session, or list the claims', flags: ["harness","session","ttl"], },
  { path: 'lessons capture', summary: 'scan the ledger and history for new lesson candidates', flags: ["diff","expires","paths","task"], },
  { path: 'lessons list', summary: 'deterministic lesson candidates and the promoted lessons', defaultFor: 'lessons', flags: ["diff","expires","paths","task"], },
  { path: 'lessons review', usage: '<id> --yes', summary: 'promote one lesson candidate into docs/lessons', flags: ["diff","expires","paths","task"], },
  { path: 'local doctor', usage: '[--allow-remote]', summary: 'the local model endpoints, and whether they answer', defaultFor: 'local', flags: ["allow-remote"], },
  { path: 'map', usage: '--task "<task>"', summary: 'the files a task is most likely to touch, within a byte budget', flags: ["allow-remote","budget","embed","level","recall","task"], values: { level: ['outline', 'names', 'signatures'] }, },
  { path: 'mcp', usage: '[--list]', summary: 'serve the read-only MCP surface over stdio', flags: ["list"], },
  // The default is the read: `pack` alone lints the working directory,
  // the way `skills` alone indexes and `graph` alone lints.
  // No sibling repository vendors a pack, so the group is frozen: it works, it is
  // documented, and it gains no feature until one is adopted somewhere real (ADR-130).
  { path: 'pack lint', usage: '[dir] [--require-measured]', summary: 'lint a rule pack in the working directory', defaultFor: 'pack', stability: 'experimental', flags: ["diff","require-measured","source"], },
  { path: 'pack new', usage: '<name> --source <spec>', summary: 'scaffold a rule pack', stability: 'experimental', flags: ["diff","require-measured","source"], },
  { path: 'pack publish', usage: '[dir] --yes', summary: 'publish a rule pack', stability: 'experimental', flags: ["diff","require-measured","source"], },
  { path: 'plan done', usage: '<id> [<sha>] --yes', mcp: { name: 'plan_done', flags: ['state', 'test'] }, summary: 'mark one tracker row complete, with its SHA and its evidence', flags: ["diff","state","test"], },
  { path: 'plan labels', summary: 'the header each tracker column matched, and the labels this repository configured', flags: [] },
  { path: 'plan next', usage: '[<id>] [--tier <name>] [--wave <name>] [--lane <name>]', mcp: { name: 'plan_next', flags: [] }, summary: "one ready slice's section, or the one named, inside a tier, a wave or a lane", flags: ["diff","state","test","tier","wave","lane"], },
  { path: 'plan status', summary: 'count the tracker rows, the share of the plan done, and its tiers, waves and lanes', defaultFor: 'plan', flags: ["diff","state","test"], },
  { path: 'plan archive', usage: '<id>', summary: 'close a finished plan or review and move it to its archive/ directory', writes: 'repo', flags: ["force","yes"], },
  { path: 'plugin', usage: '<claude|gemini|cursor|opencode>', summary: 'generate a harness package from the same tables the hooks use', aliases: ['harness plugin'], flags: ["diff","out"], },
  { path: 'pr-body', usage: '[--base <ref>]', mcp: { name: 'pr_body', flags: ['base'] }, summary: 'the pull request body: evidence, decisions, gate state and residual risk', flags: ["base"], },
  { path: 'review', usage: '[--local]', summary: 'review the staged diff against the estate rules', flags: ["local"], },
  { path: 'rules decisions', summary: 'every known decision, and which layer each came from', writes: 'repo', flags: ["yes","all"], },
  { path: 'rules list', usage: '[--root <path>]', mcp: { name: 'rules_list', flags: [] }, summary: 'the rule catalogue, marked with what applies to this repository', defaultFor: 'rules', flags: ["all"], },
  { path: 'rules show', usage: '<id>', summary: 'one rule body', flags: ["all"], },
  { path: 'rules why', usage: '<id|ADR-NNN> [--all]', mcp: { name: 'rules_why', flags: [] }, summary: 'the decision that settled a rule, and whether it is still in force', flags: ["all"], },

  // ADR-084. One path for what used to be `shared plan` and `shared install`: they
  // differed only by `--yes`, and the read - "what would this do, and where" - is the
  // form that runs without it.
  { path: 'workspace share', summary: 'what repeated rules in a workspace cost to carry, and where they would go', writes: 'repo', defaultFor: 'workspace', aliases: ['shared plan'], flags: ["yes","diff"], },
  { path: 'workspace install', usage: '--yes', summary: 'carry those rules once per reader, at user level', writes: 'repo', aliases: ['shared install'], flags: ["yes","diff"], },
  { path: 'skills brief', usage: '--task "<task>"', mcp: { name: 'skills_brief', flags: ['all', 'task'] }, summary: 'the packet for a task, read from the skill registry', aliases: ['skills select'], flags: ["all", "plan", "task"], },
  { path: 'skills compile', usage: '[<name>]', summary: 'compile a skill to the Agent Skills standard', flags: [], },
  { path: 'skills eval', usage: '[corpus]', summary: 'score the skill registry against transcripts', flags: ["all","plan"], },
  { path: 'skills find', usage: '<query>', mcp: { name: 'skills_find', flags: [] }, summary: 'skills that match a query', flags: ["all","plan"], },
  { path: 'skills index', mcp: { name: 'skills_index', flags: [] }, summary: 'rebuild the skill index', defaultFor: 'skills', aliases: ['skills list'], flags: ["all","plan"], },
  { path: 'skills install', usage: '<name> --yes', summary: 'install skills into the workspace', writes: 'repo', flags: ["yes","diff","from","variant"], },
  { path: 'skills show', usage: '<name>', mcp: { name: 'skills_show', flags: [] }, summary: 'one skill packet', flags: ["all","plan"], },
  { path: 'skills why', usage: '<name>', mcp: { name: 'skills_why', flags: [] }, summary: 'which skill covers a task', flags: ["all","plan"], },
  { path: 'slice abandon', usage: '<id>', summary: 'remove a slice worktree, delete its branch, and return the row', aliases: ['plan abandon'], flags: ["session","test","type"], },
  { path: 'slice finish', usage: '<id> --yes', summary: 'run the gates, commit the slice and record its evidence', writes: 'repo', aliases: ['plan finish'], flags: ["yes","session","test","type"], },
  // Both halves write, so a bare `slice` has no read to default to.
  // `start` is the default because with the id it is missing it fails with a usage error
  // before anything is created - the one default here that cannot mutate.
  { path: 'slice start', usage: '<id> --yes  |  -- "<text>"', summary: 'give a slice its worktree, branch and brief; -- starts one from a prompt, no row', defaultFor: 'slice', aliases: ['plan start'], flags: ["id","session","test","type"], },
  { path: 'status', usage: '[--line]', summary: 'the repository snapshot, or one line of the last check', flags: ["line"], },
  // `--check` is the spelling bare `sync` replaced: the command already reports before it
  // writes, so the flag asked a question the default answer answers. It keeps working and
  // says what replaced it, rather than disappearing from under a script.
  { path: 'sync', usage: '--yes', summary: 're-render the generated regions from the rule content', writes: 'repo', deprecated: { check: 'sync' }, flags: ["yes","baselines","check","diff","dry-run"], },
  { path: 'tests', usage: '<path> [--cochange]  |  --run [--changed]', summary: 'the tests that exercise a file, or - with --run - the ones a change reaches', flags: ["cochange","run","changed"], },
  { path: 'tokens', usage: '[--repos] [--session]', summary: 'count tokens per instruction file and per skill', aliases: ['harness cost'], flags: ["repos","session"], },
  { path: 'undo', usage: '--yes', summary: 'restore the last journaled set of writes, if untouched', writes: 'repo', flags: ["yes","diff"], },
  { path: 'workspace upgrade', usage: '--yes', summary: 'replace this installation with the pinned release', writes: 'repo', aliases: ['upgrade'], flags: ["yes","all","diff","workspace"], },
  { path: 'why', usage: '[<subject>]', summary: 'what governs a path, rule, decision, skill or finding code', flags: [], },
];


/**
 * Which tier a command belongs to, decided by its group: the commands a reader reaches
 * for while working are core and appear in `--help`; the rest are advanced and appear
 * under `help --all`. A tier is a presentation fact, not a permission, so a command
 * cannot be missing from both pages - `test/help.test.mjs` checks that every path is on
 * one of them.
 */
const CORE_GROUPS = new Set(['brief', 'check', 'gate', 'graph', 'hooks', 'impact', 'init', 'map', 'plan', 'rules', 'skills', 'slice', 'status', 'sync', 'tests', 'why']);

/**
 * A command whose group is core and whose own work is not: the two that need a corpus, a
 * registry build or a model call to answer at all. They stay reachable and leave the core
 * page, because a tier is where a command is listed, not whether it exists.
 */
const ADVANCED_PATHS = new Set(['skills compile', 'skills eval']);

/** The tier a path is listed under: `core` or `advanced`. */
export function tierOf(path) {
  if (ADVANCED_PATHS.has(path)) return 'advanced';
  return CORE_GROUPS.has(path.split(' ')[0]) ? 'core' : 'advanced';
}

/**
 * The tools that answer a question no command asks.
 *
 * `federation_query` reads the federation config and consults a sibling repository
 * directly (src/federation/query.mjs). There is no CLI verb for it, so giving it a spec
 * row would advertise a command this binary cannot dispatch; leaving it undeclared is
 * how a tool list and a command list drift apart. It is listed here with the reason
 * instead, and test/mcp-spec.test.mjs accepts a tool without a row only when this table
 * says why.
 */
export const MCP_ONLY = [
  { tool: 'federation_query', why: 'a transport-only read: no command in this binary asks a sibling repository a question' },
];

/** The dispatchable paths, sorted - the answer to "what can this binary do". */
export const SPEC_PATHS = SPEC.map((row) => row.path).sort();

/** group -> the subcommand its bare form resolves to. */
export const GROUP_DEFAULTS = new Map(SPEC.filter((row) => row.defaultFor !== undefined).map((row) => [row.defaultFor, row.path.split(' ')[1]]));

/**
 * The spellings this binary answers that are not paths.
 *
 * A rename costs every script and every habit a reader already has, so a new name
 * arrives as an alias instead of a replacement: the path stays the dispatch key, help
 * lists the path, and the alias resolves before the registry is consulted. An alias is
 * deliberately absent from help and from the generated docs — the point of a second
 * spelling is that the reader who already knows it can type it, not that a new reader
 * has to choose between two names for one command.
 */
export const ALIASES = new Map(
  SPEC.flatMap((row) => (row.aliases ?? []).map((alias) => [alias, row.path])),
);
