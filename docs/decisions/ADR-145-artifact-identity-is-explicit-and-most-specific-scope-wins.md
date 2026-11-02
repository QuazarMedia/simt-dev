---
simt-affects: ["src/work/artifacts.mjs", "test/work-artifacts.test.mjs"]
simt-supersedes: []
---
# ADR-145 — artifact identity is explicit, and the most specific scope wins

Status: accepted · 2026-11-02

## Context

A document tree has no package boundary to borrow. A country directory is a scope, a
rendered page and its Markdown are one deliverable, and a `.py` helper under a document tree
is still executable. Paths are how all three are found, and paths move: a rename that
becomes a new artifact, or a scope resolved by whichever directory happened to be listed
first, makes every downstream claim about that artifact unreliable.

## Rulings

1. **Identity is declared when it can be, derived when it cannot.** An explicit id wins and
   survives a rename; a recorded rename mapping preserves it; otherwise the id is the path
   plus its anchor, and that id changes when the path does. The tool does not guess that two
   paths are the same document.

2. **The most specific scope owns a path.** Specificity is literal segments first, then
   depth, then the fewer globs; a glob decides only where no literal scope reaches.

3. **Equal specificity is a refusal.** Two scopes of equal specificity for one path produce
   a `conflict` naming both, rather than an order that depends on how the file was written.

4. **A remote object is `namespace:type:id`.** A display name is not identity, and a missing
   component is refused rather than defaulted.

5. **Obligations are a union.** The kind's obligations plus the representation's own: a
   script under a document scope carries `execute` as well as `structure`, because it really
   runs.

## Consequences

- Renaming a document without an explicit id is visibly an identity change, which is the
  intended behaviour rather than a documented surprise.
- A scope conflict blocks resolution for that path only; the rest of the tree still
  resolves, so one ambiguous declaration cannot disable a repository's whole contract.
- `work.scopes` in the manifest is now load-bearing for ownership, so duplicate paths are
  refused at validation time as well as at resolution time.
