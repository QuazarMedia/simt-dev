# ADR-008 — One review verdict vocabulary: three values

Status: **accepted** · 2026-10-05 · affects all repos

## Context

The estate has two incompatible verdict vocabularies.

`.cursor/rules/test-gate.mdc` — used by all three one repository — allows one outcome:

> Return `BLOCK` when: any test fails, is skipped without pre-existing justification, or is
> unrun; the executable diff has no test delta without explicit justification; the coordinator
> cites partial suite results or defers failing tests.

`principal-milestone-reviewer.agent.md` — the final pre-commit gate — uses three:

> `APPROVE` / `APPROVE WITH RESIDUAL RISK` / `BLOCK`

With only two values, a reviewer who finds no blocker but did not finish has no honest answer
and is pushed toward `APPROVE` by omission or toward `BLOCK` by exaggeration. With three, the
budget mechanism works: "Use one focused pass, normally no more than 5 minutes or 8 targeted
tool calls… If the budget is reached without a concrete blocker, stop and return `APPROVE WITH
RESIDUAL RISK`. List what was not reviewed."

The agent also re-embeds the `.mdc` text verbatim as its checklist item 1, so the vocabulary
mismatch propagates from the rule into the gate.

## Ruling

Adopt the three-value vocabulary everywhere:

| Verdict | Meaning |
|---|---|
| `BLOCK` | A concrete defect, missing mandatory gate, partial test pass, or missing test delta. Always paired with a file:line or command reference. |
| `APPROVE WITH RESIDUAL RISK` | No blocker found within the review budget. **Must** list what was not reviewed. |
| `APPROVE` | Fully reviewed, no blocker. |

`APPROVE WITH RESIDUAL RISK` never converts a known failure into an approval — that constraint
travels with the verdict, verbatim from the review agent.

The `.mdc` files are updated to the three-value vocabulary. `BLOCK` remains the only value that
stops work; the other two do not weaken the block conditions, which are stated identically in
all three rules.

## Consequences

- A reviewer who runs out of budget has a correct answer, so the budget stops being a reason to
  over-search.
- Rule text and agent text stop diverging, because they now share a vocabulary and the agent no
  longer has to paraphrase the rule.
- Output format is uniform across the 15 agent files: severity-ordered findings, clickable
  file:line references, a verdict, and — when not fully reviewed — the unreviewed list.

## Rejected

- **`BLOCK` only.** Loses the honest "I did not finish" answer and makes the strict review
  budget unusable as written.
- **Four values** (adding `NEEDS WORK`). Three already distinguishes blocked from
  budget-limited; a fourth would be chosen on judgement and collapse back into two.
