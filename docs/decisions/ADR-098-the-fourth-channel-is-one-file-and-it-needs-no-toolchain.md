---
simt-affects: ["scripts/build-sea.mjs", "src/distribute/release.mjs", "src/locate.mjs", "src/package-version.mjs", "src/hooks/shim.mjs", "src/ci/workflow.mjs", ".github/workflows/publish.yml", ".github/workflows/publish-channels.yml", "Formula/simt-dev.rb", "scripts/release-formula.mjs", "scripts/publish-local.mjs", ".gitignore", "test/binary.test.mjs", "test/ci.test.mjs", "test/packaging.test.mjs"]
simt-supersedes: [{ adr: "ADR-058", ruling: 5 }, { adr: "ADR-058", ruling: 7, kind: "narrowed" }, { adr: "ADR-059", ruling: 3, kind: "superseded" }, { adr: "ADR-097", ruling: 3, kind: "narrowed" }]
---

# ADR-098 — The fourth channel is one file, and it needs no toolchain

Status: **accepted** · 2026-10-26 · supersedes ADR-058 ruling 5 · narrows ADR-058 ruling 7 and ADR-097 ruling 3 · supersedes ADR-059 ruling 3 · ruling 3's cross-host byte-identicality narrowed by [ADR-099](ADR-099-the-release-verifies-served-bytes-and-the-formula-mirrors-them.md)

Affects: `scripts/build-sea.mjs`, `src/distribute/release.mjs`, `src/locate.mjs`,
`src/hooks/shim.mjs`, `src/ci/workflow.mjs`, `.github/workflows/publish.yml`,
`.github/workflows/publish-channels.yml`, `Formula/simt-dev.rb`,
`scripts/release-formula.mjs`, `scripts/publish-local.mjs`, `test/binary.test.mjs`

## Context

Review 0002's S35 ruled that no estate repository and no CI runner may be unable to
obtain this tool, and ADR-059 shipped its first half: the remedy and the consumer CI
step branch by repository kind. The half that did not ship is the one this record
settles. For a repository without npm — a Gradle build, a Connect IQ project — every
channel that existed needed a toolchain the repository does not have: the npm tarball
needs npm, the wheel needs a Python, and the formula, until this record, declared
`depends_on "node"` and so installed a command that could not start without one. The CI
step that stood in for the missing channel ran `npm i -g simt-dev@<v>`, which needs the
npm the repository kind is defined by not having. The one repository where the gate had
no toolchain already was also the one where obtaining the tool required installing one.

Two properties of the package made the alternative cheap. It has zero runtime
dependencies and no build step (ADR-012), so "packaging" is copying ~1.3 MB of text
around a pinned runtime; and the text reads its own shipped files — `rules/`,
`templates/`, `docs/decisions/` — relative to `import.meta.url`, so it needs real files
at real paths, not a module graph. Node's single-executable-application support embeds
a script in an official node binary, and postject injects that blob into any target's
copy of one; the missing half was a payload that materializes as a tree.

## Ruling

1. **A fourth artefact is released: one file per target, carrying the same payload the
   npm tarball ships.** `scripts/build-sea.mjs` collects exactly `package.json`'s
   `files` set plus `package.json` itself, and wraps it in a pinned official node base
   at the version `engines` names. The targets are `darwin-arm64`, `darwin-x64` and
   `linux-x64` — the set the one-line remedy and the consumer CI step can name — and a
   platform outside it gets a loud 404, never a silent install of nothing. Each asset is
   published to the GitHub release beside its `.sha256`, with a build-provenance
   attestation binding the digest to the tag workflow's OIDC identity.

2. **The payload materializes as real files before the tool runs.** The SEA entry is a
   small CommonJS bootstrap (Node 22's SEA host runs the entry as CJS, whatever the
   entry's own shape) that writes the embedded file set into
   `${XDG_CACHE_HOME:-$HOME/.cache}/simt-dev/<node version>/<digest>/` and then imports
   `bin/simt.mjs` from there. The digest is a hash of the canonical payload, so one
   directory per payload, written to a staging directory and renamed into place, with a
   marker file making a second run a no-op. Real files at real paths are what keep every
   `import.meta.url`-relative read in `src/` working unmodified; a bootstrap that inlined
   the tool instead would have to re-implement each one.

3. **Determinism is the release contract, and the release checks it.** The same tree
   builds byte-identical assets on any host: the node base is pinned, the SEA config uses
   relative paths so no checkout path lands in the blob, and darwin binaries are ad-hoc
   codesigned with a fixed identifier (without one, codesign derives the identifier from
   the file path, which is what made two checkouts differ). Because of that, the tag
   workflow re-builds each asset and fails the release when its checksum is not the one
   `Formula/simt-dev.rb` in the tagged tree promises — the equality is checked, not
   assumed.

4. **Homebrew's artefact becomes the binary (supersedes ADR-058 ruling 5).** The formula
   carries one `url`/`sha256` pair per target, selected by OS and CPU at install time,
   and no longer declares `depends_on "node"`: the binary is the runtime. The "not
   `std_npm_args`" half of ADR-058 ruling 5 stands unchanged — the formula still does no
   build-time fetch of a package manager. `scripts/release-formula.mjs` patches each
   pair by content, one url and the sha256 line that follows it, and refuses a formula
   whose layout has drifted rather than patching blind.

5. **The order each channel waits on is what that channel downloads (narrows ADR-058
   ruling 7 and ADR-097 ruling 3).** PyPI still begins by checking that `npm view` serves
   the version, because the npm channel is the one a maintainer has to approve by hand.
   Homebrew now begins by checking that the release assets exist, because the formula
   downloads those — a formula naming a tag whose binaries were never built installs a
   404 just as surely as one naming an unapproved npm version. The ordering rule
   survives; only its second premise moved.

6. **The repository's own copy is checked before `PATH`, and the version pin still
   decides.** The locator resolves `$SIMT_DEV_BIN`, then `node_modules`, then
   `.simt/bin/simt`, then `PATH` — so the bytes a repository downloaded are the bytes its
   gate runs, and a machine-wide install cannot shadow them. The dispatcher's version
   comparison (ADR-059 rulings 1 and 2) is unchanged and still refuses a stale binary,
   whatever path it was found by.

7. **A repository without npm installs the binary with one command, and its CI needs no
   Node (supersedes ADR-059 ruling 3's no-npm remedy).** The remedy the shim prints for
   such a repository is one line — `curl` the asset for this machine into `.simt/bin` and
   `chmod` it — with the platform derived at run time from `uname`, because the remedy is
   committed text that a colleague on another machine will read. The generated consumer
   workflow downloads the same asset, verifies it against the published `.sha256`, and
   installs it into `.simt/bin` with no `setup-node` step at all; the install fails loudly
   rather than letting a gate pass that never started. The remedy stays one line a reader
   copies (it carries no checksum — the dispatcher re-verifies the version, and the
   automated CI install is where the published checksum is checked).

## Consequences

- **The acceptance criterion is executable.** A Gradle fixture with every directory
  containing `node` removed from `PATH` runs the release binary's `check` and its
  `agent-hook` path, and the rendered hook shim hands over to `.simt/bin/simt` and
  refuses when it is absent (`test/binary.test.mjs`). The test skips rather than fails on
  a host that is not a release target or cannot reach `nodejs.org` for the base, because
  a contributor's suite must still go green (ADR-031).
- **One `files` list feeds three artefacts.** The npm tarball, the wheel and the binary
  payload all derive from `package.json`'s `files`, so the parity ADR-058 ruled survives
  the new artefact instead of being restated in a third place.
- **The assets are large — one node runtime each.** That is the price of the only channel
  a repository with no toolchain can use, and it is paid per release, not per install:
  the payload is materialized once per node version and digest and reused after that.
- **The formula's committed checksums are the deterministic build of this tree.** Editing
  anything in the payload changes them, and a release whose build disagrees with the
  formula fails at tag time — which is the moment the maintainer still has the tree in
  front of them. The committed values are never a placeholder: they are what the next
  tag of this tree must hash to.
- **A repository that never downloads the binary is unaffected.** The locator's new
  branch is one `[ -x … ]` test that is false when the path is absent, and the npm and
  wheel channels do not consult it.

## Rejected

- **Bun and Deno `compile`.** Evaluated on their documented behaviour, not measured. The
  package's `engines` floor is Node 22.20.0, its index is `node:sqlite` (ADR-089), and
  every latency figure this plan records was taken on that runtime. A binary compiled by
  another runtime would be the one channel not running the runtime the other three run,
  so the records would stop describing it, and the estate would have to re-measure per
  channel to say anything true about it. Node's SEA keeps every channel on the declared
  runtime, and its base is an official node build — the thing that can be pinned and
  attested byte-for-byte. If the floor ever moves to another runtime, the bootstrap is
  the only part that needs rewriting, because the payload is plain files.
- **A bundler that inlines the tool into one script.** The tool reads `rules/`,
  `templates/` and its own decision records at run time; a bundle would have to
  re-implement every `import.meta.url` root computation, and ADR-012's zero-dependency
  rule leaves no bundler to depend on. The payload here is runtime-agnostic text; only
  the wrapper is node-specific.
- **An archive plus a runner script.** Two files is an install step, and the channel
  exists so that a repository with no toolchain gets one file that runs.
- **A checksum inside the one-line remedy.** The remedy is text a reader copies out of an
  error message; adding a second verification command makes it no longer one line. The
  download is TLS from the release, the dispatcher re-verifies the version the repository
  pinned, and the automated install — the CI step, which no human is watching — is where
  the published `.sha256` is checked before anything runs.
- **`npm i -g simt-dev@<v>` for a repository without npm** (what ADR-059 ruling 3 ruled).
  The command needs npm, which is the one thing the repository kind is defined by not
  having; that this was the remedy for the kind it could not serve is the defect S35
  found.
