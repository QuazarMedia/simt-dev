# ADR-055 — A status line travels, so it may not name a location; prose is the record's own argument

Status: **accepted** · 2026-10-10 · filed as S54 · affects `src/decisions/index.mjs`

## Context

`rules why` prints a decision record's `Status:` line into whatever repository the reader
is standing in, and most of them are repositories that adopted simt-dev and therefore own
none of this package's files. The `summarise` contract said so itself, in the module that
produces the output: *"Never contains a path, because a record read inside a consumer repo
cannot name one."*

The `ruled` half honoured that. The `status` half did not, because it is the record's own
prose: five records wrote `· affects src/resolve/resolve.mjs` into a field the tool parses,
copies and prints verbatim on every `rules why`, `rules show` and MCP call. The review
measured this as "two records out of forty-eight, pre-existing". The corpus says **five**,
and **three of them were written after that measurement** — ADR-053 and ADR-054 in this
cycle, and ADR-041 days earlier. A finding that grows while it is being fixed is a finding
whose real cause is a convention rather than a typo, and the convention is what needed
ruling.

The convention was ADR-038's: *"That is what the `Affects:` line on a record is for."* Five
records had an `Affects:` field available and put the clause in `Status:` instead — because
`Status:` is the line the tool reads, so putting it there feels like the place that counts.
It is the opposite: it is the one field guaranteed to travel.

## Ruling

**One. A `Status:` line may not name a location.** It is this tool's own metadata — accepted,
the date, what superseded what, what it affects — and every clause in it is a statement about
*this package* by construction. There is no benign reading to confuse it with, so the
predicate needs no judgement: a location resolving at this package's root is redacted to a
phrase naming the thing rather than the path. The redaction happens once, in `loadDecisions`,
so the text command, the JSON payload and the MCP surface cannot disagree about it — which is
the same "one place decides" shape ADR-035 settled for writers.

**Two. `Affects:` is where a location belongs, and it stays unprinted.** The loader already
stops the status paragraph at a sibling field, so moving the clause is a reformat rather
than a change of ruling, and the five records are corrected in place for the clause only.

**Three. The exempt list is what `init` writes, and it is executed.** Dot-entries and three
named files (`AGENTS.md`, `package.json`, `simt-dev.json`) are excluded from redaction,
because a repository that adopted simt-dev has them. That is a claim about a set held in a
comment, and a claim about a set held in a comment is a value nobody runs — so a test adopts
a repository and asserts that every top-level file the tool writes survives the predicate
unchanged. A name that drifts on stops being redacted; a name that drifts off starts
redacting a file the reader does have.

**Four. Prose is the record's argument and is left as written.** The `ruled` and `rejected`
excerpts are a human argument, and they may legitimately quote a location — `docs/plans/`
means *this package's* plan in one record and *the reader's own plans* in another, and no
amount of reading the string separates them. Redaction there would have to guess, and a
guessed redaction makes a correct sentence wrong, which is the worse defect. `redactEstate`
redacts prose and is not a counter-example: an estate repository name is never the reader's
business either, whereas a path inside an argument sometimes is.

**Five. The cost of ruling four is a number, not a shrug.** Seven records still print a
location in their prose — six older ones, and this record, which quotes the collision it
turns on — and a test asserts the count and the ids. A record that stops quoting one moves
it; a record that starts moves it too. The alternative — leaving it unmeasured — is how "two
of forty-eight, pre-existing" came to describe ten.

**Six. The `summarise` docstring's overclaim is withdrawn.** It asserted a property of prose
that the function never had and could not have had. An unverifiable promise in a comment is
the defect ADR-049 is about, one level down: a sentence that reads like evidence and carries
none. The comment now states the scope it can keep.

## Consequences

- **Five records changed, and only their `Status:` line.** No ruling, no context and no
  rejected alternative was touched. ADR-049's supersession machinery is unaffected:
  `partialSupersessions` still reads the raw paragraph, because a ruling number is not a
  location and redacting it would have been the wrong trade.
- **`rules why ADR-042` no longer prints `src/resolve/resolve.mjs`.** It prints
  `accepted · 2026-10-08 · ruling 1 superseded by ADR-053`, which is the whole of what the
  line is for.
- **A sixth record with a path in `Status:` is scrubbed rather than blocked.** The records
  are corrected so they stay readable to a maintainer on this repository, where the path is
  the useful part; the loader is hardened so a future one is harmless. The corpus test
  asserts the *unscrubbed* status carries none, which is the stronger statement.
- **Prose leaks are visible rather than absent.** Seven records — six older and ADR-055
  itself, which quotes the collision it turns on. Anyone who decides that is still too many
  now has the count and the argument against redaction.

## Rejected

- **Redact the prose too.** The `docs/plans/` collision is not hypothetical — ADR-014,
  ADR-016, ADR-025 and ADR-030 all use that exact string for both meanings, and `test/leaks.mjs`
  already singles it out as a substitution *default* that names where a repo keeps its own
  plans. Redacting it would corrupt four records to protect six.
- **Rewrite the ten records to drop the paths.** This repository's rule is that a record is
  never edited in place, and the argument these records make is better with the file named.
  The clause moves to the field designed for it; the sentence does not change.
- **Stop printing the status line.** It carries the supersession, which is the one thing a
  reader needs in order not to act on a reversed ruling.
- **Put the redaction in `commands/rules.mjs`.** It would then apply to the text output and
  not to `--json` or MCP, and the three surfaces would disagree about what a record says —
  the copy ADR-052 exists to prevent.