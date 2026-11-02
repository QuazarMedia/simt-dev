---
simt-affects: ["src/commands/spec.mjs", "src/commands/help.mjs", "test/spec-taxonomy.test.mjs", "test/help.test.mjs"]
simt-supersedes: []
---
# ADR-130 — Packs are experimental and frozen until a repository adopts one

Status: accepted · 2026-11-02

## Context

Packs vendor rule bytes with a pinned digest (ADR-065) and total roughly 1,000 lines. Review
0003 Q58 and Q84 found that no sibling repository vendors one: the feature is exercised only by
its own tests. Q58's three defects - a preview that ran `npm view`, a digest that skipped
symlinks the loader followed, and `--root` beating the positional - are fixed in the tree. What
is left is not a defect but a value question: what the feature is worth while nobody uses it.

## Rulings

1. **`pack` is experimental at the surface.** Every pack row carries `stability:
   'experimental'`, `help --json` exposes it, and `help --all` states the status with this
   record's number, so a reader learns it before scaffolding a pack rather than after.

2. **The group is frozen.** No new pack capability lands until a repository outside this one
   vendors a pack. The bar is an adoption, not an argument: a proposal that adds one without an
   adoption is refused citing this record. Whether to remove the feature entirely is a later
   plan's decision and is not settled here.

## Consequences

- The three pack rows carry the marker; `test/spec-taxonomy.test.mjs` holds every pack row to it
  and fails if the marker spreads to a command nobody called experimental.
- `test/help.test.mjs` pins the sentence on `--all`, so the status cannot quietly disappear.
- Q58's three defects stay fixed: freezing records that a feature has no users, it is not a
  reason to leave a known bug in place.

## Rejected

- **Removing packs in this slice.** Rejected: removal is the later plan's call if adoption never
  arrives, and deleting ~1,000 tested lines in the same commit that marks them experimental
  would leave the marker describing something already gone.
- **A general stability field on every command.** Rejected: one value for one group is cheaper
  than a taxonomy with a single member, and widening it is a decision for the day a second
  command needs it.
