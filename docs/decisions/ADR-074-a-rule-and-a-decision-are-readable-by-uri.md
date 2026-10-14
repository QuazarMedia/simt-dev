# ADR-074 — A rule and a decision are addressable, so they are readable by URI

Status: **accepted** · 2026-10-14 · filed as S43
**Affects:** `src/mcp/resources.mjs`, `src/mcp/server.mjs`, `test/mcp.test.mjs`

## Context

Review 0002 filed that the MCP server is two protocol revisions behind and returns text
only. ADR-068 closed the revision half and every tool now declares an output schema and
annotations. What remained was the other half of the finding: the server has no
**resources**, so the two things this tool is actually authoritative about — the rules it
projects and the decisions it settles — are reachable only through a tool call with an
argument in it.

That matters for a client that wants to browse rather than query. A tool call asks a
question and gets an answer; a resource is something a client can list, show in a picker,
attach to a context window and re-read on demand. The CLI already answers both by id
(`rules show`, `rules why`); what was missing was the addressable form.

So the specification was fetched and read for both revisions rather than recalled, and it
turned out the two disagree in a way that decides an observable behaviour: **a missing
resource is `-32602` (Invalid Params) in 2026-07-28 and `-32002` (Resource not found) in
2025-06-18.** 2026-07-28 keeps `-32002` only as something a *client* should still accept.
Both revisions forbid an empty `contents` array for a resource that does not exist, because
empty is ambiguous — it reads as "here is a resource with no body".

Both revisions also require the capability to be declared, and both permit the empty
object for a server with no subscriptions and no change notifications. The newer one adds
`ttlMs` and `cacheScope` to resource results, which is why a resource list is cacheable on
the newest revision and is a bare list on the two older ones — the same rule ADR-068
already applies to tools.

## Rulings

1. **Two collections and no others: the rules and the decisions.**
   `simt://rules/{id}` and `simt://decisions/{adr}`. A resource set that grew with the
   registry would be a second index to keep honest, and the registry is workspace data
   (ADR-061) — the package ships none of it, so a client browsing this server in one
   repository and another would see different sets anyway.

2. **The capability is declared unconditionally, as an empty object.** Every rule and every
   decision record ships with the package, so there is always something to read; and
   `{}` is the documented way to say "no subscriptions, no change notifications", which
   are the two things this server has no way to honour. The previous code gated the
   capability on a property hung on the tools array that nothing ever set — a promise a
   client waits on forever, only quieter.

3. **A missing resource is an error, and the code is the revision's own.** `-32602` from
   2026-07-28, `-32002` from the two older revisions, and never an empty `contents`. A
   client that reads a URI and gets silence cannot tell a bug from an empty rule, and the
   two revisions disagree about which code that silence should wear.

4. **Every listed resource carries the bytes it will cost.** `size` is in the specification
   and it is the one number a client cannot get without reading: an agent assembling a
   context window needs to know what a resource costs before it spends it. This is the
   same argument as `simt tokens`, arriving at a different surface.

5. **The frontmatter is rebuilt, unprefixed, and the body's own heading is not repeated.**
   A rule on disk opens with frontmatter this tool's namespace owns (`simt-`); a resource
   is read by a client that knows nothing about that namespace, so the identity is
   reconstructed under plain keys. The loader no longer carries the H1, so the title lives
   in the frontmatter rather than being re-added by hand in two places.

6. **A decision body is redacted on the way out.** `redactInternalPaths(redactEstate(...))`,
   the same pass the CLI applies. A resource is readable by anyone holding the connection,
   which is a wider audience than the repository the CLI is aimed at, and a record whose
   argument names an estate repository should not travel further just because it became
   addressable.

7. **Every URI is validated, and a rules id cannot contain a slash.** Custom schemes are
   allowed, which is precisely why the server checks: a URI naming another scheme, a
   `..` segment, an empty id or a nested path is refused with the same revision-correct
   error as one that simply does not exist. A refusal that is distinguishable from a miss
   is a way to probe the filesystem.

## Consequences

`resources/list` answers 97 entries in this checkout — 20 rules, the process rules, and 73
decision records — and a client can attach any of them without a tool call. The templates
list publishes the two shapes, so a client can build the URI for an id it has not listed
yet.

What this does not do: subscribe to a rule changing, because there is no stream to
subscribe to and the capability says so. That is a feature, not an omission — a client
that believes it is subscribed to a projection that only changes on `sync` would be
waiting for an event this tool will never emit.

## Rejected

- **Serving resources only through tool calls.** That is what the server already did, and
  the finding is that a client cannot browse what it can only ask about.
- **An empty `contents` array for a URI that does not exist.** Both revisions treat it as
  ambiguous, and ambiguity here is what makes a client retry forever.
- **Exposing the registry as resources too.** It is workspace data and this package ships
  none of it (ADR-061); a resource list that differed per repository would be the
  same definition-of-one-thing-twice defect, one layer up.
- **One error code for all three revisions.** `-32602` on the older two would be a code
  that revision never defined, and `-32002` on the newest would be advice to clients
  rather than the specification's own answer.