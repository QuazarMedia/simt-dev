---
simt-affects: ["src/verify/documents.mjs", "test/verify-documents.test.mjs"]
simt-supersedes: []
---

# ADR-162 — document checks are three bases, and a model name is not a second opinion

Status: accepted · 2026-11-03

## Context

Documentation repositories are verified by things that are not tests: a format check, a link
checker, a rubric, a reviewer's judgement, a model's report. Each is worth having, and merging
them into one score makes all of them worth less. Three specific confusions caused this record:

- a model judging a document was recorded as a human review, so a required sign-off was
  satisfied by a machine that is not a signatory;
- two models from one provider, given the same corpus and the same policy, were counted as two
  independent opinions because their model names differed;
- a link that answered 200 on a government domain was recorded as proof of the statement the
  paragraph made, when it proved only that a publisher exists.

A fourth is quieter: evidence produced under one rubric, prompt and input stayed "valid" after
any of them changed, so a stale judgement kept vetoing a newer one.

## Rulings

1. **Three bases stay apart.** `deterministic`, `human-review` and `model-judgement` are
   recorded separately. A requirement names the basis it needs; a judge of another basis does
   not satisfy it, and the result says which basis was found instead.

2. **Routing is most specific, and unmapped is a reason.** A document is routed to exactly the
   rubrics of its most specific matching pattern; a less specific mapping does not also apply.
   An empty mapping means explicitly unmapped, no matching mapping means unrouteable, and two
   equally specific mappings are an `ambiguous-mapping` error with a remedy rather than a
   guess. An excluded rubric is reported as excluded, not silently absent.

3. **Independence is evidence, not nomenclature.** Two model judges are independent only when
   they differ in provider (or, for people, in reviewer) and carry distinct attestations. A
   different model name from the same provider is the same reading with a different label.

4. **Semantic evidence is pinned to its rubric, prompt and input.** A change to any of them
   makes it stale with the reason. Deterministic evidence has no prompt, so a prompt change
   cannot invalidate it; a rubric change can.

5. **A claim needs an excerpt that states it.** Reachability and an authoritative domain are
   properties of a publisher, and the result says so when they are the only things offered. A
   quote that does not contain the claimed value is `quote-does-not-state-claim`.

6. **A generation contract pins four things.** Template id and digest, required sections,
   source scope and output representations. A generated document is checked against all four,
   and each failure carries a remedy — including `template-drift`, which asks for a re-review
   rather than a regeneration that would reproduce the drift.

## Consequences

- Adapters for local format and link checks feed the deterministic basis as records; this
  module never runs a checker, so a repository can replay an assessment without its tools.
- A repository with no rubric catalogue still routes by pattern; the catalogue only turns an
  unknown rubric into an error rather than a silent selection.
- The generation contract is deliberately narrower than a template engine: it checks that the
  output came from the pinned template and stayed inside its declared inputs, and says nothing
  about how the text was produced.
