---
simt-affects: ["src/knowledge/bundle.mjs", "test/work-query-contract.test.mjs"]
simt-supersedes: []
---

# ADR-161 — a read is filtered before it is ranked, and an imported bundle is data

Status: accepted · 2026-11-03

## Context

The same facts are wanted from a terminal, from an editor's MCP client, and from another
repository that needs a requirements-to-implementation handoff. Serving them is easy to get
wrong in ways that do not look like bugs:

- a restricted fact removed after ranking has already moved everything around it, so the order
  discloses what the filter removed;
- "2 results withheld" is itself a disclosure, and a policy that forbids the fact cannot be
  satisfied by a count;
- a bundle that can only be imported where the producer's tree exists is not an offline
  bundle;
- an imported bundle is untrusted text, and the one thing it must never become is a set of
  instructions.

There is also a structural failure with no failing test unless it is asked for: a `read-only`
server is read-only only if every surface that exposes the door agrees, and a write verb beside
a read tool is the same defect whether it is caught in the CLI or in MCP.

## Rulings

1. **Permission filtering precedes ranking.** The ranker receives only facts the reader may
   have, so its order cannot encode a fact the answer omits.

2. **A withheld count is disclosed only when policy allows.** `omitted.restricted` is a number
   by default and `null` under `hideCounts`, because for some facts the existence of the count
   is the leak.

3. **Bundles are bounded twice.** By facts per page and by bytes, with `page`, `truncated` and a
   reason naming which bound was hit. A page cut for bytes says so; a page with more behind it
   says how many, unless counts are hidden.

4. **A bundle is self-describing and checkable.** It carries the schema, a producer digest, the
   input revision digests, the applicability constraints and an expiry date. A fact without a
   revision digest is refused on import, because it cannot be checked.

5. **Import is data, never instruction.** The result carries `executed: false`, `effects: []`
   and `treatAs: 'data'`; imperative text in a fact stays a fact. Nothing in the module parses
   a directive, invokes a tool or writes a file.

6. **Expiry is compared against a caller-supplied date.** The module reads no clock, so a
   bundle expires at the same moment for every reader.

7. **Parity is checked structurally.** `checkDoors` requires every read-only door to exist on
   both surfaces and refuses a door whose CLI verb or MCP tool writes. The check names the door
   and the remedy, so the failure is a line to fix rather than a policy to remember.

## Consequences

- A consumer with fewer permissions than the producer re-filters on import and reports
  `withheld`, so a bundle forwarded to a narrower reader does not widen it.
- The offline property is structural: import resolves nothing, so a bundle from a repository
  that is not present — and whose siblings do not exist — imports the same way.
- The doors named here are descriptors, not registrations. Wiring them into the command and MCP
  registries is a later change; this record settles what the contract must be before either
  surface implements it.
