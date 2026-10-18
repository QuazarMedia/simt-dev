# ADR-093 — why names what governs a file

Status: **accepted** · 2026-10-18 · filed as R25 (plan 0003)

**Affects:** `src/index/govern.mjs`, `src/commands/why.mjs`, `test/why.test.mjs`,
`test/why-fixture.test.mjs`, `test/why-snapshot.test.mjs`

## Context

A decision says which files it governs in an Affects line. The line is prose.
It wraps. It names a command, a path from the repository root, a path from a
source directory, or a phrase that is not a location at all. A reader who
greps the word Affects still has to decide which of those a backtick was.

Rules, skills, gates and lessons name paths in their own way. The question
`why` answers is the same for each: does this one govern this file?

## Rulings

1. **The Affects line contributes the tokens in backticks, and nothing else.**
   Continuation lines are part of the paragraph. A blank line, a heading, or
   the next field ends it. The token is resolved in order: a command prefixed
   with the tool name, when that command exists; a path or a glob at the
   repository root; the same path under each directory named src. The tool
   name alone is not a command. A token that is none of these is reported as
   `UNRESOLVED-AFFECTS`, with the record it came from. It is not dropped and
   it is not guessed.

2. **The other governors are the path lists they already publish.** A rule
   governs a file its scope matches. An applies entry governs a file only when
   the entry is itself a path. A skill governs a file its paths match. A
   staged gate governs a file of an extension it formats, and a manifest
   command governs a file it names. A lesson governs a file its trigger names.
   A missing lessons directory, a missing skill registry, or a missing
   manifest is an empty list.

3. **The answer is computed when asked, and not stored.** The file list is
   the paths git tracks. Writing the index to answer the question would change
   the tree the question is about.

## Consequences

`simt why <path>` prints one line for each decision, rule, skill, gate and
lesson that governs that path. `simt why` with no path prints the unresolved
Affects tokens. A path git does not track is a usage error. A directory that
is not a git repository is unsupported.

On the tree at 4c27514, sixteen Affects lines were the whole set, and the
only record naming the dispatcher was ADR-017. Records written after that
commit name it as well, and `why` lists those too.

## Rejected

- **Attaching every always-on rule to every file.** The rule governs the
  repository. Listing it on each file would hide the ones that actually name
  the file.
- **Treating an unresolved token as a path that might exist later.** The
  report is the point. A guess would make the report empty.
