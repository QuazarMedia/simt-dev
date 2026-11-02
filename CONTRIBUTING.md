# Contributing

## Before anything else

The repository adopts itself: `simt init` has already run here, so `AGENTS.md` carries the
rules this repository projects into others, and the region below its `<!-- simt:begin -->`
marker is generated. A rule edit is a change to every adopting repository at once; the
acceptance test is rendering the region for a real repository and reading it as that
repository's agent, not `simt check` here.

A change to what the tool believes — a gate, a rule, a conflict's classification — is a
ruling, and rulings live in `docs/decisions/` as a numbered record with a `Status:` line.
Supersede by writing a new record and editing the old one's status, never by rewriting
history in place.

## Hooks

`git config core.hooksPath` is `.simt/hooks`. The pre-commit hook owns format and lint for
staged files, so do not re-run what it just ran. Never use `--no-verify`: a hook that fails
is telling you something about the change.

After changing a template in `src/ci/`, re-render this repository's own copies:

```sh
node scripts/ci.mjs --yes     # --check reports drift and exits 1
```

## Tests

One suite, on the repository's own runner:

```sh
npm test                          # every file, both tiers
npm run test:unit                 # the focused form: files that never spawn the CLI
node --test test/index.test.mjs   # one file
```

A focused run is the default gate. A full suite runs against a named trigger: phase exit,
release gate, cross-system behaviour, or pre-push on a protected branch. Name the exact
commands and files in the commit message; a partial pass is a blocker, and `6/8 pass` is the
canonical blocked state.

`simt gate --changed` names the tests a change reaches. `simt evidence` lists the runs
recorded against the tree on disk, which is what a commit message's claim is checked
against.

**Run the suite from a copy at a path with no siblings before you believe it.** The suite
stages its own workspace (`test/fixture.mjs`) and reads nothing outside the checkout, but that
was not always true: three failures were found only by running the tool the way a consumer
runs it.

## Commits and pushes

Conventional Commits, imperative, a scope that names the subsystem. Commit locally and
report the SHA. **Push only on explicit approval**, and say before asking whether the push
triggers a deployment, a migration, or any other remote mutation.

## How-tos

Each one names the files a change touches and the test that holds it:

- [add a command](docs/contributing/add-a-command.md)
- [add a stack profile](docs/contributing/add-a-stack-profile.md)
- [add an ecosystem](docs/contributing/add-an-ecosystem.md)
- [add a harness](docs/contributing/add-a-harness.md)
- [add an MCP tool](docs/contributing/add-an-mcp-tool.md)
- [add a finding code](docs/contributing/add-a-finding-code.md)
- [write a decision record](docs/contributing/write-an-adr.md)

The architecture these assume is in [docs/architecture/overview.md](docs/architecture/overview.md);
the reference pages are indexed from the [README](README.md#where-to-read-next).

## Release checklist

1. `npm test` green on the tree being released, and the recorded evidence cited.
2. `node bin/simt.mjs docs commands --yes` and `simt rules decisions --yes` run, and their
   diff committed.
3. Version bumped in `package.json` and the wheel's metadata, and the CHANGELOG entry
   written with one line per change and its ADR link.
4. Tag, then publish the npm package, the PyPI wheel and the Homebrew formula from that tag.
5. The release binary carries its own runtime; check one platform before announcing.
