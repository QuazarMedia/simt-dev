---
simt-affects: ["src/mcp/tools.mjs", "test/mcp.test.mjs"]
simt-supersedes: []
---

# ADR-193 — the MCP description budget is per tool, not per surface

Status: accepted · 2026-11-03

## Context

Plan 3's R41 set a 2 KB ceiling on the description prose in `tools/list`, because the list is
cached and sent to every client. It was written when twelve tools shipped and they spent 2,035
of those 2,048 bytes.

Plan 4 ships five more read-only doors (W20/W29). With them the prose totals 3,039 bytes
across 20 tools, and the absolute ceiling cannot be met by any description of any length: the
bound stopped measuring terseness and started capping the surface. Deleting the assertion would
remove the property; trimming the five new descriptions to nothing would leave a client with no
reason to choose one.

## Ruling

The property is that no single description makes `tools/list` expensive, and that the total
grows only when the surface does. So the check is two bounds:

- every description is at most 240 bytes;
- the total is at most 240 bytes times the number of tools.

Both are enforced in one test. A description that runs long is still a finding; a tool that
arrives with the plan is not.

## Consequences

- The largest description is 222 bytes, so no existing text changed to satisfy this.
- A new tool pays for its own prose and nothing else, and a rewrite that doubles one
  description still fails.
