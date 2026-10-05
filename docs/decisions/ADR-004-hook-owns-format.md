# ADR-004 — The hook owns format and lint for staged files

Status: **accepted** · 2026-10-05 · affects all repos

## Context

- `simt-social-api`: "lint and format are enforced by the pre-commit hook — **do not run them
  manually.**"
- `simt-social`: "the local pre-push hook republishes opportunistically when a token happens to
  be present." Never says the hook is the gate; instructs agents to run static checks directly.
- `bunnyland-server`: tells agents to run `uv run ruff check src tests` and `git diff --check`
  by hand, and CONTRIBUTING repeats it.
- `simt-api`, and 11 repos with no hooks at all: silent.

The audit also found the estate's hook reality: 4 incompatible conventions, and
`simt-app/hooks/pre-push` is **0 bytes** while the real git-lfs pre-push sits unused in
`scripts/hooks/`.

## Ruling

The pre-commit hook owns format and lint **for staged files**. Do not re-run what the hook
just ran on the same files.

Manual runs are correct when:

1. The hook is not installed in this checkout, or
2. A check failed and you are diagnosing it, or
3. The check is not hook-covered (typecheck, migration verification, contract generation).

A repo with no hook installed still runs its checks manually. Silence is not permission to
skip.

## Consequences

- The shared hook dispatcher from plan 0001 lands in every repo that has one, which also
  delivers the dead `simt-app/hooks/pre-push` fix.
- `simt-dev doctor` reports hook installation state, so "the hook will cover it" is a
  verifiable claim rather than an assumption.
- The 11 hook-less repos get a pre-commit on adoption, which ends the silent case entirely.

## Rejected

- **"Never run lint manually."** False whenever the hook is absent, which is most of the
  estate today.
- **"Always run lint manually."** Re-runs what a hook already verified, on every iteration.
