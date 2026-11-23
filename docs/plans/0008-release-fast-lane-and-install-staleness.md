# Plan 0008 — content-only release fast lane, install-time staleness notice

Status: **queued** · 2026-11-23

## Scope

Two levers for release friction, chosen over a package split (which would not fix the
SEA binary channel and would break ADR-012's zero-runtime-dependency ruling):

1. **Content-only releases run the cheap path.** A release whose diff since the last
   tag touches only content (harness definitions, rules, skills, docs) skips the three
   native binary builds and the formula sync; npm staging and the PyPI channel still run,
   because the wheel carries the npm bytes. Binary-channel consumers (Homebrew, `.simt/bin`)
   keep the previous content until the next full release — stated, not hidden.
2. **Rendered agent-hook entries that lag the running version are visible.** `agent-hooks
   status` already detects drift for the opencode plugin file this tool owns whole; merged
   config entries (claude, codex, cursor, …) report `present` even when their shape lags
   what the current version renders — the class the cursor `failClosed` fix exposed, where a
   stale entry silently degrades fail-closed to fail-open. Status gains entry-level drift
   detection with the one-command remedy.

The git-hooks shims are out of scope: they are pure locators (behavior runs from the
installed package plus `simt.json`), their staleness is cosmetic remedy text, and
`hooks status` already tracks shim staleness through `compare/hooksstate.mjs`.

## Tracker

| id | state | slice | evidence |
| --- | --- | --- | --- |
| F01 | Complete | release-kind classifier script + test | 3722738e88e21cb34bf617443dff1fe99afa5fa4 |
| F02 | Complete | wire classifier into `publish.yml`; skill section; ADR-256 | e719eb333e750b57185b5e8e06e56cc12df5291c |
| F03 | queued | `agent-hooks status` entry-level drift detection + test | — |

## F01 — release-kind classifier (scripts/classify-release.mjs)

A small testable script, `scripts/classify-release.mjs`: given a tag range it prints
`content-only` or `full` on stdout. The content set is `harnesses/`, `rules/`, `skills/`,
`templates/`, `ecosystems/`, `docs/`, `graph/skills.graph.json`, `packages/bench/**`, plus
the release commit's own bookkeeping (`package.json` version bump, `simt.json` projection
pin, `CHANGELOG.md`). Any path outside the set — `src/`, `bin/`, `scripts/`, `.github/` —
makes the release full. An env override (`SIMT_RELEASE_KIND=full`) forces a full release.
No previous tag (first release) is full.

Acceptance: `node --test test/release-classify.test.mjs` green; a diff touching only
`harnesses/cursor.json` classifies content-only; one `src/` file classifies full.

## F02 — wire the classifier into publish.yml + skill + ADR-256

`.github/workflows/publish.yml` gains a classify step after the version guard;
`build-binary` (and `sync-formula`, which follows it) run only when the kind is full.
`.agents/skills/release-process/SKILL.md` gains a "Content-only releases" section: what
qualifies, what runs (npm stage, release notes, PyPI), what lags (binary + Homebrew
consumers until the next full release), and how to force a full release. ADR-256 records
the ruling with the lag stated.

Acceptance: `simt check` clean; the skill section reads as a maintainer acting on it;
ADR-256 present with a Status line.

## F03 — agent-hooks status drift detection

`agent-hooks status` compares each installed merged-config entry against the group the
current version would render; a difference is `state: 'drift'` with the note naming
`simt agent-hooks install --yes`. The owned-file (opencode) path is unchanged — it already
compares rendered bytes. Entry-level comparison (not whole-file) so a repository's own
formatting of unrelated keys does not read as drift.

Acceptance: `node --test test/agenthooks.test.mjs` green, including a new test: a cursor
entry rendered without `failClosed` (pre-fix shape) reports drift with the install remedy;
a current-shape entry reports present.
