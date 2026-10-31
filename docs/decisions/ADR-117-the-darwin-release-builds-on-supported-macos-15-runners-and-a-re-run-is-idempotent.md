---
simt-affects: [".github/workflows/publish.yml", "test/binary.test.mjs"]
simt-supersedes: [{ adr: "ADR-099", ruling: 1, kind: "superseded" }]
---

# ADR-117 — the darwin release builds on supported macOS 15 runners, and a re-run is idempotent

Status: **accepted** · 2026-10-31 · supersedes ADR-099 ruling 1

## Context

The v0.7.0 release run `41215349142` reached the first binary release: the npm stage
succeeded, the release record was created, and `linux-x64` built. Both darwin jobs failed
in the same place — `macos-14`, the runner ADR-099 ruling 1 named, is deprecated, and
GitHub was running scheduled brownouts of that image ahead of its retirement.

The old matrix also used one label for two architectures. GitHub's runner-images table
now names `macos-14` as arm64 and `macos-14-large` as Intel, so "both targets on
`macos-14`" was not the native-runner arrangement ADR-099 claimed. The replacement has
to name the arm64 and Intel images explicitly.

The same run exposed a second release-path defect. `publish-npm` decided whether to skip
by asking the registry whether the version was published. A staged version is not
published, so re-running the workflow after every other job succeeded would try to stage
the same version again and fail on the duplicate. "Re-run all jobs" is the normal way to
recover a partially failed release, and it must not turn a completed stage into a red
job.

## Ruling

1. **Darwin targets build on the supported native macOS 15 images.**
   `darwin-arm64` runs on `macos-15` and `darwin-x64` runs on `macos-15-intel`;
   `linux-x64` stays on `ubuntu-latest`. These are the standard, non-deprecated labels
   for the two architectures, not the larger-runner variants. ADR-099's per-host
   determinism and upload-integrity claims are unchanged; only the label that provides
   the native host moves.

2. **A re-run is idempotent for a stage that already succeeded.**
   `publish-npm` checks the npm staging queue as well as the registry. A version that is
   published *or* already staged sets `SKIP=true`, so the tests, the wheel check and
   `npm stage publish` are not repeated. The staging check runs after npm 11 is
   available, because `npm stage list` is the command that makes the queue visible. A
   failed stage list is not treated as proof of absence: the job attempts the stage and
   fails loudly rather than silently skipping a release that does not exist.

   The release record, asset upload and formula mirror were already idempotent —
   `create-release` edits an existing release, `gh release upload --clobber` replaces
   assets, and `sync-formula` exits when the mirror already names the served bytes.
   They stay that way. A re-run does not skip a build on the grounds that an asset with
   the same name exists: the tag can have moved, and the asset must be built from the
   tree the tag now names.

## Consequences

- A darwin failure is recovered on a runner GitHub supports, and the arm64 and Intel
  assets are produced on the architectures they claim.
- "Re-run all jobs" after a successful stage is green: the stage job says the version is
  already staged, the release record is refreshed in place, and the formula is compared
  rather than overwritten.
- "Re-run failed jobs" remains the narrower recovery: it rebuilds only the targets that
  failed, which is the path the v0.7.0 run needed.
- ADR-099 ruling 1 is superseded. Its ruling 2 (upload integrity) and ruling 3 (the
  formula mirrors served bytes) still govern the release.
- `test/binary.test.mjs` reads the committed workflow and asserts the two darwin labels,
  so a future edit that returns to a deprecated or wrong-architecture runner fails the
  suite instead of a release.

## Rejected

- **`macos-latest` for arm64.** It moves with GitHub's newest stable image. A release
  builder should change when this repository decides to change it, not when a label
  migrates.
- **`macos-26`.** It is newer than the release needs, and no run has proven the pinned
  Node base and `codesign` pipeline on it. Moving to it is a separate reviewed change.
- **`macos-14-large`.** It is the Intel half of a deprecated image, so it inherits the
  brownout that caused this failure.
- **Skipping a build because the asset name already exists.** The tag this workflow runs
  for can be moved, and an asset left from an earlier tree would then be served as the
  new tag's binary. Rebuilding and clobbering keeps the bytes tied to the tagged tree.
- **Detecting a prior stage through the registry alone.** A stage is deliberately not
  public, so the registry cannot answer whether it exists.
