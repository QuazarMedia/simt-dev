---
simt-affects: ["src/brief/assemble.mjs", "src/brief/local-work.mjs", "src/commands/brief.mjs"]
simt-supersedes: []
---
# ADR-218 — A scoped brief carries committed citations and current local verification

Status: accepted · 2026-11-21

## Context

The default brief carries pointers to authored knowledge. A maintainer can
explicitly ask for a scope when the next action needs sources and verification.

## Rulings

1. `brief --scope <id>` reads the declared local scope. Only committed source
   revisions enter the citation summary. Source bodies and local task notes
   stay outside the packet.
2. The packet uses the existing proof byte cap and names how to open each
   cited section. Verification remains a read-only summary with its own
   status and selection commands.

## Consequences

- The unscoped brief, projected rules and MCP tool arguments retain their
  existing behavior.
