# ADR-048 — a baseline carries only keys a reader honours

Status: accepted · 2026-10-09 · amends ADR-025 (withdraws ruling 8, corrects its context)
**Affects:** `src/projection/baselines.mjs`, `test/baselines.test.mjs`,
`docs/plans/0001-centralise-agent-rules.md`. Closes S30 of
`docs/reviews/0002-full-review-adoption-and-public-release.md`.

## Context

ADR-025 ruling 8 put `[prettier] singleQuote = true` in the shared `.editorconfig` and
called it *"the only comment-capable home prettier reads"*. Both halves of that sentence
are false, for one normative reason and one vendor reason, and neither is visible from
inside this repository.

**A section header is a glob.** The EditorConfig specification (v0.17.2, *File Format*)
is explicit: a "Section Header … define[s] globs", and *Glob Expressions* lists `*`,
`**`, `?`, `[seq]`, `[!seq]` and `{s1,s2,s3}` as the characters that do the matching.
`[prettier]` therefore matches a file named `prettier`, in a directory of the
repository or below it. No repository has one. The block matched no file, ever.

**`singleQuote` is not a key anything honours.** The same specification's *Supported
Pairs* section defines nine keys — `indent_style`, `indent_size`, `tab_width`,
`end_of_line`, `charset`, `spelling_language`, `trim_trailing_whitespace`,
`insert_final_newline`, `root` — and `singleQuote` is not among them. That section also
settles what an undefined key does, and it settles it in the worst possible direction:
cores "shall accept and report" syntactically valid pairs even when the key is not
defined, while plugins "shall ignore unrecognized keys". An unknown key is not an error
to be reported; it is a line that parses and does nothing.

Prettier's own mapping (`src/config/editorconfig/editorconfig-to-prettier.js` on `main`)
reads exactly six properties: `indent_style`, `indent_size`, `tab_width`,
`max_line_length`, `quote_type` and `end_of_line`. `singleQuote` is not one of them, and
neither `quote_type` nor `max_line_length` is a key the specification defines — the
source labels `quote_type` an "Undocumented feature". Its published documentation
mentions only `max_line_length`, `indent_size`, `tab_width`, `indent_style` and
`end_of_line` as the editorconfig properties it reads.

So the region asserted, in a comment, that it was the file that settled the estate's
`singleQuote` disagreement; the value was in a section that matched nothing, under a key
that no reader honours. That is the "decoration that misdescribes the artefact" failure
this repository's own `AGENTS.md` names, and no gate here could see it: `check` compares
bytes, and the bytes were current.

**This record cites the specification and the vendor's source rather than a local run.**
That is a change from the review's evidence, which measured Prettier 3.8.3, and it is
deliberate. ADR-041 rules this package's suite against reaching for a formatter, and the
npm registry this was written against refuses the fetch (`403`), so a reproduced run was
not available. The two citations are stronger for the purpose anyway: one is normative and
one is the mapping Prettier actually runs, whereas a version-pinned run would date the
moment the question was asked.

## The survey S30 asked for

S30's fix was split in two on purpose: delete the block **now**, and add `quote_type =
single` **only with an estate survey**. The survey is this section, and it is the reason
the second half is not taken.

Five of the sixteen repositories run Prettier. Prettier resolves `.editorconfig` first and
merges the repository's own config over it (`resolve-config.js`: `{ ...editorConfigured,
...mergeOverrides(...) }`), so a repository that states `singleQuote` is unaffected by
anything this baseline says, and a repository that states nothing is decided entirely by
it.

| Repository | Prettier config | States `singleQuote` | Adopting `quote_type = single` |
| --- | --- | --- | --- |
| `simt-api` | `.prettierrc` | `true` | no change |
| `simt-blog` | `.prettierrc.json` | `true` | no change |
| `simt-space` | `.prettierrc.json` | `true` | no change |
| `simt-social-api` | `.prettierrc.json` | absent | **every source file reformatted** |
| `simt-social` | `.prettierrc.json` | absent | **every source file reformatted** |

Two repositories would have every source file rewritten on the day they adopted the
tool, in a commit whose message says it adopted a rules projection. The measurement is
the answer to the question S30 deferred: the second half is not taken, and the reason is
recorded here so the next person does not run the survey again to reach it.

## Rulings

1. **`[prettier] singleQuote = true` is withdrawn.** ADR-025 ruling 8 does not stand; its
   `printWidth` half is unaffected and was never implemented. This changes no behaviour,
   because the block was inert — which is why two reviews and the whole suite read past
   it: the gate compares bytes, and the bytes were what the source said they were.

2. **A baseline section header is a glob over paths, never a name.** A header with no
   special character matches one filename, and the only filenames a file every
   repository receives may name are the ones every repository has. A literal travels
   inside a brace group with the globs it belongs with — `[{*.go,*.proto}]`, which this
   baseline already does for exactly this reason. `test/baselines.test.mjs` asserts it,
   because the defect it prevents is a header that parses.

3. **Every key in a baseline is one a reader honours.** The nine keys the specification
   defines are the whole vocabulary, and the test names them with the section they come
   from. This is what rules `singleQuote` out by construction rather than by deletion:
   `quote_type` is excluded by the same test, and the reason it is excluded is written
   next to it.

4. **`quote_type = single` is not adopted, and the estate survey above is its record.**
   Not rejected in principle: rejected for now, on a measurement — two of five
   repositories would be wholly reformatted, and this tool does not reformat a
   repository on the day it adopts one. The disagreement it would settle is real and is
   still open (ADR-025's consequences already recorded `singleQuote` as unsettled
   everywhere else), and it belongs in each repository's own Prettier config, which is
   the only place that can change a repository's bytes.

## Consequences

- `.editorconfig` loses eleven lines, one of which was the only claim in the file about a
  tool. Every adopting repository sees a real `.editorconfig` change on its next
  `sync --yes`, and `check` reports it: the baseline target list is the one `check` and
  `upgrade` both read, so the repository is correctly classified as behind. What `upgrade`
  will *not* do is name the cause correctly. Measured on a scratch repository carrying the
  body this record withdraws and every other byte current:

  ```
  DRIFT      .editorconfig  region is updated; run: simt-dev sync --yes
  pin     0cfea39f…6671 (unchanged)
  region restamped; the pin was already current (the rules changed)
  ```

  No rule changed. The provenance digest covers `rules/` and `graph/` and deliberately
  excludes `src/` — the rationale is that "a change that moves a consumer's projection"
  must move the stamp, and the baseline bodies are content that leaves the package while
  living in `src/`. `check` is unaffected because it compares bytes, and `upgrade` is
  affected because it compares the stamp. ADR-032 found this exact false cause once
  already, for a different reason, and the fix there was to identify the projection by its
  content rather than by a commit; the same gap survives for the bytes that are not in
  `rules/`. It is filed as **S53** with this measurement attached rather than fixed here,
  because widening the digest changes what the stamp means and that is ADR-032's subject
  (ADR-002).

- Plan 0001 claims the contradiction is settled "in `.editorconfig`'s `[prettier]`
  section" in two places. Both were true of the file and false of its meaning, so both
  are amended to point here. Leaving them would leave the plan asserting a mechanism this
  record has just withdrawn, which is ADR-036's failure one document up.

- `test/baselines.test.mjs` grew a guard rather than an assertion about today's string,
  because a string assertion passes the day somebody pastes the block back.

## Rejected

- **Keeping the block and correcting only its comment.** Rejected: it would leave a
  section matching nothing, and the next reader would have to rediscover that a comment
  admitting it is inert is still inert.
- **`quote_type = single` under the JS/TS glob, as S30's second half proposed.**
  Rejected on the survey above. It is recorded as a measurement, not as a plan, because
  the cost lands on two repositories that did not ask for it.
- **Widening the digest to cover baseline bodies in this slice.** Rejected under
  ADR-002: it is a change to what the stamp means, which is ADR-032's subject and
  deserves its own record. It is filed as S53 with this measurement attached, so the
  next reader has the evidence rather than the conclusion.