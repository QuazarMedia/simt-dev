---
simt-affects: ["src/mcp/tools.mjs", "src/commands/spec.mjs", "test/mcp-spec.test.mjs", "docs/reviews/0003-pre-plan-0004-review.md"]
simt-supersedes: []
---

# ADR-127 — the MCP tool list is written by hand and held to the spec, and roots is not asked for

Status: **accepted** · 2026-11-01

## Context

Two clauses of review 0003's Q66 read as work still to do: "`tools/list` generated from
spec rows with `mcp` set", and "`roots`". Both were written before the spec rows existed,
when the four lists this review found disagreeing were the live problem and generation
looked like the answer to all of them.

The spec rows now exist, and they carry `path`, `summary`, `flags` and, for the commands
the surface exposes, `mcp: {name, flags}`. That is enough to say *which* flags a tool
exposes and not enough to say what they are: no types, no per-argument descriptions, and
no vocabulary shared with the transport. `check` declares no `mcp` flags and its tool
takes `root`; `compare` declares none and its tool takes `root`, `limit`, `cursor` and
`concurrency`. An `inputSchema` derived from the rows would describe `--dry-run` as a
property and omit `root`, which is a contract a client cannot call.

`roots` is the other direction. It is a client capability: the server sends `roots/list`
and the client answers with the directories it may touch. `src/mcp/server.mjs` answers
requests and never sends them — the only thing it writes unprompted is a notification for
a progress token the client supplied. A server that asks a question needs a correlation
table for replies, a timeout for a client that never answers, and a fallback for the
clients that do not implement the capability; and every tool here already takes its root
as an argument (`root`, `workspace`, or `--paths`), which is the same information stated
once, by the caller, where it can be read in the call rather than inferred from a
handshake.

## Ruling

### 1. The tool list stays written by hand, and tests hold it to the spec

The spec row is the source of the *command*: its path, its summary and its flags. It is
not the source of the transport's schema, which carries descriptions, types and defaults
the row does not have, and arguments the command line does not spell as flags.

What generation was meant to prevent — a tool with no command, a command nobody can reach
over the transport, an advertised flag the tool refuses — is enforced in
`test/mcp-spec.test.mjs`, in all three directions, plus `MCP_ONLY` for the one tool that is
deliberately not a command (`federation_query`, which names its reason). A hand-written
list under a test that fails on every kind of drift is the same guarantee as a generated
one, without a schema nobody would trust enough to keep descriptions in.

### 2. `roots` is withdrawn, not deferred

No tool is changed to accept an implicit root, and the server gains no request path. A
client that wants a tool to run against a directory passes it as the argument the schema
already names. If a future capability genuinely needs an answer from the client, that is
a different surface with its own correlation and timeout design, and it needs its own
record.

## Consequences

- Reading `mcp: {name, flags}` tells a reader which flags reach the transport; reading
  `src/mcp/tools.mjs` tells them what a caller sees. Both are checked against each other.
- Adding a second MCP-only tool means a `MCP_ONLY` entry with a reason, which is a place a
  reviewer looks, rather than a hole in the table.
- The 2 KB `tools/list` budget keeps being spent on descriptions a reader can act on,
  because nothing regenerates them from a summary phrase.
