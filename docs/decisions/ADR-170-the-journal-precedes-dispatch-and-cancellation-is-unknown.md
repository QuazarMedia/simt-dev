---
simt-affects: ["src/actions/machine.mjs", "test/action-machine.test.mjs"]
simt-supersedes: []
---

# ADR-170 — the journal is written before dispatch, and a cancellation during dispatch is unknown

Status: accepted · 2026-11-03

## Context

An external effect that nobody recorded is indistinguishable from one that never happened:

- a dispatch with no write-ahead record left no way to tell, after a crash, whether the request
  had left the process;
- a cancellation during dispatch was recorded as cancelled, when it may already have changed
  something;
- a disconnected process was assumed stopped, so its in-flight effect was forgotten;
- "exactly once" was claimed for an adapter with no server-side deduplication;
- a shell string was handed to the executor and run as a program;
- a side-effecting adapter was enabled because it was installed.

## Rulings

1. **The write-ahead record comes first.** `beginOperation` requires an operation id and the
   intent digest and writes `planned` before anything is dispatched. A record missing either is an
   error.

2. **Only declared transitions are legal.** `planned → ready → executing → observing → verified`,
   with `blocked`, `failed`, `outcome-unknown`, `compensating` and `compensated` as side states.
   An illegal transition throws; a journal describing an impossible path is worse than no journal.

3. **Cancellation during dispatch is `outcome-unknown`.** Before dispatch it is `failed`, because
   nothing left the process. After dispatch nothing is known until reconciliation, and
   `outcome-unknown` is the state that says so.

4. **A replayed journal decides what a resumed process may assume.** `replay` reports the last
   state, whether it is resumable, and whether something is in flight — with the reason that a
   live process cannot be assumed stopped.

5. **Event ids deduplicate local recording, and only that.** `recordEvent` refuses a repeated id
   and returns `remoteEffectsChanged: false` always: the remote effect is deduplicated by the
   target (W34) or not at all.

6. **The executor runs registered runners with argv.** A string containing whitespace or shell
   metacharacters is refused as a program rather than a command; an unregistered runner is
   refused; argv entries with control characters are refused; the environment is restricted.

7. **A side-effecting adapter is off unless explicitly enabled,** and no exactly-once promise is
   made without server-side deduplication or an atomic precondition.

## Consequences

- The core is transport-free: adapters own the transport, and this module owns what may be said
  about a transition.
- Every record carries correlation ids for the local script, the remote request and the verifier,
  so a sanitized log explains one transition rather than three unrelated lines.
