---
simt-affects: ["src/local/transport.mjs", "src/local/client.mjs", "src/index/store.mjs", "src/index/persist.mjs", "src/distill/distill.mjs", "test/local.test.mjs", "test/map.test.mjs", "test/distill.test.mjs"]
simt-supersedes: []
---
# ADR-204 — a local model endpoint is one bounded destination

Status: accepted · 2026-11-21 · filed as review 0005 PR25

## Context

The client validated its endpoint once and then called `fetch`. `fetch` follows redirects
by default, so a loopback endpoint could answer 302 to any host and the request would go
there with the same headers; it buffers whole responses, so a server could send without
bound; the request body was whatever the caller passed, with no ceiling; and the bearer
key was shown verbatim in errors whenever a server echoed the request back, which several
do on a 400. ADR-075's rule was "loopback unless `--allow-remote`", and every one of those
was a way to leave the endpoint the rule had approved.

The index's embedding pass and distillation's chat pass each called the client their own
way, so a policy added to one call site would not have covered the other.

## Ruling

1. **One transport, one policy.** Every local model request goes through
   `src/local/transport.mjs`. The API in `client.mjs` shapes requests and answers; the
   transport decides what may cross the socket.

2. **The destination is the configured origin.** Redirects are read rather than followed by
   `fetch` (`redirect: 'manual'`). A redirect is followed only when its resolved origin
   equals the configured endpoint's origin, and at most twice. Anything else is refused
   with the target named, and the second host receives no request.

3. **Both directions are bounded.** A serialized request body over 1 MiB is refused before
   a socket opens. A response over 16 MiB is refused, whether the size is declared in
   `content-length` or only discovered while streaming - the body is read through a
   bounded reader, not `response.text()`.

4. **A credential never appears in what a caller reads.** The key is sent as a header and
   replaced with `[redacted]` wherever it appears in an error or a server-supplied message.
   No result carries the key, the request body or the response body in an error.

5. **The exchange records its basis, not its content.** A successful call returns
   `basis: { model, endpoint, requestBytes, responseBytes, redirects }`; the index stores
   it in `meta.embed_basis` beside the vectors, and distillation returns it with its
   provenance. The model that answered is recorded; the text that was sent is not.

6. **The policy holds for every caller, including the one that opens no socket.** With
   `local` unset, or a non-loopback endpoint without `--allow-remote`, the transport is
   never reached and `socketOpened` is false - the existing ADR-075 and ADR-090 invariants
   are unchanged, and the tests for them still assert zero connects.

## Consequences

- A local server behind a proxy that redirects to another origin is refused rather than
  silently used; the error names both origins, and the remedy is to configure the final
  endpoint.
- The response cap is generous for a chat completion and an embedding batch of 32 files,
  and it fails loudly rather than truncating: a truncated JSON body would be reported as a
  non-JSON response, which is the wrong diagnosis.
- `basis` is data, not diagnostics: it is safe to print, log and store, and the tests
  assert it contains neither the key nor the content.
- The bounded reader costs one per-response loop. It is not on any read path that a
  repository without `local` configured touches.

## Rejected

- **An allow-list of extra hosts.** It is the same decision as `--allow-remote`, and a
  second list is a second place for the rule to disagree with itself.
- **Let `fetch` follow redirects and check the final URL.** The request has already been
  sent to the second host by then, with the credential attached; checking afterwards
  reports a leak instead of preventing one.
- **Trust `content-length` alone.** A chunked response has none, and a lying header is
  exactly what a hostile or broken server sends.
- **Redact by dropping the whole Authorization header.** The useful part of the error is
  usually the message next to it; replacing the secret keeps the diagnosis.
