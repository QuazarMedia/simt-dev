---
simt-affects: [".github/workflows/publish-channels.yml", "docs/decisions/ADR-097-the-channels-publish-by-hand-and-the-version-rides-in-as-an-input.md"]
simt-supersedes: []
---

# ADR-121 — the version input may be `latest`, and each job resolves it before the guard

Status: **accepted** · 2026-10-31

## Context

ADR-097's ruling 2 made the dispatch's `version` input *the release* — a concrete
version such as `0.5.0` — and the workflow's own header spelled out the reason:
`0.5.0`, not `latest`, because a channel named `latest` publishes a side channel of
whatever is newest, "which is the one failure this guard exists to prevent".

In use, the concrete field costs the maintainer a retyping: they have just approved the
stage, and the version they know is the one npm now serves. And the failure the ruling
feared — a channel published ahead of npm — is already barred, independently of what the
field says. Each channel begins with its own prerequisite: PyPI checks that `npm view`
serves the version, Homebrew checks that the release binary is downloadable, and both
jobs then compare the version against the tag's `package.json` and refuse to run on a
mismatch. A field that resolves to "what npm serves" therefore cannot outrun npm: the
resolution lands inside the job, the prerequisites and the guard run against the concrete
value, and a release whose npm stage is still unapproved fails at the prerequisite with
the remedy named, exactly as it does today for a mistyped concrete version.

## Ruling

### 1. The input is optional, and `latest` is its default

The `version` input is `required: false` with `default: latest`. An empty field and the
text `latest` are the same value — "whatever npm serves as newest" — and a concrete
version in the field is used verbatim, exactly as before. The description names both
forms; the "e.g. 0.5.0" example, which existed to steer authors away from `latest`, is
gone because `latest` is now the steered-to value.

### 2. Resolution is per-job, and it is the first step of each job

Each of the three jobs (`publish-pypi`, `publish-brew`, `verify-brew`) opens with a
step that resolves the field: an empty or `latest` value becomes
`npm view simt-dev version` — the `latest` dist-tag, the newest published npm version —
and the result is written to the job environment as `RELEASE_VERSION`. Everything after
reads the resolved value: the checkout's `ref: v<version>`, the tag guard, the channel
prerequisite, the formula render, the tap push, and the tap verification. A channel named
`latest` never reaches a guard or the tap; the guard always compares a concrete version
against the tag, which is the invariant ADR-097's ruling 2 exists to keep.

### 3. The concurrency group keeps the raw input

The `concurrency.group` is evaluated when the run starts, before any job environment
exists, so it names the field, not the resolution. Two `latest` runs share one group and
serialize, which is what a torn double-upload is guarded against; a `latest` run and a
named run of the same version land in different groups, and it is the guard — not the
group — that keeps the channels aligned. The group is a race breaker, and the guard is
the truth check; giving the group the resolved value would buy nothing the guard does
not already enforce.

## Consequences

- The maintainer's release tour is `npm stage approve <stage-id>` and
  `gh workflow run publish-channels.yml` — no `-f` — with the named form
  `-f version=0.5.0` unchanged for a release that is not the newest on npm.
- The workflow file's header and input comments state the two forms and where the
  resolution lands, so a reader of the file sees the mechanism rather than guessing at
  the `latest` semantics.
- `scripts/publish-local.mjs` is untouched: it is the not-CI twin of the file, it takes
  the version from its caller, and it has no dispatch form to resolve.

## Rejected

- **A shared resolver job.** A fourth job that resolves once and exports the value would
  run on every dispatch — including a brew-only run that ticks one box — and add a step
  the form's reader has to account for. This file's shape is one self-contained job per
  channel, each gating on its own; a resolver job is a dependency none of them needed.
  The cost of per-job resolution is one `npm view` call per ticked channel, which the
  PyPI job already makes.
- **Resolving in the concurrency group.** GitHub evaluates the group at run start, where
  no job environment exists; a `latest` in the group is a constant string that happens
  to serialize the `latest` runs, and ruling 3 says that is the right behaviour.
