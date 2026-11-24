---
simt-affects: ["rules/core.md", "AGENTS.md"]
simt-supersedes: []
---

# ADR-261 — projected rules name the MCP surface as a second door, not a second system

Status: accepted · 2026-11-24

## Context

The projected rules tell an agent to run `simt brief`, `simt impact` and `simt check` as
shell commands, and say nothing about the MCP server that ADR-126 settled as a read-only
reader over the same functions. An agent in a harness where that server is installed sees
the tools in its catalog but is told to use a shell it may not have; nothing connects the
two, and in a shell-less harness the rules instruct commands that cannot be run. The
receiving repo's reader needs one sentence: the tools and the commands are the same
logic, and a result from either counts.

## Rulings

1. **The bridge lives in `rules/core.md`.** It is stack-agnostic and projected into every
   repo, so the sentence reaches every reader at once; a stack profile or mdc file would
   leave the other repos without it.
2. **The sentence names no flags and no tool ids.** `rules/` carries what holds
   everywhere; a flag list belongs to the command docs, which render per repo. "The tools
   answer the same questions as the commands named here" is the whole claim, and it stays
   true when a tool is added or removed because it cites ADR-126, not a surface listing.
3. **A result from either surface is the same evidence.** Evidence discipline does not
   distinguish how an answer arrived; both surfaces call the same functions, which is why
   they agree.
