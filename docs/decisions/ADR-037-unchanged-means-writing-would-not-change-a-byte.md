# ADR-037 — `unchanged` means writing would not change a byte, not that the body matches

Status: **accepted** · 2026-10-08 · affects every generated region, in every file style

## Context

Review 0002's S29 reported that a region appended after a single newline fails
`prettier --check`, and pointed at `markers.mjs:232`, the `absent` branch. Measured against
the shipped binary, that branch was already correct: it inserts the blank line, and its
output passes `prettier --check` unchanged.

The defect was two branches over.

**The seam in `splice` had no blank line.** Every fixture built by putting a region into a
document that already had one — a paragraph, a heading, a list, a fenced block, a
blockquote — came back rewritten by Prettier 3.8.1, and `--check` exited 1 on every one.
The list case is worse than a missing blank line: with no gap, Prettier reads the region as
a continuation of the last list item and indents all of it, so the repair is not one byte
but a reindent.

**A body that matched behind a wrong seam was reported `unchanged`.** The comparison was on
the region body alone, so a file whose body was correct and whose seam was not produced no
drift. `check` found nothing, `sync` had nothing to rewrite, and the repository stayed red
on its own formatter with no remedy this tool offers. This is the shape ADR-034 and
ADR-036 both exist to prevent, and it is why the second half of the fix mattered more than
the first: without it, the seam fix would have applied only to files whose body happened to
change, and every already-adopted repository would have kept a seam nothing would repair.

Measured end to end: a repo whose region body is current and whose seam is wrong exits 1 on
`check`, `sync` rewrites 11,217 → 11,218 bytes, Prettier is then satisfied, and `check`
exits 0.

## Ruling

**1. `seam(before)` is the one place the separator is decided.** It normalises whatever
follows hand-written text to a blank line, and returns `''` for an empty document so a new
file does not open with a blank line. The `absent` branch had a hand-rolled equivalent that
agreed with it exactly; keeping both would have left the next reader looking at the branch
that looks wrong and is not.

**2. `unchanged` means writing would not change a byte.** Not that the body matches. The
question `sync` asks is whether it has anything to write, and a file whose seam disagrees
has something to write even when its body does not.

**3. Top placement is exempt from the byte comparison, and the reason is recorded.** There,
`splice` is a repair: it moves a region that sits below the file's own settings back above
them, which moves bytes outside the markers by design. A misplaced region is reported by
`check` as `misplaced` with its own remedy, and re-laying-out the file there was correct
before this change and stays correct. Making the exemption explicit is the point — the
alternative is to discover the reason by breaking `baselines.test.mjs`.

**4. A repair must settle.** After `sync` rewrites the seam, the next run reports
`unchanged` byte for byte. A rule that reports drift on a file nobody has touched is a
defect with the sign flipped, and the test asserts the second run rather than the first.

**5. The assertions are about bytes, not about Prettier.** Prettier cannot be a dependency
of this package (ADR-012), so the tests state the shape the formatter requires and cite the
measurement in a comment. Every fixture in the seam table was run through
`prettier --check` before the assertion was written, and every one failed.

## Consequences

`test/markers.test.mjs` gains two tests. The first walks six shapes of preceding text and
asserts exactly one blank line — not a run of them, because a formatter collapses those
and `check` must not manufacture drift out of a file nobody touched. The second covers the
`unchanged` verdict, which no formatter-shaped assertion could reach.

The second test was itself wrong on its first version and a mutation found it. It built its
fixture from a hand-written region that lacked the do-not-edit note, so the body genuinely
differed — meaning it passed with the byte comparison removed, while claiming to police it.
It now builds the fixture from a real composed region and deletes the blank line, which is
the file the defect actually produced.

Two mutations were applied and reverted, each caught by its own test: `seam` reduced to a
single newline, and the byte comparison dropped from the verdict.

The second half of the spec's acceptance — the pack-install test running `format:check` in
a fixture that has Prettier — belongs to S20 and is not done here. S20 is the row that
stages a packed install, and a test that needs Prettier cannot live in this package.

## Rejected

- **Fix only the branch the review named.** It is already correct. The finding was measured
  against the shipped binary before anything changed precisely because a plausible line
  number is not an observation, and stopping there would have shipped a no-op and closed the
  row.
- **Leave `unchanged` comparing the body, and let `check` ignore the seam.** Then the seam
  fix only helps a repository the first time its rules change, which is the one moment
  nobody is reading. The other half is the defect.
- **Have `check` report the seam as its own finding rather than as drift.** A formatter is
  not a consumer of this tool's verdict; the bytes are simply wrong and `sync` fixes them.
  A second status for one wrong byte gives the reader two questions to ask about it.
- **Compare bytes for the `top` style too, and re-lay-out its splice to match.** That is
  the change that would have broken a misplaced region finding. Re-laying-out a file to
  match a formatting rule is a move onto somebody else's territory, and the region moving
  home is the only reason those bytes are the tool's business.
- **Ship Prettier as a devDependency so the seam table can assert against the real
  formatter.** ADR-012 rules it, and the rule this record settles is expressible in bytes:
  which is the same reason the projection emits the formatter's shape rather than calling
  it.