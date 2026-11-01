---
simt-affects: ["templates/plan/tracker.json", "src/plan/index.mjs", "src/projection/manifest.mjs", "test/rules.test.mjs", "test/plan.test.mjs"]
simt-supersedes: ["ADR-082"]
---

# ADR-128 — A research plan is a plan, and the tracker reads it

Status: **accepted** · 2026-11-01 · supersedes ADR-082 ruling 1

## Context

The four founding plans left `docs/plans` for `docs/research`: completed work of a
different kind — research — but plans nonetheless, with tracker tables, slice ids and wave
dependencies. The tracker reads only the directories its template lists, so the move
de-indexed all four at once. A wave dependency that resolved through them broke with it:
`R01` in the research plan 0003 depends on `review 0002 Wave 0`, and the slices it names
live in the de-indexed documents.

The directory set was never code. ADR-081 and ADR-082 settled the mechanism — a template
lists any number of directories, each with a `kind`, a `word` and a `path`, and the parser,
the help text and `plan status` all read it — and ADR-082 ruling 1 fixed the *delivered*
set at two. Fixing the delivered set is a ruling, and this is the new one.

## Ruling

1. **The delivered template lists `docs/research` as a third directory, kind `research`,
   word `research`.** A repository that sets nothing gets all three; a repository that
   overrides `plans` replaces the `directories` section wholesale, exactly as before, so no
   existing override is disturbed.
2. **The directory is data, not a special case.** Nothing in `src/` names `research`; the
   parser, help and status keep reading the template. A fourth directory arrives the same
   way: one entry in the file, one record here.

## Consequences

- `simt plan status` names three directories, and the research plans are indexed again:
  their slices count, and a dependency may name one as `research 0003 R01`.
- Template order is index order. `research` sits between `plans` and `reviews`, which keeps
  the moved documents ahead of the reviews they depend on — the same relative order they
  had while they were in `docs/plans`.
- The tests that walk the tracker's documents (`test/rules.test.mjs`) read the template's
  directories instead of a hardcoded pair, so a future entry reaches them without an edit.
