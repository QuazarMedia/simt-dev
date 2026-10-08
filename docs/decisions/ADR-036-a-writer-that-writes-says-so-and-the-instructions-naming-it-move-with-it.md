# ADR-036 — A command that writes says so, and every instruction that names it moves with it

Status: **accepted** · 2026-10-08 · affects `sync`, every remedy naming it, and the
generated-region note shipped into every consumer repository

## Context

ADR-035 gave the command surface one write decision — `writeMode(flags)` — and
deliberately left `sync` alone, recording the omission twice: in its consequences ("it is
review 0002's S24 and stays queued") and in its rejected list ("it is a real inconsistency
and it is someone else's slice"). The reasoning was sound then. S24 depends on S10, so
making the gate part of S10 would have made the prerequisite half of the change it
prerequisite'd.

Measured against the shipped binary, `sync` was the last writer writing by default. A
fixture repository was adopted with `--yes`, a stray line was then inserted inside its
generated region, and a bare `simt-dev sync` **rewrote the file**: the stray line was gone
and the file was 14 bytes shorter. It reported success, because it had done what it was
built to do. Among the six writers in the surface, the other five preview unless told
otherwise, so this was also the only command where an agent that had learned the
interface would pattern-match onto the wrong behaviour — the preview was opt-in by command
line and opt-out by habit.

The second finding was less comfortable. Twenty-six places in `src/` name `simt-dev sync`
in a remedy, and two of them are not printed to a terminal at all: the note inside every
generated region, which ships into every consumer's `AGENTS.md`, and the `$comment` in
every consumer's manifest. Both instruct the reader to run the command that regenerates the
text they are looking at. Changing the write gate without changing them would have shipped
an instruction that is no longer true — and it would have shipped it *to the repository
being written*, which is precisely the reader with no other context. A gate that only
protects the tool from itself is not a gate on what the tool says.

## Ruling

**1. `sync` decides whether to write through `writeMode(flags)`, like every other writer.**
Not its own condition, and not a check of `--check` and `--dry-run` read separately. ADR-035
already ruled that a second copy of the decision is a defect whether or not its arithmetic
agrees today; this is the copy.

**2. A bare `sync` is a check that prints the plan, and a check that finds drift exits
non-zero.** It exits 0 only when nothing would change, which is what lets a caller run
`sync` in place of `sync --check` and get the same verdict. The preview names the command
that applies it. Exiting 0 after reporting a change would be the one-question-two-answers
shape ADR-035 exists to prevent, reached from the opposite direction.

**3. `--json` agrees with the exit code, as it must.** `ok` is `false` on a previewing run
that found work, `written` is `0`, and `dryRun` is `true`. `written` used to be a boolean
and is now a count, because a preview that says "nothing written" in a field typed as a
flag cannot distinguish "no changes" from "changes withheld".

**4. Every string that names the command moves with the behaviour, including the ones that
ship.** The region note, the manifest comment, all 26 remedies, and the help synopsis.
This is the part that is easy to skip and expensive to miss: the two shipped strings are
compared by `upgrade` and written into files the reader owns, so a change to the gate with
no change to them leaves a permanently-false instruction in every repository in the estate.

**5. The test asserts the flag, not the command.** The existing guard read
`/simt-dev sync/` and passed identically before and after this change — it could not have
prevented the defect it appeared to cover. It now reads `/simt-dev sync --yes/`, and a new
test walks `src/` for any occurrence of the bare spelling so the next command to grow an
authorisation flag cannot inherit twenty-six no-op remedies unnoticed.

## Consequences

The contract table in `test/contract.test.mjs` gains a `sync` row, which is the row that
would have caught this defect: every writer is asserted to leave the filesystem
byte-identical without `--yes`. `sync` needs stale region bytes rather than a stale pin,
because what it writes is the region and the pin was already current — a fixture that
staled the wrong file would have passed a `sync` that wrote nothing for the wrong reason,
which is the shape ADR-031 rules out. For `sync` alone the unauthorised case also asserts a
non-zero exit, because the byte comparison alone passes on a preview that returned success.

Three mutations were applied and reverted, each caught by its own test: the write gate back
to reading `--check` and `--dry-run` directly, the preview back to exiting 0 on drift, and
one remedy back to the bare spelling. The third matters most — it is what proves the
remedy test sees individual occurrences rather than the template literal around them.

One item in this slice's spec could not be done. It asks for a CHANGELOG entry, and there
is no CHANGELOG in this repository; the row that would add one is queued as S18 and is
named as its dependency here rather than created, because inventing the file would settle
a question S18 has not been closed on.

## Rejected

- **Keep `sync --check` as the only no-write mode and teach the difference in help text.**
  Two spellings for one behaviour means every caller has to know which one it wants, and
  the one that writes by default is the one a caller reaches for. Help text is not a gate;
  it is only evidence that a gate was considered.
- **Make `sync` preview only when it detects a non-interactive caller.** The tool cannot
  tell an agent from a terminal, and the argument for the flag is that guessing wrong
  destroys work — which is not a cost worth paying for a convenience nobody asked for.
- **Exit 0 on a preview so that existing scripts keep passing.** This preserves callers
  that were checking whether `sync` *ran*, not whether the repository was *current*. The
  second is the question every one of them was actually asking, and the answer was `ok:
  true` while a file was rewritten.
- **Update only the terminal output and leave the shipped region note and manifest comment
  alone, since they are documentation.** They are the only copy of the instruction a
  consumer repository's reader ever sees. Changing them is the whole second half of this
  slice.
- **Fold this into ADR-035 by editing its ruling in place.** ADR-035 is accepted and its
  rejected list names this exact change as someone else's slice. Rewriting the ruling would
  erase the evidence that the omission was deliberate, and a reader diffing the two
  records would have no way to tell which writer had been considered.