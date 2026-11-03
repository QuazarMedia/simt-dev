---
simt-affects: ["src/brief/kind.mjs", "test/work-intent.test.mjs"]
simt-supersedes: []
---
# ADR-149 — intent is a vector with a version, a tie is a discovery, and routing grants nothing

Status: accepted · 2026-11-03

## Context

One label was enough while every task was a source patch. It stops being enough as soon as a
repository has documents, recipes and remote objects: "fix the docs" is a bugfix to a reader
of the old label and a document correction to the repository that owns the page, and
"document the API mutation" is both a document to write and a state to observe. A single
label forces a choice, and the choice disappears from the report — the reader cannot see
that the other reading was ever considered.

The dangerous variant is not the mislabelled task, it is the label that quietly widens what
the task may do. A task that says "document the mutation" and routes to `operate` with an
authorization attached has turned a reading of a sentence into permission to change a
customer's state.

## Rulings

1. **The vector is additive and versioned.** `classifyIntent` returns `version: 2`, the
   intents it matched with their scores and the evidence line for each, and the unchanged
   `kind` and `basis` v1 clients read. A v1 caller sees no difference in the field it reads.

2. **Uncertainty is routed to discovery, never to a default.** No match, or a tie at the top
   score, reports `unknown` or `ambiguous` and adds `intent:discover`. The tied intents are
   still named, so the report says what the choice was between.

3. **A requirement is not a grant.** `effect:authorize` is an obligation to *obtain*
   authorization; `state:observe` is an obligation to look. Nothing in the classifier
   produces an effects list or an authorization field, and no result can be upgraded into
   one by a caller reading it as consent.

4. **Verbs decide observation versus execution.** An operation mentioned in a task is
   observed; an operation addressed by an executing verb — create, apply, delete, deploy,
   run — additionally requires authorization. Naming a declared operation id routes to
   `operate` and requires the observation, and stops there.

5. **Evidence outranks a term, and paths are evidence.** A declared artifact or operation id
   weighs more than a matched word, because the repository said it. A document path obliges
   its validation; an executable path obliges code tests; a generator obliges both its tests
   and the regeneration of what it produced.

6. **Accuracy is reported per intent, with its denominator.** `evaluateIntent` reports
   precision and recall per intent and lists the ambiguous and unknown examples by name. A
   denominator of zero is `null`, because a corpus with no example of an intent is not
   evidence about it.

## Consequences

- `src/brief/` still asks for one kind when the card is assembled; switching the packet to
  the vector is a later slice, and this ruling does not change today's projected bytes.
- Overrides exist for the labelled corpus and for a caller that knows better; they are
  reported in `reasons` and still cannot add an effect.
- The corpus in `test/work-intent.test.mjs` is a canary written beside the rules, so its
  perfect score is a regression check, not evidence that natural language routing is solved.
