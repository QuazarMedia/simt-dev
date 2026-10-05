---
id: python
title: Python
applies: [python]
---

# Stack profile: Python

Applies to: `python`.

## Invocation

- `uv run -m pytest`, or the repository's own wrapper script. **Never** `uv run pytest`: the
  console entrypoint can miss the `uv` import path and silently run against the wrong
  environment, importing a different copy of the package than the one under test.
- `uv run ruff check src tests` for lint; never a bare `ruff` from a different environment.
- Do not run `uv sync` unless explicitly asked. It mutates the lockfile mid-task.

## Typing

- No `typing.Any`. Accept `unknown`-equivalent types (`object`) at genuinely untrusted
  boundaries and narrow explicitly.
- `Mapping` for a read-only parameter, `dict` for a value that is mutated. Returning a
  concrete `dict` from a function annotated `Mapping` forces a copy on every caller.
- Every public function annotated. An unannotated signature is a review finding.

## Tests

- `fail_under` is set per repo in `simt-dev.json` (ADR-006). Where a repo requires 100 %, treat
  it as a behavioural gate: an uncovered path is either a missing test or dead code, and both
  are defects.
- No `pytest.skip` without a pre-existing written justification.
- Test the narrowest layer that proves the behaviour; reach for an integration test only when
  the behaviour is genuinely cross-system.

## Diff hygiene

- `git diff --check` before handoff: no whitespace errors, no conflict markers, no stray
  debug prints.
- Generated artifacts (coverage output, build directories, caches) are not committed.

## Async

- `Awaitable` in annotations, never a bare coroutine where an `Awaitable` is the contract.
- No blocking I/O on the event loop.
- No unbounded task creation: a fan-out needs a concurrency limit.