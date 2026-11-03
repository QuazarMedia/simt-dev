---
simt-affects: ["src/actions/intent.mjs", "test/action-intent.test.mjs"]
simt-supersedes: []
---

# ADR-169 — an authorization is about the intent, never about its rendering or its source text

Status: accepted · 2026-11-03

## Context

An approval is a decision about a specific operation, and every way of widening it silently has
already happened somewhere:

- an approval survived a change of target, actor, effect set or semantic delta, because what was
  compared was a description rather than the intent;
- a cosmetic re-render invalidated an approval, training people to re-approve without reading;
- `--yes` on a local writer plan was read as permission to act on a remote system;
- text retrieved from a document, or a resumed agent's summary of an old approval, minted a new
  one.

## Rulings

1. **The digest covers the intent, not the prose.** `scopeOf` takes the goal, target, actor,
   selectors, before-revisions, delta, effect set, verifier, contract, limits and recovery class.
   Labels and descriptions are outside it, so a re-render neither grants nor revokes anything, and
   changing a target, actor, effect, contract or delta does.

2. **Authorization sources are named.** Only `user` and `policy` may authorize. A document, a
   model, a retrieved page or a resumed agent is refused with that reason, and `bindAuthorization`
   refuses to record one.

3. **A widened effect set asks again, and names the expansion.** The response lists the effects
   the recorded authorization did not cover, so re-approval is a decision about something
   specific.

4. **`--yes` is a local writer plan and nothing else.** With remote effects present it is
   `unauthorized`, with a reason that says so; with only local effects it authorizes the plan and
   says it covers the local effects only.

5. **A dry run has no effects at all.** `buildIntent({dryRun: true})` empties the effect set rather
   than flagging it, because a flag beside a full list still reads as a list. The dry run is a
   different intent, so it carries its own approval and an approval bound to the effect set cannot
   cover it by accident.

6. **An approved bounded intent proceeds without a redundant prompt.** A matching digest and a
   covering effect set return `authorized` with `prompt: false`; the decision was already made.

## Consequences

- The manifest is a value with a digest and no clock; a recorded authorization can be replayed
  against it and diffed.
- This module decides scope, not transport: an executor still has to check the platform's own
  authorization, and a policy denial is not overridden by an approval recorded here.
