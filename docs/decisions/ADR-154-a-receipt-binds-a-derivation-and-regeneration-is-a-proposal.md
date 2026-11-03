---
simt-affects: ["src/knowledge/derivations.mjs", "test/knowledge-derivations.test.mjs"]
simt-supersedes: []
---
# ADR-154 — a receipt binds a derivation, completeness is claimed, and regeneration is a proposal

Status: accepted · 2026-11-03

## Context

A generated document records nothing about how it was generated, so a source change leaves
one of two bad options: regenerate everything, or guess which outputs are affected. The guess
is wrong in the direction that matters — an output nobody remembers generating looks
untouched and stays stale.

Once receipts exist, the next mistake is overwriting. A generated file that somebody edited
by hand is a real edit, and a tool that regenerates over it has destroyed work while
reporting a clean operation. The same is true of two generators that both wrote one output.

## Rulings

1. **A receipt binds the derivation**: the input sections and claims with their digests, the
   template, skill, rubric and generator with their digests, and the output's own digest. A
   receipt is the unit of "this was built from that".

2. **The dependency set's digest is the Merkle key.** Sorted, so the same work recorded in a
   different order is the same derivation, and two receipts with the same key may reuse one
   another's result.

3. **Completeness is claimed, not assumed.** `complete` defaults to false; an incomplete set
   makes its output a regeneration candidate whatever the change list says, and expands the
   candidate scope to every other output of the same generator.

4. **Staleness propagates to a fixpoint.** A stale output's digest will change, so everything
   recorded against that output becomes stale in turn — which is what makes a source change
   select the requirements, the design note and the rendering without listing them.

5. **An edit is a conflict, and so is a second generator.** An output whose current digest
   differs from its receipt, or one output with two receipts describing different
   derivations, is reported as a conflict. It is not regenerated, and no proposal claims it.

6. **A missing receipt is unknown lineage.** An output with no receipt makes `minimalSafe`
   false: the tool cannot justify excluding it, and saying so is more useful than a short
   list that happens to look complete.

7. **Regeneration is a proposal.** The result carries `proposal` and `applies: false`, and the
   module opens no file. Applying a proposal is a reviewed patch, on the same footing as any
   other change.

## Consequences

- A tool change is named by `toolRef` (`template:country-page@3`), so a template or skill
  change selects its consumers without a diff of every output.
- A malformed receipt is reported with its id and left out of the answer rather than
  silently reducing the candidate set.
- The module reuses `digestOf` from the observation model, so one digest spelling serves both
  lineages.
