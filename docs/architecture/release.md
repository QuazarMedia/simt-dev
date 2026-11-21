# Release

Four channels, one tag, and the same bytes:

| Channel | How it is published |
| --- | --- |
| npm | `npm publish` from the tagged commit; `files` decides what ships — `bin`, `src`, `rules`, `templates`, `agents`, `skills`, `ecosystems`, `harnesses`, `docs/decisions`, `CHANGELOG.md` |
| PyPI | the wheel carries the same bytes as the npm tarball; it does not fetch them at install time |
| Homebrew | the formula downloads the single-file binary for the machine |
| single-file binary | one executable per platform (macOS arm64/x64, Linux x64) beside its `.sha256` |

The optional `@simt-dev/bench` package is released with the same version as the
core. `publish.yml` builds it from the tagged tree and stages it beside
`simt-dev`; `publish-channels.yml`'s `verify-bench` job installs the published
pair by name and runs `simt bench replay`. The core does not carry or import the
bench, and the bench declares `simt-dev` as a peer, so installing both by name is
the supported route (ADR-211).

The Node floor is 22.20.0 for the npm and PyPI channels, because the index needs
`node:sqlite` with FTS5. The binary carries its own runtime, so it has no such floor.

## Qualification

The offline correctness gate and the artifact gate are separate commands, because a
network or a prior build cache must not decide whether `npm test` passes.

```sh
npm run qualify:offline    # suite, lint, generated CI, incremental-index budget
npm run qualify:artifacts  # wheel parity, pinned SEA build, built-binary acceptance
```

`qualify:offline` uses a fixed four-worker test concurrency and writes npm and Git
state under temporary directories; it needs no network and no host Git identity.
`qualify:artifacts` sets `SIMT_QUALIFY_SEA=1`, builds into `SIMT_SEA_CACHE` (or a
temporary cache), and reports a missing Node base or npm registry as a named stage
failure. The `simt-dev qualification` workflow runs both across the supported Node and
macOS/Linux matrix on manual dispatch; a skipped stage prints its prerequisite rather
than counting as a pass.

## What a release must contain

- the version in `package.json` and the wheel's metadata,
- for a bench release, `@simt-dev/bench` at the same version, with its stage
  approved and the published pair verified,
- a CHANGELOG entry with one line per change and its decision-record link,
- `docs/commands/` and `docs/decisions-index.md` regenerated and committed,
- a green suite on the released tree, cited in the release notes,
- for a binary release, the checksum verified on at least one platform before the announcement.

## Why pinning matters

The tool writes a content digest into every file it generates. An unpinned upgrade changes
those files under a repository that did not ask for the change, which is why the install
instructions say to pin and why `sync` prints the plan before it writes. `simt upgrade`
replaces an installation with the pinned release, and records what it replaced.

The step-by-step checklist is in [CONTRIBUTING.md](../../CONTRIBUTING.md#release-checklist).
