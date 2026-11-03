---
simt-affects: ["test/plan-surfaces.test.mjs", "docs/research"]
simt-supersedes: []
---

# ADR-194 — a slice is complete when its acceptance sentence is exercised

Status: accepted · 2026-11-03

## Context

Plan 4's rows W23 and W29 were recorded `Complete`, with SHAs, on the strength of a module and
its unit test. W23's acceptance line reads "CLI/MCP parity, explicit pagination and max-byte
truncation indicators; no write operation slips into the read-only server. Offline bundle works
in an isolated no-siblings consumer". At the SHA it was closed on, none of the four doors it
names existed. W29 proposed `simt verify status` and closed without it.

Nothing failed, because nothing was checking. The tracker has no column for "the surface exists",
`simt plan done` records a SHA and evidence of a test run, and the dead-export scan called those
modules reachable — they were reachable, from their own tests. Three true statements, and the
conclusion drawn from them was false.

## Ruling

A slice is complete when the acceptance sentence in its own row can be exercised by a consumer:
every command it names dispatches, every surface it names answers, and the test proves it that
way rather than by importing the module.

Where a named command is deliberately absent, the absence is a record with a reason, in the same
shape the MCP-only tools use — so the excuse is visible, reviewable and checked for staleness.

`test/plan-surfaces.test.mjs` enforces this for plan 4: every `simt <command>` its text names
either resolves in the command spec or appears in that record. `simt verify run` appears there,
because it executes validators and the executor is not this package's.

## Consequences

- A future plan is covered by adding its document to the same test; the check is over the plan's
  text, not over anyone's memory of it.
- An excuse that stops being true fails: an excused command that becomes dispatchable is a stale
  record, and the second test names it.
- The cost is paid at review time, when a row is closed, which is the only moment the acceptance
  sentence is still in front of the person closing it.
