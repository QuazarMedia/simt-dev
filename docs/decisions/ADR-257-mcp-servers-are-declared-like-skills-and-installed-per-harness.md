---
simt-affects: ["graph/mcp.json", "src/mcpconfig/dialects.mjs", "src/mcpconfig/status.mjs", "src/mcpconfig/install.mjs", "src/mcpconfig/toml.mjs"]
---

# ADR-257 — MCP servers are declared like skills and installed per harness

Status: accepted · 2026-11-23

## Context

Which MCP servers a repository should run, and where each harness stores them
(`.cursor/mcp.json`, `.codex/config.toml`, …), was knowledge every repository had to
carry on its own: the tool projected rules and skills, but a reader who adopted it still
had to hand-write every server into every harness's config. Plan 0009 settles how the
tool ships that knowledge: `graph/mcp.json` declares servers the way
`graph/skills.graph.json` declares skills, `brief` surfaces them, `simt mcp status`
reports entry-level drift, and `simt mcp install` writes the project-scoped config.
The rulings below are the four boundaries that implementation (M01–M04) observes, and
what a reader of this repository needs in order to extend the set.

## Rulings

1. **The registry is package data with a closed entry shape.** `graph/mcp.json`
   sits beside the skill registry but is *not* workspace data: skills resolve across
   workspace members, while servers are declared once per package and overridden only
   by `--registry <path>`. The entry shape is closed — `id`, `name`, `summary`, a
   `transport` that is `{type: "stdio", command, args}` or `{type: "http", url}`, and
   `capabilities` — because status's comparison and install's write render from the
   *same* shape: a server that cannot be expressed in it is not shippable, and the two
   doors cannot disagree about what an entry means. A server with no capabilities is
   never auto-offered by `brief`; it is installed on request and reported, not
   recommended.
2. **Install writes project scope only.** Every path `mcp install` writes is
   project-relative, taken from the harness's own facet (`loader.mcp`); user-scope
   files are never touched, so a run cannot reach past the repository it was invoked
   in. A harness whose configuration lives nowhere project-scoped (the DeepSeek plugin
   row) is reported `not-ours` with its vendor note, not written.
3. **Status claims file facts, never acceptance.** `simt mcp status` reads the config
   file and reports `present`, `absent`, `drift` (the entry's data differs from the
   registry) or `unreadable`; comparison is on canonicalised entry data, so a
   hand-written file with a different key order is not drift. It does not start the
   server and never claims it is enabled: acceptance is a vendor-side fact, and status
   names the verify command instead of pretending to run it. An `unreadable` file is a
   problem (the run exits FAIL); `absent` and `drift` are states, not failures.
4. **The TOML subset owns tables, not lines.** For a harness whose config is TOML
   (codex), the tool reads and writes only the tables under its own container
   (`mcp_servers`): a rewrite drops the owned blocks and preserves every other byte in
   place, which is what makes install idempotent — a second run over its own output
   changes nothing. A file whose *owned* tables carry content outside the subset is
   refused and named, and no other harness is written: a half-written install across
   harnesses is a state the reader cannot untell.
