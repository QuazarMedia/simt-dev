# ADR-064 — The context meter counts what the tool wrote, and says what it did not

Status: **accepted** · 2026-10-13 · filed after review 0002 S38

**Affects:** the `tokens` command, the new context meter in `src/measure/context.mjs`, and
the structure field `readLimitFindings` now returns.

## Context

Review 0002 S38 measured the estate by hand and filed a number: 90,042 bytes of always-on
context per turn across seven workspace roots, of which 64,738 bytes — 72% — were a
paragraph an earlier root had already loaded. It also found a repository whose region
ended past the 32,768 bytes Codex reads before it stops.

Two things are wrong with a finding that arrives as a hand count. The count ages: the
moment a rule is edited, the number is a description of a version nobody has any more.
And it cannot be re-derived by the reader who has to act on it — it was produced by
reading seven repositories, which is the work the tool exists to do.

Plan 0003 R06 asks for the same measurement as a command, with an acceptance criterion
that names the figures it must reproduce: the 90,042 bytes, the 64,738 redundant, and a
repository beyond Codex's limit. Reproducing a hand count is only possible if the meter
counts what the hand counted — which means settling what "always-on" means before
writing the code, because every choice here changes the number the criterion will be
checked against.

The answer is the hardest question in the command, and it is not "bytes".

## Rulings

1. **The meter counts what this tool wrote, and reports hand-written bytes beside it
   rather than folding them in.** The budget being defended is the projection's: a
   repository's own 40 KB of prose in AGENTS.md is an authoring decision the tool did not
   make and cannot shrink. Billing it to a projection budget would make the budget
   unachievable for reasons outside the projection, which is how a budget stops being
   read. So every channel reports `generatedBytes` and `readerBytes` separately, and the
   headline figure is the generated one.

2. **A token count is an approximation, and it is labelled as one every time it is
   printed.** Four bytes per token, stated in the payload and in the text, with a `~`
   in front of the number. Nobody has measured this corpus, and a figure that looks exact
   invites the reader to spend it as though it were.

3. **A region is the span between its two markers, and nothing outside it counts as
   generated — not even the blank line above the marker.** This is the defect the first
   test run caught: subtracting the hand-written prefix from the file billed the
   projection for a newline a person typed. In a command whose whole claim is that it
   counts exactly, that byte is the whole argument.

4. **Redundancy is byte-exact, blank-line-paragraph by blank-line-paragraph, measured
   across roots in sorted path order.** That is the method review 0002 used by hand, and
   it is reproducible: the same corpus measured twice gives the same figure, which is
   what lets the number appear in a commit message. Order is therefore load-bearing —
   `discover` sorts, and the first root to carry a paragraph owns it. Reordering the walk
   would move bytes between roots, so nothing downstream re-sorts them.

5. **The budget is reported, not enforced, and the command exits 0 for it.** A
   repository over budget is a fact about the repository. A meter that went red for it
   would train people to ignore the number it exists to print. Enforcement is R08's
   business, and it is a manifest field rather than a constant so a repository can argue
   with its own budget.

6. **A pointer is counted once, as the file it points at.** One reader, one copy of the
   text; enumerating the target as well would double every rule the projection replaced
   with a pointer, which is precisely the saving the pointer was made for.

7. **MCP `tools/list` bytes are reported once, outside every repository total.** The
   same tool list is loaded whatever the repository, so summing it into each root would
   multiply one number by the number of roots and call the result a workspace cost.

8. **The flag is `--repos`, not `--workspace`.** Plan 0003 R06 wrote `--workspace`, but
   `--workspace <path>` has been a value flag since plan 0002, where it names a
   directory of skill sources. One flag cannot mean two things depending on which
   command read it — that is the silent-ignore defect the argument parser's own header
   refuses — so the new one is `--repos`, and it says what it measures: every repository
   under the root, in sorted order.

9. **No MCP tool exposes this yet.** The byte counts are already in the payload, but a
   tool that returns a per-repository context cost is a second public surface to keep
   honest. It arrives when there is a second caller for the logic to be wrong in.

## Consequences

- `simt tokens` answers "what does a turn pay for this repository", and
  `simt tokens --repos` answers "what does a turn pay for the workspace". Both print
  bytes and a labelled approximation; `--json` carries the same figures, because two
  renderings of one question must not be able to disagree (ADR-050).
- The command refuses two shapes of path — a directory holding repositories when
  `--repos` was not passed, and a directory holding none — with remedies that are
  commands rather than locations.
- `readLimitFindings` grew structured fields (`reader`, `limitBytes`, `endByte`,
  `overBy`) beside its prose, so the meter and the check that already reported the
  Codex limit are reading the same numbers rather than each re-deriving them.
- S38 stays open. What landed is the instrument. The 30 KB figure it wants needs R07's
  kernel, R08's budget field, R11's dedupe, and R01–R05's evaluation of whether moving
  the process rules behind skills costs compliance — and this meter's job is to report
  whether that work succeeded.

## Rejected

- **Failing the run when a repository is over budget.** The measurement would become
  something people route around, and the number would go with it.
- **Treating a pointer as free rather than counted once.** Its target is still loaded;
  calling that zero is the sort of accounting that makes a report unfalsifiable.
- **`--workspace` for the new flag, on the grounds that the plan says so.** The plan
  wrote that before `--workspace` was a value flag for something else, and a plan is a
  record of an intention, not a reason to ship two meanings for one name.