---
simt-affects: ["rules/mdc/slice-commit.mdc", "AGENTS.md"]
---

# ADR-230 — a commit message carries what the diff cannot

Status: accepted · 2026-11-22

## Context

The `slice-commit` rule (the git-workflow home since ADR-120) specified a body of
`What:`, `Why:`, `Before:` and `After:` sections. An 80-commit sample of this
repository's own history measured what each section contributed:

- `What:` restated the title at finer grain in every full-body commit; the diff
  already says both, exactly.
- `Before:` restated the first sentence of `Why:`, or snapshotted a state the parent
  tree already holds.
- `After:` did two jobs at once — narrating the mechanism (which is the diff) and
  claiming evidence ("byte-identical — verified by diffing…"). The evidence claim is
  the most agent-valuable sentence in a message: ADR-087 made a run into evidence
  precisely because "a test was run" is otherwise a sentence nothing checks. It sat
  in free prose where it cannot be grepped, shaped or separated from narration.
- Decision ids were cited inline in prose (31 of 80 commits); "which commits
  implement ADR-NNN" cost a `git log -G` scan of free text.

The failure is not that the sections were false. It is that three of them claimed
what the tree already shows, and the one claim worth a fixed shape had no shape.

## Rulings

1. **The body is `Why`, then `Delta`, then `Evidence`, in that order, separated by
   one blank line.** `Why` is always present: one to three sentences naming the task,
   defect or decision that asked for the change. `Delta` appears only when the patch
   does not show the change by itself — skipped work, scheduling, wire format — as
   one line with an ASCII `->`. `Evidence` appears only when a check ran, naming the
   commands and their result. `What:`, `Before:` and `After:` are retired: the title
   plus the diff is the What, and the parent tree is the Before.

2. **Ids sit on a `Refs:` trailer; the attribution is the last trailer.** `Refs:` is
   present when a decision or task id settles the change, space-separated;
   `Co-Authored-By: Simt Dev <noreply@simt.space>` is always last. Trailers are the
   part of a commit message with a grammar, so `git log --grep='^Refs:'` answers
   "what implements this decision" without a scan of prose.

3. **The layout is fixed.** One blank line between title and body, between sections
   and above the trailer block. Labels are a capital word, an ASCII colon and one
   space; bodies are sentence case with a terminal period, wrapped at 72 columns.
   Em-dashes are prose punctuation; labels and trailers are ASCII.

4. **The rule text is the change.** The `slice-commit` rule body states the pattern;
   the rendered region of every adopting repository carries it on the next `sync`.
   No tool validates an existing message, and no historical commit is rewritten — the
   rule binds forward only.

## Consequences

- A full-body commit drops from about 150 words to a third of that, with no claim
  lost: everything `What:` and `Before:` carried is recoverable from title, diff and
  parent tree.
- Evidence and references move from prose into positions a reader can grep, so the
  estate's no-false-claims rule becomes mechanically checkable in history.
- `git log --oneline` triage is unchanged; the title was already the working part.
- Every repository that adopts this package inherits the pattern on its next render;
  a repository mid-migration will show both patterns in history, and that is the
  expected state until its older commits age out of view.

## Rejected

- **Keep `Before:`/`After:` as a state summary.** The measured history showed they
  restate `Why:` or the parent tree; a state a reader can check out is not a claim
  worth words.
- **A `Refs:` section in the body.** A section is prose with a label; a trailer is
  data with a grammar. The ids belong in the part git can parse.
- **A linter that enforces the pattern.** ADR-030 ruled that a convention asked for in
  prose is not a tool requirement until a tool needs it; nothing here reads the
  message, so the rule text is the enforcement.
