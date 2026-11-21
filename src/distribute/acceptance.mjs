// The release acceptance matrix as data (ADR-214).
//
// A green source suite cannot establish installation, upgrade, configuration or
// enforcement in a receiving repository. This module is the single place that
// states WHAT a release must prove and FROM WHERE: installed
// artefacts only, against independently staged fixtures — never this checkout.
// `docs/reference/acceptance.md` is its publication, and `test/acceptance.test.mjs`
// fails when the two disagree, in the same way `support.md` and `support.mjs`
// cannot drift (ADR-206). A scenario or a limit gains a row, not a paragraph.

import { CLI } from '../name.mjs';
import { CHANNELS } from './support.mjs';
import { TARGETS } from './release.mjs';
import { MIN_NODE } from '../node-version.mjs';

/** Where a reader finds the matrix below, published with the package. */
export const ACCEPTANCE_DOC = 'docs/reference/acceptance.md';

/**
 * The fixture kinds the matrix exercises. Each is a repository the tool must handle,
 * staged as an independently installed copy — not this checkout. `channels` is null
 * when every channel applies, or the subset that does: a question only one channel
 * can answer has no row for the others, and a row for a channel that cannot run there
 * is a promise the fixture cannot keep.
 */
export const SCENARIOS = [
  { id: 'docs-only', name: 'a docs-only repository', fixture: 'a README and nothing else — no code, no package.json' },
  { id: 'custom-ecosystem', name: 'a custom ecosystem', fixture: 'a manifest the tool detects through a profile, not a built-in stack' },
  { id: 'non-node', name: 'a non-Node codebase', fixture: 'one build.gradle and nothing else; the binary channel runs it with no Node on PATH' },
  { id: 'node-installer', name: 'Node with each supported installer', fixture: 'the same repository installed by npm, pip, brew and the one-line binary download' },
  { id: 'nested', name: 'mixed and nested projects', fixture: 'a package inside a repository, and a subdirectory that is its own git root' },
  { id: 'worktree-submodule', name: 'git worktrees and submodules', fixture: 'a worktree and a submodule, each carrying its own head' },
  { id: 'mono-multi-repo', name: 'a monorepo and a multi-repo', fixture: 'one repository with many packages, and a workspace of several repositories' },
  { id: 'shallow-clone', name: 'a shallow clone', fixture: 'git clone --depth 1; the history the index cannot walk is absent by construction' },
  { id: 'dirty-checkout', name: 'a dirty checkout', fixture: 'uncommitted changes and untracked files beside the adopted region' },
  { id: 'prior-formats', name: 'prior published formats', fixture: 'simt-dev.json, simt-dev.lock.json and the simt-dev: region prefix, each read by its owner' },
];

/**
 * The proofs every applicable channel must establish, in the order stated. `command`
 * is the reproducible command a release engineer runs against the installed artefact:
 * a command, not a location, so a reader outside this estate can act on it. The
 * preview form runs first and must write nothing; the `--yes` form is what applies.
 */
export const CAPABILITIES = [
  { id: 'preview', name: 'a preview writes nothing', command: `${CLI} init --root .` },
  { id: 'adoption', name: 'adoption lands the region and the manifest', command: `${CLI} init --root . --yes` },
  { id: 'projection', name: 'projection renders the region, and check reports it current', command: `${CLI} sync --yes && ${CLI} check` },
  { id: 'frozen-check', name: 'the frozen check passes against the pinned digests', command: `${CLI} check --frozen` },
  { id: 'gates-evidence', name: 'the declared gates run, and evidence records them', command: `${CLI} hooks run pre-commit && ${CLI} evidence` },
  { id: 'undo', name: 'undo reverts the tool’s writes, and nothing else', command: `${CLI} undo --yes` },
  { id: 'upgrade', name: 'an upgrade preview writes nothing; --yes moves the pin', command: `${CLI} upgrade && ${CLI} upgrade --yes` },
  { id: 'clean-packaging', name: 'the pack carries the shipped file set, and no checkout path', command: 'npm pack --dry-run' },
];

/**
 * The surfaces beyond the plain CLI, each exercised against the installed copy. A
 * surface that installs and cannot be invoked is a door the tarball left unbuilt; the
 * command is how a release proves the door opens from the artefact, not this checkout.
 */
export const SURFACES = [
  { id: 'cli', name: 'the plain CLI', command: `${CLI} --version` },
  { id: 'library', name: 'the library export', command: `node -e "import('simt-dev')"` },
  { id: 'mcp', name: 'the MCP surface over stdio', command: `${CLI} mcp --list` },
  { id: 'harness', name: 'the agent hooks', command: `${CLI} agent-hook pre-tool-use --harness cursor` },
];

/**
 * Measurable limits, declared BEFORE performance data is collected (PR37). A bound
 * with no metric, subject or unit is a wish, not a limit: each names what is measured,
 * in which unit, against which direction. The numbers are bounds a release must meet;
 * collecting the data that proves it is a separate, named qualification job, and a bar
 * declared after the numbers is not a bar (ADR-183).
 */
export const LIMITS = [
  { metric: 'startup', subject: 'a cold `simt --version`, from process start to exit', unit: 'ms', bound: 500, direction: 'lte' },
  { metric: 'index', subject: 'an incremental index over a bounded work-set', unit: 'ms', bound: 300, direction: 'lte' },
  { metric: 'hook', subject: 'one pre-tool-use hook invocation, policy decision included', unit: 'ms', bound: 200, direction: 'lte' },
];

/**
 * Unsupported combinations, each with the reason it is out of scope and the supported
 * exit or remedy. `exit` is the name in the EXIT table the tool reports for this class
 * (EXIT.UNSUPPORTED: the request cannot be satisfied on this platform); `remedy` is a
 * command a reader runs, never a place they read (ADR-206).
 */
export const UNSUPPORTED = [
  {
    combo: 'the release binary on linux-arm64',
    reason: `no native arm64 runner in the publish matrix; a binary for it would need an arm64 build job and a fourth formula pair carrying a real checksum`,
    exit: 'UNSUPPORTED',
    remedy: `npm i -D simt-dev, or pip install simt-dev with Node >= ${MIN_NODE}`,
  },
  {
    combo: 'a native Windows build',
    reason: 'a different executable format, and none is planned',
    exit: 'UNSUPPORTED',
    remedy: 'run the tool under WSL2 with npm, pip or the binary',
  },
];

/**
 * The channel rows the matrix is qualified against, reused from the support inventory
 * (ADR-206) rather than restated. The acceptance matrix and the support table name the
 * same four channels; a second list of them here would be a copy that drifts.
 */
export function acceptanceChannels() {
  return CHANNELS;
}

/** The release targets the binary channel is built for, reused from `release.mjs`. */
export function acceptanceTargets() {
  return TARGETS;
}
