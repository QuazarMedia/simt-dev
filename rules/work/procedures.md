---
simt-id: work/procedures
simt-title: Declared procedures
simt-applies: [has-work-validators]
simt-priority: convention
simt-scope: ["**/*.md", "**/*.py", "**/*.mjs", "**/*.js", "**/*.ts", "**/*.json", "**/*.yml", "**/*.yaml"]
---

# Work profile: declared procedures

Applies when a repository declares its own validators under `work.scopes` in `{manifest}`.
The point of the declaration is that the checks are the repository's, not this tool's
default: a validator listed there is one the repository has agreed to run.

## Running a declared check

- Run the validator declared for the scope the change touches, and only that scope's
  validators. A change to one scope is not evidence about another.
- Invoke it through the repository's own runner when the declaration names one
  (`uv run`, `npm run <script>`, `./gradlew`); never through a package runner that fetches
  a different copy of the tool.
- A validator that cannot run - missing interpreter, missing fixture, unavailable service -
  is reported as blocked. A blocked check is not a passing one, and a partial pass is a
  blocker.
- Do not edit the validator to make a change pass. If the check is wrong, say what is wrong
  with it and change it deliberately, with the reason in the commit message.

## What a declared check proves

- A structural check proves structure: headings, links, required fields, generated files
  present. It does not prove the content is true, current, or applicable.
- A replay or mocked check proves the code path, not the live target. Report the two
  separately; a mock passing is not a remote operation verified.
- When the declaration gives the check a name, use that name in the report, so a reader can
  find the same check in `{manifest}`.

## Adopting a repository with no runner

- A repository that declares validators and no package runner has exactly those validators.
  Do not add a runner, do not synthesize a test gate, and do not describe the repository as
  untested: it has the checks it declared, and nothing else.
- If the declaration is empty or absent, say that no check is declared for the scope rather
  than implying one passed.
