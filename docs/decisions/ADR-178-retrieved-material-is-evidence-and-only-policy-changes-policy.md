---
simt-affects: ["src/work/trust.mjs", "test/work-trust.test.mjs"]
simt-supersedes: []
---

# ADR-178 — retrieved material is evidence, and only the repository's own policy changes policy

Status: accepted · 2026-11-03

## Context

Retrieved text is the least trusted input in the system and the one most likely to be read as an
instruction:

- a hostile document or tool result broadened the effect set, invoked another adapter or rewrote
  the rules a run followed;
- derived chunks lost the label of the source they came from;
- an adapter was called with a path outside its root, a URL to an unexpected host, an oversized
  input or an argv the schema never allowed;
- a denied path's content reached an index, a vector, a receipt or an error message;
- hashing a credential was treated as access control;
- an assurance report described mediation it did not have.

## Rulings

1. **Three labels, attached to content.** `control` is the repository's own policy, `contract` is
   reviewed, `evidence` is everything else. Only `control` may change what the rules require; a
   contract may be relied on and still cannot rewrite policy.

2. **Labels are inherited.** A derived chunk carries its parent's label, because a summary of
   evidence is evidence.

3. **A path resolves inside its root or is refused.** An absolute path, a parent reference and an
   empty path are all refusals; the adapter's root is the whole world it may read.

4. **A call is validated before dispatch:** declared adapter, declared operation, argv without
   control characters, in-root path, allowed scheme, no embedded credentials, and an input bound.

5. **A denied path is not indexed, summarised or quoted.** "Appears nowhere" starts with not being
   indexed; an error message that quotes the content has already leaked it.

6. **Redaction reuses the repository's scanner.** `src/secrets.mjs` already knows the patterns;
   a second list would drift from the first.

7. **Assurance states what it covers.** The report names the unmediated routes, says a shared
   account cannot separate actors, and keeps `requiresPlatformAuthorization: true`: an approval
   recorded here never substitutes for the platform's own check.

## Consequences

- The module is pure and reads nothing, so a policy decision over retrieved content can be
  replayed and diffed.
- Credential hashing is not a control anywhere in this path: access is a decision, not a digest.
