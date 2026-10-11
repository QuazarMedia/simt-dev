# ADR-031 — the suite stages the environment it needs, because a test that inherits the author's directory is not evidence

Status: accepted · 2026-10-08
**Affects:** `test/fixture.mjs`, `test/install.test.mjs`, `test/hooks.test.mjs`,
`test/upgrade.test.mjs`, `test/workspace.test.mjs`. **Extends:** ADR-003 (test breadth)
and the AGENTS.md rule that the tool must be run the way a consumer runs it. **Relates to:**
ADR-015 (a source is content, not a location) — this is the same claim applied to the tests
that consume a source.

## Context

`simt-dev own gate` had been red on every push to `main` since the first baseline commit
landed. Not intermittently: 22 of 543 tests failed on runs `37476671363` through
`37642437221`, and the same 22 failed on all four. Locally the suite was 542/543 green.

Three separate causes, none of them recent:

1. **`test/install.test.mjs:17` read the estate off the author's disk.**
   `const WORKSPACE = resolve(HERE, '..', '..')` is `/home/developer/code/simt`, and the
   install tests copied skill bodies out of it — `repo-11/.agents/skills/d1-safe-change`,
   and `singleRepoClone()` out of `repo-14`. On a runner the checkout is
   `/home/runner/work/simt-dev/simt-dev`, so `../..` is `/home/runner/work/simt-dev`,
   which contains this repository and nothing else. The bodies were not there,
   `skills install` exited 3, and nineteen tests asserted on a refusal they never asked for.
   This is the third time this repository has made this mistake. AGENTS.md already names the
   first two: "workspace resolution that only worked in the checkout, and content lookup that
   only worked with a workspace." The rule was written down and the suite broke it anyway,
   which is worth recording plainly — a written rule does not prevent the failure, only a
   fixture that cannot express it.

2. **Three `git commit` calls carried no identity.** `hooks.test.mjs:502` and `:587` and
   `upgrade.test.mjs:310` ran bare `git commit`, which dies with `Author identity unknown`
   on any machine without a configured identity. Two other files in the same suite
   (`compare.test.mjs:57`, `init.test.mjs:177`) passed `-c user.email=…`. The suite was
   half right in a way that only shows up on a runner.

3. **Two tests asserted the checkout's own directory name.**
   `PACKAGE_ROOT is the package directory, not its parent` asserted
   `PACKAGE_ROOT.endsWith('/simt-dev')`, and `CLI: doctor reports which source answered`
   asserted the label `(heuristic: sibling of this package)`. Both pass when the directory is
   called `simt-dev` and fail when it is called anything else, which is a fact about the
   folder rather than about the code. Neither failed in CI, because CI's directory *is*
   called `simt-dev`. They were found only by running the suite from a copy named `repo`.

Causes 1 and 2 explain all 22 failures. Cause 3 explains none of them and is the most
instructive, because it is a test that passes for the wrong reason.

## Rulings

1. **The suite builds its own environment; it never reads the author's.** A test that
   resolves a body, a workspace, or a git identity from anything outside the checkout is
   defective even when it passes. `test/fixture.mjs` is the single place that constructs
   them, so the assumption is stated once instead of being re-derived in each file.

2. **Bodies are generated from the registry, not copied from a sibling.** A declared source
   is a *size* and a *location*; `locateSource` compares `measureSkill(path).bytes` against
   the declared number and nothing else. So `skillWorkspace()` walks
   `graph/skills.graph.json`, and writes a body of exactly the declared length for every
   one of the 45 declared sources. Two consequences follow and both are deliberate: a source
   added to the registry is staged without a second edit, and a declared size that changes
   cannot leave the fixture staging the old one. Copying real bodies instead would have
   reintroduced the dependency this record exists to remove, and would have made the suite
   fail whenever an unrelated repository edited a skill.

3. **Byte-exactness is a contract, not a detail.** A body one byte short is refused with
   `exists but is not the declared body`, so a fixture that pads approximately turns the
   tests green into tests that assert a refusal. Verified: removing one byte from the padding
   fails 19 of the 31 install tests.

4. **Only the stack signals that select something are staged.** The two repos whose names
   appear in a variant-bearing skill's `sources` carry the dependencies and the
   `vite.config.ts` that make `fingerprint` emit `react` + `node-web` against `hono` —
   `node-web` comes from a config file, not from `package.json`, so a fixture that only
   writes dependencies silently fails to select the `web` variant. Repos the registry names
   for single-body sources are staged neutral, because nothing is ever chosen by signal from
   them. Inventing stacks for them would be decoration, and would risk
   `every variant-bearing skill resolves to exactly one variant per real repo` passing for a
   reason nobody can reconstruct.

5. **`git` is invoked through one helper that always carries an identity**, on the command
   line rather than in a config file, so the suite can neither read nor write the developer's
   git configuration. `commit.gpgsign=false` for the same reason: a developer with signing
   configured must not be the only person whose tests pass.

6. **A test that asserts a location-derived fact asserts the location.** Ruling 1 makes the
   checkout's path and name unavailable as evidence. `PACKAGE_ROOT` is now checked
   structurally — the package's own `package.json` and `bin/simt-dev.mjs` are inside it, and
   they are not one level up. `doctor reports which source answered` no longer asserts
   *which* source; it empties the config and disables the workspace so the answer is the
   same on every machine. The sibling heuristic keeps its own coverage where it belongs, in
   the `resolveWorkspace` unit tests.

## Consequences

The suite now passes from any checkout: verified at an arbitrary path under a directory named
`fork-of-simt-dev`, with no sibling repositories present, 542/542. It passed there before this
record only if the directory happened to be named `simt-dev`.

The fixture stages bytes that satisfy the registry, not a copy of anybody's documentation.
Ten of the estate's skills ship a `references/` directory that `skillWorkspace()` does not
reproduce, because `measureSkill` sums the directory and a single padded `SKILL.md` satisfies
every check except the one test that asserts a reference file arrives — and that split is
declared for the one skill whose test needs it. If a future test asserts a layout, the split
goes in `FILE_SPLITS` rather than the fixture growing a copy of the estate.

The cost is that `test/install.test.mjs` no longer proves anything about the *real*
`d1-safe-change`. It proved it never: what it verified was that a body of the declared size is
copied verbatim, and the declared size came from the registry either way. What it did prove,
accidentally, was that this checkout's siblings are intact — which is not a property of the
tool.

## Rejected

- **Cloning the estate into CI so the existing tests pass.** Fastest, and it leaves the
  defect exactly where it is. The suite would still be unable to detect that the tool only
  works with a workspace, which is the failure AGENTS.md says has already happened twice.
- **Pointing the install tests at this repository's own skill bytes.** Would make the tests
  pass, but `skills install` exists to move a body *between* repositories, so a test whose
  source and destination are the same repository is not exercising the command.
- **Committing the real bodies as fixture files under `test/`.** Deterministic, and it would
  have avoided the padding code entirely. Rejected: it copies other repositories' work into
  this one and creates a second thing to update whenever a body changes, which is a
  synchronisation problem rather than a test.
- **Setting a global `SIMT_DEV_WORKSPACE` for the whole suite.** Ruling 1 makes each test
  name the environment it needs; a default would let a test inherit a workspace without
  having asked for one, which is the same class of defect one level up.
- **Fixing only the 22 CI failures.** Causes 1 and 2 are all the runner can see. Cause 3 was
  found by running the suite from a directory with a different name, and would have stayed
  invisible to anyone who only ever ran it in place.
