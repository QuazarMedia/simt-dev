# Add an ecosystem

An ecosystem is the detection record that says which files make a repository this kind of
repository, and which language claims which extension for extraction and for resolution.
It is data under `ecosystems/<id>.json`, not a branch in the engine.

1. **Add the record.** `ecosystems/<id>.json` names the markers (`package.json`,
   `go.mod`, …), the language map, and the build files a gate template might run. Two maps
   matter and they are not the same: `extract` decides how a file is parsed, `canonical`
   decides how a file is resolved, and a record that merges them makes `.ts` a TypeScript
   import target in a JavaScript repository.
2. **Add the profile, if the ecosystem has rules.** See
   [add-a-stack-profile](add-a-stack-profile.md). An ecosystem with no profile is still
   adopted: it gets the core rules and no gates, and `simt doctor` says so.
3. **Never edit the projection to make a product work.** If `src/projection/project.mjs` or
   `src/resolve/fingerprint.mjs` needs a new branch for an ecosystem, the design is wrong
   (ADR-013): the fact the branch would need belongs in the record.
4. **Test the detection.** A fixture repository carrying only that ecosystem's markers must
   select that ecosystem's profile and no other; `test/ecosystems.test.mjs` and
   `test/detect*.test.mjs` are where that lives.
