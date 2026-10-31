---
simt-affects: ["src/context.mjs", "src/commands/hooks.mjs", "test/hooks-context.test.mjs"]
simt-supersedes: []
---

# ADR-125 — a shared context belongs to a read, and a writer reads directly

Status: **accepted** · 2026-10-31

## Context

`repoContext` holds one pending promise per question for the length of a command. It
was threaded through the reads — `check`, the four skills reads, `diagnose`, the rules
catalogue — and Q67's last clause was to finish the job, which raised the question the
row did not answer: should a command that *writes* hold a context too?

The two cases are not the same. A reader asks several questions about an unchanging
tree and pays once. A writer changes the tree between its questions: `init` writes a
manifest and then renders against it, `upgrade` replaces files and then reports drift,
`sync` rewrites the region and then computes the lock. A context that survived those
writes would answer the second question with the first answer, and the command would
report a repository it had already changed.

## Ruling

### 1. A read command may hold one context for its whole run

A command that only reads creates one `repoContext` at its entry and passes it to
every reader beneath it. Two questions with the same answer cost one computation, and
the cache reports its own hits so a context that is wired but never used cannot pass
for a fast machine.

### 2. A writer reads its repository directly

A writer calls the readers as it always has. It is not an optimisation left undone: a
shared context would make a stale answer the reward for a correct write, and the
failure would surface as a drifted manifest in a repository that had just been fixed.

### 3. The hook path keeps its dynamic import

`planHooksInstall` resolves the node runner from a fingerprint, and it imports the
fingerprint module dynamically so that loading the hooks command does not load it.
Static-importing a context into `src/commands/hooks.mjs` costs about 3 ms of module
graph on the shim path, which Q64 measured and removed once. A caller that holds a
context passes it and shares the walk; a caller that does not keeps the light path.

## Consequences

- Q67 closes with the reads threaded and the writers explained rather than converted.
- The 3 ms module cost is paid only when a command actually uses a context; `hooks
  run` keeps the dynamic path.
- A future writer that wants a context has this record to argue against, instead of
  discovering the staleness as a bug report.

## Rejected

- **Giving every writer a context and invalidating entries after each write.** The
  invalidation is the whole bug surface: forget one entry and the failure is a stale
  answer that looks like a correct one, in the command whose job is to make the tree
  correct.
- **A process-lifetime context.** `bench` writes manifests mid-run; a process-wide
  memo would answer a benchmark for a repository it had just changed.
- **Making the context required on every reader signature.** It would put the cache in
  the contract of functions that do not need one, and a caller with no context would
  have to invent an empty one.
