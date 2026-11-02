# Testing

One suite, on the repository's own runner:

```sh
npm test                          # node --test over test/*.test.mjs
node --test test/index.test.mjs   # the focused form
```

## What the suite is built on

`test/fixture.mjs` stages a workspace and a git identity, so a test never depends on the
machine it runs on, and nothing in `test/` reads outside the checkout (ADR-031). That rule was
written after three failures that only appeared on a machine that was not the author's: a
resolution that only worked in the checkout, a content lookup that only worked with a
workspace, and a suite that read skill bodies out of sibling repositories and kept `main` red.

A test that needs a repository builds one: `mkdtemp`, `git init`, committed files. A test that
needs the tool's own bytes reads them through the same function the command uses, which is why
`docs/commands/` is compared against `renderCommandPages()` rather than against a string.

## Gates

- A focused run is the default gate. A full suite runs against a named trigger: phase exit, a
  release, cross-system behaviour, or pre-push on a protected branch.
- A partial pass is a blocker. A skipped test needs a pre-existing written reason.
- A numeric bar — a coverage floor, a file-length cap — is declared per repository in
  `simt.json`, never assumed centrally (ADR-006).
- The pre-commit hook owns format and lint for staged files; a manual run is for diagnosis, or
  for a check the hook does not cover.

## Evidence

`simt evidence` lists the runs recorded against the tree on disk. A commit message that claims
a passing run this tree does not have is a finding rather than a trust exercise, and the commit
fails when `gates.evidence` is `block` (ADR-120). Cite the command and the file, not the
feeling.

## The isolated run

Before believing the suite, run it from a copy at a path with no siblings:

```sh
rsync -a --exclude node_modules ./ /tmp/simt-isolated/ && (cd /tmp/simt-isolated && npm test)
```

That is how the sibling-dependent failures were found. A green run in a checkout with a
workspace beside it is not evidence about the tool a consumer installs.
