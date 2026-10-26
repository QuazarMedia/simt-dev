// The binary channel: what a release publishes, where a repository keeps its copy,
// and the one command that gets it there.
//
// This module is the single place that knows those facts, because three generated
// surfaces must agree on them and they are rendered from different call sites: the
// locator block (src/locate.mjs) checks a path, the hook shim's remedy prints a
// download command, and the CI workflow renders the same download as a step. A
// second copy of the asset name or the URL is a copy that drifts, and a drifted
// remedy tells a reader to fetch bytes that do not exist.
//
// The channel is a fourth beside npm, PyPI and Homebrew (ADR-058), and unlike the
// other three it is the one that needs no toolchain at all: the npm channel needs
// npm, the wheel needs a Python, and the formula - until this release - needed
// node. The binary is a file. That is the whole design (ADR-098), and it is why
// the locator checks a path in the repository before it checks PATH: the bytes a
// repository pinned are the bytes its gate runs, on a machine with nothing else.

import { CLI, PACKAGE_NAME } from '../name.mjs';

// The GitHub repository the release is published from. A fact about where the
// bytes come from, like the npm registry host: a reader outside this estate
// reads it as a URL, not as an organisation. Not exported: the only surface a
// caller needs is the URL, and a second copy of the slug is a copy that drifts.
const REPO_SLUG = 'QuazarMedia/simt-dev';

/** The platforms the release builds. The set is small on purpose: it is the set
 *  the locator's remedy and the CI step can name, and a platform in this list that
 *  the release does not build is a remedy that downloads a 404. */
export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64'];

// Where a repository keeps the binary it pinned, relative to its top level.
// Beneath `.simt`, like every other per-repo state this tool writes, so a reader
// who has seen one knows where to look for all of them. The name is the command,
// not the package: the reader types one program and this is it, the same way
// `bin/simt.mjs` is it on npm.
const LOCAL_BIN_NAME = CLI;

/** The directory a repository keeps its pinned binary in, relative to its top
 *  level. Exported because a caller that installs the binary must create it and
 *  has no other source for the fact. */
export const LOCAL_BIN_DIR = '.simt/bin';

/** The path the locator checks, relative to the repository's top level. */
export const LOCAL_BIN = `${LOCAL_BIN_DIR}/${LOCAL_BIN_NAME}`;

/**
 * The release asset name for a version and a target.
 *
 * The package name, not the command: it sits beside its siblings in the release
 * and next to the npm tarball `simt-dev-0.5.0.tgz`, where one name for the project
 * is what a reader matching names expects.
 *
 * @param {string} version x.y.z
 * @param {string} osArch one of TARGETS
 * @returns {string} e.g. `simt-dev-0.5.0-darwin-arm64`
 */
export function assetName(version, osArch) {
  if (!TARGETS.includes(osArch)) throw new Error(`unknown target ${osArch}; known: ${TARGETS.join(', ')}`);
  return `${PACKAGE_NAME}-${version}-${osArch}`;
}

/**
 * The asset name with the platform left for the shell to fill in at runtime.
 *
 * The CI step and the remedy both run on a machine whose platform is not known
 * where the text was written, so the name is completed from `uname` or the
 * runner there. One template shared with {@link assetName} keeps the two from
 * drifting: a name rendered here that the release does not publish is a 404.
 *
 * @param {string} version x.y.z
 * @returns {string} e.g. `simt-dev-0.5.0-$os-$arch`, for a shell with $os and $arch set
 */
export function assetNameExpr(version) {
  return `${PACKAGE_NAME}-${version}-$os-$arch`;
}

/**
 * The URL the release serves a version's assets from.
 *
 * @param {string} version x.y.z
 * @returns {string}
 */
export function releaseBase(version) {
  return `https://github.com/${REPO_SLUG}/releases/download/v${version}`;
}

/**
 * The URL the release serves one asset from.
 *
 * @param {string} version x.y.z
 * @param {string} osArch one of TARGETS
 * @returns {string}
 */
export function releaseUrl(version, osArch) {
  return `${releaseBase(version)}/${assetName(version, osArch)}`;
}

/**
 * The download a reader without npm runs from their repository's top level: fetch
 * the asset this machine needs and put it where the locator looks.
 *
 * One line on purpose - it is rendered into a remedy that a reader copies from an
 * error message, and a multi-line script in an error message is not copied. The
 * platform is derived rather than baked in, because the remedy lives in a file
 * that is committed and shared: a URL rendered for the machine that wrote the
 * shim would be a 404 for the colleague who clones it.
 *
 * The transport is TLS from the release, and the version the bytes report is
 * checked against the repository's pin by the dispatcher itself (ADR-098), so
 * the remedy does not also carry a checksum: it is the shortest command that
 * reaches a working state, and the gate re-verifies what it runs.
 *
 * @param {string} version x.y.z
 * @returns {string} POSIX sh, run from the repository's top level
 */
export function localInstall(version) {
  return [
    `mkdir -p ${LOCAL_BIN_DIR}`,
    ...platformLines(),
    `curl -fsSL "${releaseBase(version)}/${assetNameExpr(version)}" -o ${LOCAL_BIN}`,
    `chmod +x ${LOCAL_BIN}`,
  ].join(' && ');
}

/**
 * The two shell lines that derive this machine's release target at run time.
 *
 * `uname -m` answers `x86_64` on both platforms' Intel builds and `arm64` on
 * Apple Silicon, so one substitution covers the naming gap. Both the remedy and
 * the generated CI step name their asset from these lines: the text is committed
 * and shared, so a URL baked for the machine that wrote it is a 404 for the
 * colleague who clones it, and a workflow expression interpolated into a command
 * substitution is worse - the CI step once rendered `os=$('${{ runner.os }}' …)`,
 * which the runner substitutes to `os=$('Linux' …)` and `set -eu` refuses, so the
 * install failed on every run in the one repository kind this channel exists for.
 * The step is executed, not pattern-matched, in test/binary.test.mjs.
 *
 * @returns {string[]} POSIX sh lines assigning `$os` and `$arch`
 */
export function platformLines() {
  return [`os=$(uname -s | tr A-Z a-z)`, `arch=$(uname -m | sed "s/x86_64/x64/")`];
}
