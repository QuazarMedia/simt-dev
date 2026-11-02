---
simt-affects: ["test/tier.mjs", "test/tiers.test.mjs", "scripts/run-tests.mjs", "package.json", "docs/architecture/testing.md", "CONTRIBUTING.md"]
simt-supersedes: []
---
# ADR-137 — the suite has two tiers, and the tier is a property of the file

Status: accepted · 2026-11-02

## Context

Review 0003 Q92 measured one tier: 1,373 tests, 2.5–4 minutes, every file run whatever the
change touched. A change to `src/markdown.mjs` paid for 84 test files that spawn the CLI, and
the focused run that ADR-003 makes the default gate had no cheaper form than the full one.

The obvious repair is a list of files per tier, and it is the one repair that fails silently.
A new integration file left off the list still passes `test:unit`, and the tier it is missing
from is the tier the change needed.

## Rulings

1. **Two tiers, and a file belongs to one by what it does.** `test/tier.mjs` classifies a test
   file as `integration` when its own source reaches the CLI — `child_process`, the shared
   `simt` helper imported as `simtCli`, or the `BIN` path — and `unit` otherwise. There is no
   list to maintain, so a new file is in its tier the moment it exists.

2. **`scripts/run-tests.mjs` runs a tier**, and `package.json` exposes it as `test:unit` and
   `test:integration`. Measured on this tree: 392 unit tests in 9 s, 1,439 integration tests in
   55 s, against 1,831 in 63 s for `npm test`.

3. **`npm test` is unchanged.** It keeps its own `node --test … test/*.test.mjs` shape, because
   `test/ci.test.mjs` asserts that the script names the files it runs — `node --test test/` is a
   directory that node 22 and 24 resolve as a module path, and the assertion is worth more than
   one entry point for both. `npm test` therefore runs every file, in both tiers.

4. **The gates do not move.** Pre-push and the shipped CI workflow still run the full suite:
   ADR-003 names pre-push on a protected branch a full-suite trigger, and a tier split is not a
   licence to push on half a gate. The tiers serve the focused run, which ADR-003 already makes
   the default; they do not narrow the trigger.

5. **The partition is asserted, not assumed.** `test/tiers.test.mjs` fails when a file falls out
   of both tiers, when a unit file turns out to import `child_process`, or when the classifier
   stops recognising a CLI spawn. A tier that quietly runs less than it claims is the failure
   this record exists to prevent.

## Consequences

- `npm run test:unit` is the shape of a focused run: 392 tests, nine seconds, no subprocess.
- Coverage and the whole-suite triggers keep running `npm test`; nothing about what counts as
  evidence changes (ADR-006).
- One extra process hop in a tier run (`spawnSync` from `scripts/run-tests.mjs`), and `npm test`
  keeps its direct form, so the suite's own startup cost is unchanged.

## Rejected

- **A `test/unit/` and `test/integration/` directory split.** It moves 129 files and rewrites
  every relative import to `../src/…`, for a classification the file's own source already
  answers.
- **A maintained list in `package.json`.** The list is a second copy of the test set, and it
  fails silently (see Context).
- **Routing `npm test` through the new runner.** It breaks the file-naming assertion in
  `test/ci.test.mjs`, whose comment records the four red matrix legs it was written for.
