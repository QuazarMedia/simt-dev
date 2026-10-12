# ADR-059 — The version a repository runs is the one it pinned, and the gate refuses otherwise

Status: **accepted** · 2026-10-12 · affects all repos

## Context

ADR-010 ruled that a tool which is genuinely not a project dependency may be invoked directly,
**provided its version is pinned**. For a repository with a `package.json`, simt-dev is that
dependency, and npm does the pinning: it installs the version in `package.json` into
`node_modules`, and a stale copy is a stale lockfile that `npm ci` reproduces.

For a repository **without** npm — a Gradle build, a Connect IQ project — there is no
`node_modules` to pin in. simt-dev is a global install, and nothing pins it. The version on
`PATH` is whatever the last `npm i -g` left there, and it can be anything. The gate that runs
on commit is the one in that binary. If it is not the version the repository adopted, the gate
that runs locally is not the one CI runs: a green tick from a check that ran the wrong version
is the one outcome worse than a red build, because it is a pass that never happened.

The same gap sat in the remedy. The shim and the consumer workflow assumed npm everywhere —
`npm i -D simt-dev@<v>` and `npm ci`. In a Gradle repository that command installs into a
`package.json` the repository will never have, so the remedy cannot succeed and the CI step
cannot start. The install and the remedy each needed to know the kind of repository they were
in, and neither did.

## Ruling

1. **The manifest records the version a repository adopted.** `projection` carries
   `version` alongside the existing `simtDevSha`, written at adoption and refreshed by
   `upgrade`. A node_modules copy is pinned by npm itself, so this field matters only where
   npm is not the pin — but it is written everywhere, because a manifest that records the
   version in one shape of repository and not another is two manifests.

2. **The gate compares the running binary against that pin, and refuses on a mismatch.** The
   comparison is in the dispatcher (a failed `version` gate) and in `check` (a blocking
   finding), not in the shim's rendered bytes: the dispatcher is where every gate already runs,
   and a comparison duplicated into bytes a formatter might rewrite would drift from the one
   that decides. It is placed after the empty-gate check on purpose — a repository that declares
   no gate has nothing the version could get wrong, and failing it would block commits in repos
   that deliberately declare none.

3. **The install and the remedy are per kind.** Where a `package.json` exists, simt-dev is pinned
   as a devDependency and the remedy is `npm i -D simt-dev@<v>`. Where there is no npm, it is a
   pinned global install and the remedy is `npm i -g simt-dev@<v>` (or `export SIMT_DEV_BIN=…`).
   The consumer CI workflow makes the same choice by kind — `npm ci` where the package is a
   declared dependency, the pinned global install otherwise — so the gate that runs in CI is the
   one the machine remedy names, and a check cannot pass in one place and fail to start in the
   other.

## Consequences

- A stale global binary can no longer produce a green tick from a check that ran a different gate
  than CI does. The mismatch is a refusal with the one command that fixes it, and the remedy and
  the CI step agree on which version to install.
- A repository adopted before the field existed — a manifest with `simtDevSha` but no
  `projection.version` — is **skipped, not failed**. There is nothing to compare against, and
  failing every pre-0.2 repository the moment this check ships would turn the gate red for a
  reason it cannot fix. `compare` reports that missing field as a stale manifest (ADR-045's
  defect from the far side), so it is visible and repairable rather than silently absent.
- The version a repository runs is now an invariant the gate enforces, not a comment: the pin in
  the manifest and the binary on `PATH` must agree, or the commit does not happen.

## Rejected

- **Shell out to `simt --version` in the shim.** The dispatcher runs from the binary that
  resolved it, so reading the running package's version is the same answer without a subprocess,
  and it is correct whether the binary came from `node_modules`, a global install, or a source
  checkout. A subprocess would answer only for the binary that started it.
- **Fail a repository with no recorded pin.** There is nothing to compare against; it would make
  every pre-0.2 repository red on the day this ships, for a mismatch nobody can resolve until
  they re-adopt. The missing pin is reported as drift, which is the repairable form of the same
  fact.
- **Put the check only in the shim's rendered bytes.** The dispatcher is where every gate runs and
  where `check` already lives, so the comparison belongs in one place. Rendered bytes are read by
  a formatter and a reviewer; a control that lives in both is two copies of one question, which
  is the shape this record's siblings keep finding drifting.
