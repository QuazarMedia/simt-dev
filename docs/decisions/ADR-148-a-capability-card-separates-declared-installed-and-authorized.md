---
simt-affects: ["src/work/capabilities.mjs", "src/work/assurance.mjs", "test/work-capabilities.test.mjs", "packages/bench/src/work-probes.mjs"]
simt-supersedes: []
---
# ADR-148 — a capability card separates declared, installed and authorized, and reading a card is not an action

Status: accepted · 2026-11-03

## Context

A repository with documents and remote targets asks a question a code repository never has
to: what can be verified here, right now? The tempting answer collapses four facts into one.
A gate declared in the manifest, an adapter installed on disk, a target that answers a
request, and an actor holding a permission all render as "supported" — and the weakest of
them inherits the credibility of the strongest. An endpoint that answers a ping is then
mistaken for a place the tool can read, and a permission for a place it can write.

The alternative is worse in the other direction: probing the target to fill the card. A
report that opens a socket has become an action, and it has done so without going through
the authorization that a real action needs.

## Rulings

1. **Five sources, kept apart.** A card names the repository's declaration (`declared`),
   the probed local runner (`local`), the installed adapter (`adapter`), the target's
   reported capability (`target`) and the actor's grant (`authorized`). They are fields and
   evidence, never one merged word.

2. **`available` requires something installed that can carry the check out.** A declared
   command, a present runner manifest, or an adapter on disk. A declaration of intent and a
   target that answers are not availability.

3. **`authorized` is permission, not capability.** An actor granted a write with no installed
   adapter to perform it reports `authorized: true, available: false`. Neither field is
   derived from the other, and neither is inferred from reachability.

4. **Completing a card is read-only.** Observations and authorizations arrive as records the
   caller already holds; the card never calls a target, runs a check, or reads a credential
   file. A reachable endpoint is not a read path.

5. **A rubric without a callable adapter is an agent workflow.** It is reported as
   `mode: agent-workflow`, not as an unavailable check and not as a passing one, because
   nobody can say what an agent following a rubric produced.

6. **Assurance stays a level with a subject (ADR-142).** A card floors at `declared` and
   reaches `observed` only from an observation record that names its target. One level table
   serves both the cards and the adversarial probes; a second copy is how two surfaces come
   to report two different sets of levels.

## Consequences

- `src/work/assurance.mjs` is now the single level table; `packages/bench/src/work-probes.mjs`
  re-exports it, so ADR-142's rulings and its test are untouched.
- Consumers get one card per validation kind in a fixed order, which is what a renderer and a
  future `verify plan` need; no command surfaces the cards yet.
- A card can be complete while the repository is unverifiable — `available: false` with a
  reason naming the missing piece is the honest answer, and it is not a failure to be
  repaired by guessing.
