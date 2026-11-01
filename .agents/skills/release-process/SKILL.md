---
name: release-process
description: Use when releasing simt-dev: cutting a version, writing the changelog, bumping the version, tagging, the publish and publish-channels workflows, npm staging, the PyPI and Homebrew channels, or deprecating a version.
---

The release is one commit, one tag, and two workflows. `publish.yml` runs on the
tag push and stops at npm staging; a human approves the stage; `publish-channels.yml`
publishes the downstream channels by hand, with the version as an input (ADR-097).

## 1. Cut the version

One commit on `main`, subject `release: simt-dev <version> (<kind>; <summary>)` —
`<kind>` is `major`, `minor` or `patch`, `<summary>` one phrase of what the release
is — with the `Co-Authored-By: Simt Dev <noreply@simt.space>` trailer. Three things
must agree **in that commit**:

1. **CHANGELOG.md** — a new section above the previous release, dated, in the shape
   `## [0.7.1] — 2026-11-01`, with `### Added` / `### Changed` / `### Fixed`
   subsections. Every change since the previous tag goes in it; the release notes
   are cut from this block.
2. **package.json** — the `version` field. `publish.yml`'s version guard compares
   the tag against it on the tagged tree and refuses a disagreement.
3. **simt.json** — the `projection.version` pin. The gate compares the running
   binary against it and refuses a mismatch (ADR-059).

The 0.7.1 release shipped with the bump and the pin landing in follow-up commits,
and both were caught after the fact. Do not split them.

## 2. Tag and push

```sh
git push origin main
git tag v0.7.2             # lightweight, on the release commit
git push origin v0.7.2
```

The tag push starts `publish.yml` (trigger `push: tags: ['v*']`). A version that is
already published *or staged* is skipped quietly, so a re-run is idempotent (ADR-117).

## 3. What `publish.yml` does

1. **Version guard** — the tag must equal `package.json` on the tagged tree.
2. **Stage** — the full suite, the skill-registry lint, the wheel-parity check
   (`npm run verify:wheel`), then `npm stage publish --tag latest`.
3. **Create the release** — cuts this version's changelog block into the GitHub
   release notes.
4. **Build the binaries** — the three release targets on native runners, each
   uploaded with its `.sha256`, then verified: the served bytes are the built bytes
   (ADR-099).
5. **Sync the formula** — re-renders `Formula/simt-dev.rb` from the published
   assets' checksums and commits it to `main`; the tap is a mirror of that file.

A green run means **staged, not published**: nothing is installable until a
maintainer approves.

## 4. Approve the stage — a human step

```sh
npm stage list             # needs npm >= 11; prints the id the "what is now waiting" step showed
npm stage approve <id>     # 2FA; a maintainer decision, never a CI step
```

## 5. The downstream channels

```sh
gh workflow run publish-channels.yml                  # the newest on npm
gh workflow run publish-channels.yml -f version=0.7.2 # a named release
```

- **PyPI** refuses to run until the npm channel serves the version — approve the
  stage, then run the workflow. It builds the wheel, verifies it carries the npm
  bytes, and publishes with trusted publishing.
- **Homebrew** verifies the three release assets exist, lints the formula,
  re-renders it from the published checksums, and pushes it to the tap; `verify-brew`
  then proves the tap serves the release.

## 6. Verify

```sh
npm view simt-dev version   # the channel serves the version
npm stage list              # nothing left staged
```

plus the GitHub release's assets and `.sha256` files, the committed
`Formula/simt-dev.rb`, and the tap's copy of it.

## 7. Deprecation

`npm deprecate simt-dev@<version> "<reason>"` is an **owner action**, not a
workflow step. The burned versions and their deprecation commands are recorded in
`RELEASING.md`; `test/packaging.test.mjs` refuses the burned placeholders in
`package.json`.

## When Actions cannot run

`node scripts/publish-local.mjs --version=X.Y.Z` is the manual twin: the same three
channels from one machine in the same forced order (npm, PyPI, Homebrew), idempotent,
`--dry-run` first.
