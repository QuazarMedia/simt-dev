# ADR-084 — A workspace carries its repeated rules once, and the region does not read the reader's home

Status: **accepted** · 2026-10-17 · filed as R11 (plan 0003)

**Affects:** `src/projection/shared.mjs`, `src/commands/shared.mjs`, `src/projection/rules.mjs`,
`src/projection/manifest.mjs`, `src/projection/markers.mjs`, `src/commands/tokens.mjs`,
`src/commands/index.mjs`

## Context

The same rules are projected into every repository of a workspace, and each repository's
region carries the full text. The plan asked for the intersection to be installed once, at
user level, and for a repository to switch to the remainder when its manifest said
`projection.shared`. It also named home paths for four harnesses, and said CI should keep
rendering the full region so a teammate without the user file loses nothing in review.

Two of those would not survive contact with the rest of the tool. `projection` is generated:
`upgrade` replaces it, which is why a repository's own budget already lives beside it rather
than inside it. And a region that is full in CI and short on a reader's machine is a region
`check` cannot agree with, because `check` renders the same function the reader gets.

## Rulings

1. **The unit that is shared is a rule, and only a rule every repository renders with the
   same bytes.** The meter can report a repeated paragraph; it cannot store one, and
   `simt rules show` prints one rule. A rule one repository does not ship, or renders
   differently, stays in every region. The comparison is the rendered text, because one
   repository can drop a line the others keep.

2. **The declaration is `shared` on the manifest, beside `budget` and `mode`.** `level` is
   `user` and `rules` is the list of ids. It is not a key of `projection`, because that
   object is replaced on upgrade. A missing key, a level other than `user`, or an empty
   list means the region carries everything it carried before. A value that is not that
   shape is an error from the one reader the region, `doctor` and `simt shared` share.

3. **The file that is written is the one the loader table says the harness reads.** The
   plan named paths. A path the table does not record would be written and never loaded, so
   a surface with no user-level row, and a pointer surface with no loader row, gets a block
   to paste and no path. Where the table names a flat user rules directory, the file is
   `simt.md`. Where a harness reads one of two files and the reader already has a non-empty
   one, that file is the one written. A cap the table states in tokens is reported, not
   compared with a byte count, and a copy over its cap is reported rather than refused.

4. **`simt shared plan` writes nothing. `simt shared install` writes only with `--yes`.**
   The write is the user-level file, keeping whatever prose sits outside the generated
   region, and the same declaration in every repository that already has a manifest. A
   repository without one is skipped, with the command that adopts it. A workspace with
   nothing to share writes neither an empty home file nor a declaration. The regions
   change on the next `simt sync`, not during the install.

5. **The region is a function of the declaration, not of the reader's home directory.** CI
   and the reader therefore render the same delta. A teammate without the user file loses
   the shared rules from the region; `simt doctor` says so — current, stale, absent,
   unreadable, or no target — and does not fail the gate. The index line names the rule,
   why it is not in the file, and `simt rules show <id>`. It does not name a home path,
   because that path is not true on both machines.

6. **One section holds every reason a rule is missing, and its heading names the fact.**
   Class-deferred, cut to a budget, and carried once are three decisions and one fact for
   the reader: the rule is not in this file. The heading is `## Rules not in this region`.
   This narrows ADR-073 ruling 6 and ADR-083 ruling 7, which named that section
   `## Deferred rules` when a class deferral was the only reason to be in it. The rest of
   both rulings stands: one section, each line says which reason, and the remedy is the
   same command.

7. **A repository's own profile or pack is not shareable.** It is policy that repository
   owns. Putting it in a home file would change one repository by editing a file every
   sibling reads. Only rules this package ships are candidates, and the shareable set is
   computed before the declaration drops them, so a second install does not shrink the
   intersection against an already-reduced list.

8. **`simt tokens` counts the user-level copy once.** `tokens --repos` adds the whole file
   to the estate total, prose outside the region included, because that prose is also
   always-on for the reader. A repository on its own counts the same file, so a single
   root does not look cheaper than the workspace it belongs to.

## Consequences

`simt shared plan` is the default of `simt shared`, for the same reason `simt skills` lists
before it installs: the read answers what would happen, and the write needs `--yes`.

The plan's accept bar — always-on bytes for the seven-root estate at most 30 KB, and no R
loss in bench — is **unmeasured**. The tests prove the mechanism on fixtures: identical
rules leave the region, a divergent rule stays, the reader's own prose survives, and the
meter counts the copy once. They do not measure the estate, and they do not run the bench.

## Rejected

- **`projection.shared`.** The next upgrade would delete it, and the region would silently
  grow back.
- **CI renders the full region while a reader renders the delta.** `check` would report
  drift on every machine that had installed the copy, or would have to read a home
  directory the projection is forbidden to depend on.
- **The union of rules across repositories.** A rule one repository does not ship is that
  repository's absence, and installing it at user level would give the rule to a reader of
  a repository that declined it.
- **Writing the paths the plan named when the loader table records a different file, or
  none.** A file the harness does not read is a second copy the reader never sees.
- **An empty shared file for a workspace with nothing to share.** It would look like a
  decision and contain none.
