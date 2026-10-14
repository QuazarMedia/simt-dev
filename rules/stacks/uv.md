---
simt-id: uv
simt-title: uv
# Selected on the lockfile, not on the language. `python` used to carry `uv run` and
# `uv.lock` in its body while selecting on any Python marker, so a Poetry project was
# told to run a tool manager it does not use (S28, ADR-047).
simt-applies: [has-uv-lock]
simt-priority: convention
simt-scope: ["uv.lock", "pyproject.toml"]
---

# Stack profile: uv

Applies to: `has-uv-lock` — a `uv.lock` is committed, here or in a workspace package.
The language rules are in the `python` profile, which every Python repository gets.

## Invocation

- `uv run -m pytest`. **Never** `uv run pytest`: the console entrypoint can miss the
  `uv` import path and silently run against the wrong environment, importing a
  different copy of the package than the one under test.
- `uv run ruff check src tests` for lint; never a bare `ruff` from a different
  environment.
- The same rule in every form: `-m <module>`, never the console script name.

## The lockfile

- Do not run `uv sync` unless explicitly asked. It mutates the lockfile mid-task, and
  the resulting diff is not yours to review.
- `uv add` and `uv remove` change `pyproject.toml` and the lockfile together. Never
  hand-edit one without the other; a lockfile that disagrees with its project is a
  build that reproduces nothing.
- `uv.lock` is committed. An uncommitted lockfile means the resolution a CI run
  performs is not the one the last developer tested.