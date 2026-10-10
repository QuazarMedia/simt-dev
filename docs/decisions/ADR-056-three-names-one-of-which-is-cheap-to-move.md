# ADR-056 — The command, the package and the project are three names, and only one of them is cheap to move

Status: **accepted** · 2026-10-10 · filed as S18 · amends [ADR-023](ADR-023-the-gate-ships-as-a-file-the-repo-owns.md) · affects `src/name.mjs`, `package.json`, `src/projection/manifest.mjs`

## Context

This tool had four names and no record of which was which. `PACKAGE_NAME` was spelled in
`locate.mjs`, the manifest name in `manifest.mjs`, the config directory in `workspace.mjs`
and the gate filename in `workflow.mjs` — four definitions, four places to forget. The
command itself appeared **276 times across 33 files**, in remedy strings, help columns, shim
source, MCP tool descriptions and the note every generated region carries.

Publishing forced the question S18 had been asking since it was filed: *what is this
called?* And the answer turned out to be four different answers depending on what you were
asking about, which is not an answer.

The measurements that settled it:

- `simt-dev.json` is on disk in **fourteen repositories** that adopted the tool.
- `<!-- simt-dev:begin -->` is in every projected `AGENTS.md` in every one of them.
- `.simt-hooks/` and `SIMT_DEV_BIN` are in the `.git` directories of those repositories.
- `simt-dev-check.yml` is in the `.github/workflows` of each of them.
- The command name appears in **no file at all** until a reader types it.

## Ruling

**One. There are three names, and they are recorded as three.** `src/name.mjs` owns all of
them and nothing else spells them:

- `PROJECT` — the repository, and the artefacts already on somebody else's disk.
- `CLI` — the command a reader types.
- `PACKAGE_NAME` — what you install to get the command.

They are three constants that happen to be related. Deriving one from another was
considered and rejected: a derivation that picks between a package and a scope turns a
one-line rename into a one-line diff whose meaning depends on a comparison nobody reading
it would think to check.

**Two. The command is `simt`; the project and the package keep `simt-dev`.** This is the
whole ruling, and it rests on the asymmetry in the measurement above. The command is the
only one of the three that appears in no file until somebody types it, so it is the only
one that can change without a breaking change to files rather than to a package. Spending
the rename on the cheap name is what made this a rename instead of a fourteen-repository
roll-forward.

**Three. The manifest follows the command, and its move is a read-both/write-new.** The
manifest was one of the on-disk names and it is the one that moved: `simt-dev.json` is now
`simt.json`. Without a fallback, all fourteen adopting repositories would read as "no
manifest" on their next `check` — and "no manifest" is the answer that offers to re-adopt a
repository that is already done. So:

- **Read** takes `simt.json` if it exists, else `simt-dev.json`. Every read site goes
  through one resolver (`manifestPath`) rather than knowing the fallback itself, because a
  fallback that lives in five places is a fallback that eventually stops living in one of
  them. The fingerprint, which reads the directory listing rather than a path, accepts both
  spellings for the same reason: a fingerprint that misses the manifest silently loses the
  repository's declared stack, which is the one input no amount of marker reading replaces.
- **Write** goes to `simt.json`, and a lone `simt-dev.json` is moved, not shadowed: two
  manifests in one repository is a state nobody can reason about, and the second would be
  the one that is never read.
- **The window closes per repository** on its first `init` or manifest write after the
  upgrade. Until then, the old name keeps working everywhere.

The fallback is asserted in `test/naming.test.mjs` with both spellings — the new name wins
when both exist, the old name is still read, and a write moves the old file — because its
failure mode is silent: the tool would simply stop seeing a repository it has been
managing.

**Four. The remaining on-disk names are locked, and the lock is asserted.**
`test/naming.test.mjs` pins `simt-dev-check.yml`, `.simt-hooks`, `SIMT_DEV_BIN` and the
project name as literals, so renaming one is a deliberate edit to a test rather than a
constant change that looks harmless. A lock nobody can trip is a comment.

**Five. The command name lives in one constant and is executed, not agreed.**
`test/naming.test.mjs` walks `src/` and fails on any command string that *spells* the
command instead of interpolating it. The pattern matches the real verb list rather than
"space then a lowercase word", because the looser rule flags the tool naming itself in
prose — `simt-dev will not remove a file it wrote` and `the simt-dev region is not at the
top of the file` are the project talking about itself, and the project keeps its name.
The guard was proven with a negative control: one injected spelled command, one failure
naming the file and line, reverted.

**Six. The package is unscoped.** `@simt` and `@quazarmedia` were both free on npm; an
unscoped `simt-dev` was already reserved by this project's own account. An unscoped name
is the one a reader can guess, and the reserved one was the only spelling already pointing
at something.

## Consequences

- **No repository has to do anything, including about the manifest.** Every adopted repo
  keeps its markers, hooks directory and gate, and `check` does not report drift anywhere.
  The manifest is the one name that did move, and it moved behind the fallback: a
  repository holding `simt-dev.json` is still read, and on its first write the file moves
  to `simt.json`. The migration is real, but it runs itself — one repository per write —
  instead of running as a fourteen-repository roll-forward.
- **The generated gate file names the command correctly.** `name: simt check`, "If `simt`
  cannot be found the job FAILS", "run `simt ci --yes`". These are shipped bytes into
  every adopting repository, which is why they were checked by rendering them, not by
  reading the source.
- **One upgrade step is real and is documented.** A shim written before this change looks
  for `simt-dev` on `PATH`. A machine that installed the package and never re-ran
  `hooks install` finds nothing until the dependency is refreshed and `simt hooks install
  --yes` re-runs. That is in the CHANGELOG rather than left to be discovered.
- **The other on-disk names can still move, but only deliberately.** They would need the
  same shape the manifest got — read-both, write-new, an asserted fallback — and S36's
  estate roll-out to execute it.

## Rejected

- **Rename the artefacts too — `masar.json`, `masar-hooks/`, `<!-- masar:begin -->`.**
  This was the shape the slice was originally taken in and it is strictly worse: it turns
  a rename into a fourteen-repository migration, every one of which would see its
  `AGENTS.md` stop being managed on the first `check` after the upgrade. It was rejected
  for what it would have cost, not for being unclear. The manifest is the exception to this
  rejection, and it is an exception only because ruling three makes the move safe: the
  markers and the hooks directory have no read-both fallback to hide behind, because a
  region marker that does not match is simply not a region.
- **`@quazarmedia/simt-dev` as the package name.** Free, but already named in the shim
  remedy, the review and the workflow install step. Changing it would have edited all
  three for no availability gain, since the unscoped name was already reserved.
- **Rename the command by a script that rewrites every literal.** The first attempt at the
  propagation used "space then a lowercase word" and rewrote `user.name=simt-dev tests`
  and a test title — both of which would have passed. A rename that cannot tell a command
  from a git identity in a fixture is a rename that will eventually rewrite a sentence.
- **Derive `PACKAGE_NAME` from `SCOPE` and `PROJECT`.** Rejected above; the three names
  will not always agree, and the day they disagree the derivation picks for you.
