# ADR-003 — Focused tests are the default; a full suite needs a named trigger

Status: **accepted** · 2026-10-05 · affects all repos

## Context

- `repo-14` / `repo-11`: "Focused tests are the default gate, and full suites are
  the exception… **absent a named trigger, running a full suite is a defect, not diligence.**"
- A repo outside this estate: `fail_under = 100` plus a full-suite script as the pre-push
  default, and a contributor loop that says "run the full gate locally (lint + tests +
  coverage)."
- `repo-07`: reframes the axis entirely as a layer-conditional 5a–5m matrix.
- `repo-13`: no policy — it just lists `npm run test:unit && npm run test:e2e`.

The Social pair make a full suite a sin. media presents it as unremarkable. The hard-gate
repo makes it mandatory. These cannot all be org rules as stated.

## Ruling

Focused tests are the default gate. Running a full suite is legitimate **only** against a
named trigger:

1. Phase exit.
2. Release gate.
3. Behaviour that crosses a system boundary.
4. A repo-declared numeric gate (see ADR-006 for where that number lives).
5. Explicit user or caller instruction.
6. Pre-push on a protected branch, in a repo that declares this trigger in `simt-dev.json`.

Re-running a full suite as a progress meter is a defect. Repos outside this estate already
say exactly this ("do not run the full gate repeatedly as a progress meter"); the principle is
adopted as canonical.

## Consequences

- Each repo's `simt-dev.json` declares which of the six triggers are active for it. A repo
  with a declared numeric gate activates 4 and 6; one repository activate 1, 2 and 3.
- A reviewer can ask "which trigger?" and get a number, not an opinion.
- media gains an explicit policy instead of an implicit one that contradicts its siblings.

## Rejected

- **"A full suite is a defect."** Wrong for a release gate and wrong for a repo whose coverage
  floor is a hard number; it makes the rule get ignored rather than followed.
- **Full suite by default.** Re-pays the whole cost on every iteration; the Social pair are
  right that an inflated brief is a defect in the brief, not thoroughness.
