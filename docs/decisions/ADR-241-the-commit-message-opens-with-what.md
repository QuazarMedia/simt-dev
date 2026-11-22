---
simt-affects: ["rules/mdc/slice-commit.mdc"]
simt-supersedes: []
---
# ADR-241 — The commit message opens with What

Status: accepted · 2026-11-22

## Context

The slice-commit format dropped the `What` section on the ground that the diff is
the What, written down, and a body section that restates the title spends words on
what the tree already shows. In practice the title is one line: a reader who has
only the log entry, not the diff, cannot tell what the change is from a scoped
imperative verb. The title says the dispatcher gate changed; it does not say what
it now does, and the `Why` that follows explains the ask, not the change.

## Rulings

1. **`What` is the first section of every commit body.** It precedes `Why`, it is
   always present, and with `Why` it makes a body mandatory: the one-line commit
   with no body no longer exists.

2. **`What` is the title said out, capped.** One to two sentences: what the change
   is, explained, not a file list recited and no more detail than the title asks
   for. Longer than two sentences is a paragraph, and a paragraph in `What` is the
   restatement the dropped section existed to prevent.

3. **The Before stays with `Delta`.** The state before the change is not a section
   of its own: `Delta` carries the before -> arrow, and the diff is the before
   written down.

## Consequences

- Every commit message body opens `What:` then `Why:`, in that order.
- The old ruling that the title and diff already say the What is superseded for
  the message: they say it for the tree, not for a reader with only the log.

## Rejected

- **Keeping `What` optional.** An optional section that carries the only
  description of the change will be left out, and the format reverts to a title
  no one can expand without the diff.
