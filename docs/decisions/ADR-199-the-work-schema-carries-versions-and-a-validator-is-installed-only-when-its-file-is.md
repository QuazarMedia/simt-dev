---
simt-affects: ["src/work/config.mjs", "src/work/effective.mjs", "src/work/capabilities.mjs", "src/work/facets.mjs", "src/work/artifacts.mjs", "src/manifest/schema.mjs", "src/commands/work.mjs", "test/work-config.test.mjs", "test/work-artifacts.test.mjs", "test/work-capabilities.test.mjs", "test/work-facets.test.mjs"]
simt-supersedes: [{ adr: "ADR-144", ruling: 1 }]
---
# ADR-199 — the work schema carries versions, and a validator is installed only when its file is

Status: accepted · 2026-11-19 · supersedes ADR-144 ruling 1

## Context

Plan 0006 starts from two findings about the same door. `work inspect` reported a declared
validator as available even when the executable it named did not exist, and it reported a
configured scope's artifacts from a bounded sample of file names rather than from the
declaration the maintainer wrote. Both are the same defect in different words: the answer
was derived from what the tool could see, and the repository's own statement was decoration.

Two smaller faults came with them. A scope path was compared as written, so `./docs` and
`docs/` were two trees and neither was the one the resolver ranked. And the schema admitted
exactly one version, which meant the first new field would be a breaking read for every
repository already writing a declaration - the reader would be told the tool had never heard
of the field, not which version carries it.

## Rulings

1. **`work` carries a set of versions, and a field names the version that carries it.**
   Version 2 adds `scopes[].ignore`. A version-1 declaration stays readable with every field
   it had; a version-2 field used under version 1 is refused at its own path
   (`work.scopes[0].ignore`) with the version bump as the remedy. An unknown version is still
   refused outright.

2. **A path declaration is repository-relative and has one spelling.** `.` and `''` are the
   repository root; a leading dot segment, a repeated slash and a trailing slash are
   spellings and not distinct locations, so two scopes that differ only in one of them are a
   conflict rather than two scopes. An absolute path or a parent segment names something the
   repository does not own and is refused with the field and a remedy, never trimmed into
   something that resolves.

3. **A validator is installed only when the file it names is in the repository.** The probe
   reads the command's file arguments - not its program, which lives in the shell's PATH - and
   answers `true` (every named file exists), `false` (one is missing or resolves outside the
   repository) or `null` (it names no file, so the tree cannot tell). Nothing is executed: a
   read-only inspection may not run a check in order to look green.

4. **A configured scope is the authority on what it holds.** A facet's kind carries its basis:
   `declared` when a scope says so, `inferred` when a bounded sample guessed from file names. A
   declared kind survives a corpus the sampler does not recognise (`handbook/*.rst` declared as
   `document` is documents), and an invalid declaration decides nothing - the same rule ADR-144
   applies to targets, now applied to scopes.

5. **One reader.** `readWork` loads the manifest, validates once, and exposes normalized
   scopes, targets and adapters - or none of them when the declaration is invalid. A caller
   that wants work configuration does not parse `manifest.work` itself, because the three
   readers that used to each read it disagreed about what an invalid declaration meant.

## Consequences

- `work inspect` gains `scopes`, `validators` and `next`. `next` is the one actionable step:
  an unconfigured repository is told which key to add and which command reads it again, so the
  inspection ends in an action rather than a wall. No reader loses a field it had.
- The structural capability card can now say `available: false` for a declared validator whose
  file is missing, and `available: true` only when something it names is not known to be
  absent. A declared command remains `declared`, not `observed` (ADR-142): the probe proves
  the file exists, never that the check passes.
- A facet row reports `basis`, so a reader can tell a declaration from a guess.
- Version-1 declarations keep working. The next field that arrives needs a version-3 gate in
  `FIELD_VERSION`, not a rewrite of the parser.

## Rejected

- **Keep one exact version (ADR-144 ruling 1).** Every new field would break every existing
  declaration at read time, and the message the maintainer received would be about a word the
  tool did not know rather than about the version that could carry it.
- **Treat an unprobed validator as installed.** That is the reported failure: the card says
  the check exists because the manifest mentions it. An unprobed validator is `null` - unknown
  - and only a probe can lower it.
- **Execute the validator to find out whether it works.** A structural inspection that runs a
  check is not an inspection, and the plan's boundary is explicit: no validator runs during
  setup, selection, preview, sync or a read-only query.
- **Let the sample keep deciding for a configured scope.** Two authorities for one question is
  how a corpus of `.rst` pages reports as no documents at all.
