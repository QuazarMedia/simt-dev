---
simt-affects: ["src/index/coverage.mjs", "src/commands/gate.mjs", "src/commands/tests.mjs"]
simt-supersedes: []
---
# ADR-245 — Precise test selection requires bound Git hunks

Status: accepted · 2026-11-22

## Context

A file-level gate can reach tests through a dispatcher that serves unrelated
exports. The full file closure is still the conservative test-selection basis.

## Rulings

1. **Narrow only with sufficient evidence.** An explicit `--precise` on a
   Git diff may use observed symbol ranges when binding coverage is at
   least 90 percent along the import path. Keep direct file-level tests
   and all tests reached by bound symbols, including through a hub.

2. **Report fallback and omissions.** Use full file reach when evidence
   is missing, the path uses dynamic imports or star exports, or the caller
   requests `--conservative` or `--strict`. A narrowed result names the
   omitted hub-mediated tests and counts other file-level omissions.

3. **Rank optional co-change by directional confidence.** `tests --cochange`
   uses bounded, decayed Git-history evidence. Direct tests keep priority.

## Consequences

The default gate uses the full file import closure pending measured
regression-catching recall. The same flags apply through `tests --run`.
