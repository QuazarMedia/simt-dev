# ADR-005 — File length is two tiers: 400 review trigger, 1000 hard ceiling

Status: **accepted** · 2026-10-05 · affects all repos

## Context

- `repo-14` / `repo-11`: "**Split any file once it exceeds 1000 lines**; extract
  along the nearest cohesive boundary instead of growing the file further."
- `repo-07`: "**File length: 400 lines is a smell threshold, not a hard gate.**" Generated
  `.mc` files are exempt, with a named exception for a 408-line template.
- Several repos: no file-length rule stated at all.

The two numbers are not in conflict — they measure different things. 400 is where a human
should start asking questions; 1000 is where the file must already have been split.

## Ruling

Two tiers, both advisory in wording but checkable in `simt-dev check`:

- **400 lines — review trigger.** Crossing it requires a stated reason to keep the file whole.
- **1000 lines — hard ceiling.** `simt-dev check` fails. Extract along the nearest cohesive
  boundary.
- **Generated files are exempt**, declared per repo in `simt-dev.json`. The hook must name the
  generator.

Per-repo overrides are permitted via `limits.fileLines` in `simt-dev.json`.

## Consequences

- one repository' hard 1000 gate and garmin's soft 400 both survive unchanged in force.
- The generated-file exemption that garmin had to state in prose becomes a declared property,
  so the hook can honour it without hardcoding `.mc`.
- `repo-14`'s pre-commit file-size check (currently inlined as 1000 lines of shell, and
  duplicating `scripts/check-file-sizes.ts`) becomes one implementation in the shared
  dispatcher.

## Rejected

- **One number org-wide.** Either it is too tight for legitimately long declarative files or
  too loose to prompt a human at 400.
- **No rule.** one repository' pre-commit check exists precisely because a rule was missing,
  and it is now implemented twice.
