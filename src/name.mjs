// Every name this tool answers to, in one file.
//
// They are collected here because the alternative was measured rather than assumed:
// 276 occurrences of the command name across 33 files under src/, threaded through
// remedy strings, help text, shim source and workflow templates. A rename touching
// that many literals is a rename nobody finishes, and a half-finished one is worse
// than an unrenamed tool — it ships remedies telling a reader to run a command that
// does not exist, which is the exact failure this whole tool exists to prevent.
//
// `test/naming.test.mjs` enforces the half that a comment cannot: a command string may
// not SPELL the command, only interpolate CLI. Without that guard this file is a
// suggestion, and a suggestion about a name is not a constraint.
//
// The names split into two groups, and which group a name is in decides whether it can
// move at all. Getting that backwards is the expensive mistake: the publish name can
// change at any time, the on-disk names cannot.

/**
 * The project: the repository, and every name it has already written into somebody
 * else's repository. LOCKED — not because renaming is forbidden, but because these
 * strings are on disk in repositories this tool does not own, and changing one is a
 * breaking change to files rather than to a package.
 */
export const PROJECT = 'simt-dev';

/**
 * The manifest an adopting repository owns. LOCKED: fourteen repositories carry a
 * `simt-dev.json`, and `read` would fail rather than migrate in every one of them.
 */
export const MANIFEST_FILE = 'simt.json';

/** What the manifest file was called, and still is in every adopted repo. */
export const MANIFEST_LEGACY = 'simt-dev.json';

/**
 * The namespace the generated region writes into a repository's files: the begin and end
 * markers, and the provenance header inside them. It follows the command, like the
 * manifest: the region is the command's footprint in a file the repo owns.
 */
export const MARKER_PREFIX = 'simt';

/** What the region was namespaced under, and still is in every adopted repo. */
export const MARKER_PREFIX_LEGACY = 'simt-dev';

/** The config directory on the adopting engineer's machine. LOCKED, same argument. */
export const CONFIG_DIR = PROJECT;

/**
 * The per-repository state directory: the index, ledger, benchmark runs and local-model
 * proposals a repository writes for itself. Renamed from `.simt-dev` to `.simt`; the
 * rename is unreleased, so no repository carries the old spelling as a name this tool
 * cannot rewrite. Deliberately not derived from CONFIG_DIR: that is the user-level
 * config directory, and a derivation would let two different on-disk names agree by
 * accident rather than by decision.
 */
export const STATE_DIR = '.simt';

/**
 * The gate this tool writes into a repository. LOCKED: it is a path in `.github`, and
 * a repo that renames the file silently stops running the gate it was adopted with.
 */
export const WORKFLOW_FILE_NAME = `${PROJECT}-check.yml`;

/**
 * The environment variable that points a shim at a binary it cannot find. LOCKED, and
 * deliberately still spelled with the project name: it is read by shims already sitting
 * in repositories' `.git` directories, so renaming it would strand every one of them
 * with no way to find the tool again.
 */
export const BIN_ENV = 'SIMT_DEV_BIN';

/**
 * The command a reader types.
 *
 * This is the name that moved, and it is deliberately not the project name. The
 * project keeps `simt-dev` in the places on disk the tool cannot rewrite in place -
 * the gate file, the hooks directory, the shim's environment variable, the entry
 * point - and renaming any of those is a breaking change to files rather than to a
 * package. The command appears only in text the tool itself writes - remedies, region
 * headers, the manifest comment - and that text migrates on the next write: read-both
 * covers the gap in between. That is what makes it the cheap name to change, and the
 * one worth spending.
 *
 * `test/naming.test.mjs` is what stops this from drifting back into a hundred
 * literals. Without it this constant is a comment with an export.
 */
export const CLI = 'simt';

/**
 * The package a repository installs to obtain the command.
 *
 * Unscoped, and equal to the project name, because that name was reserved on the npm
 * registry before this package existed and holds only an empty `1.0.0`. Reserving it
 * and then publishing under a different spelling would leave the one name anyone can
 * find pointing at nothing.
 *
 * Not derived from CLI. The command moved to `simt`; the package did not, and a
 * derivation that silently picked between them would turn a one-line rename into a
 * one-line diff whose meaning depends on a comparison nobody reading it would think
 * to check.
 */
export const PACKAGE_NAME = PROJECT;

/** The entry point, relative to the package root. LOCKED: `bin` in package.json. */
export const BIN_REL = 'bin/simt.mjs';