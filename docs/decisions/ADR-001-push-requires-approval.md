# ADR-001 — Push requires explicit approval

Status: **accepted** · 2026-10-05 · affects all repos

## Context

Five repos state a commit/push policy. They disagree on whether an agent may push.

- `bunnyland-server/AGENTS.md` §9: "always create a focused Git commit… skip the commit only
  when the user explicitly asks not to commit." Silent on push.
- `simt-garmin/AGENTS.md` DoD #8: "**Committed and pushed** with a conventional message."
- `simt-social` and `simt-social-api`: "create a non-interactive Conventional Commit. Report
  the commit SHA; **do not push**."
- `simt-api`, `simt-social-media`: silent.

The Social pair justify it: a push to the production branch triggers Cloudflare Workers Builds,
so "an approved push is therefore a production deployment action, not only source publication."
`simt-garmin` has no such coupling, and its rule asks for an autonomous push.

## Ruling

Commit locally, report the SHA, **push only on explicit user approval**.

When a repo's push triggers a deployment, a migration, or any remote mutation, say so before
asking for approval — do not treat approval for the push as approval for the deploy.

`simt-garmin` DoD #8 changes to "committed with a conventional message; pushed on approval."
This is the single outlier, and the 4:1 majority is also the safe direction.

## Consequences

- An agent that finishes a task ends at a reported SHA. Pushes become a separate, explicit step.
- `simt-dev init` and `upgrade` propose changes and never push, including for simt-dev itself.
- Repos whose CI deploys on push must state that consequence in their own AGENTS.md, which is
  where the Social pair's rule already lives.

## Rejected

- **Autonomous push (garmin's current rule).** Removes the only checkpoint between "the agent
  thinks it is done" and "production changed".
- **Push on completion, as bunnyland's loop implies.** Same objection; CONTRIBUTING's PR step
  does not require an agent to open the PR unattended.
