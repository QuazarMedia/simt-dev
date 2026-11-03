---
simt-affects: ["src/actions/delta.mjs", "test/action-delta.test.mjs"]
simt-supersedes: []
---

# ADR-168 — a semantic delta never guesses a masked field, and an unknown never justifies replacement

Status: accepted · 2026-11-03

## Context

A remote change is reviewable only if the delta means what a reviewer reads into it. Four
failures made it unreliable:

- a permuted unordered collection produced a delta, so every read looked like a change and
  reviewers learned to skim;
- a permission change vanished because the field's value was masked — the one change a reviewer
  must never miss;
- a masked field was guessed at from context instead of being reported unknown;
- a lossy snapshot was used to replace a whole object, deleting fields the snapshot never saw;
- a promotion copied an environment-local id into another environment.

## Rulings

1. **Field classes carry the meaning.** `identity`, `functional`, `permission`, `privacy`,
   `reference` and `opaque` are declared per field, so "a label changed" and "a permission
   changed" are properties of the data rather than of the reviewer's attention.

2. **Collection semantics are declared.** An unordered array is compared as a set, so a
   permutation is not a delta; an ordered array is compared as a sequence, so a reorder is.

3. **A significant masked change is visible and unread.** A `permission` or `privacy` change is
   reported with `kind: 'unknown'`, `significant: true` and an explanation that says the content
   was not read. A masked functional field is listed in `unknown` and never becomes a guess.

4. **An unknown never justifies replacement.** `canReplaceWholeObject` is false when any field is
   masked or opaque; such a snapshot may describe the fields it read and nothing more.

5. **Frame conditions name what must stay.** Every untouched readable field becomes
   `{field, expect}`, so "the change was only this" is checkable rather than assumed.

6. **References travel as logical references.** A reference change records the reference, not the
   wrapper around it, and promotion resolves it against each target's own map. A raw
   environment-local id is rejected by shape and by declaration, and an unmapped target is
   reported unmapped rather than left out.

7. **An opaque body keeps a digest and an unknown frontier.** `referenceEdges` reports
   `incomplete: true` for a snapshot with an opaque field instead of claiming the analysis is
   whole.

## Consequences

- Add, remove, rename and reset each have one stable explanation, so a reviewer reads the same
  sentence for the same change on every run.
- The module reads no target and holds no clock: an adapter produces snapshots, this judges them.
