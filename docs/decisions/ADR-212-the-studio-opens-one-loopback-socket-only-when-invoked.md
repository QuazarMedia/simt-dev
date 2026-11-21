---
simt-affects: ["src/studio/server.mjs", "src/studio/api.mjs", "src/commands/studio.mjs", "src/studio/public/overview.js", "test/studio-server.test.mjs", "test/studio-api.test.mjs", "test/studio-shell.test.mjs", "test/studio-overview.test.mjs"]
simt-supersedes: [{ adr: "ADR-187", ruling: 5, kind: "narrowed" }]
---

# ADR-212 — the studio opens one loopback socket, only when invoked

Status: accepted · 2026-11-21

## Context

Every door this tool ships is a one-shot process: a CLI invocation, an MCP stdio call, a hook.
A maintainer who wants to watch what the tool is doing — gates, leases, slices, the ledger —
has to run those doors one at a time and read their text. A dashboard would make the same
facts visible at a glance, but a dashboard needs a socket, and ADR-187 ruled that the rollout
opens none: a default run must never make a request, and a feature nobody enabled must never
listen. ADR-075 adds the stronger promise: nothing a reader does leaves the machine.

The tension is real only if the socket is ambient. A socket that exists because a person typed
`simt studio`, binds the loopback interface, and dies with the process is not a rollout
behaviour; it is an explicitly invoked tool, the same category as `simt mcp` holding stdio open.

## Rulings

1. **One socket, loopback only, only while `simt studio` runs.** The server binds `127.0.0.1`
   and no other address; no flag names a different one. Core resolution is untouched:
   ADR-187 ruling 5 is narrowed to the resolution paths it lists, not withdrawn.

2. **A per-launch token guards the session.** Each launch mints a 256-bit token with
   `node:crypto`, prints it once in the URL, and exchanges it on first load for an HttpOnly,
   SameSite=Strict cookie. The token is one-shot: a replayed token query is refused. The
   comparison is constant-time. The token lives in process memory and dies with the process.

3. **Every request is checked against the socket it came for.** The Host header must name the
   loopback authority the server bound, and an Origin header, when present, must match it;
   a foreign name is refused, which is the DNS-rebinding defense. Responses carry a strict
   `default-src 'self'` CSP and `nosniff`, and no CORS header is ever sent.

4. **The studio reads; it writes nothing in this ruling.** Every route serves the same facts
   the CLI and MCP doors serve (ADR-035). A control path, if it ships, is a later record with
   its own preview, confirmation and undo; this ADR grants no write.

5. **Nothing leaves the machine.** No CDN, no web font, no analytics, no third-party fetch —
   ADR-075 applies to every byte the shell loads. SIGINT and SIGTERM close the socket and
   leave the repository byte-identical.

## Consequences

- `test/studio-server.test.mjs` holds each ruling: the bind, the refusal without a token, the
  one-shot exchange, the Host/Origin check, the headers, the clean shutdown.
- `test/studio-api.test.mjs` extends the ADR-035 parity assertion to a third transport: each
  read route's JSON deep-equals the CLI's `--json` document on the same repository, and the
  check route answers without writing the gate's cache.
- `test/studio-shell.test.mjs` holds the shell to ruling 5: no shipped asset references
  another origin, the asset budget and file-line ceiling hold, and a refusal renders its
  error and remedy rather than hiding behind a loading state.
- `test/studio-overview.test.mjs` holds the Overview to rulings 4 and 5: it is a pure
  view-model over the doors' own documents, a failed slot or a refused check/work read is
  confined to its own card while the rest still answer, every finding renders with its
  remedy, and a count opens the rows behind it rather than hiding them.
- The surface inventory classifies `studio` as `optional` (ADR-207): shipped and supported
  when used, not part of the adoption path.
- A future control surface must cite this record and add its own; the read-only promise here
  is what makes the socket safe to open before that decision exists.