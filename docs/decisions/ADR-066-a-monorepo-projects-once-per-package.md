# ADR-066 — A monorepo projects once per package

Status: **accepted** · 2026-10-13 · filed as S41
**Affects:** `init`, `sync`, `check`, `compare`, `hooks run`, `src/monorepo.mjs`,
`src/projection/rules.mjs`, `src/projection/project.mjs`, `src/hooks/dispatcher.mjs`,
the `gates.cwd` manifest field

## Context

A monorepo received exactly one projection: the root's `AGENTS.md`, fingerprinted from
the root. Everything below the root was invisible to the detector, so a React
application inside a node workspace was handed the node profile and nothing else, while
a Workers service beside it was handed the same. Neither the repository's rules nor the
tool's output said another package existed with different rules.

The estate's own monorepos made this expensive rather than merely wrong. Fourteen
repositories hold between them hundreds of packages, and one rule set per repository
means every package is told the union of what the root can see and nothing about what it
is. The profile that should have applied to a package is applied by nobody, so the rule
that package needed was simply missing — not wrong, missing.

Three shapes of answer were available, and the cheapest is the one that was not taken.
Writing every package's full profile set into the root duplicates text the reader loads
once per turn (review 0002 S38 measured that duplication at 72% of the workspace's
always-on bytes). Writing the root's set into each package does the same and worse.
Projecting the root once and each package once, with each package carrying only what the
root does not, adds bytes proportional to the number of packages that actually differ,
and nothing at all to the ones that do not.

The harder half is that `check` is the gate. A projection the tool writes but does not
check is a projection nobody is held to, and a monorepo that drifts in one package would
report `current` while CI is green and the reader is wrong.

## Rulings

1. **A workspace is read from its declarations, never from a directory scan.** npm
   workspaces, pnpm's package list, turbo's workspace list, Cargo members, a go.work use
   list and Gradle includes are all read, because each one is a file that already states
   which directories are members and why. Finding a marker file by walking the tree is
   the alternative, and it is the one this repository's rules forbid: a heuristic that
   cannot be explained by a declaration is a heuristic a reader has to reverse-engineer
   from its output, and the only way to find out why a directory was or was not given
   rules is to read this tool's source. A declaration this tool cannot read is a
   directory it does not discover, which is an honest absence rather than a guess.

2. **The root keeps the shared rules; a package carries its delta.** The root is
   fingerprinted as before and renders the core plus every profile the root's own signals
   select. A package is fingerprinted the same way, and renders only the profiles the
   root did not already select. A reader opening the package file is therefore never
   shown a rule the root already gave them, and a reader of the root file is never shown
   a rule that belongs to one package. The duplication the workspace reader pays for is
   one sentence of orientation per package, and the bytes it pays for scale with the
   packages that differ rather than with the repository count.

3. **An empty delta writes nothing.** Two node packages under one workspace select the
   same profiles, so the delta is empty and there is no file. A file whose entire content
   is a claim about rules it does not contain is always-on bytes spent on nothing, which
   is the cost S38 exists to measure, and the reader is left looking for rules that are
   not there.

4. **A gate names its directory in a map, not in a new shape for the command.** The
   manifest's gate commands stay name-to-command-line strings, and an added map gives
   each gate a directory to run in. Re-reading a command string to discover where it runs
   would mean the answer to "where does anything run" lives inside a value whose purpose
   is something else, and a manifest written by an earlier release would have to be
   rewritten to gain the capability. A directory that does not exist, or that resolves
   outside the repository, fails the event with a message naming which of the two things
   is wrong, because they are repaired by different edits. Containment is checked on the
   resolved path rather than on the text: a relative traversal and a symlink both pass a
   prefix test applied to a string.

5. **`check` reports a bad directory before a commit, not at one.** The dispatcher fails
   closed on the same condition, so a reader would otherwise find out by being unable to
   commit — after writing a commit, which is the wrong order for the news. The same
   applies to a directory entry naming a gate that is not declared at all: the entry is
   inert, the reader believes the gate runs where it says, and nothing anywhere says
   otherwise.

6. **`compare` counts findings, not repositories.** One monorepo with three drifted
   packages is one repository with three findings. A summary that said one problem would
   understate the work by a factor of three, and a reader comparing two runs would see a
   single count that moves by three when the underlying state changed by three. The
   repository still counts once among repositories with problems, because that count is
   about how much work a person has.

## Consequences

- A workspace whose members are declared in a form this tool does not read gets the root
  projection only, exactly as it did before. That is a gap to close by adding a row to
  the declaration table, not a behaviour to document.
- Nested regions are checked, and their findings are printed with their paths. A reader
  who edits a package file by hand is told which file, which is the same information the
  root's own drift finding carries.
- The package file is a generated region like any other: the markers, the source list and
  the repair command all behave identically, so there is no second kind of generated file
  for a reader to learn.

## Rejected

- **Scanning for marker files instead of reading declarations.** Rejected for ruling 1.
  A marker file answers "is there a build here", which is not the question; a declaration
  answers "is this a member of the workspace", which is.
- **Folding every package's rules into the root region.** Rejected for ruling 2. It is
  the smallest change to make and it makes every reader in the workspace carry every
  package's rules, which is the cost S38 measured and S38's kernel exists to remove.
- **A directory field on each declared command.** Rejected for ruling 4, for the reason
  recorded there: it puts where a gate runs inside the value that says what it runs, and
  it makes an old manifest unreadable rather than merely older.
- **Skipping the directory check because the dispatcher already fails closed.**
  Rejected for ruling 5. The dispatcher's refusal is correct but late; the reader who
  learns about it from a failed commit has already done the work the commit would have
  saved them.
- **Refusing to project a monorepo at all until every package is understood.** Rejected:
  a root-only projection is a strictly smaller claim than it was, and refusing to improve
  it because the improvement is incomplete makes the reader worse off than the tool.
