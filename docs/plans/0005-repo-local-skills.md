# Plan 0005 — Repo-Local Skills

**Status:** in progress · 2026-10-31

## Scope

Remove all repo-specific skills from simt-dev's central graph. simt-dev keeps only
skills about its own usage (`simt-commands`) and truly generic stack skills. The
removed skills must exist in the repos that need them. simt-dev gains the ability to
discover and use skills that are local to a repo, not just the central graph.

## Context

The skill graph (`graph/skills.graph.json`) currently holds 39 entries. 31 are
repo-specific (tied to `repo-NN` workspace members). 8 are vendored generic stack
skills or about simt-dev itself. The graph was a central registry for a workspace
of repos; simt-dev should be a generic tool that works in any repo, discovering
whatever skills that repo has locally.

**Keep (8):** `simt-commands` (simt-dev usage) + 7 vendored generic stack skills
(cloudflare, durable-objects, firebase-auth-basics, firebase-basics, graphify,
workers-best-practices, wrangler).

**Remove (31):** all non-vendored, repo-specific skills.

## Repo Mapping

| Graph label | Actual repo | Stack | Skills on disk? |
|---|---|---|---|
| repo-02 | simt-app | gradle, kotlin | ✓ 7 |
| repo-03 | simt-blog | node, less | ✓ 2 |
| repo-04 | simt-gnss | gradle, kotlin | ✓ 1 |
| repo-05 | simt-landing | node, less | ✓ 1 |
| repo-06 | simt-social | react, firebase | ✓ 14 (has 16) |
| repo-07 | simt-social-api | cloudflare, hono | ✓ 13 (has 17) |

All skills already exist in their target repos. S1 is a verification no-op.

## Tracker

| id | state | evidence |
|---|---|---|
| S1 | Complete | f94c93a · test: verified 31 repo-specific skills on disk in mapped repos |
| S2 | Complete | 4133dba3c5067c0ee9fc907f17a9ebbc37737c8b · test: npm run test |
| S3 | Complete | 7d44071b3aa1406655ddae0b749316467f336903 · test: npm run test |
| S4 | Complete | b0da29c9200384689214510d7a384a27fd44e63a · test: npm run test |
| S5 | queued | — |

## S1 — Verify skills exist in target repos

All 31 repo-specific skills already exist on disk in their target repos.
Verify the count and frontmatter validity. No copying needed.

Acceptance: Every skill named in the graph's `sources` has a corresponding
`SKILL.md` on disk in the mapped repo. Frontmatter has `name` and `description`.

## S2 — Remove repo-specific skills from the graph

Delete all 31 non-vendored, repo-specific entries from `graph/skills.graph.json`.
Keep the 8 vendored/generic skills (`simt-commands` + 7 stack skills).
Update the capabilities list to remove capabilities that are now orphaned
(no skill covers them). Update tests that assert specific skill counts.

Acceptance: `graph/skills.graph.json` has exactly 8 skill entries.
`npm run test` passes. `simt graph lint` is clean.

## S3 — Discover local repo skills

simt-dev should find and use skills that exist in a repo's skill directories
(`.agents/skills/`, `.cursor/skills/`, `.claude/skills/`, `.opencode/skills/`)
even when they are not in the central graph. The `installedSkills()` function in
`src/projection/disclosure.mjs` already reads from disk for the AGENTS.md disclosure
section. Extend this to `skills find` and `skills brief` so they work with local
skills. Map local skills to the repo's stack via fingerprint.

Acceptance: `simt skills find <keyword>` in a repo with local skills returns them.
`simt skills brief <name>` works for a local skill not in the graph.

## S4 — Clean up ADRs

Find ADRs that reference the removed skills by name or that establish the central
registry as the sole home for all skills. Supersede or annotate them to reflect the
new model: simt-dev ships its own skills, repos own their own.

Acceptance: No ADR in `docs/decisions/` asserts that all skills must be in the
central graph. `simt rules why` resolves every citation.

## S5 — Update tests and verify

Update all tests that reference the removed skills (count assertions, leak guard,
registry lint). Run the full suite from a copy at a path with no siblings.

Acceptance: `npm run test` passes 100%. The suite passes from a standalone copy.
