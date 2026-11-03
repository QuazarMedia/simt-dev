---
simt-affects: ["CHANGELOG.md"]
simt-supersedes: []
---

# ADR-191 — a release states what its surface reaches, and a command is added for a consumer

Status: accepted · 2026-11-03

## Context

0.10.0 carries the work layer of plan 0004: twenty-three rulings, and the modules they produced.
An import-graph walk from `bin/simt.mjs` showed that **none** of them was reachable from the CLI —
they were in-process surface exercised only by the suite. The release notes were written to say
that outright, and then `agent-hooks explain` (ADR-190) wired the first of them, because
`agent-hooks status` could report a harness as wired while nothing could say what its payload had
been read as.

The open question was whether the release should wait for more wiring. The temptation is real:
a minor version whose substance is unreachable reads like a smaller release than it is, and adding
commands until the count looks respectable would answer that.

## Rulings

1. **The notes state what the surface reaches.** A module the CLI cannot reach is described as
   library surface the suite exercises. A release that implied a capability its binary does not
   have is decoration that misdescribes the artefact, which is the failure this repository names
   before any other.

2. **A command is added for a consumer, not for a release.** `agent-hooks explain` earned its
   surface because a real question had no answer: which class the policy table had assigned to a
   payload that a harness was already sending. `src/adapters/conformance.mjs` did not earn one:
   `work.adapters` is a manifest key since 0.8.0, and no repository in this estate declares it, so
   a status command would print "none declared" everywhere and be its own only caller.

3. **Reachability is a review step, not a gate.** A test asserting that every module is reachable
   would force exactly the speculative commands ruling 2 forbids, and would fail on the first
   module written ahead of its consumer. The check is an import-graph walk performed at release
   time, with its result stated in the notes.

4. **0.10.0 ships with one wired module and says so.** The remaining seventeen are covered by the
   suite and described as unreachable; the release does not present them as CLI behaviour.

## Consequences

- A future slice that wires a module names the question it answers and who asks it.
- Release notes gain a factual sentence the author can check in one command rather than an
  adjective.
- The work layer can be finished and adopted incrementally without a release having to wait for
  the whole of it.
