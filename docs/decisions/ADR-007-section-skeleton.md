# ADR-007 — One canonical section skeleton

Status: **accepted** · 2026-10-05 · affects all repos

## Context

Six `AGENTS.md` files use the same conceptual sections under three different headings:

| File | Authority | Invariants |
|---|---|---|
| `repo-04`, `repo-13` | "Authority and Scope" | "Non-Negotiable Invariants" |
| `repo-07`, `repo-14` | "Authority and scope" | "Non-negotiable invariants" |
| `repo-11` | "Authority and **ownership**" | "Non-negotiable invariants" |

At least one repo outside this estate uses a numbered 12-part layout with no equivalent
sections at all.

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

Repos may add sections after these; they may not rename them. A repo that arrives with its
own numbered layout keeps it during adoption and maps each part onto a canonical section in
`simt-dev.json`, so both structures remain navigable while it migrates.

Each invariant states **which kind of claim it is** — platform, policy, or data — so a reader
knows immediately what breaking it costs and who may change it.

## Consequences

- Cross-repo reading becomes possible: section N means the same class of thing everywhere.
- A future grep for "what are the invariants" returns a comparable list across all 16 repos.
- "Ownership" is kept in the heading because `repo-11` earned it by being the only
  file that enumerates ownership explicitly.

## Rejected

- **Standardise on Title Case** (`repo-04`'s variant). Capitalisation in headings is noise;
  three repos already use sentence case.
- **Normalise a differently-shaped layout immediately.** A mechanical conversion of 12
  numbered parts would produce a worse document than a mapping.
