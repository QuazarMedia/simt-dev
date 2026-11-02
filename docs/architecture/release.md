# Release

Four channels, one tag, and the same bytes:

| Channel | How it is published |
| --- | --- |
| npm | `npm publish` from the tagged commit; `files` decides what ships — `bin`, `src`, `rules`, `templates`, `agents`, `skills`, `ecosystems`, `harnesses`, `docs/decisions`, `CHANGELOG.md` |
| PyPI | the wheel carries the same bytes as the npm tarball; it does not fetch them at install time |
| Homebrew | the formula downloads the single-file binary for the machine |
| single-file binary | one executable per platform (macOS arm64/x64, Linux x64) beside its `.sha256` |

The Node floor is 22.20.0 for the npm and PyPI channels, because the index needs
`node:sqlite` with FTS5. The binary carries its own runtime, so it has no such floor.

## What a release must contain

- the version in `package.json` and the wheel's metadata,
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
