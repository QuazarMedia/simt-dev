---
simt-affects: ["src/brief/assemble.mjs", "src/commands/brief.mjs", "src/commands/skills.mjs", "src/mcp/tools-facts.mjs", "src/mcp/tools-read.mjs", "src/mcp/schemas.mjs", "src/resolve/resolve.mjs", "src/commands/spec.mjs", "test/mcp.test.mjs", "test/parity.test.mjs", "test/resolve.test.mjs", "test/workspace.test.mjs", "test/mcp-session.test.mjs", "docs/reference/mcp.md", "docs/decisions-index.md"]
simt-supersedes: [{ adr: "ADR-035", ruling: 5 }, { adr: "ADR-052", kind: "superseded" }]
---

# ADR-226 — The skills brief is a view of the packet, not a second packet

Status: accepted · 2026-11-21

## Context

Plan 0003 R27 built `simt brief` and named it the replacement for `skills brief`, but the
tier-1 command and MCP `skills_brief` stayed in place. The row was deferred because retiring
them moves two records at once: ADR-035 ruling 5 (the no-input `warning` field, a field the
packet does not have) and ADR-052 (the `--skill` forcing and the shared budget arithmetic).
It also changes an MCP output schema. No ADR covered the move, so two packet builders
survived.

They had already drifted. `skills brief` kept a 20,480-byte default, inlined bodies up to the
budget, and rendered its own RESOLVED / NOT SELECTED / BODIES blocks; its MCP alias returned
that document. `brief` packs a packet with one ceiling, never inlines a body, and reports
what it cut. Review 0003's migration table names the target: `skills brief` becomes
`skills select`, which is `brief --only skills`, with one budget.

## Rulings

1. **There is one packet and one budget.** `brief` gains `--only <section>`; `skills brief`,
   its `skills select` alias and MCP `skills_brief` render the packet's SKILLS section. The
   20,480-byte tier-1 default is withdrawn: the packet's 2,048-byte default applies, and
   `--budget 0` (or the skills view's `--all`) asks for the whole answer.

2. **The skills view carries names, sizes and reasons, not bodies.** A body is read with
   `skills show`, which makes its cost visible before it is paid. `--skill` forcing and
   `--plan` are withdrawn: the task text and paths select, and `skills show` / `skills find`
   cover the override and discovery cases. This is the progressive-disclosure rule the
   packet already followed.

3. **MCP `skills_brief` returns the brief document with `only` applied**, not a second
   schema. It is read-only like every tool: a cold repository is told `run: simt index`
   instead of being handed a registry-only packet under the same name.

4. **The duplicate engine is deleted, not left dormant.** `skillsBriefFacts`, its renderer,
   `emitAllFacts`, `pointerLine` and `readBody`'s brief-only siblings are gone;
   `selectWithinBudget` — ADR-052's whole arithmetic — is removed with its tests because
   `packet.mjs` now owns the budget. A parity test compares MCP `skills_brief` with
   `brief --only skills` at a tight and an open budget, so the two surfaces cannot drift
   again without a failure.

5. **A removal is reported by the packet's own cut line.** The view keeps the packer's
   `cut` output, so a view that dropped lines says so rather than looking complete.

## Consequences

- `simt skills brief` and `simt skills select` still run, with the packet's 2,048-byte
  default and no body. `--skill` and `--plan` are breaking removals; the next release notes
  them.
- MCP `skills_brief` is a view of `brief` and declares `output.brief`. A cold index is an
  error with the remedy `simt index`, not a fallback document.
- `skills_brief`'s tool description now points at `skills_show` for a body and at `brief`
  as the entry point; `skills_find` points at the brief rather than the retired name.
- `selectWithinBudget` disappears from `resolve.mjs`; its dependency-direction and
  deferred-pointer tests go with it, because the packet's packer is now the only budget.
- The skills view is empty when the registry selects nothing (for example a task whose words
  match no skill, in a repository whose stack excludes the candidates). It prints a blank
  line rather than a second, registry-wide catalogue: `skills find` is that catalogue.

## Rejected

- **Keep two budgets.** That is the drift ADR-052 was filed to end; the view exists so a
  caller cannot get two answers to one question.
- **Alias the name but keep the v1 output.** The document would still inline bodies and
  print a `warning` field, so `skills brief` and `brief --only skills` would disagree while
  claiming to be one command.
- **Delete the command names outright.** Scripts and agents call them; the alias keeps both
  spellings working while removing the second engine.
- **Keep the cold-index fallback.** It made the same tool name return two different
  documents, and it was the one path by which a read-only MCP call could appear to answer
  about a repository it had never indexed.
