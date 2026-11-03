---
simt-affects: ["src/actions/targets.mjs", "test/action-targets.test.mjs"]
simt-supersedes: []
---

# ADR-167 — a target is identified by namespace and incarnation, and a session is a credential not an identity

Status: accepted · 2026-11-03

## Context

Every remote-operation failure this plan is built to prevent starts with an object that was not
the one the operator meant:

- a hostname was used as an identity, so a target that was reset and rebuilt kept its name and
  every observation of it looked current;
- an object id was assumed unique, so the same numeric id in two tenants collided;
- an expired session was renewed with whichever credential was available, which changes the
  actor while calling itself a refresh;
- a target with no established identity was guessed at rather than refused;
- a report carried the token it had used to read.

## Rulings

1. **Identity is `(namespace, incarnation)`, together or not at all.** A hostname, a display name
   and an alias are labels a human writes; they resolve locally to a reference and never stand in
   for identity. Same hostname after a reset is a different target, and the two identities differ.

2. **Object keys include the namespace.** `objectKey` is `${namespace}:${type}:${id}`, so the same
   id in two tenants is two objects. A key missing any component is `null`, not a guess.

3. **An alias resolves locally, and an ambiguous alias resolves to nothing.** Two targets claiming
   one alias produce `ambiguous-alias` with the candidates named, because picking one is picking a
   target on the operator's behalf.

4. **A session is recorded as state and expiry, never as a token.** An expired session yields
   `reauth-required`: re-authenticate and re-observe. It never yields a different credential, and
   a snapshot observed for another actor is refused with that reason rather than switched.

5. **Unknown identity prevents mutation.** With no namespace and incarnation the state is
   `unknown-identity` and `mayMutate` is false, whatever capabilities or actor the snapshot
   carries.

6. **A declared capability is not a granted one.** `unsupported-operation` is reported when the
   operation is absent from the declared set; authorization remains the intent layer's decision
   (W32), and this module does not make it.

7. **Reports are built from declared fields.** `redactedTarget` copies only known fields, so a
   token or cookie placed on a snapshot cannot leave through a report.

## Consequences

- `src/util/canonical.mjs` now holds the canonical encoder the ledger and these contracts both
  need; the ledger's private copy is gone rather than copied a third time.
- Snapshots are values with a digest and no clock, so an observation can be replayed and diffed.
- Nothing here opens a socket: an adapter supplies the observation, and this module judges it.
