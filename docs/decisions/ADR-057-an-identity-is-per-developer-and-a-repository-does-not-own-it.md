# An identity is per-developer, and a repository does not own it

Status: **accepted** · 2026-10-11

Affects: `simt init`, `src/identity.mjs`, `test/identity.test.mjs`

## Context

Two repositories in the estate carried a `git.config` file in their tracked files.
It holds a name and an email address:

```ini
[user]
	name = Said Elimam
	email = 169009+saidelimam@users.noreply.github.com
```

Both had a local `include.path` pointing at it, and both worked. Both were also
wrong in ways that had nothing to do with each other.

**It was a tracked file.** A repository has more than one person in it. Committed,
one developer's name and email is published to every other developer and to
everybody who can read the repository. This repository's own release review had
already said so, in the table of findings, as: *"`git.config` tracked at the root
with a personal name and email — Identity file in a public tree, read by nothing
— Remove it from the tree."* The finding was recorded and the file stayed.

**It pointed somewhere else.** Both `include.path` values named
`../../simt-dev/git.config` — another repository's identity file, resolved through
the git directory rather than the working tree. Including the git config's own
file from a relative path three directories up means one repository's commits
depend on a sibling checkout existing at an expected path, which fails the moment
anybody clones without it. It went unnoticed because every developer here has a
global identity configured, so the include resolved to the same person the
include would have skipped to, and the file it never read was the reason nothing
broke.

The interesting part is that these are opposite mistakes with the same root.
`git.config` is not the repository's to own, and treating it as the repository's
produced both: a file that should have been ignored got committed, and an
`include` that should have named the repository's own file named a stranger's.

## Ruling

1. **`simt init` writes `git.config` when the repository has none.** It is planned
   like everything else `init` writes, so it appears in the same preview that lists
   the rest, and its source is named on the line — writing somebody's name is a
   statement about a person and the plan says where the name came from.

2. **An existing `git.config` is left exactly as it is.** Not updated, not merged,
   not reformatted. It may have been written by a person, by an older version of
   this tool, or by hand years ago, and none of those are this tool's to
   second-guess.

3. **The identity is derived, in this order, and the first answer wins:**
   the repository's **last commit author**, then the identity **git would use on
   this machine anyway**, then nothing.

   Last commit first because it is a fact rather than a default: it is who has
   actually been working here. It is read from `git log`, not from
   `git config user.email`, because at that moment the configured value is what the
   file is about to be derived from, and the step would be circular.

   The second is `--get` rather than `--global`, so it resolves through git's own
   precedence and returns what a commit would have used had this file never
   existed. That is the fallback's whole point: it must not be a second opinion
   about what identity means.

4. **When nothing is available, no file is written.** A placeholder is an identity
   git would use on the next commit, and an adopting command is the last thing that
   should invent one. The refusal is printed with its reason rather than swallowed.

5. **Only the keys that were found are written.** A partial identity is written as a
   partial identity, for the same reason.

6. **`init` adds `git.config` to `.gitignore`** when it creates one, and points
   `include.path` at `../git.config` — the repository's own file.

   `--replace-all`, not `--add`: a value naming *another* repository's identity file
   is not an addition to keep, it is a link to break.

   A repository that already *tracks* `git.config` is not untracked by `init`.
   Removing a tracked file is not something an adopting command should do silently,
   and doing it would be a change to that repository's history rather than to its
   working tree.

## Consequences

`src/identity.mjs` is new and is the single answer to "whose identity is this, and
may we write it". `init` plans it, writes it, gitignores it and repoints the
include; the four refusals are asserted in `test/identity.test.mjs` rather than
described, because each of them is the correct answer rather than a failure to try
harder.

One test scrubs `HOME` and `GIT_CONFIG_GLOBAL` before asserting the "nothing
anywhere" case. That is not tidiness: a developer with a global `user.email` — which
is most of them — makes the identity resolvable, so without scrubbing the test
would pass for the wrong reason on that machine and nowhere else. ADR-031 is about
a result depending on the author's environment; this test would have been the next
instance of it.

## Rejected

- **Write `git.config` into the tracked tree, as a shared record of who works
  here.** This is what the two repositories did, and it is a publication of a
  person's email address with a commit attached.
- **Take the identity from the OS (the login name, the home directory).** It
  produces `saidelimam@example.com` and similar: an identity nobody configured,
  used for authorship. Ruling 4's refusal covers it.
- **Overwrite an existing `git.config` when it differs from the derived one.**
  Difference is not error. A file that has been there for years and disagrees with
  the last commit author is a decision somebody made.
- **Fix the `include` only when it is wrong.** The include is only written when it
  is missing or does not name this repository's own file. Rewriting it when it is
  already correct would be a no-op that reads as a change.