---
simt-affects: ["test/help.test.mjs"]
simt-supersedes: []
---
# ADR-129 — Distill is documented on the advanced help page, not the core one

Status: accepted · 2026-11-02

## Context

`simt --help` is capped at 2048 bytes and is the page an agent reads to choose a command
(review 0003 Q61). `distill` writes a budgeted proposal summary into `.simt/local/distilled/`
for a human to merge: it projects nothing, commits nothing, and its quality bar has never
been measured. Review 0003 Q84 asks whether it earns a line on the core page, which today
costs 1092 bytes of the 2048 available and must say what a repository does in its first week.

## Rulings

1. **`distill` is documented on `simt help --all` and nowhere in the default page.** The
   default page names the core tier only; `help distill` still answers with the command's own
   page, so the command is reachable by name without spending page budget on it.

2. **A place on the core page is earned by a measurement, not an argument.** For `distill`
   that means a measured improvement in task outcome from a merged proposal, recorded the way
   a pack records ΔR. Until such a number exists, the command is advanced.

## Consequences

- The default page stays at 1092 bytes and gains no line for an authoring aid.
- `test/help.test.mjs` pins both directions: `distill` is absent from the default page and
  present on `--all`, so a later edit that promotes or drops it fails a named test.

## Rejected

- **Keeping it on the core page.** Rejected: it spends page budget every reader pays for a
  command most repositories never run, and the page's own contract is "what can this do, and
  where do I start".
- **Removing the command.** Rejected: the command works and is used when authoring a skill or
  a doc; the open question was placement, and removing a capability to settle a placement
  question answers a different question.
