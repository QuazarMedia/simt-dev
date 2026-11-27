# Add an ecosystem

An ecosystem is the detection record that says which files make a repository this kind of
repository, and which language claims which extension for extraction and for resolution.
It is data under `ecosystems/<id>.json`, not a branch in the engine.

1. **Add the record.** `ecosystems/<id>.json` names the evidence, language map, gate/card
   metadata and Dependabot rows. Two language maps matter and they are not the same:
   `exts` decides how a file is parsed, `canonical` decides how a file is resolved, and a
   record that merges them makes `.ts` a TypeScript import target in a JavaScript repository.
2. **Prove the fact from committed evidence.** Use `markers` for root files and directories.
   Use `probes` for repository-relative file existence, bounded regex matching, exact JSON
   object paths, or root and depth-bounded globs. Set `stripComments: true` when a text
   matcher must ignore line and block comments, including nested Kotlin block comments.
   A content probe names its input file and records that file as evidence; it does not
   inspect PATH, follow symlinks outside the repository, or read installed packages. Glob
   evidence must be a contained regular file. Invalid paths, regexes, matchers, probe lists
   or gate/card/Dependabot exclusions quarantine the record (ADR-262).
3. **Declare only automation the repository can run.** A gate row names a real tool and a
   command. Fresh adoption seeds it only when that tool is available; a marker alone is not
   runnability evidence (ADR-017, ADR-062). If nested modules or projects prove the broader
   ecosystem, give root commands a separate root-scoped fact so nested evidence cannot seed
   an unrunnable root gate or card line. Reuse the existing `format`, `lint`, `test` and
   `typecheck` names when their meaning fits. Card commands come from the same gate rows or
   an explicit `card` facet. Do not add a gate merely to make a support row look complete.
4. **Exclude conflicting rows with data.** `unless` on a gate, card condition or Dependabot
   row suppresses it when another fact is present. Use it for cases such as Flutter/Dart or
   Bun/npm instead of adding a product condition to the engine.
5. **Add the profile, if the ecosystem has rules.** See
   [add-a-stack-profile](add-a-stack-profile.md). An ecosystem with no profile is still
   adopted: it gets the core rules, and `simt doctor` reports its evidence.
6. **Never edit the projection to make a product work.** If `src/projection/project.mjs` or
   `src/resolve/fingerprint.mjs` needs a new branch for an ecosystem, the design is wrong
   (ADR-013): the fact the branch would need belongs in the record.
7. **Test the whole record.** A fixture carrying only that ecosystem's evidence must select
   its profile and no unrelated framework. Add negative controls for incidental text and
   lookalike files, then assert evidence, language resolution, gate/card behavior and
   Dependabot output. When nested evidence is supported, assert that it keeps coverage but
   does not seed root commands. Shared coverage lives in `test/ecosystem-probes.test.mjs`,
   `test/genericity.test.mjs`, `test/card.test.mjs` and the focused ecosystem test for the
   new record.

The [ecosystem support matrix](../reference/ecosystems.md) is the reader-facing inventory;
the records and profiles remain its source of truth.
