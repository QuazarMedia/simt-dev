# ADR-002 — Blast radius bounds refactoring; a third copy is a defect

Status: **accepted** · 2026-10-05 · affects all repos

## Context

Two repos state opposite philosophies, and both are reasonable in isolation.

- `simt-social` / `simt-social-api`: "When a second real use or a near-duplicate already
  exists, refactor the existing code to extract the shared part… A third copy of the same
  logic is a defect, and so is an abstraction invented for a single caller."
- `bunnyland-server/AGENTS.md` §2: "Match existing style, naming, and test layout. **Do not
  refactor neighboring code unless the requested change requires it.** Do not add speculative
  flexibility, configuration, or abstractions."

Neither can be an org rule as written. The Social rule mandates proactive refactoring;
bunnyland forbids it.

## Ruling

Both survive, split by scope:

- **Outside the current change's blast radius** — do not refactor. Unrelated code is not
  collateral.
- **Inside the blast radius** — a second real use extracts, and the extraction is *finished*:
  no orphaned imports, exports, styles, messages, files, feature flags or compatibility
  aliases remain anywhere in the affected dependency graph.
- **A third copy of the same logic is a defect.** So is an abstraction invented for a single
  caller.

## Consequences

- "Do not refactor neighbours" survives verbatim as a reviewer's objection to drive-by changes.
- "A third copy is a defect" survives verbatim as a reviewer's objection to copy-paste.
- Refactor completion becomes a checkable state, not an intention: the reviewer greps for
  orphans rather than trusting the claim.
- bunnyland's "no speculative flexibility" is restated as the single-caller half of this
  ruling rather than as a blanket ban.

## Rejected

- **Social's rule verbatim.** Sanctions unrelated refactors, which is how a 10-line fix turns
  into a 400-line diff nobody can review.
- **bunnyland's rule verbatim.** Sanctions the third copy, which is how a codebase grows four
  subtly different implementations of the same validation.
