# Plan 0005 — wire the knowledge doors into the default flows

Status: **queued** · created 2026-11-07

## Scope

The `simt knowledge` doors (why, rank, debt, impact, derivations, sections, export,
import) are standalone: a repository that authors inputs under `.simt/knowledge/` must
discover the doors itself, nothing validates the inputs, and the brief an agent starts
from says nothing about them. This plan wires the doors into three default flows:

1. **Agent awareness (K1)** — a `has-knowledge` fingerprint fact (directory presence,
   mirroring `has-migrations-dir`) gates a new `rules/knowledge.md`; `simt sync`
   projects it into the AGENTS.md of every repository that carries inputs, and into no
   other repository's bytes.
2. **Validation (K2)** — `simt check` validates each knowledge input that is present:
   absent is legal, unparseable or shape-mismatched is a finding with a remedy.
3. **Brief (K3)** — `simt brief` gains a pointer-only knowledge section when the
   directory exists: the directory and its README, and the doors to use. The agent
   reads the README for claim ids; the brief enumerates nothing.

Decisions (2026-11-07, with the user):

- Brief content is **pointer-only** — no claims index, no keyword matching.
- The rule gates on **directory presence**, not a manifest key.
- The MCP surface stays at three doors (why/export/import); extending it is deferred
  until a client needs it.

Out of scope: MCP tools for rank/debt/impact/derivations/sections; keyword-ranked
claims in the brief; knowledge facts in `simt gate`, `simt evidence` or `simt review`.

## Tracker

| id | state | evidence |
| -- | ----- | -------- |
| K1 | queued | — |
| K2 | queued | — |
| K3 | queued | — |

## K1 — `has-knowledge` fact + `rules/knowledge.md` (agent awareness)

The mechanism, verified in source: `fingerprint()` (`src/resolve/fingerprint.mjs`)
emits dir-presence facts (`{ name, kind: 'dir', paths }` in `FACTS`);
`isEligible()` (`src/projection/rules.mjs`) intersects a rule's `simt-applies` with
those signals; `simt sync` projects eligible rule bodies into the generated AGENTS.md
region. The work-scoped facts (`has-work-scopes`) set the precedent for a
declaration-gated profile that must not change a non-declaring repo's bytes.

Change:

- `src/resolve/fingerprint.mjs`: add `{ name: 'has-knowledge', kind: 'dir', paths: ['.simt/knowledge'] }` to `FACTS`.
- `rules/knowledge.md`: new rule, `simt-id: knowledge`, `simt-applies: [has-knowledge]`,
  priority `convention`. Body teaches the agent: the eight doors and their inputs,
  where the repository's own inputs live (`.simt/knowledge/`), that the README there is
  the repository's invocation cheat sheet, and when to use each door — `impact` before
  a change, `derivations` after a source move, `debt` for staleness, `why` for
  lineage. Read-only; none of the doors writes.
- `simt sync` projects the rule for a repository with the directory; a repository
  without it keeps its projection byte for byte.

Acceptance: `fingerprint()` emits `has-knowledge` on a tree with `.simt/knowledge/`
and not on one without (evidence recorded as the directory name, per the dir-fact
pattern); the rule loads with no frontmatter finding in `simt check`; a projection
fixture with the directory contains the rule body and one without does not.

Tests: extend `test/genericity.test.mjs` (fact emission) and `test/rules.test.mjs`
(eligibility + projection); `node --test test/genericity.test.mjs test/rules.test.mjs`.

## K2 — `simt check` validates the knowledge inputs

`checkRepo()` (`src/commands/sync.mjs`) aggregates findings; a knowledge input that
does not parse is exactly the class of defect the gate exists for — a door that
crashes on the repository's own input is a red state nobody sees until an agent
reads it.

Change:

- A validator for the six known input shapes under `.simt/knowledge/` — claims
  (`claims`/`artifacts`/`edges`), units (`units`), debt (`items`), impact
  (`graph.nodes`/`graph.edges`/`change`), derivations (`receipts`/`changes`/`observed`),
  export (`facts`/`repository`/`revisions`/`expiresAt`) — checking parse and the
  shape the matching door requires. An absent file is legal; a file that is present
  but unparseable or shape-mismatched is a finding naming the file, the defect, and a
  remedy.
- Wired into `checkRepo` so both the full check and `--changed` report it.

Acceptance: a fixture repository with a malformed `claims.json` (an edge of an
undeclared kind) fails `simt check` with the file named and a remedy printed; a
repository with valid inputs stays green; a repository without the directory is
unaffected in findings and exit code.

Tests: new `test/check-knowledge.test.mjs`; `node --test test/check-knowledge.test.mjs test/checks.test.mjs`.

## K3 — `simt brief` knowledge pointer

`assembleBrief()` (`src/brief/assemble.mjs`) builds the packet an agent starts from.
The decision is pointer-only: the section tells the agent the knowledge inputs exist
and where their own cheat sheet is; it enumerates no claims and performs no matching,
so the same tree yields the same bytes.

Change:

- When `.simt/knowledge/` exists, the packet gains a `KNOWLEDGE` section: the
  directory path, the README path when present, and the door list with one line of
  usage each.
- When the directory is absent, the brief is byte-identical to today's output — no
  section, no trailing whitespace.

Acceptance: a brief for a tree with the directory names the directory, the README,
and the doors; a brief for a tree without it is byte-identical to the pre-change
output; the section is pointer-only (no claim ids).

Tests: extend `test/brief.test.mjs`; `node --test test/brief.test.mjs`.
