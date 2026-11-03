---
simt-affects: ["src/agenthooks/normalize.mjs", "test/work-agenthooks.test.mjs"]
simt-supersedes: []
---

# ADR-177 — a tool call is named by its effect, and a boundary cannot mediate what it cannot name

Status: accepted · 2026-11-03

## Context

The policy table decides once; the harnesses disagree about what a call looks like. That gap is
where a rule gets enforced in one harness and forgotten in another:

- the same action was judged differently in two harnesses because one payload was recognised and
  the other was not;
- a payload nobody could classify was treated as allowed at a boundary that claimed to mediate;
- shell text analysis was presented as a security boundary, when it reads a string a wrapper can
  defeat;
- a recorded tool call kept the token it carried.

## Rulings

1. **The call is named by effect and resource.** `read`, `local-write`, `history`, `push`,
   `remote-write`, `unknown`, with the written paths as the resource selector and the repository
   as the target. The harness is recorded, not reasoned about.

2. **An unparsed command is `unknown`.** A command the parser could not read is not `read`; the
   difference between "nothing happens" and "we did not understand it" is the point of the class.

3. **The existing table still decides.** `mediate` calls the same `decide` with the same facts, so
   a call the table already understood gets exactly the verdict it had, and the push, history,
   generated-region and lease policies are untouched.

4. **Assurance is stated, not implied.** A boundary that mediates denies an unclassifiable call
   with that reason; a boundary that only observes allows it and says `observe-only`, so nobody
   reads an observation as enforcement.

5. **A recorded call is redacted before it is written.** Redaction on display is too late: the log
   already holds the token.

6. **Parity is a property of normalisation, not of the harnesses.** Two harnesses reporting the
   same action produce the same operation digest, which is what makes "equivalent verdicts across
   declared harnesses" checkable rather than asserted.

## Consequences

- This module adds no policy: it names calls so the one table can judge them.
- The normaliser reads no filesystem and no clock, so a recorded call can be replayed.
