---
simt-affects: [".github/workflows/publish.yml", "scripts/classify-release.mjs", ".agents/skills/release-process/SKILL.md"]
---

# ADR-256 — a content-only release skips the binary build

Status: accepted · 2026-11-23

## Context

Every tag paid the full release: three native single-executable builds on native
runners, a formula re-rendered from the served bytes, and their upload integrity
checks — even when the diff since the previous tag touched only content the binary
serves without behaving differently (a harness definition, a rule body, a skill).
Harness churn is the common case, and each of those releases paid three builds that
changed nothing a binary does.

A package split (`@simt-dev/harnesses`) was considered and set aside: the SEA build
embeds the whole shipped file set, so a split would not fix the binary channel — a
harness change would still need a rebuild and republish for every consumer on it —
and a dependency breaks ADR-012's zero-runtime-dependency ruling. The lever that
does fix the stated pain is release *kind*, not package size: a content-only release
publishes through npm and PyPI (the wheel carries the npm bytes) and skips what no
content change requires.

The classifier is plan 0008 F01: `classifyReleaseKind` in `src/distribute/release.mjs`
with a closed content path set, and `scripts/classify-release.mjs` supplying the git
facts (previous tag via `git describe`, diff names). This ruling wires it into
`publish.yml` and states the lag it creates.

## Rulings

1. **The release kind is closed-set and deterministic.** A release is
   `content-only` when every path it changes since the previous tag sits in the
   content set — `harnesses/`, `rules/`, `skills/`, `templates/`, `ecosystems/`,
   `docs/`, `packages/bench/`, `graph/skills.graph.json`, and the release
   commit's bookkeeping files (`package.json`, `simt.json`, `CHANGELOG.md`,
   `README.md`) — and `full` otherwise. The safe side is full: a release misread
   as content-only leaves binary-channel readers on old bytes until the next full
   release, which is recoverable and stated; a release misread as full only pays
   builds it did not need. With no previous tag (the first release) the kind is
   full, because the binary channel has nothing to serve. `SIMT_RELEASE_KIND=full`
   in the environment forces full and is read before the diff; a value other than
   `full` is refused, because a typo that silently skips the build is the failure
   this lane exists to prevent.
2. **`publish.yml` gates the binary work on the kind.** The `version` job
   classifies after the version guard (its `fetch-depth: 0` checkout is what makes
   the previous tag reachable) and exports `kind`; `build-binary` and
   `sync-formula` run only when it is `full`. The npm stage, the release notes,
   and the PyPI channel always run.
3. **The lag is stated, not hidden.** For a content-only release, binary-channel
   readers — the Homebrew formula and a repository's `.simt/bin/simt` — keep the
   previous **full** release's bytes until the next full release, which rebuilds
   the binaries and re-syncs the formula from what is then served. The release's
   Homebrew channel is skipped, because its asset check verifies the three release
   assets exist and they do not. The skill (`release-process`, "Content-only
   releases") carries this statement for the maintainer who runs the channels by
   hand.
