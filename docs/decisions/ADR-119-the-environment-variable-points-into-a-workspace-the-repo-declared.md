---
simt-affects: ["src/workspace.mjs", "src/graph/load.mjs", "test/workspace.test.mjs", "simt.json"]
simt-supersedes: [{ adr: "ADR-014", ruling: 1, kind: "superseded" }]
---

# ADR-119 — the environment variable points into a workspace the repo declared

Status: **accepted** · 2026-10-31 · supersedes ADR-014 ruling 1

## Context

ADR-014 made the workspace configuration, resolved in a fixed, reported order:
`--workspace`, then `SIMT_DEV_WORKSPACE`, then the user config file, then the sibling
heuristic. Its ruling 1 named the variable's purpose as "CI and one-off invocations".

A variable that is *exported* is not a one-off invocation. Measured: a developer whose
shell exports `SIMT_DEV_WORKSPACE` for a multi-repo workspace, working in a single repo
that declared no workspace, gets that repo treated as a member of the exported workspace
— `repo/path` skill sources resolve against it, `compare` discovers its siblings, and
`doctor` reports `env` as the source. The default case ADR-014 ruling 3 exists to keep
first-class — a single repo with no workspace — silently depends on ambient environment.

The asymmetry is the defect: the user config file is a *per-developer* fact, and an
exported variable is one too, but a workspace is a *per-repo* fact. Nothing in the
precedence list asked the repository whether it has a workspace at all.

## Ruling

### 1. The precedence gains the repository's own declaration, above the environment variable

Precedence, highest first:

1. `--workspace <path>` — an explicit flag always wins.
2. The repository's own manifest declaration — a `workspace` key in `simt.json` (or the
   legacy `simt-dev.json`, read by the same reader every other command uses). An `off`
   value declines exactly as it does from any other source, and the environment variable
   cannot override a decline: a repo that said it has no workspace is not one.
3. `SIMT_DEV_WORKSPACE` — a value that names a directory is honoured **only where
   the manifest declares a non-declining workspace**: the variable is a pointer INTO
   a workspace the repo opted into, not one imposed on a repo that never declared
   one. A value that declines is honoured from anywhere, because a decline points
   at nothing and so needs no declaration to work.
4. The manifest's value — a relative path resolves against the manifest's directory, not
   the process's, so `workspace: ".."` means the same thing from any subdirectory.
5. The user config file — unchanged, and honoured regardless of the declaration, because
   it is a per-developer fact that predates the repo.
6. The sibling heuristic — unchanged: consulted last, accepted only when it verifies.

Every command that consults the workspace reports where it came from, as before; the
declaration introduces the source label `repo`.

### 2. A manifest that exists and does not parse is an error, and it names the file

Same shape as the unparseable-config error ADR-014 ruling 2 established: precedence
decides which *answer* wins, but a file that exists and does not parse is a defect in
the reader's setup, and hiding it because some other source outranked it would send
them looking in the wrong place.

### 3. The memoisation key names the directory whose manifest decides

`src/graph/load.mjs` memoised the resolution per flag, variable and config location.
The current directory's manifest now decides part of the answer, so the key names it;
a memo that cannot see the directory serves one caller's declaration to a later caller
standing in another repo.

## Consequences

This repository dogfoods the declaration: its own `simt.json` carries
`"workspace": ".."`. The resolved root is unchanged — the sibling heuristic already
verified the same directory — but the source label moves from `heuristic` to `repo`,
which is the point: the workspace this repo resolves is declared, not guessed.

An exported `SIMT_DEV_WORKSPACE` is inert in a repo that declared no workspace, which
is the measured case this record exists to fix. In a repo that did declare one, the
variable still overrides the declared value, so CI pinning a workspace for a known
multi-repo checkout is unchanged.

## Rejected

- **Honouring the variable only in CI.** The tool has no CI detector, and "CI" is not
  a fact about the repository; a detector that is wrong in one direction reproduces
  the measured defect, and wrong in the other breaks the one-off use the variable
  exists for.
- **Making the declaration a precondition for the config file too.** The config file
  is per-developer and works from any repo, including one that has no manifest yet;
  requiring a declaration would break the single-repo reader with a config, which is
  the audience ADR-014 ruling 3 protects.
- **Renaming the variable.** It is the documented pointer in every remedy string this
  tool ships; renaming it moves the defect into the reader's muscle memory rather
  than deleting it.
