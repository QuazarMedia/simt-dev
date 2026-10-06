# An unset hooks path is not an absent hook

Status: **accepted** · 2026-10-06

Affects: `simt-dev hooks install`, `simt-dev hooks status`, `simt-dev compare`, `src/hooks/where.mjs`

## Context

Phase 4 began by piloting `simt-dev init` on `simt-space`. The dry run was
unremarkable. The defect appeared when I read what `hooks install` would actually
do to that repository, which is something I had not done in any of the earlier
phases.

`simt-space` has a hand-written `.git/hooks/pre-commit` — 4088 bytes, with prose
explaining why it deliberately does not run tests. `core.hooksPath` is unset.
`simt-dev hooks status --root ../simt-space --json` reported:

```json
{ "hooksPath": null, "installed": [{ "event": "pre-commit", "present": false }],
  "problems": ["core.hooksPath is (unset), expected .simt-hooks",
               "pre-commit not installed"] }
```

and exited with `ok: true`. A live, working gate was reported as not installed.

`hooks install` then did this, with no warning of any kind:

```
core.hooksPath  created  (unset) -> .simt-hooks
CREATED   .simt-hooks/pre-commit
CREATED   .simt-hooks/pre-push
WROTE    shims and set core.hooksPath
gates    preCommit = (none declared)
         prePush   = (none declared)
```

Three things went wrong at once, and the first one is the load-bearing fact:

1. **An unset `core.hooksPath` was read as "git runs no hooks".** It means the
   opposite: git falls back to its default directory and runs whatever is in it.
2. **The takeover guard only looked at `core.hooksPath`.** It existed to stop
   simt-dev silently replacing routing somebody else had chosen — and it checked
   only for a *configured* value. The most common way to have hooks is the one it
   could not see.
3. **The install created two shims that enforced nothing.** `simt-dev init` had
   already said, in prose, that this repo declares no gate it can run and there is
   nothing to install. `hooks install` disagreed, and in doing so replaced a
   working gate with a gate that checks nothing.

The consequence in a real adoption is worse than a misreport. A repo that adopts
and then installs hooks gets, in place of its working formatter, two shims that
fail closed because `@quazarmedia/simt-dev` is not yet a dependency. Every commit
is blocked. The only exit is `--no-verify` — the exact spiral the dispatcher was
built in step 8 to prevent.

The same class of error sat under the two commands that already existed.
`src/compare/hooksstate.mjs` was written as "the read half of what `hooks status`
does inline", but `hooks status` never called it: it had its own `readHooksPath`,
its own `describeShim` and its own `collectProblems`. Three copies of the same
question, which is why fixing the shared one changed nothing visible.

## Ruling

1. **Ask git where hooks are, never infer it from whether config exists.**
   `resolveHooksDir(root)` implements the two rules directly: `core.hooksPath`
   when set (a relative value resolves against the top of the working tree, which
   is what makes `simt-app`'s `hooks` work), otherwise `<git-common-dir>/hooks`.

   `git rev-parse --git-path hooks` is the obvious shortcut and is unusable. It
   returns `.git/hooks` in a normal repository, `hooks` in a linked worktree, and
   **`./`** in a linked worktree with `core.hooksPath` unset — because a worktree's
   `.git` is a file, not a directory. An implementation that trusted it would
   enumerate a worktree's entire root as its hooks directory and report every file
   in the repository as a hook.

2. **A hook git runs and simt-dev did not write is a first-class fact.** It is
   named in `hooks status` text and JSON, in `hooks install`'s refusal and its
   post-install notes, and as a row-level `foreignHooks` field. Identity is decided
   by content, never by name: a simt-dev shim is also called `pre-commit`, so only
   the bytes can tell ours from somebody else's.

3. **Taking over a foreign hook requires `--yes`, and the refusal names the hook.**
   The existing guard was right about the principle and incomplete about the facts.
   It now covers both a configured path and an unconfigured default directory.

4. **A shim is installed only for an event that declares at least one gate, and
   `install` refuses when no event does.** An empty-gate shim enforces nothing but
   still displaces whatever was there, so installing one over a working hook is a
   downgrade. `init` and `install` must not describe different tools.

5. **In `compare`, a repo running its own hooks is a note, not a problem.** Notes
   do not affect the exit code. "Not adopted yet" is the normal state of a
   migration, and step 9 established — deliberately, after finding that a dashboard
   which goes red for the normal state is a dashboard everybody ignores — that only
   defects drive the exit code. Six of the sixteen repositories run their own hooks,
   so putting this in `problems` would have made the entire estate red on day one.

6. **A missing shim is only a defect when a gate needs it.** A repository that
   declares no `preCommit` gates has no reason to want a `pre-commit` shim. A
   repository with *no manifest* is a different case: we do not know what it wants,
   so we cannot rule the shim out. Absence of knowledge is not a decision.

## Consequences

`src/hooks/where.mjs` is new and is the single answer to "where are this repo's
hooks". `hooksstate.mjs` and `hooks status` no longer hold separate
implementations — the three duplicated functions in `hooks.mjs` are gone, and
`hooksstatus` reads through the shared module.

Two guard tests are recorded in `test/compare.test.mjs` because the JSON surface
had already lost a field once: the `summary` block in `compare --json` was a
hand-listed copy of `summarise()`'s output, and `withOwnHooks` reached the text
render while silently vanishing from the machine surface. A copied list of names is
a list that rots, so one test now asserts the two agree and another asserts every
row carries `notes` and `foreignHooks` even when empty.

Measured across the estate after the fix, six repositories run hooks simt-dev did
not write — `simt-space` (4088 B), `simt-app` (four hooks), `simt-social` (two),
`simt-social-api` (two), `simt-landing` (one), and the `.wt-wear-redesign`
worktree (five, including the `git-lfs` `pre-push`). Every one of them would have
been silently taken over.

## Rejected

- **Treat an unset `core.hooksPath` as "no hooks", and document it.** This is the
  bug. The documentation would have been accurate about the code and wrong about
  git.
- **Ask the user before overwriting, and leave `hooks status` as it was.** The
  question was never asked, because the tool did not know a hook existed. A guard
  that cannot see the thing it guards is decoration.
- **Move a foreign hook aside instead of blocking.** Blocking is right; the file is
  left on disk untouched either way, so the outcome already is "move it aside".
- **Install the shims anyway and warn.** The gate list was empty. Warning about a
  replacement that enforces less than what it replaces is the wrong direction.
- **Put foreign hooks in `compare`'s `problems`.** Six of sixteen repositories, all
  of them unadopted, on the day the dashboard is introduced.
- **Use `git rev-parse --git-path hooks`.** Returns `./` for a linked worktree.