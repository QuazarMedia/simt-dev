---
simt-affects: ["src/index/why-graph.mjs", "src/index/commit-citations.mjs", "src/commands/why.mjs"]
simt-supersedes: []
---
# ADR-248 — Governance witnesses carry typed paths and commit citations

Status: accepted · 2026-11-22

## Context

A direct declaration is one kind of governance evidence. A dispatcher,
an imported contract or a historical commit can explain a relationship
that the current record does not spell out for the target file.

## Rulings

1. **Explain command and dependency reach with exact paths.** A command
   witness follows at most two imports from its command module. Use the
   shortest witness for each decision and target. Inherited authority
   follows one outgoing import.

2. **Use the appropriate graph basis.** A named tracked file may use a
   verified staged index. Diff, directory and symbol queries read the
   live graph. Report the basis and any truncated witness list.

3. **Keep citations historical.** Record ADR identifiers named in the
   last 500 non-merge commits with each commit SHA and touched path.
   Update on index builds and rebuild the bounded history after rewrites.
   A commit citation does not establish current authority.

## Consequences

`simt why` can summarize files in a directory or diff and can resolve a
symbol with `<path>#<symbol>`. The legacy path report is available with
`--retrieval v1`.
