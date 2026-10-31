# Contributing

This package has no runtime and no development dependencies, so there is nothing to
install: `node bin/simt.mjs --help` runs the tool from a clone, and `npm test` runs the
suite.

## Wire the hooks first

```sh
git config core.hooksPath .githooks
```

Without it git reads `.git/hooks`, finds nothing, and `.githooks/pre-push` never runs —
which is how a repository has a hook nobody has ever been stopped by. The setting is
local to your clone; `git config --unset core.hooksPath` opts out.

The pre-push hook copies `HEAD` into a temporary directory and runs the checks there,
because a suite that only passes beside this repository's sibling checkouts does not
prove it passes in a clone (ADR-031). A failure prints the tail of its log, so you do
not have to re-run the gate to find out what broke.

## The checks

| Command | What it proves |
| --- | --- |
| `npm test` | the suite, including the content guards |
| `node bin/simt.mjs graph lint` | `graph/skills.graph.json` is consistent with the skills it names |
| `node bin/simt.mjs ci --check` | `.github/workflows/simt-dev-check.yml` matches the template that writes it |
| `npm run lint` | the registry lint |

The same three run in CI on Linux and macOS, on the Node floor and the current releases.
A change to a rule body or to a template is a change to every adopting repository, so
run `node bin/simt.mjs ci --yes` after editing `src/ci/workflow.mjs` and commit the
regenerated workflow with the template change.

## Commits

Commit locally and report the SHA; pushing is a separate decision. Do not use
`--no-verify`: a hook that fails is telling you something about the change.
