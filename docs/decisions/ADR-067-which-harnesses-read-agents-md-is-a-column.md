# ADR-067 — Which harnesses read AGENTS.md is a column, and a row without a document gets none

Status: **accepted** · 2026-10-13 · filed as S42
**Affects:** `harness detect`, `src/projection/surfaces.mjs`, `src/commands/harness.mjs`, the
table tests in `test/surfaces.test.mjs`, `test/harness.test.mjs`

## Context

Review 0002 filed the finding as "harness coverage stops at five surfaces", and the table
stops at five: opencode, Cursor, Claude Code, Antigravity and Copilot. The same review then
listed a dozen more harnesses that read instruction files — Gemini CLI, Windsurf, Zed, Kiro,
Cline, Roo Code, Junie, Aider, Continue, Amp, Goose — and its own fix had two halves that pull
against each other.

The first half is mechanical: add a column recording whether each harness reads AGENTS.md,
and add rows only for the ones that do not. Most of the candidates need no row at all,
because most of them read AGENTS.md natively, and that fact is exactly what the column is for:
it turns "which harnesses do we support" from an open question into a lookup.

The second half is the one the review flagged on itself. It proposes a row per vendor and a
`verified` field citing that vendor's documentation — while stating in the same paragraph that
it did not re-verify each vendor's current documentation and that its list should be treated as
candidates. So the rows would carry a field whose entire purpose is to say "this was checked
against a source", filled in by a list that was not checked.

That combination is the failure this repository exists to prevent, in its exact form. The
repository's own ruling on manifest comments records the shape of it: a comment claiming each
value cites its decision record, where none did, is decoration that misdescribes the artefact.
A surface row is not decoration — it decides whether a reader's agent gets a rule at all. A
guessed row puts an unverified assumption into every repository that adopts the release, and
the reader who is wrong about it cannot tell, because the field that would tell them is the
one that was invented.

Detection was the other half and it has no such trap. "Which harnesses is this repository set
up for" is answerable from directories that exist, provided the command claims exactly that
much and no more.

## Rulings

1. **Whether a harness reads AGENTS.md is a vendor fact recorded per row, in three values.**
   `all` means every reader the row names loads it; `some` means a subset does and the row
   says which, in its own words; `none` means the row is the only channel those readers have.
   Two values would be wrong in a way that matters: Copilot's CLI reads AGENTS.md and its
   editor, code review and cloud agent do not, and a boolean there would have to be read as
   "this repository is covered for Copilot", which is false for two of its three readers.
   Every row whose value is not `all` carries the sentence that makes it true.

2. **The column is not the existing `readsPrimary` flag, and the two must not be merged.**
   That flag answers whether a per-rule file would repeat text the folded region already
   carries, and it is only meaningful while folding is on. This column answers whether the
   file is read at all, and it decides whether a harness needs a row. Merging them would make
   a duplication question stand in for a coverage question, and the value would then change
   answer a reader is relying on.

3. **A row requires provenance, so no row ships from the candidate list.** Review 0002's
   candidates are recorded as configuration directory names, not as surfaces. Adding a row
   requires a vendor document, and a row whose `verified` cites nothing does not get added —
   which means this ruling lands fewer surfaces than the review asked for, deliberately. The
   cost of waiting is that a harness which does not read AGENTS.md is not served until
   somebody reads its documentation; the cost of guessing is that every adopting repository
   inherits the guess and the reader of the row is the only one who can catch it.

4. **Detection reports presence and calls it presence.** A directory that exists implies a
   harness is in use. It does not imply the harness reads AGENTS.md, is installed, or is
   configured the way this tool would configure it, and the output never says it does. The
   candidate list claims nothing about what those readers load for the same reason ruling 3
   does: the directory name is evidence of a harness, and the fact nobody has verified is
   what it loads.

5. **A configuration directory with no channel is a note, never a problem.** It is the
   expected shape of a repository whose team uses something this release does not serve, and
   the remedy for it is not something the reader can be told to do. The command also exits 0
   whatever it finds, including on a repository with no harness configuration at all: a
   non-zero exit would be read as "this repository is set up wrong", which is the one thing a
   directory scan can never establish.

6. **The home directory is opt-in.** `--user` adds it. A command whose answer changes because
   something was installed elsewhere is one a reader stops trusting, and the repository is
   not the reader's machine.

## Consequences

A harness that does not read AGENTS.md and has no row is now visible rather than invisible:
`harness detect` names its configuration directory as present with no channel, and says in the
same breath that presence is not a coverage claim. That is the honest answer available without
vendor documentation, and it is the one a reader can act on — by asking, or by adding a row
with a citation.

The candidate list will be wrong sometimes: a harness may name its directory differently, or
use a dotless one, or write its config elsewhere. Each of those produces a miss, and a miss is
silent. That is the shape of the problem as it stands; the alternative was a table of claims.

## Rejected

- **Adding a row per review-0002 candidate with `verified` citing the review.** The field would
  name a document that was never read. It is the exact defect the ruling on manifest comments
  records, and it would be harder to spot later because each row would look like a verified
  one.
- **A two-valued column.** Every row would have to pick the more flattering half, and the
  flattering half for Copilot is the one two of its three readers contradict.
- **Merging the column into `readsPrimary`.** It would turn "does this harness read the file"
  into "would this duplicate the region", and the answer a reader gets would depend on whether
  they had folded the rules.
- **Reporting an unclaimed configuration directory as a finding.** It would put a red mark on a
  repository for using a tool this project has not documented, which is a statement about the
  project, not about the repository.
- **Scanning for configuration files rather than directories.** A file such as a workflow or
  a settings blob is not evidence that a harness is in use, and the one directory deliberately
  excluded here — the one that holds workflows and issues — would have been reported for every
  repository with CI.
