---
simt-affects: ["src/verify/local-selection.mjs", "src/verify/select.mjs", "src/work/config.mjs", "src/work/validators.mjs"]
simt-supersedes: []
---
# ADR-216 — Scoped verification describes admissible checks before running them

Status: accepted · 2026-11-21

## Context

The explicit selector can plan over obligations the caller provides. A repository
should be able to derive obligations from a staged or working-tree change using
its declared scope and installed runners.

## Rulings

1. Repository selection retains the source import closure. It reports each
   unresolved changed path, including an ambiguous or out-of-scope path.
2. Version 3 work scopes may declare checks with an id, argv or gate reference,
   execution class, coverage kinds, and optional cwd, timeout and provider.
   Legacy validator commands cover document structure. Local selection cannot
   satisfy human review or remote obligations.
3. The plan records its staged or working-tree basis, and names unavailable
   checks. A plan supplies no execution evidence.

## Consequences

- Setup still writes the minimal version 2 declaration. Existing explicit
  verification documents remain valid.
- A complex shell gate needs an explicit argv for use by scoped verification.
