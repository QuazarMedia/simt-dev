# ADR-049 — a ruling that a later record moved says so where it is printed

Status: accepted · 2026-10-09
**Affects:** `src/decisions/index.mjs`, `src/commands/rules.mjs`, `src/mcp/tools.mjs`,
`test/rules.test.mjs`. Closes S31 of
`docs/reviews/0002-full-review-adoption-and-public-release.md`.

## Context

Review 0002 §5 filed S31 with a measurement: `rules why ADR-023` printed the status
`accepted · 2026-10-06 · ruling 2 superseded by` and then printed ruling 2 — *"It is written
once and never rewritten"* — as a ruling in force. ADR-024 had superseded exactly that
ruling. The module header names this as its own failure mode: *"the failure mode of a
provenance feature that only proves provenance, not currency."*

Two more defects were in the same reader and neither was in the finding.

**The status is a paragraph, and it was read as a line.** `loadDecisions` matched
`/^Status:\s*(.*)$/m`, which stops at the newline. Four of forty-eight records wrap their
status over more than one line, and the one that matters is ADR-023: its second and third
lines are the whole claim — which record superseded ruling 2, and that rulings 3 and 4 were
narrowed by the same record. The parser saw `ruling 2 superseded by` and stopped, which is
a sentence with no object.

**A partial supersession could not become a whole one, and the obvious fix makes it do
exactly that.** `supersededBy` was `/superseded by \[ADR-(\d{3})\]/i` over the status.
Once the status is the whole paragraph, that pattern matches ADR-023's *"ruling 2
superseded by [ADR-024](…)"* — and `supersededBy` is the field that makes `rules why`
answer a record by printing its replacement's rulings and suppressing its own. Five
rulings in ADR-023 that the status line itself says stand would have been dropped, by the
field that exists to stop precisely that. Anchoring the match to the start of the status is
not a detail of the fix; it is the fix.

**Rulings are numbered five different ways and one of them was read.** This is the finding
that made S31's stated fix impossible as written, and it was not visible until the ruling
text was measured rather than the status line:

| Family | Records | Example |
| --- | --- | --- |
| `1. **bold**` | 17 | ADR-021 |
| `**1. prose**` | 8 | ADR-034–040 |
| `**One.**` | 7 | ADR-041–047 |
| `### 1. Title` | 4 | ADR-013–016 |
| a bare bullet list | 1 | ADR-009 |
| unnumbered paragraphs | 11 | ADR-001–012 |

Only the first was recognised. The consequences are not stylistic. ADR-045 declares six
`**One.**` rulings and printed **one** merged blob of them. ADR-013 printed the literal
string `### 2.` to an agent as though the record had ruled with it. ADR-015 lists four
resolution strategies inside `### 2.`, and the first version of the fix read three of them
as rulings numbered 1, 2 and 3. And a supersession says *"ruling 3"*: a number that cannot
be located cannot be reported as no longer in force, so annotating a ruling depends on
knowing what one is.

**`accepted` was one record's spelling, not the document's.** The check was
`status.includes('**accepted**')`. ADR-001 to ADR-020 write `**accepted**`; ADR-021 onwards
write `accepted`. Fourteen accepted records read as not accepted. This is S19's finding and
S31 names the fix; it is the sixth instance in this repository of a check that reads the
author's habits rather than the artefact.

**A section ended at a heading inside a code block.** `section()` ended a section at the
next `^## `, and ADR-007's ruling is a document skeleton in a fence whose headings are
`##`. The record kept only the lead-in — which was still longer than the minimum length,
so the test asking whether every record yields a ruling passed on a fragment.

## Rulings

1. **`Status:` is a paragraph.** It is read to the first blank line or the first sibling
   field, whichever comes first, and flattened. A sibling field is a capitalised label and
   a colon, optionally in emphasis: `Affects:` and `**Affects:**` both end it, and no
   continuation line in the corpus does. Getting the boundary wrong is not cosmetic in
   either direction — stopping early truncates the sentence that says what was overturned,
   and reading on swallows `Affects:`, whose value is a list of paths in a file read inside
   repositories that own none of them.

2. **Every field is read off the flattened, markdown-free status.** The link form and the
   bare form are then one spelling, so a record that writes `ADR-046` and one that writes
   `[ADR-046](…)` are read by the same line rather than by two patterns kept in step.

3. **A record is superseded only when its own status says so first.** `supersededBy` is
   anchored to the start of the status. See the Context: the unanchored form turns a
   partial supersession into a total one.

4. **`accepted` is read from the status.** `/^accepted\b/i` on the flattened paragraph, so
   the record's own wording is what counts and no record's habits are.

5. **A partial supersession is data, not a sentence to be parsed out of prose at print
   time.** `partial: [{ruling, kind, by}]`, one entry per ruling a later record moved, in
   three kinds the corpus uses — `superseded`, `narrowed`, `withdrawn`. A ruling a later
   record names is printed with the fact attached, in place: *(superseded by ADR-024)*.
   `ruling: null` is a record that says "one ruling" without saying which — a fact about the
   record, carried rather than guessed at — and `by: null` is "the same record" in a status
   that has not named one. Neither is resolvable, and neither is silently dropped.

6. **"The same record" resolves to the last record this status named.** ADR-023 uses it for
   rulings 3 and 4 immediately after naming ADR-024 for ruling 2. Resolving it to nothing
   would drop two of the three supersessions on the one record this slice is about.

7. **A ruling's identity is its number, and a section has one family.** The family is read
   off the first line that looks like any of the six, and that family alone opens a ruling
   for the whole section. One family per section is what keeps a list *inside* a ruling
   inside it, which is ADR-015's four resolution strategies and ADR-013's four bullets.
   A blank line does not close a ruling, because a record's parenthetical about its own
   rulings sits between them. The heading marker and the bullet are structure and do not
   survive into the text.

8. **A section ends at the next heading, but not at one inside a fenced block.** The fence
   marker is structure; its contents are not, and ADR-007's ruling is entirely inside one.

9. **`summary.rulingNumbers` is exported.** It is the join between a supersession and the
   ruling it moves, and nothing else observes it. The `**One.**` ordinal was dropped in
   testing — one line of code — and **every test passed**, because no record in the estate
   has both a word-numbered ruling and a partial supersession. That is ADR-042's failure
   (a declared value nobody executes) inside a fix whose subject is a declared value
   nobody executes, and the field is exported so the next such mutation has something to
   fail against.

## Consequences

- `rules why` prints a `partial` line naming every ruling the record lost, because two
  rulings are printed and a record may have six: ADR-021's overturned ruling is the third,
  so the annotation cannot reach it and the status line is all that is left. The same fact
  appears twice by design — once as a line, once on the ruling — because the two print
  different sets, and one copy could not cover both.
- The JSON payload gains `partial` and `summary.rulingNumbers`, and `rules_why` over MCP
  carries `partial`. Both are additive; `ruled` stays a list of strings, because three
  surfaces read it and the annotation is attached to the text rather than beside it.
- `supersedes` no longer reports ADR-046 as superseding ADR-021. It supersedes *ruling 3*
  of ADR-021, which is `partial` on the other record. A whole-record supersession is the
  rarer case and the one that has always been reported.
- `accepted` is now true for fourteen records that were false. Nothing in this repository
  reads the field outside `rules why --json`, where a caller asking "is this in force?" was
  being told no about records that are.

## Rejected

- **Model the backward direction too — `supersedes ADR-021 ruling 3`,
  `amends ADR-017 ruling 1`, `refines ADR-013 ruling 1`.** Rejected under ADR-002, with
  the evidence attached: the same edge appears in both records, the passive side is the one
  that must not print a ruling as in force, and parsing only the passive side is what makes
  the anchoring in ruling 3 cheap. The active side is a reader convenience, not a safety
  property, and it would need the `Affects:` paragraph as well as the status because
  ADR-024, ADR-026, ADR-027 and ADR-028 all state it there.
- **Rewrite the forty-eight records to one spelling.** Rejected: the parser reading five
  shapes is one function; reformatting every record is forty-eight edits to evidence, and
  the `**accepted**` half of the problem was a one-line fix in the reader.
- **Number the rulings in ADR-016 so `ruling: null` disappears.** Rejected: ADR-045 says
  what it narrows, and ADR-016's narrowing targets a bullet in its `Consequences` section
  rather than one of its six numbered rulings. There is no number to write.
- **Print every ruling rather than two.** Rejected under ADR-002: it changes the output size
  of every `rules why` in every repository, and no measured defect needs it. A ruling past
  the excerpt cannot mislead a reader who is not shown it; the `partial` line is what makes
  it knowable.