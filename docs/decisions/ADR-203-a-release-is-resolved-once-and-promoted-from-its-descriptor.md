---
simt-affects: ["src/distribute/descriptor.mjs", "scripts/release-descriptor.mjs", "scripts/release-formula.mjs", ".github/workflows/publish-channels.yml", "test/release-descriptor.test.mjs", "test/packaging.test.mjs", "RELEASING.md"]
simt-supersedes: []
---
# ADR-203 — a release is resolved once, and promotion verifies the source it resolved

Status: accepted · 2026-11-21 · filed as review 0005 PR27

## Context

`publish-channels.yml` asked each job to resolve the version. Two jobs expanded `latest`
from npm independently, so a release landing between them split one run across two
versions; the brew verification read a third. The workflow concurrency key was the raw
dispatch input, so `latest` and `0.7.0` — the same artifact — were two groups that never
waited for each other.

The PyPI gate checked that a version existed on the registry and then compared the wheel
against bytes built from whatever tree this run had; the brew job downloaded the assets
again and wrote the tap's checksums from that second download. Nothing compared a channel
against a single record of what the release is, so "the same release" was an assumption
repeated three times.

The dispatch value was also interpolated into generated shell (`version="${{ inputs.version }}"`)
before any validation, which puts a form field in a command line by construction.

## Ruling

1. **A release is a descriptor, and there is exactly one per run.** The descriptor carries
   the concrete version, the tag, the commit the tag names, and every target's asset name,
   URL, byte length and sha256. It is produced by `resolve` once and passed to every job as
   a job output; no channel reads npm, the tag or the release assets to decide what to
   publish.

2. **Resolution refuses anything that is not one release.** The input is trimmed and must
   be `x.y.z` (an optional prerelease suffix is allowed); `latest` and an empty field are a
   *request* that the resolver expands from the registry exactly once. The tag must exist and
   peel to a commit, the version must be live on npm (a staged version names the approval),
   every target's asset must download, and a tap formula that already names this version
   must agree with the resolved bytes.

3. **The dispatch value reaches the resolver as an environment variable, never as shell
   text.** `INPUT_VERSION` is the only place `inputs.version` is interpolated. A value that
   is not a concrete version is refused before any command runs.

4. **Promotion re-verifies the descriptor, and serialises per destination on its version.**
   Each channel job re-reads npm's newest version, the tag's commit and every asset's bytes
   before promoting, and fails when any of them moved. Job-level concurrency is
   `publish-<destination>-<resolved version>`, so a `latest` run and an explicit run that
   resolve to the same release queue behind each other.

5. **Every channel is verified against the descriptor after promotion.** PyPI downloads the
   published wheel and compares its hash with the wheel this run built; the tap formula is
   read back and its checksums compared with the descriptor's. A retry is idempotent: the
   same bytes already present are a skip, a tap with nothing staged commits nothing, and a
   destination serving this version at different bytes is a conflict automation may not
   overwrite.

## Consequences

- The evidence a maintainer reviews is one block: release, commit, tag, one line per asset
  with its digest, and the descriptor id. It is printed by the resolve job and reproducible
  from the descriptor file.
- `--simulate <dir>` answers every probe from a directory, so staged, latest, explicit,
  moving, mismatched and partially published releases are all reproduceable without a
  network — and the tests drive the same script the workflow does.
- The brew job renders the formula from the descriptor rather than re-downloading assets,
  so the two channels write the same checksums by construction.
- A partial promotion is visible and recoverable: the recheck names the asset or channel
  that is missing, and the steps that already landed skip.

## Rejected

- **Keep per-job resolution and make the input stricter.** A strict input still lets
  `latest` expand twice; the defect is the second resolution, not the value.
- **One workflow-level concurrency group on the resolved version.** It cannot be expressed:
  workflow-level `concurrency` may only read `github`, `inputs` and `vars`, and the
  resolved version is a `needs` output. Job-level groups are the only place the answer is
  available, which is also the right scope — PyPI and brew should not wait for each other.
- **Upload the descriptor as an artifact.** It is a few kilobytes of JSON with no newline;
  a job output carries it without a second action to pin, a download step or a retention
  policy.
- **Trust the tap's checksums when it already names the version.** That is the channel whose
  formula can be edited by hand; comparing it against the release is the only check that
  catches a formula pointing at different bytes.
