---
simt-affects: ["src/kernel/checks.mjs", "src/index/source-lines.mjs", "src/projection/project.mjs", "src/commands/sync.mjs", "src/commands/doctor.mjs"]
simt-supersedes: []
---
# ADR-251 — Check reuses staged source evidence

Status: accepted · 2026-11-22 · D36

## Context

A clean staged blob can supply its line count and generated marker from
the local index. Working-tree changes need live evidence, and a deleted
dependency can still affect an unchanged importer.

## Rulings

1. **Match cached facts by blob revision.** Reindex records line counts
   and generated markers without a schema migration. Dirty files and
   files without matching facts use a safe working-tree read.

2. **Keep a scoped check distinct from a repository verdict.** Use
   `simt check --changed` to limit source and graph findings to changed
   paths and their direct import neighbors. Validate manifest and
   generated regions on every run. A scoped run leaves the repository's
   full check cache alone.

3. **Retain findings and link shared causes.** When evidence identifies a
   common cause, the first affected finding carries `rootCause`. Other
   affected findings carry the same identifier in `causedBy`. The
   existing flat array preserves finding order and individual remedies.

## Consequences

A receiving repository can run a local edit check before the full
`simt check` used for a repository-wide verdict.
