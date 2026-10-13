# ADR-068 — The revision list is a claim about revisions that were read

Status: **accepted** · 2026-10-13 · filed as S43
**Affects:** `mcp`, `src/mcp/server.mjs`, `src/mcp/tools.mjs`, `src/mcp/schema.mjs`, the
protocol tests in `test/mcp.test.mjs`

## Context

Review 0002 found the MCP surface pinned to one protocol revision and two behind the
published specification, and returning text only: no structured content, no output
schemas, and no hint that any of the ten tools were read-only. The finding is accurate and
so is its severity, which is P2 rather than P1 for a reason the row states itself — a
client that predates a field still reads the text block, so the surface works, it just
cannot be validated and cannot cache.

The tempting fix is to look up what the newest revision says and implement it. ADR-067
settled a neighbouring question one release ago: a row that cites a document nobody read
is decoration that misdescribes the artefact. The same trap waits here, and it is worse,
because a protocol is the one thing in this repository where being confidently wrong is
not a style defect — it is a client that believes a feature is on.

So the revisions this server speaks were read. Each of the three changelogs was fetched
and read, and what follows is what actually changed for a server on stdio — which is a
smaller list than the changelogs, because most of each revision's changes are about HTTP
transports, sessions and authorization that a stdio server never had.

## Rulings

1. **The revision list cites what changed for this transport.** Three revisions are
   supported. The 2025-06-18 revision already had structured tool output, so the gap this
   review found was never the missing feature — it was the missing declaration. The
   2025-11-25 revision changed nothing a stdio server depends on, and is supported because
   a client on it is a real client. The 2026-07-28 revision removed the handshake, made
   every request carry its own version in `_meta`, added a discovery method that servers
   must implement, required a result-type field on every result, required a cache lifetime
   on list results, removed the liveness method, and moved the resource-not-found code from
   the implementation range to the invalid-params one. Each of those is implemented and
   each has a test.

2. **The version is read from the request, and remembered only where a client needs it.**
   A request that names its version in `_meta` is answered at that version, with no
   memory involved — that is the newest revision's shape, and it is stateless by design. A
   client that negotiated through `initialize` sends bare requests forever after, so the
   stream keeps one remembered revision for it. A client that never says anything gets the
   newest. The remembered value exists for exactly one group of clients and is labelled as
   the residue of a handshake the specification removed.

3. **An unsupported version fails at the one place the client checks.** `initialize`
   answers with the server's own revision, which is the older revision's guidance and the
   only thing that works there. A per-request version we do not speak returns the
   specification's own error for it, naming every revision we do. Silence there would be
   the failure this whole row is about: a client proceeding against a shape we never
   implemented.

4. **Removed methods are refused by name, not dropped.** The liveness method was removed
   in the newest revision, so a client on it gets a method error saying which revision
   removed it, while a client on either older revision still gets its answer. Dropping the
   method entirely would have broken the older clients; answering it to everyone would
   have told the newest one we support something we do not.

5. **Every result carries both blocks, and every tool declares both shapes.** The text
   block is what a client that predates structured content reads; the structured block is
   what a client validates against the declared output schema and what it can index. One
   without the other leaves half the clients guessing. The same holds for a failure, which
   stays a result rather than a protocol error, because a client that renders an exception
   renders no answer at all. The declared shape per tool is what makes the pair checkable,
   and the test calls every tool with the least a client would send and validates what
   comes back.

6. **The byte ceiling bounds the text block only.** A caller who sets a ceiling wants a
   smaller answer, not a malformed one: the structured block stays whole, so it keeps
   matching the schema, and the text block says how much was omitted and how to ask for
   more. A tool that truncated the structured block would make the one representation a
   client can validate fail validation.

7. **The schema checker is in this repository.** The output schemas are here, so the thing
   that reads them is here too: a dependency would be a second copy of rules that could
   drift out of date without anyone noticing, and a tool that has to validate an answer
   has to work on a machine where nothing was installed. The checker understands a small
   set of keywords and throws on one it does not, because a keyword it ignored would turn
   every schema using it into decoration — the check would pass, and the payload would not
   match.

## Consequences

A client on any of the three revisions gets an answer in the shape it asked for, and one on
the newest can cache the tool list for an hour instead of asking on every conversation. A
client that validates gets a real failure message when a payload grows a field nobody
wrote down, which is how the schemas here were corrected on the day they were written:
five of them described a payload that does not exist in that shape.

Nothing here adds a resource. Rules and decisions are readable through tools today, and
publishing them as resources is the next half of the review's fix rather than a detail of
this one.

## Rejected

- **Implementing the newest revision only.** It would have broken every client that
  negotiates, and the specification's own guidance for `initialize` is to answer with what
  the server speaks.
- **Echoing whatever version a client asks for, as the old code did.** That was the
  original defect: the echo was true for one revision and a guess for the rest.
- **Answering the removed liveness method to everyone.** A client on the newest revision
  would read a success as support for a method the protocol deleted.
- **Truncating the structured block with the text.** The one representation a client can
  check would fail the check.
- **Taking a JSON Schema validator from npm.** Zero runtime dependencies is a hard
  requirement, and the schemas being validated live in this file, so the rules and the
  reader of the rules belong together.
- **Declaring a resource capability with no resources behind it.** A capability is a
  promise a client will wait on, so it is declared only when a method answers.
