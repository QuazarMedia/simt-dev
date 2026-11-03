---
simt-affects: ["src/actions/review.mjs", "test/action-review.test.mjs"]
simt-supersedes: []
---

# ADR-179 — a review bundle says which of three states it is in, and promotion is a new intent

Status: accepted · 2026-11-03

## Context

A remote change should be reviewable with the discipline of a code diff, and each shortcut around
that has already gone wrong:

- a reviewer could not tell whether a bundle was planned, applied or verified;
- a bundle was imported into the wrong target, or applied against a revision it had never seen;
- promotion copied environment-local ids into another environment;
- promotion reused the approval of the intent that had run somewhere else;
- a remote mutation was hidden inside a push, a tracker update or a documentation change.

## Rulings

1. **Three states, forward only.** `planned`, `applied`, `verified`. Results are appended; appending
   to a verified bundle is an error rather than a fourth state.

2. **The bundle is the review.** Contract commit, redacted semantic delta, target class and
   incarnation, resource mappings, before revisions, authorization scope, postconditions and
   residual risk. `checkBundle` names what is missing, including the receipts an applied bundle
   needs, so a reviewer can decide from the artefact alone.

3. **A bundle mutates nothing.** `mutates` is false by construction: it is an artefact, not an
   executor, and no remote mutation is hidden inside `git push`, `plan done` or a documentation
   update.

4. **Promotion is a new intent.** It requires another target incarnation, its own authorization,
   and re-resolved mappings. A same-target promotion, a missing authorization, a lossy bundle and a
   raw environment id are all rejected with their reasons, and an unmapped logical reference is
   reported rather than dropped.

5. **A lossy bundle cannot justify whole-object replacement.** It describes the fields it read, so
   carrying it into another environment would delete what it never saw.

## Consequences

- The bundle is a value with a digest and no clock, so a prospective bundle and the applied one can
  be diffed.
- The source-only PR body is untouched: remote evidence is an optional extension, not a new
  requirement on code work.
