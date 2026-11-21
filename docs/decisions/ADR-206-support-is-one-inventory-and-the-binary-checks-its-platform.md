---
simt-affects: ["src/distribute/support.mjs", "src/distribute/release.mjs", "docs/reference/support.md", "docs/getting-started.md", "README.md", "test/pack.test.mjs", "test/packaging.test.mjs", "test/binary.test.mjs", "test/node-version.test.mjs"]
simt-supersedes: []
---
# ADR-206 — support is one inventory, and the binary checks its platform

Status: accepted · 2026-11-21 · filed as review 0005 PR28

## Context

Four channels ship the same bytes (npm, PyPI, Homebrew, the release binary), and each
stated its own prerequisites in a different paragraph. The release target list lived in
`src/distribute/release.mjs`, the publish matrix in `.github/workflows/publish.yml`, the
post-release verification in a shell literal, the node floor in five files, the Python floor
in `pyproject.toml`, and the formula in `Formula/simt-dev.rb`. Nothing compared them, and
the review found the consequences:

- The one-line download a remedy prints derives the platform with `uname` and curls
  `simt-dev-<version>-<os>-<arch>`. On Linux arm64 - a host npm and pip both support - that
  name is not published, so the reader got a 404 from the release and a message blaming
  themselves.
- "Which platforms does this run on?" had four answers depending on which document the
  reader opened first, and only one of them was complete.
- The linux-arm64 question was open: the tool runs there through npm or pip, but no release
  asset exists, and adding one is a release action rather than a build flag.

The package itself was qualified from a real install (test/pack.test.mjs), but only for the
bin, the registry and the adoption lifecycle: the library export, the MCP surface and the
shims it renders were asserted from the checkout instead of from the installed copy.

## Ruling

1. **One inventory, published.** `src/distribute/support.mjs` holds the channel rows
   (install, runtime, platforms, fallback), the runtime floors and the doc's location.
   `docs/reference/support.md` is its publication, and a static test fails when the table
   and the module disagree. A channel that gains a prerequisite adds a row, not a paragraph.

2. **The target list stays in `release.mjs` and is reused, never restated.** The publish
   matrix and the post-release verification loop are asserted equal to `TARGETS` in
   `test/binary.test.mjs`; `support.mjs` imports the list rather than typing one.

3. **The download checks the platform before it fetches.** `localInstall` derives the target,
   matches it against `TARGETS` in a shell `case`, and on any other host prints the fallback
   (npm or pip with the node floor) and exits non-zero. A 404 from the release is not a
   support statement; it reads as a broken release.

4. **The floors are stated once and compared.** Node 22.20.0 is `src/node-version.mjs`,
   `package.json` `engines.node`, the SEA base version, the publish job's `node-version` and
   the PyPI launcher's tuple; `test/node-version.test.mjs` compares all five. Python 3.9 is
   `requires-python` and the launcher. Git 2.5 is required only for the worktree features.

5. **Linux arm64 is deferred, explicitly.** The binary is published for darwin-arm64,
   darwin-x64 and linux-x64. Adding linux-arm64 needs three things that must land at a
   release boundary: an arm64 runner in the publish matrix, a fourth formula pair carrying a
   real checksum, and the remedy naming it. Until then the supported route on arm64 Linux is
   npm or PyPI with a Node, and the page says so rather than listing the platform as
   unsupported. Windows is WSL2 only.

6. **Rollback is a documented install, not a mode.** Pin the version, install it back, then
   `simt sync --yes` re-renders the region the running version projects and `simt check`
   reports the drift. There is no downgrade flag, because a region is a claim about the
   version that wrote it and `sync` is already the operation that repairs it.

7. **The installed package qualifies every door it ships.** `test/pack.test.mjs` now runs the
   installed `--version`, imports the library export from the consumer's own resolution,
   lists the MCP surface, and renders a hook shim - each against the tarball, not this
   checkout.

## Consequences

- `docs/reference/support.md` and `support.mjs` fail the suite when they drift; the cost is a
  test edit when a channel changes, which is the point.
- The remedy line is longer. It is still one line and still contains no single quote, which
  is what `renderLocator` and the copy-paste rules require.
- Linux arm64 and Windows have no binary until the criteria above are met; the fallback is
  a command, and the page names it.
- The wheel/tarball content comparison (`npm run verify:wheel`) and the SEA build
  (`npm run build:sea`) remain release-job checks. They need a Python build environment and
  a network fetch of the pinned node base, so they are not in `npm test`; the static
  invariants that can run here are in the four test files this slice names.

## Alternatives

- **Add linux-arm64 now.** It would need a checksum for an asset that does not exist yet,
  and a formula pair fabricated ahead of a release is the placeholder defect this review
  already ruled on. Deferral with a stated fallback is honest; a fabricated asset is not.
- **Keep the prerequisites per channel.** That is the state the review found: four answers,
  one of them wrong, and no test that could notice.
- **Make the download derive a fallback asset.** There is no second artefact to fall back
  to; the fallback is a different channel.
- **Declare a higher Git floor because CI runs a newer one.** A floor is what the code needs,
  not what a runner happens to have. `git worktree` is 2.5, and the read-only commands need
  no Git at all.
