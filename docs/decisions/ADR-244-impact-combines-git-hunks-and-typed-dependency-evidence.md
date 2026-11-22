---
simt-affects: ["src/commands/impact.mjs", "src/index/impact-targets.mjs", "src/sys/changes.mjs"]
simt-supersedes: []
---
# ADR-244 — Impact combines Git hunks and typed dependency evidence

Status: accepted · 2026-11-22

## Context

Reviewers need one impact report for a change set or a prompt. A specific
function edit and a module-level change support different reachability claims.

## Rulings

1. **Narrow only with complete range evidence.** Read names and zero-context
   hunks from the same Git diff. Use symbol reach when every hunk in a
   modified file fits an observed source scope. Keep file reach for new or
   deleted files, edits outside scopes, and unavailable ranges.

2. **Keep evidence by relationship.** Report structural reach and tests with
   their hop tiers, then report directional co-change partners not already
   reached. Return up to three positive lexical matches when requested or
   when structural evidence is empty. Governance, owners, and consumers are
   aggregated across targets.

3. **Use one reader for CLI and MCP.** Multiple targets, diff hunks, and task
   requests select v2. A legacy single target can still request v1 and keeps
   that format by default.

## Consequences

Git hunks, explicit targets, and anchors from a task use the same live graph.
A model can call the read-only impact tool without generating a shell command.
