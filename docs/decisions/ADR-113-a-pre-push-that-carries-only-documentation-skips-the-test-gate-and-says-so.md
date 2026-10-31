---
simt-affects: ["src/hooks/dispatcher.mjs", "src/commands/hooks.mjs", "simt.json", "test/hooks.test.mjs"]
simt-supersedes: []
---

# ADR-113 — a pre-push that carries only documentation skips the test gate, and says so

Status: **accepted** · 2026-10-31

## Context

The shared dispatcher runs a repository's declared pre-push gates on every push.
For this repository that is the full test suite — fifteen hundred tests, minutes
of wall clock — and the push it guards is frequently the one shape of push the
suite adds nothing to: a release commit (version, changelog, manifest pin), a
tag, a documentation edit. The suite runs there for the same reason it runs
anywhere, which is the correct reason in general and a tax in this case.

The dispatcher's standing commitments shape what the fix may be. It fails
closed, never fail open: a gate that cannot run is a failure, not a skip. It
never weakens a control to make a hook pass, and a control is downgraded only
from the manifest, where a reviewer sees it. And it reports what did not run,
so "passed" can never be mistaken for "only some of it passed". A skip that is
invisible is a weakened control the reader did not approve; a skip that is
guessed at is a fail-open.

git answers both problems: it feeds the pre-push hook a ref list on stdin —
one line per ref being pushed, with the local and remote shas — so the push
can be diffed against exactly what the remote already has, and the manifest is
already the declared home of gate configuration.

## Ruling

1. **The `test` gate is the only gate a push can skip, and only on evidence.**
   Before running its gates, the dispatcher classifies the push from the ref
   list git fed on stdin. The `test` gate is skipped when, and only when, every
   ref being pushed is one of: a branch whose diff against the remote is at
   most a declared number of commits and touches only declared paths; a tag
   whose commit is confirmed already delivered; or a deletion. Every other gate
   runs unconditionally: they are cheap and repo-specific, and a skip the
   classifier does not own is a skip it did not earn.
2. **The skip is opt-in per repository, and absence runs the suite.** The
   classification is declared in the manifest as `gates.prePushSkipTest` with
   `maxCommits` and `paths`. A repository without the key runs the full suite
   on every push; a key with missing or mis-shaped fields does the same. The
   control is downgraded from the manifest where a reviewer sees it, and a
   downgrade the manifest cannot state precisely is one it did not make.
3. **Every uncertainty fails closed to the full suite, and a skip is reported.**
   An unreadable ref list, a new branch (no remote sha to diff against), a tag
   whose commit cannot be confirmed already delivered, a commit count above the
   ceiling, a file outside the declared paths, or a git error each run the suite.
   When the skip does fire, the report prints the gate as `SKIPPED` with the
   reason — the commit count, file count, and tag count that earned it — so the
   reader sees the suite was not run and why.

## Consequences

- A push of one or two documentation or release commits no longer pays for the
  full suite in this repository, whose manifest declares a ceiling of two
  commits over markdown, `docs/`, `package.json` and `simt.json` — the shape
  of a release commit.
- The file list is a tree diff over `remote..local`, so a force push is judged
  on the trees it replaces, not on the commits it adds.
- A release tag rides along in the skip. In the release flow a tag names commits
  already delivered (and tested) by a branch push, so the classifier accepts it
  only when the commit it points to is reachable from a remote-tracking ref, or
  is among the commits the same push is delivering on a branch. A tag on a
  commit no pushed ref contains runs the suite: the gate does not assume a tag
  is harmless, it verifies the commit behind it.
- The classification reads the repository's git state, so it runs on the real
  root; the disposable worktree at HEAD is for the gates, and a push that
  earns the skip does not need one.
- Nothing in this ruling widens to other events. Pre-commit has no ref list to
  classify and keeps running its gates on every commit.

## Rejected

- **Skip by file extension in the hook, with no manifest declaration.** The
  hook would then own a policy no reviewer can read in a diff, which is the
  exact failure the manifest requirement exists to prevent — and a reader of
  another repository could not tell whether its suite had run.
- **Skip when the push is small, whatever it touches.** A two-line change to a
  gate definition is a code change the suite exists to catch, and a size
  threshold without a path rule cannot tell it from a two-line doc edit.
- **Make the skip silent.** The dispatcher's report is its contract: a gate
  that did not run is named with its disposition and its reason, or the reader
  cannot distinguish "passed" from "never ran".
