# Platform and channel support

What runs where, what it needs, and what to do when your combination is not listed. The
table is data in `src/distribute/support.mjs`; `test/packaging.test.mjs` fails when this page
and that module disagree, so the two cannot drift the way four hand-written paragraphs did.

| Channel | Install | Needs | Platforms | If yours is missing |
| --- | --- | --- | --- | --- |
| npm | `npm i -D simt-dev` | Node >= 22.20.0 | macOS, Linux | install Node from nodejs.org, or use the release binary |
| PyPI | `pip install simt-dev` | Python >= 3.9; Node >= 22.20.0 on PATH, or the `[node]` extra | macOS, Linux | `pip install "simt-dev[node]"` brings a node with the wheel |
| Homebrew | `brew install QuazarMedia/homebrew-tap/simt-dev` | no runtime (the formula downloads the binary) | macOS, Linux | use npm or PyPI where brew is unavailable |
| release binary | the one-line download into `.simt/bin` | no runtime | darwin-arm64, darwin-x64, linux-x64 | use npm or PyPI with Node >= 22.20.0 on another platform |

## Runtime floors

- **Node 22.20.0** is the floor for npm and PyPI. It is not a preference: the index needs
  `node:sqlite` with FTS5, and an older runtime is refused by name instead of being given a
  second index format to read. `package.json` `engines.node`, `src/node-version.mjs`, the SEA
  base that `scripts/build-sea.mjs` downloads, and the PyPI launcher all carry this number,
  and a test compares them.
- **Python 3.9** is the floor for the wheel's launcher, which is standard-library only. The
  launcher replaces itself with `node`, so Python is not a runtime for the tool itself.
- **Git 2.5** is required when you use worktrees — `simt slice` and the head-worktree reader
  call `git worktree`. Commands that only read repository files do not require Git.

## The release binary

One executable per published target, each beside a `.sha256` the download checks:

- `darwin-arm64`, `darwin-x64`, `linux-x64`.

The binary carries its own Node runtime, so it is the channel for a machine with no
toolchain. The one-line install checks `uname -s`/`uname -m` against that list **before**
fetching; on any other host it prints the fallback (npm or pip with a Node) and exits
non-zero, rather than downloading a 404.

**Linux arm64 is not published today.** The fallback is the npm or PyPI channel, which runs
on arm64 with a Node installed. Adding `linux-arm64` is a release decision, not a build flag:
it needs a native arm64 runner in the publish matrix, a fourth formula pair with a real
checksum from a release, and the locator's remedy to name it. It will be added at a release
boundary where those three can land together, and this page changes with it.

**Windows is not published.** Use **WSL2** and install there with npm, PyPI or the binary.
A native Windows build would need a different executable format and is not planned.

## Rolling back

Pin the version your repository adopted (`npm i -D simt-dev@x.y.z`, `pip install
simt-dev==x.y.z`, or the release tag in the download). Installing the earlier version back
is the rollback; then run `simt sync --yes` so the projected rules are re-rendered for the
version you are actually running, and `simt check` to see the drift the rollback created.
A generated region is a claim about the version that wrote it, so a rolled-back install and a
newer region is the one state `check` reports and `sync` fixes.
