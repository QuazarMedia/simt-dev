# ADR-053 — The Node floor is 22.20.0

Status: **accepted** · 2026-10-10 · affects `package.json`, `src/ci/workflow.mjs`, `src/resolve/resolve.mjs`

## Context

Node 20 reached end of life on 2026-04-30. `engines.node` still said `>=20`, both workflow
templates pinned setup-node to `20`, and `matchesGlob` was a hand-written translation because
`path.matchesGlob` is stable from Node 22.20.0 (and 24.8). ADR-042 recorded that translation
and said ruling 1 collapses into the built-in when the floor moves. Review 0002 S47 settles
the floor at `>=22.20.0` and says the own CI runs 22, 24 and 26.

## Ruling

**One.** `engines.node` is `>=22.20.0`. Both workflow templates pin `actions/setup-node` to the
version that range names, read from `package.json`, so a template cannot name a version the
package says it does not run on. This repository's own gate also runs Node 24 and Node 26. A
floor that is only executed at the minimum is a floor in name.

**Two.** `matchesGlob` is `path.matchesGlob`. A trailing double star also matches the directory
itself: the built-in requires a child, so `migrations` misses `migrations/**`, and that empty
path is the one `graph lint` builds (ADR-042, ruling 3). A glob containing `?`, `{` or `[`
matches nothing, so ruling 4 still holds. Ruling 1 of ADR-042 is superseded by this record.
Rulings 2, 3 and 4 of ADR-042 stand.

**Three.** The runtime line is the same sentence in `package.json`, both templates, this
record, plan 0002's live Runtime line, and `README.md`. The README states the floor and
nothing else; the packaging README is S18 and does not get to pick a different floor.

## Rejected

**Waiting for S18's README before raising the floor.** The floor is what CI and the matcher
run on. A missing README was not a reason to keep declaring a runtime that is end of life.

**Pinning both templates at Node 24 in this record.** S48 owns "templates use 24", the SHA
pins, and the macOS matrix. This record's adopting template uses the floor so it agrees with
`engines`. The own gate's extra versions are coverage, not a second floor.

**Letting `path.matchesGlob` implement `?` and braces.** It does, and that is how `src/a?.ts`
matches `src/aq.ts`. ADR-042 ruling 4 refused that reading because the registry does not use
it and a glob that matches the wrong paths is worse than a glob lint rejects.

## Consequences

- `compileGlob` is gone. The cases ADR-042's tests lock (`**/*.ts`, a star that does not cross
  `/`, a bare `**`) are now the built-in's, and the `?` case still fails lint.
- SHA-pinning `actions/checkout` and `actions/setup-node`, and the macOS runner, stay with S48.
- The adopting workflow's install step stays with S35.
