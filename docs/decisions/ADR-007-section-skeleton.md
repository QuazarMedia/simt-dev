# ADR-007 — One canonical section skeleton

Status: **accepted** · 2026-10-05 · affects all repos

## Context

Six `AGENTS.md` files use the same conceptual sections under three different headings:

| File | Authority | Invariants |
|---|---|---|
| `simt-api`, `simt-social-media` | "Authority and Scope" | "Non-Negotiable Invariants" |
| `simt-garmin`, `simt-social` | "Authority and scope" | "Non-negotiable invariants" |
| `simt-social-api` | "Authority and **ownership**" | "Non-negotiable invariants" |

`bunnyland-server` uses a numbered 12-part layout with no equivalent sections at all.

The deeper difference is in what "non-negotiable" means. Garmin's are **platform physics**
("breaking any of these produces a product that is wrong, crashes, or cannot be shipped"); the
Social pair's are **product and privacy policy**; api/media's are **data and schema
invariants**. Those are three different kinds of claim wearing one heading, which is why the
naming drifted — nobody could tell whether the sections were meant to align.

## Ruling

One canonical skeleton, sentence case:

```
## Authority and ownership
## Non-negotiable invariants
## Engineering conventions
## Workflow and validation
```

Repos may add sections after these; they may not rename them. `bunnyland-server` keeps its
numbered layout during adoption and maps each part onto a canonical section in
`simt-dev.json`, so both structures remain navigable while it migrates.

Each invariant states **which kind of claim it is** — platform, policy, or data — so a reader
knows immediately what breaking it costs and who may change it.

## Consequences

- Cross-repo reading becomes possible: section N means the same class of thing everywhere.
- A future grep for "what are the invariants" returns a comparable list across all 16 repos.
- "Ownership" is kept in the heading because `simt-social-api` earned it by being the only
  file that enumerates ownership explicitly.

## Rejected

- **Standardise on Title Case** (`simt-api`'s variant). Capitalisation in headings is noise;
  three repos already use sentence case.
- **Normalise bunnyland to the skeleton immediately.** Its layout is 12 numbered parts of a
  Python ECS server; a mechanical conversion would produce a worse document than a mapping.
