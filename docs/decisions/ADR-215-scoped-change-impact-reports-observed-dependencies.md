---
simt-affects: ["src/knowledge/local-impact.mjs", "src/sys/changes.mjs", "src/commands/knowledge.mjs"]
simt-supersedes: []
---
# ADR-215 — Scoped change impact reports observed dependencies

Status: accepted · 2026-11-21

## Context

Explicit impact documents can answer typed change questions. A repository with
existing Markdown and procedure annotations needs the same walk from its Git
diff. A scope may own only a fraction of the changed paths.

## Rulings

1. The selected work scope governs source reads and dependency reporting. A Git
   rename supplies both paths and can preserve a reference when the anchor
   still exists. An unresolved reference remains a coverage gap.
2. Reviewed citations, authored procedure annotations and observed code imports
   retain their own basis. Proposed document references remain proposals.
3. A tracked derivation document supplies generation receipts. Changed inputs
   and tools can put an output in question. An output digest that disagrees
   with the recorded output requires review. Impact never invokes a generator.

## Consequences

- Source gates and scoped impact share the Git change reader. Scope and path
  permissions are evaluated before reading a source or sidecar.
- Existing explicit impact and derivation input forms remain available.
