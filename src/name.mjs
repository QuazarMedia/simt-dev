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
export const MANIFEST_FILE = `${PROJECT}.json`;

/** The config directory on the adopting engineer's machine. LOCKED, same argument. */
export const CONFIG_DIR = PROJECT;

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
 * The command a reader types. This is the name that moves, and it is a separate constant
 * rather than something derived: the project keeps its name across a publish rename, the
 * command does not, and a derivation that silently picks between them would turn a
 * two-line rename into a two-line diff whose meaning depends on a comparison nobody
 * reading it would think to check.
 */
export const CLI = PROJECT;

/**
 * The package a repository installs to obtain the command. Moves with the command.
 *
 * Not derived from CLI or SCOPE. These are three names that happen to agree today, and
 * they will not always: a scope is a namespace on a registry, a package is a name in one
 * namespace, and a command is whatever the package's `bin` map says it is.
 */
export const SCOPE = 'quazarmedia';
export const PACKAGE_NAME = `@${SCOPE}/${PROJECT}`;

/** The entry point, relative to the package root. LOCKED: `bin` in package.json. */
export const BIN_REL = 'bin/simt-dev.mjs';