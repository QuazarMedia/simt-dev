---
simt-affects: ["src/work/config.mjs", "src/manifest/schema.mjs", "test/work-config.test.mjs"]
simt-supersedes: []
---
# ADR-144 — the work namespace is versioned, and adoption fabricates no runner

Status: accepted · 2026-11-02

## Context

Adopting a knowledge repository left the tool with a question it answered dishonestly: no
package runner, no test command, no build step. The options were to fabricate one so that
"checks exist", to import a code-shaped default that would fail on the first run, or to say
that the repository has only the checks it declares. The first two make a repository look
adopted while nothing checks it.

## Rulings

1. **`work` carries an exact version.** `work.version` must equal the version this parser
   knows. A mismatch is a problem with a remedy, never a best-effort read.

2. **Adoption writes no runner.** No `package.json`, no `pyproject.toml`, no `pytest`
   gate, no build step is created by `init`, `doctor` or `sync`. A repository with a runner
   keeps it; one without gains only the checks it declared.

3. **A misspelt or duplicate declaration is a check that does not exist.** Unknown keys
   inside `work`, duplicate scope ids and two scopes claiming one path are refused, because
   each would leave a repository believing in a check the tool cannot run.

4. **`work` is the repository's key.** `init` preserves it across re-adoption, as it
   preserves `limits`; the tool reads it and does not rewrite it.

5. **Validation is local and read-only.** Deciding whether a declaration is valid executes
   nothing: no validator runs, no target is contacted, no credential is read.

## Consequences

- A docs-only repository can be adopted honestly today, with `facets` describing its
  artifacts and `gates` staying empty rather than invented.
- New `work` features need a version bump and a new ruling, not a silently widening
  schema.
- A malformed declaration reaches `doctor` as a problem with a remedy, which is the same
  surface every other manifest problem already uses.
