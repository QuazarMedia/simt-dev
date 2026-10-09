# ADR-052 — a dependency is counted against the budget, and there is one budget

Status: accepted · 2026-10-09
**Affects:** `src/resolve/resolve.mjs`, `src/commands/skills.mjs`, `src/mcp/tools.mjs`,
`test/resolve.test.mjs`, `test/mcp.test.mjs`. Closes S06 of
`docs/reviews/0002-full-review-adoption-and-public-release.md`.

## Context

S06 filed two defects. Both reproduced; one of them is a different defect now.

**A dependency overran the budget by 6.7×.** Both budget loops tested
`entry.via.size > 0` and, if the entry was a dependency, inlined it regardless of size:

```js
const isDep = entry.via.size > 0;
if (flags.all || used + skill.bytes <= budget || isDep) {
```

Measured against the shipped registry:

```
$ simt-dev skills brief --skill parallel-feature-team --budget 2000
resolved: parallel-feature-team (1131), slice-commit (5048), complete-testing (7324)
          = 13,503 bytes against a 2,000-byte budget
```

Nothing in the output says the budget was exceeded, because the condition that enforced it
had already been short-circuited. The code's own comment gives the reason — *"a skill that
is useless without its dependency is worse than a large context, because it silently
misleads"* — and the premise is correct while the conclusion does not follow from it. A
missing dependency is fixed by a line in the output; an unbounded budget is not a fix for
anything.

**The two copies had already drifted.** This is the part that had become worse than filed,
and it is the shape ADR-035 named: a promise about a *set* of readers holds only while
something checks the set, and here the set was two loops. `skills brief` tested `deferred`
first and never inlined one; the MCP tool tested the budget first and then had a nested
`if (isDep || !entry.skill.deferred)`, which **did** inline a deferred dependency. One
command inlined a 384 KB body, the other did not, and neither could see the other.

The review's probe #14 evidence is stale and the record should say so: it measured
`summary:the` selecting four estate skills, which stopped being true when ADR-043 and
ADR-044 landed. What is *not* stale is the defect — the `isDep` bypass is in the shipped
code and 6.7× over budget is measured against today's registry, on a path the review never
used.

## Rulings

1. **Dependencies are counted against the budget.** No entry gets in because of what it
   is. This is the whole behavioural change and it is one condition.

2. **A group that does not fit is deferred together.** An entry reached through `requires`
   that misses the budget takes its parents with it, to a fixpoint — because a parent shown
   without the thing it requires is precisely the misleading state ruling 1's comment was
   written to avoid. It is now avoided by dropping the parent rather than by ignoring the
   budget. The direction matters and is the whole of it: a small parent does not earn the
   right to appear without its dependency.

3. **`deferred` is a pointer, not a budget failure, so it does not propagate.**
   `deferred` is derived from `deferredThreshold` and means "fetch this with
   `skills show`". `--all` means take everything, and the pointer to a deferred dependency
   is what a pointer is for. Only *budget* pressure moves a parent. Conflating the two is
   how a 384 KB body would end up suppressing an unrelated 300-byte skill.

4. **`selectWithinBudget()` is the whole arithmetic, and there is one of it.** It returns
   `{ picked, deferred, used }`, and `used` is recomputed from what was actually picked
   rather than accumulated during the walk — a parent pulled out by ruling 2 must stop
   counting, because a total that includes a dropped skill reports bytes nobody is paying
   and the header line prints it.

5. **The two surfaces are compared to each other in a test.** Not "each is correct" —
   each asserted against the other's output at two budgets. A parity test is the only thing
   that catches a copy drifting from a copy, and the review's probe for this row caught the
   drift by reading both.

## Consequences

- `--skill parallel-feature-team --budget 2000` now resolves nothing and names all four
  deferred skills with `over budget`. At `--budget 20000` it resolves the group whole. The
  reader can raise the budget or ask for one skill; before, it got 13 KB and no explanation.
- `skills_brief` over MCP and `skills brief` are now the same function, and the test drives
  both at 2,000 and 20,000 bytes and compares selected, deferred and bytes.
- Six mutations were applied and reverted, each caught: dependencies bypassing the budget,
  the group rule dropped, `deferred` no longer excluded, `deferred` counted against the
  budget, the total no longer being the bytes paid, and the MCP tool not calling the shared
  function.

## Rejected

- **Keep the bypass and report the overrun.** Rejected: the output already has a `deferred`
  list with reasons, and a budget that means "unless" is not a budget. If the estate ever
  decides a dependency is worth any number of bytes, that is a flag with a name saying so.
- **Defer only the dependency and leave its parent.** Rejected: that is the state the old
  comment called *silently misleading*, and it is what ruling 2 exists to stop.
- **Propagate `deferred` to parents too, for symmetry.** Rejected under ADR-013: the two are
  different signals from different fields — `bytes` against a budget the caller set, and
  `deferred` against a threshold the registry declares — and collapsing them makes a size
  threshold suppress a selection.
- **Change the default budget or the deferred threshold.** Rejected: nothing here measured a
  case where the budget, rather than its enforcement, was the problem.