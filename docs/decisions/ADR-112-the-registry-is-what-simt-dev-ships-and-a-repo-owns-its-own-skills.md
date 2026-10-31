---
simt-affects: ["graph/skills.graph.json", "src/resolve/local.mjs", "src/commands/skills.mjs", "src/projection/disclosure.mjs", "src/resolve/body.mjs"]
simt-supersedes: [{ adr: "ADR-009", ruling: 4 }]
---

# ADR-112 — the registry is what simt-dev ships, and a repo owns its own skills

Status: **accepted** · 2026-10-31 · filed as S4 (plan 0005) · supersedes ADR-009 ruling 4

## Context

ADR-009 settled the layout: a skill is `<name>/SKILL.md` with mandatory `name`
and `description` frontmatter, and body size and reference count are declared in
`graph/skills.graph.json`, "so the registry stays the single source of truth for
resolution metadata". The layout half of that ruling was about one estate's
thirty-nine skills, and the metadata half assumed the estate was the universe: a
skill not in the graph is a skill that does not exist.

Plan 0005 broke that assumption in two slices. S2 removed the thirty-one
repo-specific entries from the graph, leaving the eight skills this tool ships —
`simt-commands` and seven vendored stack skills. A graph that describes one
estate and is read by everyone was ADR-061's finding; a graph that is one
estate's whole skill population is a stronger claim ADR-061 did not make, and S2
made it false. S3 then gave the repo's own skill directories standing in the
resolver: `skills find`, `brief`, `show` and `why` answer for a skill the
registry never declared, synthesising its node from the file — name and summary
from frontmatter, size from the file, body from the path (commit 7d44071).

A reader of ADR-009 acting on the metadata sentence concludes that a skill absent
from the graph has no resolution metadata, and therefore cannot resolve. That
conclusion is now false in every repo that keeps its own skills, and a record
that says what the tool no longer believes is the failure this directory exists
to prevent.

## Ruling

1. **The graph is a catalogue of what simt-dev ships, not the sole home of
   skills.** Membership in `graph/skills.graph.json` is a statement about the
   package, not about existence. A skill a repository installed in its own skill
   directories exists and resolves with no entry in the graph.
2. **A repo's skill directories are a first-class source of resolution.**
   Presence is the eligibility signal — a skill the repo installed is about the
   repo, and the stack it belongs to is the stack the repo has. Frontmatter
   supplies the name and the summary; the file supplies the body and the size.
   This is the mechanism S3 shipped; the ruling records it so the reader learns
   what the tool believes without reading the plan.
3. **Where a name is in both, the registry entry is canonical.** The graph entry
   and the local file are one skill — the file is the installed copy of what the
   graph declares — and keeping both would rank one skill twice. The graph wins
   the dedupe; the local node is dropped, not merged.

## Consequences

- ADR-009's layout ruling stands and is load-bearing: discovery reads `name` and
  `description` from frontmatter, so a local skill without them is invisible,
  which is the defect class ADR-009 exists to prevent. What moves is the metadata
  sentence: a local skill's resolution metadata is synthesised from the
  filesystem, not read from the graph, so the graph is no longer the single
  source of truth for it.
- `skills find`, `brief`, `show` and `why` answer for names the registry never
  declared. The NOT SELECTED block no longer points a reader at a `skills show
  <name>` that 404s for a name the graph does not carry.
- Nothing in the shipped bytes changes. ADR-061 stands as written: the registry
  is workspace data, the package ships none of it, and a command that finds no
  registry says so. This record settles the half ADR-061 left open — who is
  allowed to have skills the catalogue does not name — without touching its
  rulings.
- `skills index` keeps reporting the catalogue only: it is the tier-0 view of
  what this tool ships, and local skills surface where a repo is the context,
  which is `find` and `brief`.

## Rejected

- **Rewrite ADR-009 in place.** The supersession rule this directory opens with
  is a new record and an edited status line, never a rewritten ruling. ADR-009's
  audit data — the forty-six frontmatter tallies that found the flat file — is
  evidence its own ruling relies on, the same shape that kept ADR-011 standing
  when ADR-012 reversed it.
- **Annotate ADR-009 without a record.** The supersession is a claim about what
  the tool believes, and a claim without a record is a ruling nobody can cite.
  The annotation points at ADR-112; ADR-112 carries the argument.
