# ADR-009 — Skills are `<name>/SKILL.md` with mandatory frontmatter

Status: **accepted** · 2026-10-05 · affects all repos

## Context

45 of the 46 skill entries in the estate already use `<name>/SKILL.md`. One does not:
`bunnyland-server/.agents/skills/coverage-hunt.md` is a flat 7 266-byte file that also omits the
`name` frontmatter key — the only skill in the workspace with no name.

Frontmatter field usage across all 46 entries: `name` 45, `description` 46, `argument-hint` 14,
`disable-model-invocation` 2, `references` 1, `compatibility` 1, and **`globs` zero**. No skill
in any repo scopes itself by file pattern.

That last point matters for discovery. A skill that could declare `globs: "migrations/**"`
would let the resolver select it from the diff alone. Since none do, path-based resolution has
to come from the graph registry instead — which is why `paths` lives in
`graph/skills.graph.json` (plan 0002 §3.2) rather than in frontmatter.

## Ruling

- A skill is a directory `<name>/` containing `SKILL.md`.
- `name` and `description` are **mandatory** in frontmatter.
- `argument-hint` is recommended for any skill invoked by hand, and is optional otherwise —
  simt-app's 7 skills omit it legitimately, since they are task-shaped rather than
  user-invoked.
- Body size and reference-file count are declared in `graph/skills.graph.json`, not in
  frontmatter, so the registry stays the single source of truth for resolution metadata.

`bunnyland-server/coverage-hunt.md` is wrapped into `coverage-hunt/SKILL.md` with its `name`
added during adoption.

## Consequences

- Every skill becomes addressable by one stable name across all 16 repos, which is a
  precondition for `simt-dev skills find/show/install` and for `variant-of` edges.
- The registry in `graph/skills.graph.json` becomes the one place resolution metadata lives,
  instead of metadata split across frontmatter, prose and directory size.
- `simt-dev skills eval` can key on skill names, because every skill has one.

## Rejected

- **Require `globs` in frontmatter.** Attractive, but it would put resolution metadata in two
  places and drift from the graph — the exact failure mode that produced the 8 divergent
  `.mdc` files. Recorded as considered and rejected.
- **Keep flat `.md` as an accepted form.** Two layouts means two resolver paths and two sets of
  conventions to police.
