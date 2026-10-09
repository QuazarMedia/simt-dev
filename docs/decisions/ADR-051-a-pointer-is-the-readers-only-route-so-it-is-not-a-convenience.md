# ADR-051 — a pointer is the reader's only route, so it is not a convenience

Status: accepted · 2026-10-09
**Affects:** `src/projection/project.mjs`, `src/projection/targets.mjs`,
`src/commands/sync.mjs`, `test/surfaces.test.mjs`. Closes S09 of
`docs/reviews/0002-full-review-adoption-and-public-release.md`.

## Context

`pointer-drift` was in `NON_BLOCKING`, with a comment saying a misaimed `CLAUDE.md` is *"a
smaller problem than a red gate on every commit: the editors that matter already read
AGENTS.md, and the pointer is a convenience."* The first half is true and the second half
is the defect. Reproduced on a repository that had adopted and then had its pointer moved
to `README.md`:

```
check     exit 0, three files CURRENT
compare   problems 0 repos
CLAUDE.md # readme
AGENTS.md 13 rule citations, none of them read
```

Claude Code's own documentation, quoted in this repository's `POINTERS[0].verified`, says
**"Claude reads CLAUDE.md by default and AGENTS.md only as a fallback."** On a repository
that selected the `claude` surface, a pointer aimed elsewhere means the reader for whom the
rules were written is reading something else — and the gate said nothing. This is the same
shape as ADR-018's *"an unset hooks path is not an absent hook"*: the file exists, so the
thing that reads it is satisfied, and nothing reports that it is reading the wrong bytes.

The comment's reasoning came from a real observation about a **different** surface.
DeepSeek's loader renders a drifted *copy* in full beside its twin, which is duplication.
A *symlink* aimed elsewhere is not duplication — it is a reader looking at the wrong file.
The old test named DeepSeek and asserted the asymmetry, so the belief was written down and
the finding it produced was, by construction, unable to see.

A second defect, not in the finding: `pointerState` classified a path as a symlink, a
regular file, or **absent** — three answers, and a directory matched the third. A directory
at `CLAUDE.md` is not hypothetical: it is where Claude Code keeps per-project instructions.
Measured:

```
check    says nothing at all
sync     ERROR 1 EEXIST: file already exists, symlink 'AGENTS.md' -> 'CLAUDE.md'
         REMEDY run: simt-dev doctor
```

`EEXIST` fires *after* every other target is written, so the run left a half-migrated
repository, and the remedy it offered reports nothing about a directory. The reason it was
invisible for as long as it was: the note that would have said so printed
`POINTER CLAUDE.md: a directory, not a pointer (undefined bytes)`, and `undefined` in a
report reads as nothing at a glance.

## Rulings

1. **A misaimed pointer blocks `check` when its reader is a surface this repository
   serves.** The gate is where the exit code lives and where CI runs. A pointer whose
   surface was not selected is not reported at all: the reader it serves is not reading
   this repository, and a gate that reddens for it is a gate people learn to ignore.

2. **The finding names the reader.** The remedy is `simt-dev sync --yes (Claude Code reads
   CLAUDE.md, not AGENTS.md)` — because "run the command" does not tell a reader why this
   matters, and a warning that has been learned to skip is worse than no warning.

3. **`pointer-unread`, not `pointer-drift`.** The name is the reader's word for it: the
   pointer is present and unreadable *as the thing it is for*. `pointer-drift` named the
   defect as staleness, which is a file's problem, and that is how a reader-blindness
   arrived at a file-scoped non-blocking rule.

4. **`sync` does not block on it and `check` does, and they are two sets.** The remedy is
   `sync --yes`; a `sync` that refused on this finding would be a gate whose remedy is the
   command being run, which ADR-025 ruling 6 calls worse than a noisy gate. `check` is the
   gate CI runs and the one whose exit code a repository acts on, and there the finding is
   the defect.

   This was the finding of the slice, and it was found by rendering the output rather than
   by reading the code — the same acceptance `AGENTS.md` sets for rule text. **The first
   version of this fix kept one `NON_BLOCKING` set** shared by both commands, on the
   reasoning that the writer's rule was the correct one. So `check` exited 0 on the exact
   repository this record exists to fix, and a test asserting `check` exited 1 **passed** —
   on a bare scratch directory that was red for a missing `AGENTS.md`. One set covering both
   commands is how the defect survived the first time, which is the sentence worth keeping:
   the rule was written to keep `sync` quiet and quietly quieted `check`'s exit code too.

   Two sets, both asserted, and the relationship between them asserted as well: everything
   `check` tolerates, `sync` tolerates. The gate is never the laxer one.

5. **A directory is `foreign`, and its measure is entries.** `stat` distinguishes a
   directory from a file before anything is read, because reading a directory as utf8
   throws `EISDIR` and the old catch reported that as *absent* — the one answer that hides
   it. The size reported is what would be lost: bytes for a file, entries for a directory.

6. **`sync` repairs a misaimed pointer, because it is the remedy `check` prints.** The
   pointer is this tool's own output, it is a symlink so it carries no content, and
   `symlink()` at an existing path is `EEXIST` — which is what happened, after every other
   target was written, with `simt-dev doctor` named as the remedy and `doctor` reporting
   nothing about it. A command whose own remedy crashes on the state it names has no
   remedy at all. Only a symlink is unlinked; a regular file or a directory never entered
   the plan, so the repair is keyed on the pointer's **state** and not on the path
   existing.

## Consequences

- `SYNC_NON_BLOCKING` and `CHECK_NON_BLOCKING` are two exported sets, and both are asserted
  as sets *and* as a relationship. Three mutations passed the whole suite before that: `check`
  keeping the finding non-blocking (the defect), `sync` dropping it (the ADR-025 hazard), and
  the gate reading the writer's set. The text output is identical in all three, which is
  ADR-035's sentence about promises about a *set* of commands, applied to a set of statuses.
- Two tests asserted a gate that was red for the wrong reason, and both are fixed the same
  way: "a pointer this repository does not serve stays a note" and "check blocks a mispointed
  pointer" checked `check` on a bare scratch directory, which is red for a missing
  `AGENTS.md`. Both now sync first, so the only thing that can redden the gate is the
  pointer. ADR-031's shape, one level down — and the second instance is the one that matters,
  because it was the test written *for this fix* that passed against the defect unfixed.
- `sync` keeps its note-and-continue for a foreign pointer, and now says what kind of thing
  is in the way. It repairs a *misaimed* one, and the test asserts that the file the bad
  link pointed at survives — because the repair is a deletion, and a test that only checked
  the link now points where it should would pass if `unlink` had removed the wrong thing.
- The corpus test that encoded the old belief was **replaced, not amended**, and its
  comment now records what it got wrong and why the observation it was built on does not
  transfer.

## Rejected

- **Blocking on a misaimed pointer for every repository.** Rejected: `pointerTargets`
  filters on the selected surfaces, and a repository on `opencode` that has a stray
  `CLAUDE.md` gains nothing. The scoping is not a compromise; it is the same rule the
  pointer table already encodes (ADR-021 ruling 1: a pointer belongs to the surface that
  needs it).
- **Writing the pointer anyway when it is misaimed.** Rejected: `symlink()` over an
  existing path is `EEXIST`, and unlinking a path someone may have pointed deliberately is
  a deletion this tool does not do (ADR-021 ruling 6).
- **Treating a directory as `pointer-blocked` with a byte count of zero.** Rejected: the
  count would be a number the reader cannot use, and the report says what is in the way so
  a person can decide.