---
simt-id: work/remote-operations
simt-title: Remote operations
simt-applies: [has-work-targets]
simt-priority: convention
simt-scope: ["**/*.md", "**/*.py", "**/*.mjs", "**/*.js", "**/*.ts", "**/*.json", "**/*.yml", "**/*.yaml"]
---

# Work profile: remote operations

Applies when a repository declares external targets under `work.targets` in `{manifest}`.
A local test cannot prove that a remote change happened, that it kept its promise, or that
it left neighbouring state alone. These rules are about the state transition, not the
request.

## Before the write

- Name the target identity: namespace, type and id. A display name is not an identity, and
  "the calculation" is not a target.
- Read the current revision and state the semantic delta. A change whose diff you cannot
  describe is not ready to send.
- State the allowed effects and what must stay unchanged. Unrelated state is part of the
  contract.
- Get explicit approval for the specific mutation. Approval to edit code is not approval to
  operate a live target, and approval that expired is not approval.

## Sending it

- Use compare-and-set: send the revision you read and let the target refuse the write if it
  moved. A stale write that merges silently corrupts someone else's change.
- Carry an idempotency key for anything not naturally idempotent. A timeout is not a failed
  effect - the effect may have committed and lost its response - so reconcile before
  retrying, and never retry a create without a key.
- When a fallback route drops a required field (for example a private flag the UI cannot
  set), refuse the fallback. A partial write through a weaker route is not a smaller
  success.
- Do not send credentials, cookies, tokens or host identifiers into logs, evidence or a
  journal, and do not paste them into a report.

## After the write

- Verify independently: read the object back and check the business invariant, not the HTTP
  status and not the id the request returned.
- Say what was observed by whom. A write mediated by a wrapper is `mediated`; a claim by the
  adapter about itself is `declared`; only an invariant the target enforces is
  `externally-enforced`.
- If live verification is unavailable, the result is unverified. Report it that way rather
  than recording a pass.
- Do not undo a remote change by re-running the operation. If a rollback is needed, state
  the inverse operation, its approval, and its verification separately.
