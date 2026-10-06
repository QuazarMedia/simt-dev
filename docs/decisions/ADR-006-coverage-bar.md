# ADR-006 — Evidence discipline is central; the numeric bar is per-repo

Status: **accepted** · 2026-10-05 · affects all repos

## Context

The coverage bar is the one concept that is mutually incompatible *in kind* across the estate:

| Repo | Bar |
|---|---|
| `bunnyland-server` | Quantitative. `fail_under = 100`, branch coverage, "a behavioural coverage gate, not a line-count scoreboard" |
| `simt-garmin` | Quantitative, but a different quantity. Memory: 64 KB app / 24 KB Glance against a 32 KB ceiling, plus 12 named lint scripts |
| `simt-social`, `simt-social-api`, `simt-social-media` | Qualitative. No number anywhere. Evidence discipline: named commands, 100 % pass, no unjustified skips, behavioural test delta |
| `simt-api` | Neither. Three verification commands. |

You cannot average these. 100 % line coverage is unreachable for Kotlin/Compose UI code and for
Monkey C memory budgets; a memory ceiling is not a coverage proxy; "no number" is not a weaker
version of 100 %, it is a different instrument.

## Ruling

**The central rule mandates evidence discipline. The numeric threshold is a declared,
per-repo constant.**

Central, mandatory, portable — for every repo regardless of stack:

1. Name the exact commands and the exact test files.
2. Those commands must exit 0 with **all** selected tests passing. Partial pass is a hard
   blocker; "6/8 pass" is the canonical worked example of a blocked state.
3. No test is skipped without a pre-existing written justification.
4. Every executable change carries a test delta: new or extended test for new behaviour, a
   regression test reproducing the failure mode for a bugfix, or a stated reason existing tests
   fully prove the invariant.
5. Never claim a test you did not run. Never cite a partial suite as evidence.
6. Approval by budget never converts a known failure into an approval.

Per-repo, declared in `simt-dev.json` under `limits`: the numeric gate, if any — coverage
percentage, memory budget, size ceiling. The central rule specifies *how to declare it*, never
the value.

## Consequences

- bunnyland keeps `coverage: 100` and its "untested paths are typed holes" framing intact.
- garmin declares its memory budgets in the same slot, and its "layer-conditional 5a–5m matrix"
  becomes a declared gate list rather than 12 prose sentences.
- The three social repos declare no number and keep their evidence discipline verbatim — which
  is now shared rather than independently re-invented in each.
- A new repo inherits a real policy from `simt-dev init` with no configuration, and can opt into a
  number later without changing the rule.

## Rejected

- **Hard 100 % coverage org-wide.** Unreachable in Kotlin/Compose and meaningless for Monkey C;
  would push repos to delete the rule rather than meet it.
- **No number anywhere.** Leaves bunnyland's genuinely strong gate unenforced org-wide and
  invites every new repo to skip the question.
- **One number for coverage and a separate slot for memory.** Two slots invite a repo to declare
  only the one it likes.
