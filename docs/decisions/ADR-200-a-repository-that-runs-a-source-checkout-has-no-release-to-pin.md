---
simt-affects: ["src/projection/manifest.mjs", "src/package-version.mjs", "src/manifest/schema.mjs", "src/commands/init.mjs", "src/commands/upgrade.mjs", "src/upgrade/plan.mjs", "src/compare/row.mjs", "docs/reference/manifest.md", "test/follows-source.test.mjs"]
---
# ADR-200 — a repository that runs a source checkout has no release to pin

Status: accepted · 2026-11-20 · affects every repository that adopts simt-dev from a checkout

## Context

ADR-059 made the version a repository runs an invariant: `projection.version` records the
release it adopted, `projection.simtDevSha` records the rule digest that rendered its region,
and the dispatcher and `check` refuse when the running binary disagrees with the pin. That is
right for a *copy* — the `node_modules` dependency npm itself pins, a global install, the
release binary in `.simt/bin`. It is wrong for an *install that is a live checkout*: a sibling
clone selected by `SIMT_DEV_BIN`, or a checkout reached through `npm link`. In that install the
bytes that run are the bytes a pin would name, so there is nothing to compare against. The
recorded pin goes stale by construction: every version bump in the checkout is a
`VERSION-MISMATCH` in every adopting repository, and every generated-field refresh asks for a
number the repository never installed. The estate's sibling repositories ran that way, and the
work of rewriting the pair after each release is exactly the work this record removes.

The declaration cannot be inferred from the running binary. The same repository can be pinned
in CI (a dependency install) and run from a checkout on a developer's machine (a deliberate
override), and an adoption performed from the checkout — including every fixture the test
suite stages — would silently become a follows-source adoption. The install mode is a decision
the repository makes, not a fact the invocation happens to have.

## Ruling

1. **`projection.follows: "source"` is the repository's declaration that it runs a checkout.**
   `simt init --follow-source` records it; `simt init --no-follow-source` removes it; a
   re-init that passes neither keeps the declaration it finds. The declaration is
   repository-owned, validated at the manifest boundary, and read by every pin reader.

2. **A follows-source projection carries no release pin.** The object is
   `{ "follows": "source" }` plus any sub-key the repository owns (`place`). Generated
   `simtDevSha` and `version` are neither written nor compared; a leftover pair is
   `STALE-GENERATED-FIELD` with `simt sync --yes` as the repair, because a pin that is present
   and ignored is a number a reader will keep current and the tool will never read.

3. **The region is still checked and still re-rendered.** The declaration removes the release
   pin, not the projection's provenance. A change to the rule text still makes the region
   stale and `simt sync --yes` still updates it; that is a real change to the projected bytes,
   and the region's own `simt:sha=` stamp records the digest it was rendered from. A commit
   that changes no rule text no longer touches every adopting repository.

4. **The readers take the answer from one predicate.** `followsSource(manifest)` is the
   declaration's only reader. `assertVersionPin` (and therefore `check`, the dispatcher,
   `sync`, `slice` and `help`), `buildManifest`, `manifestDrift`, `withGenerated`/`sync`,
   `upgrade` and `compare` all call it or read the projection the writer produces; none of
   them re-spells `=== 'source'`.

## Consequences

- A follows-source repository stops reporting a version mismatch when the checkout moves, and
  stops being asked to record a release it does not install. A pinning repository is unchanged:
  npm still pins its dependency, and a repository without npm still has the pin as the only
  guard on a release binary that nothing else pins.
- The generated region remains the thing that answers "are these the rules this checkout
  renders", which is the question a follows-source repository actually needs answered.
- Moving a repository to a release install is one `simt init --no-follow-source --yes` (or the
  same run from a release binary), and the next `sync` writes the pin from the running build.

## Rejected

- **Treat every checkout as follows-source automatically.** A checkout is a fact, but it is a
  fact about the invocation, not about the install: CI may run a release while a laptop runs a
  checkout of the same repository, and the two must not rewrite each other's declaration.
  It would also make every adoption the maintainers perform from the checkout — and every
  staged fixture in the test suite — a follows-source adoption with no decision behind it.
- **Keep the pins and skip the comparison.** The manifest would carry a number nothing reads,
  which is the shape every stale-field finding exists to prevent. The writer removes the pair
  instead.
- **Detect `SIMT_DEV_BIN` at check time.** An environment variable is a property of the shell
  that invoked the check, not of the repository; a gate whose answer changes with the caller's
  environment is the non-determinism this tool's resolution refuses.
