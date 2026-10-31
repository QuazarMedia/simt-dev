// The command spec: one row per path this binary dispatches (review 0003 Q60).
//
// The list of commands existed in four places that disagreed - the dispatch map, a
// hand-written `--help` template, the completions table and the README - so a command
// could work and be undiscoverable, or be documented and absent. A row here is the one
// place a command is declared; `src/commands/index.mjs` derives its dispatchable paths
// and group defaults from it, and `test/spec.test.mjs` fails when the registry and the
// spec stop agreeing in either direction.
//
// The fields that only some consumers need (`tier`, `writes`, `args`, `flags`) arrive
// with the slices that read them: help (Q61), validation (Q62), MCP (Q66). A field no
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
 * @property {string} [mcp] the MCP tool name that answers this row, when one does
 */

/** @type {SpecRow[]} */
export const SPEC = [
  { path: 'agent-hook', summary: 'the harness entry point: decide one tool call, or deliver the prompt packet', flags: ["diff","harness"], },
  { path: 'agent-hooks install', summary: "write this repository's policies into each harness hooks file", flags: ["diff","harness"], },
  { path: 'agent-hooks status', summary: 'what each harness will run, and what is not trusted yet', defaultFor: 'agent-hooks', flags: ["diff","harness"], },
  { path: 'agents install', summary: 'write the Simt-Agent into each harness agents file', flags: ["diff","harness"], },
  // A group like `agent-hooks`: `install` writes the agent file into each harness's own
  // directory and `status` reports what a harness carries. The default is the read.
  { path: 'agents status', summary: 'what each harness carries, and what is not installed yet', defaultFor: 'agents', flags: ["diff","harness"], },
  { path: 'bench ablate', summary: 'measure one arm of the brief against its ablation', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench critic', summary: 'score the review critic against the labelled bench set', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench export', summary: 'write the sealed bench corpus as one signed document', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench import', summary: 'verify a sealed corpus and load it into the vault', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench mine', summary: 'mine tasks out of a repository history', defaultFor: 'bench', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench probes', summary: 'run the deterministic probes against a workspace', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench report', summary: 'summarise the runs recorded in the vault', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench run', summary: 'run agents against the mined tasks', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'bench variants', summary: 'run one task across its variant prompts', flags: ["all","arm","compare","cross-group","harness","labels","model","regrade","replace","reps","task"], },
  { path: 'brief', mcp: { name: 'brief', flags: ['budget', 'paths', 'task'] }, summary: 'the packet for a task: rules, skills and the files it names, within a budget', flags: ["budget","explain","paths","task"], },
  { path: 'check', mcp: { name: 'check', flags: [] }, summary: 'report stale or missing generated regions and every check finding', flags: ["check","diff","dry-run"], },
  { path: 'ci', summary: "refresh simt-dev's own .github workflow and Dependabot files", flags: ["check","diff"], },
  { path: 'compare', mcp: { name: 'compare', flags: [] }, summary: 'the adoption and drift matrix across every sibling repository', flags: [], },
  { path: 'completions', summary: 'print a bash, zsh or fish completion script generated from this spec', flags: [], },
  { path: 'decide', summary: 'scaffold a numbered decision record with its frontmatter', flags: ["check","diff","dry-run","paths","supersedes","task"], },
  { path: 'distill', summary: 'turn a repository into a skill or rule proposal', flags: [], },
  { path: 'doctor', mcp: { name: 'doctor', flags: [] }, summary: 'report what is wrong with this installation', flags: ["diff","fix"], },
  { path: 'evidence', summary: 'the runs recorded against the tree on disk', flags: [], },
  { path: 'evidence check', summary: 'a commit message claiming a run this tree does not have', flags: [], },
  { path: 'explain', summary: 'what one check finding code means, and how to fix it', flags: [], },
  { path: 'gate', summary: 'the tests a change reaches, and only those', flags: ["changed"], },
  { path: 'graph lint', summary: 'check the skill registry against the skills on disk', defaultFor: 'graph', flags: ["spec"], },
  { path: 'harness detect', summary: 'which harness is installed, and what it carries', defaultFor: 'harness', flags: ["at","reader","table","user"], },
  { path: 'harness loaders', summary: 'the instruction files each harness loads, and what they cost', flags: ["at","reader","table","user"], },
  { path: 'hooks install', summary: 'install the shared dispatcher and report what it would run', flags: ["diff","dry-run","yes"], },
  { path: 'hooks run', summary: "run one git event's gates now, as git would", flags: ["diff","dry-run","yes"], },
  { path: 'hooks status', summary: 'what each git event routes to, and whether it is wired', defaultFor: 'hooks', flags: ["diff","dry-run","yes"], },
  { path: 'ignore', summary: 'render the one ignore list into every harness ignore file', flags: ["diff"], },
  { path: 'impact', summary: 'who a change reaches: importers, their tests and the contract', flags: [], },
  { path: 'index', summary: 'rebuild the local file index from git blob hashes', flags: ["allow-remote","embed"], },
  { path: 'init', summary: 'adopt this repository: manifest, region, hooks and toolchain pins', flags: ["accept-conflicts","backup","diff","surfaces"], },
  { path: 'lease', summary: 'claim files for one session, or list the claims', flags: ["harness","session","ttl"], },
  { path: 'lessons capture', summary: 'scan the ledger and history for new lesson candidates', flags: ["diff","expires","paths","task"], },
  { path: 'lessons list', summary: 'deterministic lesson candidates and the promoted lessons', defaultFor: 'lessons', flags: ["diff","expires","paths","task"], },
  { path: 'lessons review', summary: 'promote one lesson candidate into docs/lessons', flags: ["diff","expires","paths","task"], },
  { path: 'local doctor', summary: 'the local model endpoints, and whether they answer', defaultFor: 'local', flags: ["allow-remote"], },
  { path: 'map', summary: 'the files a task is most likely to touch, within a byte budget', flags: ["allow-remote","budget","embed","level","recall","task"], values: { level: ['outline', 'names', 'signatures'] }, },
  { path: 'mcp', summary: 'serve the read-only MCP surface over stdio', flags: ["list"], },
  // Plan 0003 R45. The default is the read: `pack` alone lints the working directory,
  // the way `skills` alone indexes and `graph` alone lints.
  { path: 'pack lint', summary: 'lint a rule pack in the working directory', defaultFor: 'pack', flags: ["diff","require-measured","source"], },
  { path: 'pack new', summary: 'scaffold a rule pack', flags: ["diff","require-measured","source"], },
  { path: 'pack publish', summary: 'publish a rule pack', flags: ["diff","require-measured","source"], },
  { path: 'plan done', mcp: { name: 'plan_done', flags: ['state', 'test'] }, summary: 'mark one tracker row complete, with its SHA and its evidence', flags: ["diff","state","test"], },
  { path: 'plan next', mcp: { name: 'plan_next', flags: [] }, summary: "one ready slice's section, or the one named", flags: ["diff","state","test"], },
  { path: 'plan status', summary: 'count the tracker rows', defaultFor: 'plan', flags: ["diff","state","test"], },
  { path: 'plugin', summary: 'generate a harness package from the same tables the hooks use', flags: ["diff","out"], },
  { path: 'pr-body', mcp: { name: 'pr_body', flags: ['base'] }, summary: 'the pull request body: evidence, decisions, gate state and residual risk', flags: ["base"], },
  { path: 'review', summary: 'review the staged diff against the estate rules', flags: [], },
  { path: 'rules decisions', summary: 'every known decision, and which layer each came from', flags: ["all", "yes"], },
  { path: 'rules list', mcp: { name: 'rules_list', flags: [] }, summary: 'the rule catalogue, marked with what applies to this repository', defaultFor: 'rules', flags: ["all"], },
  { path: 'rules show', summary: 'one rule body', flags: ["all"], },
  { path: 'rules why', mcp: { name: 'rules_why', flags: [] }, summary: 'the decision that settled a rule, and whether it is still in force', flags: ["all"], },
  { path: 'shared install', summary: 'install the shared rules into a reader home directory', flags: ["diff"], },
  // ADR-084. `shared` is the one group whose default writes nothing, and it is `plan`
  // for the same reason `skills`'s is `index`: the read answers "what would this do, and
  // where", and `install` - the subcommand that touches a reader's home directory - is
  // the one that needs `--yes` before it does anything.
  { path: 'shared plan', summary: 'what the shared install would write, and where', defaultFor: 'shared', flags: ["diff"], },
  { path: 'skills brief', mcp: { name: 'skills_brief', flags: ['all', 'task'] }, summary: 'the packet for a task, read from the skill registry', flags: ["all", "plan", "task"], },
  { path: 'skills compile', summary: 'compile a skill to the Agent Skills standard', flags: [], },
  { path: 'skills eval', summary: 'score the skill registry against transcripts', flags: ["all","plan"], },
  { path: 'skills find', mcp: { name: 'skills_find', flags: [] }, summary: 'skills that match a query', flags: ["all","plan"], },
  { path: 'skills index', mcp: { name: 'skills_index', flags: [] }, summary: 'rebuild the skill index', defaultFor: 'skills', flags: ["all","plan"], },
  { path: 'skills install', summary: 'install skills into the workspace', flags: ["diff","from","variant"], },
  { path: 'skills show', mcp: { name: 'skills_show', flags: [] }, summary: 'one skill packet', flags: ["all","plan"], },
  { path: 'skills why', mcp: { name: 'skills_why', flags: [] }, summary: 'which skill covers a task', flags: ["all","plan"], },
  { path: 'slice abandon', summary: 'remove a slice worktree, delete its branch, and return the row', flags: ["session","test","type"], },
  { path: 'slice finish', summary: 'run the gates, commit the slice and record its evidence', flags: ["session","test","type"], },
  // Plan 0003 R53. Both halves write, so a bare `slice` has no read to default to.
  // `start` is the default because with the id it is missing it fails with a usage error
  // before anything is created - the one default here that cannot mutate.
  { path: 'slice start', summary: 'give a slice its own worktree, branch and brief', defaultFor: 'slice', flags: ["session","test","type"], },
  { path: 'status', summary: 'gate state from the last check', flags: ["line"], },
  { path: 'sync', summary: 're-render the generated regions from the rule content', flags: ["check","diff","dry-run"], },
  { path: 'tests', summary: 'the tests that exercise a file', flags: ["cochange"], },
  { path: 'tokens', summary: 'count tokens per instruction file and per skill', flags: ["repos","session"], },
  { path: 'undo', summary: 'restore the last journaled set of writes, if untouched', flags: ["diff"], },
  { path: 'upgrade', summary: 'replace this installation with the pinned release', flags: ["all","diff","workspace"], },
  { path: 'why', summary: 'what governs a file: decisions, rules, skills, gates and lessons', flags: [], },
];


/**
 * Which tier a command belongs to, decided by its group: the commands a reader reaches
 * for while working are core and appear in `--help`; the rest are advanced and appear
 * under `help --all`. A tier is a presentation fact, not a permission, so a command
 * cannot be missing from both pages - `test/help.test.mjs` checks that every path is on
 * one of them (review 0003 Q61).
 */
const CORE_GROUPS = new Set(['brief', 'check', 'gate', 'graph', 'hooks', 'impact', 'init', 'map', 'plan', 'rules', 'skills', 'slice', 'status', 'sync', 'tests', 'why']);

/** The tier a path is listed under: `core` or `advanced`. */
export function tierOf(path) {
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
