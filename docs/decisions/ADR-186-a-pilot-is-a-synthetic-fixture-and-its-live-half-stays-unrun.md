---
simt-affects: ["test/pilot-remote.test.mjs", "test/fixtures/pilot-remote.json"]
simt-supersedes: []
---

# ADR-186 — a pilot is a synthetic fixture, and its live half stays unrun until someone authorises it

Status: accepted · 2026-11-03

## Context

The remote-work pilot exists to show that the contracts hold together on a task-shaped case without
contacting anything. The temptation is to make it look like a live run: a real hostname in a
fixture, a credential in an example, an "expected" transcript that was never produced.

## Rulings

1. **The fixture is synthetic and committed.** A mock vendor, an `example.test` host and no
   credentials. The golden scenarios are named in the fixture: response loss, target reset,
   ambiguous identity, feature disabled, UI-only operation and a required field the fallback cannot
   set.

2. **Every check runs offline, through the real modules.** The pilot imports the target, retry,
   executor, recovery and replay modules rather than re-implementing their logic, so a regression in
   any of them fails the pilot.

3. **The live half is not run and is not claimed.** `offline()` reports `liveAcceptance: false`;
   nothing in the pilot asserts a live outcome, and adopting the repository enables no credential
   and no opt-in marker.

4. **The scenarios are the assertion.** A lost response reconciles before retrying, a reset target
   is a different identity, an ambiguous alias resolves to nothing, a disabled feature is
   unsupported, a UI path that cannot set the required field is refused, and a fallback that adds an
   effect is a new intent.

## Consequences

- A live pilot is a separate, authorised act with its own evidence; this record does not authorise
  one, and the fixture cannot be edited into one.
- The knowledge pilot (W49) follows the same shape: a synthetic fixture and a guide, with its live
  half unrun.
