# ADR-025 — a baseline is a region in a file the repo owns, and only a file that can hold one

Status: accepted · 2026-10-06 · rulings 1 and 2 narrowed by ADR-026
**Affects:** `src/projection/baselines.mjs`, `src/projection/markers.mjs`,
`src/projection/project.mjs`, `src/commands/init.mjs`, `test/baselines.test.mjs`,
`test/leaks.mjs`, `test/surfaces.test.mjs`. Settles §3.1 row 5 and row 7 of
`docs/plans/0001-centralise-agent-rules.md` for the files it names, and leaves the rest ruled
out by name rather than outstanding.

Rulings 1 and 2 did not survive whole: ADR-026 rules that a config whose grammar cannot
carry a comment is owned whole rather than not at all, and does so by reusing this record's
neighbour (ADR-023) rather than by overriding anything here. What rulings 1 and 2 still
settle is narrower and is not in dispute — a file that **can** hold a region is a region,
and no comment-capable file is to be taken over whole.

## Context

§2.2 of the plan named the mechanism before any of the files existed: *"Same for
`.editorconfig`, `.prettierrc`, `.gitattributes`. Local content is never clobbered; shared
content can never drift silently."* Only the first file was ever built, and only for
`AGENTS.md`.

§3.1 row 5 asks for eight baselines and promises six concrete resolutions: the `singleQuote`
contradiction, the ten repos with no editorconfig, the missing strictness flags, the three
disagreeing `.nvmrc`, no `packageManager`, and eslint fighting prettier in three of five
configs. Row 7 asks `init` to scaffold them.

What is actually missing is not the files. `rules/stacks/node.md` already mandates their
shapes — *".nvmrc pins the development version"*, *"`moduleResolution` spelled consistently"*,
*"Prettier owns formatting"* — and mandates them **with no values**. Every line is a shape
with the value left to whoever reads it. That is the failure AGENTS.md names as "can the
reader act on it — command, not location?", except it is worse: the reader is told a file
exists and not what goes in it.

The same profile is where the plan's own resolutions point. `singleQuote` is a
`[prettier]`-section value, which prettier reads from `.editorconfig` — a file whose comment
character is `#`, and therefore a file that can hold a region.

## Rulings

1. **A baseline is a marker-managed region, not a file simt-dev owns.** The repo keeps
   `.editorconfig`; simt-dev owns the bytes between `# simt-dev:begin` and `# simt-dev:end`.
   This is §2.2 as written. A whole-file baseline would overwrite the exact content the plan
   says must never be clobbered, and the ten repos that already have an editorconfig are the
   ones with the most to lose.

2. **Only a file whose format can carry a comment may hold a region.** This is the whole
   filter, and it is grammar rather than caution. `.editorconfig` qualifies: `#` is a comment
   in INI and every editorconfig parser honours it. `tsconfig.base.json` and
   `.prettierrc.json` do not — JSON has no comment syntax, and a "region" in a JSON file
   would have to be a string literal that `tsc` and prettier both have to tolerate.
   `.nvmrc` is a bare version string. A baseline for any of those is a whole-file write, and
   ruling 1 forbids it. They are ruled out, not deferred.

3. **The marker syntax is a property of the file, not of the module.** `markers.mjs` grew
   `STYLES`: `html` for `AGENTS.md` and every `.mdc`, `hash` for `.editorconfig`. The HTML
   rendering is byte-identical to what it was — asserted by the existing 36 tests — because a
   change to those bytes would make every adopted repository drift. A third style is a row in
   that table, not a second implementation, per the ADR-002 rule about a third copy being a
   defect.

4. **The region goes first, and `where` is a style property rather than a caller argument.**
   editorconfig takes the last matching definition. An appended region would leave the repo's
   `indent_size = 4` in the file and silently dead — no byte removed, nothing in `check` to
   report, and a reader with no way to tell why their setting stopped working. Placing the
   shared block first makes the repo win by construction. The placement belongs to the style
   because the correct answer is a fact about the file's semantics, and a caller who has to
   remember it is a caller who gets it wrong once.

5. **A region that is not at the top is a finding of its own.** `check` raises `MISPLACED`
   whenever bytes appear above `# simt-dev:begin`, with the reason and the fix. The bytes are
   right and the meaning is wrong, which is the hardest drift to notice; a finding whose
   detail said so is the only thing that makes it visible. `sync` repairs it by rewriting the
   placement and leaving the content alone.

6. **Absence blocks, the way absence of a rule file blocks.** An adopting repository ran
   `init`; a baseline that has been deleted or a file whose region has been removed is drift,
   and the remedy is one command. The alternative — silently reporting nothing for a file the
   repo does not have — was rejected for the same reason ADR-023 ruling 4 exists: a check that
   reports only what it can see is a check that cannot be relied on to report what it cannot.

7. **`end_of_line` is deliberately absent.** It reads like an editor setting and is not one.
   It decides whether a save rewrites every line of every file, which is a claim about what
   belongs in the repository, and that claim is made in `.gitattributes` where git reads it.
   Setting it here would change every checkout of every repository on the day it landed, and a
   repository that wanted CRLF could only opt out by deleting the region — losing the
   indentation baseline with it.

8. **`[prettier] singleQuote = true` is in, `printWidth` is out.** `singleQuote` is the
   contradiction the plan named first, it is the only comment-capable home prettier reads, and
   a repository with its own prettier config overrides it — which is the right order, because
   the nearer file wins. `printWidth` is absent because nobody has ruled on one. The
   repository that already has `120` would be overruled by a number no one argued about, and a
   baseline that picks a value the estate has not agreed to is not a baseline.

9. **`.gitattributes` is ruled out for now, for the reason in ruling 7.** It is
   comment-capable and would qualify mechanically, but every line that earns its place in it
   changes what git does to the working tree — `text=auto` rewrites every checkout,
   `linguist-generated` and `export-ignore` need build directories, and build directories are
   stack-specific, which §3.2 keeps local. A shared `.gitattributes` region today is either
   dangerous or empty. It needs its own record, and this is not it.

   **Ruling 9 is superseded by ADR-027**, which is the record this ruling asked for. The
   deferral was sound and the conclusion was one line too broad: the shared region is neither
   dangerous nor empty, it is exactly one line — `* text=auto eol=lf` — and the `auto` is
   what makes it safe. The rest of this ruling stands, including ruling 7's refusal to
   claim line endings from `.editorconfig`: they are claimed here instead, where a repository
   can overrule the claim on one line without losing anything else.

## Consequences

- `.editorconfig` is the only baseline. `BASELINES` is a list, so the next one is a row, and
  `test/baselines.test.mjs` asserts the list is exactly `['.editorconfig']` with a real style,
  a reason and a record number on every row — a baseline added without noticing that its file
  cannot hold a comment would fail there rather than in someone's editor.
- The node profile's shapes now have values behind them for `singleQuote` and for indentation.
  They still do not for `.nvmrc`, `packageManager` and `moduleResolution`, and the profile
  still mandates the shapes. That gap is named in the plan's row 5 annotation rather than
  hidden, because the next fix is three more JSON files and therefore a different mechanism.
- `init`'s plan now prints a third caption, because a reader told "frontmatter kept, body
  replaced" about a file that keeps everything outside a region has been told the wrong thing
  about the edit they are approving.
- This repository is not self-adopted and therefore has no `.editorconfig`. That is the same
  reason it has no generated region in `AGENTS.md`.

## Rejected

- **Ship whole template files for every baseline in §3.1 row 5.** Rejected under ruling 1:
  it overwrites repo content, and eight of the files in that row are JSON or bare strings,
  which is the whole problem.
- **A `tooling/` directory of template files, as §5 of the plan shows it.** Rejected for the
  same reason: the directory was drawn before anyone checked which of those files can hold a
  managed region, and four of the nine cannot.
- **A manifest key to opt out of a baseline.** Rejected for now: with one universal baseline
  there is nothing to opt out of, and a key added before there is a choice is a key nobody
  reads. If a second baseline turns out to be stack-specific, the opt-out question returns with
  it.
- **`[prettier] printWidth = 100`.** Rejected under ruling 8.
