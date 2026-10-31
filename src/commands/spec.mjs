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
 */

/** @type {SpecRow[]} */
export const SPEC = [
  { path: 'agent-hook', summary: 'the harness entry point: decide one tool call, or deliver the prompt packet' },
  { path: 'agent-hooks install', summary: "write this repository's policies into each harness hooks file" },
  { path: 'agent-hooks status', summary: 'what each harness will run, and what is not trusted yet', defaultFor: 'agent-hooks' },
  { path: 'agents install', summary: 'write the Simt-Agent into each harness agents file' },
  // A group like `agent-hooks`: `install` writes the agent file into each harness's own
  // directory and `status` reports what a harness carries. The default is the read.
  { path: 'agents status', summary: 'what each harness carries, and what is not installed yet', defaultFor: 'agents' },
  { path: 'bench ablate', summary: 'measure one arm of the brief against its ablation' },
  { path: 'bench critic', summary: 'score the review critic against the labelled bench set' },
  { path: 'bench export', summary: 'write the sealed bench corpus as one signed document' },
  { path: 'bench import', summary: 'verify a sealed corpus and load it into the vault' },
  { path: 'bench mine', summary: 'mine tasks out of a repository history', defaultFor: 'bench' },
  { path: 'bench probes', summary: 'run the deterministic probes against a workspace' },
  { path: 'bench report', summary: 'summarise the runs recorded in the vault' },
  { path: 'bench run', summary: 'run agents against the mined tasks' },
  { path: 'bench variants', summary: 'run one task across its variant prompts' },
  { path: 'brief', summary: 'the packet for a task: rules, skills and the files it names, within a budget' },
  { path: 'check', summary: 'report stale or missing generated regions and every check finding' },
  { path: 'ci', summary: "refresh simt-dev's own .github workflow and Dependabot files" },
  { path: 'compare', summary: 'the adoption and drift matrix across every sibling repository' },
  { path: 'completions', summary: 'print a bash, zsh or fish completion script generated from this spec' },
  { path: 'decide', summary: 'scaffold a numbered decision record with its frontmatter' },
  { path: 'distill', summary: 'turn a repository into a skill or rule proposal' },
  { path: 'doctor', summary: 'report what is wrong with this installation' },
  { path: 'evidence', summary: 'the runs recorded against the tree on disk' },
  { path: 'evidence check', summary: 'a commit message claiming a run this tree does not have' },
  { path: 'explain', summary: 'what one check finding code means, and how to fix it' },
  { path: 'gate', summary: 'the tests a change reaches, and only those' },
  { path: 'graph lint', summary: 'check the skill registry against the skills on disk', defaultFor: 'graph' },
  { path: 'harness detect', summary: 'which harness is installed, and what it carries', defaultFor: 'harness' },
  { path: 'harness loaders', summary: 'the instruction files each harness loads, and what they cost' },
  { path: 'hooks install', summary: 'install the shared dispatcher and report what it would run' },
  { path: 'hooks run', summary: "run one git event's gates now, as git would" },
  { path: 'hooks status', summary: 'what each git event routes to, and whether it is wired', defaultFor: 'hooks' },
  { path: 'ignore', summary: 'render the one ignore list into every harness ignore file' },
  { path: 'impact', summary: 'who a change reaches: importers, their tests and the contract' },
  { path: 'index', summary: 'rebuild the local file index from git blob hashes' },
  { path: 'init', summary: 'adopt this repository: manifest, region, hooks and toolchain pins' },
  { path: 'lease', summary: 'claim files for one session, or list the claims' },
  { path: 'lessons capture', summary: 'scan the ledger and history for new lesson candidates' },
  { path: 'lessons list', summary: 'deterministic lesson candidates and the promoted lessons', defaultFor: 'lessons' },
  { path: 'lessons review', summary: 'promote one lesson candidate into docs/lessons' },
  { path: 'local doctor', summary: 'the local model endpoints, and whether they answer', defaultFor: 'local' },
  { path: 'map', summary: 'the files a task is most likely to touch, within a byte budget' },
  { path: 'mcp', summary: 'serve the read-only MCP surface over stdio' },
  // Plan 0003 R45. The default is the read: `pack` alone lints the working directory,
  // the way `skills` alone indexes and `graph` alone lints.
  { path: 'pack lint', summary: 'lint a rule pack in the working directory', defaultFor: 'pack' },
  { path: 'pack new', summary: 'scaffold a rule pack' },
  { path: 'pack publish', summary: 'publish a rule pack' },
  { path: 'plan done', summary: 'mark one tracker row complete, with its SHA and its evidence' },
  { path: 'plan next', summary: "one ready slice's section, or the one named" },
  { path: 'plan status', summary: 'count the tracker rows', defaultFor: 'plan' },
  { path: 'plugin', summary: 'generate a harness package from the same tables the hooks use' },
  { path: 'pr-body', summary: 'the pull request body: evidence, decisions, gate state and residual risk' },
  { path: 'review', summary: 'review the staged diff against the estate rules' },
  { path: 'rules decisions', summary: 'every known decision, and which layer each came from' },
  { path: 'rules list', summary: 'the rule catalogue, marked with what applies to this repository', defaultFor: 'rules' },
  { path: 'rules show', summary: 'one rule body' },
  { path: 'rules why', summary: 'the decision that settled a rule, and whether it is still in force' },
  { path: 'shared install', summary: 'install the shared rules into a reader home directory' },
  // ADR-084. `shared` is the one group whose default writes nothing, and it is `plan`
  // for the same reason `skills`'s is `index`: the read answers "what would this do, and
  // where", and `install` - the subcommand that touches a reader's home directory - is
  // the one that needs `--yes` before it does anything.
  { path: 'shared plan', summary: 'what the shared install would write, and where', defaultFor: 'shared' },
  { path: 'skills brief', summary: 'the packet for a task, read from the skill registry' },
  { path: 'skills compile', summary: 'compile a skill to the Agent Skills standard' },
  { path: 'skills eval', summary: 'score the skill registry against transcripts' },
  { path: 'skills find', summary: 'skills that match a query' },
  { path: 'skills index', summary: 'rebuild the skill index', defaultFor: 'skills' },
  { path: 'skills install', summary: 'install skills into the workspace' },
  { path: 'skills show', summary: 'one skill packet' },
  { path: 'skills why', summary: 'which skill covers a task' },
  { path: 'slice abandon', summary: 'remove a slice worktree, delete its branch, and return the row' },
  { path: 'slice finish', summary: 'run the gates, commit the slice and record its evidence' },
  // Plan 0003 R53. Both halves write, so a bare `slice` has no read to default to.
  // `start` is the default because with the id it is missing it fails with a usage error
  // before anything is created - the one default here that cannot mutate.
  { path: 'slice start', summary: 'give a slice its own worktree, branch and brief', defaultFor: 'slice' },
  { path: 'status', summary: 'gate state from the last check' },
  { path: 'sync', summary: 're-render the generated regions from the rule content' },
  { path: 'tests', summary: 'the tests that exercise a file' },
  { path: 'tokens', summary: 'count tokens per instruction file and per skill' },
  { path: 'undo', summary: 'restore the last journaled set of writes, if untouched' },
  { path: 'upgrade', summary: 'replace this installation with the pinned release' },
  { path: 'why', summary: 'what governs a file: decisions, rules, skills, gates and lessons' },
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

/** The dispatchable paths, sorted - the answer to "what can this binary do". */
export const SPEC_PATHS = SPEC.map((row) => row.path).sort();

/** group -> the subcommand its bare form resolves to. */
export const GROUP_DEFAULTS = new Map(SPEC.filter((row) => row.defaultFor !== undefined).map((row) => [row.defaultFor, row.path.split(' ')[1]]));
