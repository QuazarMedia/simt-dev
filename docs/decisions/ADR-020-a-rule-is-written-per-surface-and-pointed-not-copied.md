# A rule is written per surface, and pointed at — never copied

Status: **accepted** · 2026-10-07

Affects: `simt-dev init`, `simt-dev sync`, `simt-dev check`, `simt-dev compare`,
`src/projection/surfaces.mjs`, `src/projection/project.mjs`, `src/compare/row.mjs`

## Context

`simt-dev` writes rules into a repository. Until this record it wrote them into **two** places:
the `AGENTS.md` generated region, and `.cursor/rules/*.mdc`. So the estate's three
always-on process rules — `test-gate`, `intake-questions`, `preview-postflight` — reached
**Cursor users and nobody else**. Every other editor got whatever happened to be in
`AGENTS.md`, by the accident that those editors read it.

That accident is not support. Claude Code reads `CLAUDE.md` by default and only falls back to
`AGENTS.md` when no `CLAUDE.md` exists anywhere above the working directory. Copilot's editor
and code-review surfaces read `.github/copilot-instructions.md` and
`.github/instructions/*.instructions.md`, which this tool wrote nowhere — while its conflict
scanner already *scanned* `.github/instructions/`, because a detector that reads a surface is
half a promise to write it. Antigravity's native surface is `.agents/rules/*.md` with a
required `trigger:` key it will silently discard if it does not recognise. So the three
repositories in the pilot had three different answers to "what rules apply here", and only
one of the three was written down.

The conventions were not guessed. Each was read from that vendor's own documentation, and
`src/projection/surfaces.mjs` records the document beside every row.

## Rulings

1. **A surface is named data.** Every editor is a row: its id, its label, the readers it
   serves, its rule-file path template, its frontmatter, and **the document it was verified
   against**. A row that cannot name that document does not belong in the table.

2. **A pointer is not a copy.** `CLAUDE.md` and `GEMINI.md` are symlinks to `AGENTS.md`.
   Both vendors document the symlink. The estate contains a byte-identical `CLAUDE.md` and
   `AGENTS.md` pair, which is the one true content duplicate in the corpus and the reason this
   tool exists. DeepSeek's harness documents the failure from the other side: candidates that
   are byte-identical after trimming collapse, so a symlink renders once — while **a real copy
   that has drifted loads in full alongside** `AGENTS.md`. A copy is not a second copy of the
   rule; it is a second rule that nobody reviews.

3. **Per-rule files are generated, not linked.** `rulePath()` writes the same body to each
   surface under that surface's own naming. Symlink support is documented for
   `.claude/rules/`; writing a symlink into `.agents/rules/` or `.github/instructions/` would
   be an unverified guess carrying a mode bit. A machine-written file derived from one
   canonical source and verified by `simt-dev check` is a build output, not duplication —
   nobody can hand-edit one and survive a sync, which is the test the estate's own review
   agent applies to duplicated policy text.

4. **An always-on rule emits no scoping frontmatter.** Claude documents that a rule file with
   no `paths:` loads eagerly at session start, and carries a documented parser defect: quoted
   values and YAML sequences in `paths:` silently fail to lazy-load, and its own documented
   examples are not valid YAML. Emitting a scope we do not need, on an editor where a
   malformed scope fails silently, buys nothing.

5. **The default is the global standard, and the set is always reported.** Every rule surface
   unless the repository narrows it with `"surfaces"` in `simt-dev.json`; `--surfaces` wins
   over the manifest. An empty list is a real choice meaning `AGENTS.md` only, not an
   accident. Every command prints the set and **where it came from** — an invisible
   configuration is one nobody can debug, which is the same ruling ADR-014 made about the
   workspace.

6. **A surface row states its own failure mode.** An unrecognised frontmatter key is inert;
   an unrecognised *value* can make an editor discard the rule with no error. So each row
   carries `documentedKeys`, and `undocumentedKeys()` — used by the test suite and by any
   consumer that wants the same guarantee — fails when the table emits a key its own vendor
   does not document.

## Consequences

`simt-dev init`, `sync` and `check` write and verify up to four rule files per rule plus two
pointers. `compare` reports `rules  N/M current` per repository, because a repository with a
current `AGENTS.md` and three stale rule files is now a state that can exist, and reporting
only the `AGENTS.md` finding would hide it.

A missing pointer is **not** a failing check. A repository that has never been adopted has no
`CLAUDE.md` and no `simt-dev.json`, and reddening every commit for that is the adoption
problem, not a defect — the same reasoning ADR-018 applied to a repository's own hooks. A
*mispointed* pointer is likewise not failing; a pointer simt-dev did not write, which means a
human's `CLAUDE.md` is in the way, **is** reported, because overwriting it silently would
destroy prose nobody backed up.

## Rejected

- **Keep two surfaces and call it support.** The rules a reader most needs are the ones that
  never reached three of the four editors that read this repository's rules.
- **Copy `AGENTS.md` to `CLAUDE.md`.** The one true duplicate in the corpus. DeepSeek's
  harness loads a drifted copy in full; Claude's own docs steer away from it.
- **Symlink every rule file to a canonical directory.** Symlink support is documented only for
  `.claude/rules/`. A symlink into `.agents/rules/` or `.github/instructions/` would be a
  guess with a mode bit attached.
- **Emit `paths:`/`globs:` on an always-on rule** and rely on it. Claude's parser defect makes
  it a silent-failure surface for zero benefit; Antigravity discards a rule whose `trigger`
  it does not recognise.
- **Guessing Antigravity's or DeepSeek's convention and moving on.** Both were read from the
  vendors' documentation before anything was written, and the document is recorded per row so
  a future maintainer knows what a claim rests on.
- **Making the default a single surface** because it is the one most repositories use. A
  default that leaves three editors uninstructed is the defect this record exists to close.
