---
simt-id: python
simt-title: Python
simt-applies: [python]
simt-priority: convention
simt-scope: ["pyproject.toml", "requirements.txt", "setup.py", "*.py"]
---

# Stack profile: Python

Applies to: Python — `pyproject.toml`, `requirements.txt` or `setup.py`. The
environment rules — how to invoke tools, and which lockfile owns them — are in the
`uv` profile (`simt rules show uv`), which selects on a committed `uv.lock`.

## Invocation

- Run through the repository's own runner: `uv run` where a `uv.lock` is committed,
  `poetry run` where a `poetry.lock` is, and the repository's documented wrapper
  otherwise. See `simt rules show uv` for the form that must not be used.
- Never invoke a tool from whatever environment the shell happens to have. It will
  usually be a different copy of the package than the one under test, and the failure
  it produces looks like a bug in the code.

## Typing

- No `typing.Any`. Accept `unknown`-equivalent types (`object`) at genuinely untrusted
  boundaries and narrow explicitly.
- `Mapping` for a read-only parameter, `dict` for a value that is mutated. Returning a
  concrete `dict` from a function annotated `Mapping` forces a copy on every caller.
- Every public function annotated. An unannotated signature is a review finding.

## Tests

- `fail_under` is set per repo in the repository's manifest (`{manifest}`) (ADR-006).
  Where a repo requires 100 %, treat it as a behavioural gate: an uncovered path is
  either a missing test or dead code, and both are defects.
- No `pytest.skip` without a pre-existing written justification.
- Test the narrowest layer that proves the behaviour; reach for an integration test
  only when the behaviour is genuinely cross-system.

## Diff hygiene

- `git diff --check` before handoff: no whitespace errors, no conflict markers, no
  stray debug prints.
- Generated artifacts (coverage output, build directories, caches) are not committed.

## Async

- `Awaitable` in annotations, never a bare coroutine where an `Awaitable` is the contract.
- No blocking I/O on the event loop.
- No unbounded task creation: a fan-out needs a concurrency limit.