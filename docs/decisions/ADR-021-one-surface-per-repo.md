# ADR-021 — One surface per repo, chosen or defaulted

Status: accepted · 2026-10-07 · ruling 3 superseded by ADR-046
**Affects:** `simt-dev init`, `sync`, `check`, `compare`, `skills install`, `src/projection/surfaces.mjs`, `src/projection/rules.mjs`

> **Ruling 3 superseded by ADR-046.** It rested on a factual claim about Cursor — that a Cursor
> reader getting `.mdc` files "does not serve them", i.e. that Cursor cannot read `AGENTS.md` — and
> Cursor's own documentation says it can. Five repositories were loading 28,101 bytes of rule text
> twice. The claim had been sitting on the wrong row of simt-dev's own surface table all along.
> Every other ruling here stands; ruling 6 in particular is what makes ADR-046's orphan handling a
> note rather than a deletion.

## Context

ADR-020 answered a question that had been answered wrongly for months. `simt-dev init`
wrote `AGENTS.md` and `.cursor/rules/*.mdc` and reported that it supported the
estate's editors. It did not: the three always-on process rules lived only in a
directory only Cursor reads, so a Claude Code, Copilot or Antigravity user received
the core and stack rules and none of the process rules.

ADR-020 fixed that by writing one file per verified editor — four rule directories
and two pointer symlinks. That was correct and it was too much. A repo whose team
lives in one editor now acquires three rule directories and two symlinks it will
never open, every rule change lands four times, and `check` must be told which
surface to ask about or it answers a different question from the one `sync` was
asked.

"Support every known editor" is satisfied by knowing how to write each one and
writing the one that was asked for. It is not satisfied by writing them all.

## Rulings

1. **One surface per repo by default; a repo may name another.** `--surfaces` takes a
   comma-separated list, so one, several, or none are all reachable. An empty list is
   a real choice and means the primary region and nothing else.
2. **The default is opencode**, because it is the agent this tool is developed
   against and its paths — `AGENTS.md` and `.agents/skills/` — are already this
   workspace's. It is also the least private choice available: seven of the eight
   readers on that row read `AGENTS.md` natively, so the default file is the one most
   editors already read even when they were not asked for it.
3. **A folding surface carries its rules inside the region.** opencode documents no
   per-rule directory, so its surface folds every rule into the one generated region.
   Folding is `some`, not `all`: a repo that also opts into Cursor still folds, because
   an opencode reader's only channel is `AGENTS.md` and a Cursor reader getting `.mdc`
   files does not serve them.
4. **Skills follow the same rule.** One canonical skills directory per repo, `.agents/skills`,
   which opencode, Claude Code and Antigravity all document and which the estate
   already uses. Not four copies of every skill.
5. **The choice is always visible.** Every command prints the surface set and its
   origin — flag, manifest, or global standard — because an invisible configuration is
   one nobody can debug (ADR-014).
6. **A written file is not removed when a surface is dropped.** Narrowing the surface
   set stops new files appearing; `sync` never deletes a file it once generated,
   because a deletion is not something a projection should do silently. Removing them
   is a human decision with a visible diff.
7. **A pointer belongs to the surface that needs it.** ADR-020 wrote `CLAUDE.md` and
   `GEMINI.md` unconditionally, so narrowing the surface set left both behind — the
   same over-writing ruling 1 exists to stop, one file down. Each pointer now names the
   surface that requires it (`claude-md` → `claude`, `gemini-md` → `antigravity`) and
   is planned only when that surface was selected. On the default surface simt-dev
   writes exactly one file.

   *Added after ADR-021 was first implemented: this was found by running the command
   against the four adopted repos rather than by reading it, which is the third time
   that has been the only way to find anything.*

## Consequences

- **Which surface a repo already has is the strongest signal of which it wants.**
  Measured across the four pilot repos: three track `.cursor/rules/*.mdc` (3, 3 and 12
  files) and one tracks no rules layer at all. Those three adopt `opencode,cursor`
  because they already use Cursor; the fourth takes the bare default. A repo's own
  tracked files answer this better than any default could.

- `simt-dev init` on a fresh repo writes one file: `AGENTS.md`.
- `check` and `sync` must be given the same surfaces or they ask different questions.
  The manifest records the choice, which is why `init` and `upgrade` write it.
- The four repos adopted under ADR-020 carry rule files for surfaces they did not ask
  for. Narrowing stops the next sync writing them; removing the existing ones is
  Phase 6 work with a visible diff.

## Rejected

- **Write every verified surface by default.** Rejected: gives a single-editor repo
  three unread directories, and makes every rule change a four-file change.
- **Make the default no surface at all.** Rejected: that is what the tool did before
  ADR-020 and it is how three editors received no process rules.
- **Delete generated files for a dropped surface automatically.** Rejected: a
  projection that deletes files is a projection that can lose work, and it does it
  without a diff anyone reads.
- **One surface per rule, chosen by rule.** Rejected: the same rule then exists in two
  places, which is the estate's original problem restated.
- **Ask on every run.** Rejected: a prompt is a hang for an agent, and the default
  exists precisely so nothing has to be asked.
