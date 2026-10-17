# ADR-085 — The region ends with the names of what it kept out

Status: **accepted** · 2026-10-18 · filed as R12 (plan 0003)

**Affects:** `src/projection/disclosure.mjs`, `src/projection/rules.mjs`, `src/graph/spec.mjs`,
`test/disclosure.test.mjs`, `test/scoped.test.mjs`

## Context

A profile that declares a scope already leaves the always-on region when every selected
surface can load it narrowly, and the region keeps a pointer (ADR-071). A package in a
monorepo already gets its own region (ADR-066). What a reader still cannot see is an
installed skill: the body lives in its own file, and a surface with no skill channel never
mentions the name, so the reader has no reason to open it.

The plan asked for one index at the end of the kernel, one line per scoped rule and per
skill, carrying the name and the trigger. The accept is that the scoped body is absent
from what loads at session start and present in the file a matching path loads, checked
per surface.

## Rulings

1. **The index is the last section of the region, and it is one section.** Its heading is
   `## Disclosure`. A scoped profile keeps the pointer ADR-071 ruling 7 requires: the
   patterns, and the files the profile moved to. A skill keeps its name and its
   description, which is the trigger. A second heading for the second kind would spend
   region bytes on a distinction the reader acts on the same way — open that thing when
   the line says to.

2. **A skill contributes nothing but that line.** The body stays in the skill file. The
   description is read with the same frontmatter reader the skill lint uses, so a folded
   description is the sentence the author wrote and not the marker in front of it. A
   skill with no description says so and names `simt skills show`, because a line that
   invents a trigger would send the reader to the wrong file.

3. **The directories are the four a skill is installed into.** They are the directory
   `skills install` chooses and the directories a loader row records, which together are
   four and not a walk of the repository. A symlink to a skill already counted is not a
   second skill. Two different files that share a name are both listed, with the
   directory, because keeping one would hide a trigger.

4. **The index is region text, so every selected surface sees the same lines.** A surface
   that already shows a skill's name and description at session start sees the line
   twice. The alternative is a region that depends on which surface is reading it, and
   `check` would then disagree with a reader whose surface has no skill channel. The
   body is the copy that stays out. ADR-071 ruling 1 still decides the profile itself:
   it leaves the region only when every selected surface can narrow it.

5. **The index is not a candidate for a budget cut.** Cutting it would remove the only
   mention of the rules a cut had already removed. It is weighed, because it does cost
   bytes, and it is kept.

## Consequences

On a surface that can narrow, a fixture's scoped profile is absent from the region and
present in the file that surface loads when a matching path is in play. On a surface that
cannot, the profile stays in the region. That is the accept, checked by rendering each
surface rather than by driving the harness: this tool writes the file, and the harness
is what opens it.

A repository with no installed skill and no scoped profile gains no section. An empty
heading would be a line about nothing.

## Rejected

- **Putting the skill body in the region.** That is the cost the index exists to avoid,
  and it is what a surface with a skill channel already refuses to do.
- **Omitting the line on a surface that shows skill metadata itself.** The region is one
  document. A line present for one reader and absent for another is drift.
- **Truncating a description to keep the line short.** The description is the trigger. A
  shorter line that no longer says when to open the skill is a line that cannot do its
  job.
