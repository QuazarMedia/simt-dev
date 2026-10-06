# A declared command is the runner; the remedy must be one the reader can take

Status: **accepted** · 2026-10-07

Affects: `simt-dev init`, `simt-dev check`, `simt-dev hooks status`, `simt-dev hooks run`,
`src/hooks/capability.mjs`, `src/hooks/resolve.mjs`, `src/projection/manifest.mjs`

## Context

ADR-017 made `simt-dev init` declare only gates a repository can actually run, and it shipped
green because the first adopter — `simt-social-media` — is a Node repository whose scripts
and binaries are exactly what the filter understood. It was verified by running that
repository's own tests.

`simt-app`, the third pilot, is a Gradle repository. It has **no `package.json` at all**. The
dry run dropped all five proposed gates, and the remedy for each one was an instruction the
reader cannot follow. The output as it stood, before this record was written:

```
$ simt-dev init --root ../simt-app
  dropped   gate test: no "test" script in package.json
            remedy: add a "test" script to package.json, then re-run: simt-dev init --yes
```

Ruling 4 changes both lines. `simt-app` will never have a `package.json`. "Install prettier as
a dev dependency" is equally impossible. The filter was right about the facts and wrong about
what followed from them, and the reader's only honest reaction to that remedy is to stop
trusting the next one.

Then the repo declared what it does have, using the escape hatch the remedy for command gates
had always advertised:

```json
"gates": { "preCommit": ["i18n-completeness"], "prePush": ["test"],
           "commands": { "i18n-completeness": "scripts/check_string_translations.sh",
                          "test": "./gradlew check" } }
```

and three surfaces answered three different things about it:

- `simt-dev hooks run pre-commit` — **PASSED**, running the declared script.
- `simt-dev hooks run pre-push` — would have demanded an npm script that does not exist,
  because `resolveGate` only consulted `gates.commands` for gates of kind `command`.
- `simt-dev check` — **UNRUNNABLE** on both, because `readCapability` never read
  `simt-dev.json` at all and so always reported an empty command map.

One manifest. Three answers. The one I would have shipped if I had only run `check`.

## Rulings

1. **A gate name is a requirement, not a mechanism.** The repository declares "prove `test`
   somehow"; `gates.commands[test]` is how it says how. Once declared, that wins for **every**
   gate kind — `script`, `staged` and `command` alike — because a repository naming its own
   program is a more specific statement than any table this tool can ship.
2. **`gates.commands` is part of what a repository can run.** `readCapability` reads
   `simt-dev.json` alongside `package.json` and `node_modules/.bin`. This is the one
   capability source that is a declaration rather than an observation, and that asymmetry is
   the point: the only evidence that can prove a command gate is the declaration.
3. **The dispatcher, `check` and `hooks status` read one manifest once and answer identically.**
   Two surfaces must never disagree about what a gate will do; the disagreement is what made
   this a defect rather than a rough edge.
4. **A remedy names an action the reader can take.** Where npm is the runner, the npm remedy
   stands. Where it demonstrably is not, the remedy is to name the program under
   `gates.commands` — the same instruction already given for command gates.
5. **An empty declared command is a failure, not a silent pass.** It would resolve to an empty
   argv and report `PASSED` while proving nothing, which is the worst outcome a gate can have.
6. **`'none'` is an answer; absent is not.** A capability that does not report its runner (one
   built by hand, or by an older caller) is treated as npm. Claiming a repository has no
   `package.json` on the strength of a missing field is a much worse guess than assuming it.
7. **Runner detection reads files, and must know the difference.** The marker for Gradle is
   the `gradlew` file. My first cut used `readdir` to test existence, which answers "no" for
   every file (`ENOTDIR`) and classified every Gradle repository in the estate as having no
   runner at all — a wrong answer from an evidence reader, which is worse than no answer
   because the caller cannot tell them apart.

## Consequences

- `simt-app` declares `i18n-completeness: scripts/check_string_translations.sh` on
  pre-commit — the gate its own hand-written pre-commit hook already runs — and
  `test: ./gradlew check` on pre-push.
- The `simt-social-media` and `simt-space` manifests are unaffected: they declare no commands.
- A Node repository that wants to override a gate now can, without abandoning the gate name it
  shares with every other repository. `gates.commands.format` is a supported thing to write.
- `readCapability` reads one more file per invocation, and it reads it in a `try` that cannot
  throw: a repository with no manifest simply has no declared commands.

## Rejected

- **Add a `gradle` gate kind, and a `python` one, and a `cargo` one.** Each would need its own
  dispatcher branch, its own remedy, its own tests, and its own entry in `GATES`. One rule —
  a declared command wins — covers every ecosystem including the next one, which is the reason
  the `command` kind exists at all.
- **Let the reader name the gate.** A repository could declare a gate called `gradle-check`
  rather than `test`. Then `test` is dropped for lack of a script while a second, unrelated
  gate appears, and the two estates of gate names stop being comparable.
- **Guess the Gradle task.** Printing `./gradlew test` as the remedy for a Gradle repository
  would be shorter and would be wrong in exactly the repositories where it is printed — plenty
  of Gradle projects have no `test` task and a `spotlessCheck` that is not `spotlessFormat`.
- **Treat an unreadable marker file as a runner.** A permission error is not evidence that a
  repository runs Gradle; it is evidence that this tool cannot see. Absent is the safe reading.
- **Leave `check` reporting the gate unrunnable and let `hooks run` be the truth.** Then the
  gate a reader is told to fix is not the gate that fails, and the two disagree on the same
  manifest — this defect, with the direction reversed.

## Evidence

`simt-app` is the first adopter with a non-npm runner and the first to declare a command for a
gate that is not of kind `command`. Every earlier adopter was a Node repository, which is why
ADR-017's own verification passed. The estate's three runners — npm, Gradle and Python — were
all in the repository set the whole time; only the pilot order had not reached them.