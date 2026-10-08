# ADR-041 — The suite installs the package in order to test it

Status: **accepted** · 2026-10-08 · affects `test/pack.test.mjs` and what the suite may assume about `npm`

## Context

Every other file in `test/` imports from `../src`. That is what they are for: they are tests of
units, and a unit test cannot see a file that `package.json` forgot to ship. S01 shipped a
package whose `files` list and whose runtime reads disagreed, and the suite was green — because
every test in it was reading the checkout rather than the artefact.

Review 0001 §S20 named five missing test families. Four have since landed: the JSON and
write-mode contract table (S10), the git-state hook tests (S08), the resolver tests (Wave 1) and
the MCP parity work in progress. The first family on the list, pack-and-install end to end, was
still open, and review 0002 §5 says plainly that it "is the one that would have caught S01, S27
and S35 before they shipped; land it first, with S01". S01 had already been closed. So the row
that was supposed to be carried by it was never carried at all.

Two facts about this repository make that gap harder to notice than it looks. `test/` may not
reach outside the checkout (ADR-031), and this package has no dependencies (ADR-012). Together
those mean the suite has no installed copy of itself to test, and the natural workaround —
borrowing a formatter from a neighbouring checkout — is the one ADR-031 rules out. Prettier 3.8.1
is sitting in `../simt-blog/node_modules/.bin` and is not available here.

## Ruling

**One.** `test/pack.test.mjs` drives `node_modules/.bin/simt-dev`, installed from a tarball that
`npm pack` produced from the working tree. Anything a reader of this repository only learns from
the published package — that the registry resolves out of `node_modules`, that the decisions are
present to read, that a full adoption survives a commit and a hook — is asserted here and nowhere
else.

**Two.** The install is `npm install --offline`. That is a constraint on this repository, not a
setting: the package must install with no network and no warm cache, so `dependencies` and
`devDependencies` stay empty and adding a build-time or test-time tool to either of them is a
change to a guarantee rather than a convenience. A suite that fails on a cold runner gets
skipped on one, and a skipped test and a passing test are the same line of output.

**Three.** The pack test runs `npm pack` against the working tree rather than against a staged
or committed tree. A mutation test has to be able to change a byte in `src/` and watch this file
notice, and packing a commit would hide the change it is supposed to catch.

**Four.** This file does not assert that the projected output is formatted, because there is no
formatter to assert it with. S29's second acceptance half — a packed install whose output passes
`format:check` — therefore stays open, and the seam it would have caught is asserted
structurally instead, in `test/markers.test.mjs`. The record is here so that the open half is a
decision rather than an oversight, and so that whoever makes Prettier reachable does not have to
rediscover why this file stops where it stops.

## Consequences

Four mutations were made against the four rulings, each reverted immediately, and each was caught
by the test that claims the behaviour:

| Mutation | Caught by |
| --- | --- |
| `"graph"` removed from `package.json` `files` | `the registry the installed tool reads comes out of node_modules`, plus three others |
| `"docs/decisions"` removed from `files` | `the decisions the tool explains itself with are in the tarball` |
| `planGates` stops filtering by capability | `a repo that cannot run a gate is not told it has one` |
| `upgrade` and `hooks install` write without `--yes` | `a packed install survives the whole adoption, and no writer writes unasked` |

The first two are the S01 class and they shipped green for a long time. The third is S27. The
fourth is ADR-035 and ADR-036, and it is in the list because `hooks install` was found by hand the
day before, not by any of these tests.

One thing this file deliberately does not assert, having been measured while writing it: the
`files` list in `package.json` names four directories that do not exist in this repository —
`skills`, `agents`, `tooling` and `hooks`. npm ignores them without complaint and the tarball is
complete. An assertion that each entry exists would pass the moment the directories are created
and say nothing in the meantime, so the fact is recorded here rather than encoded as a check.

## Rejected

**Running the installed binary out of a staged copy of `src/`.** It reproduces the checkout's
bytes under a different path, which is precisely the state S01 shipped in. A test that cannot
distinguish the two is worse than no test.

**Adding Prettier as a devDependency so the formatting assertion can be written.** It would
make the assertion possible and the suite unreliable: `npm install` would need the network on a
cold runner, and ruling two exists because that is not a cost this repository pays. The
correct fix is a formatter the suite can already reach, which is a decision somebody should make
deliberately rather than a side effect of this one.

**Skipping the pack test when `npm` is unavailable.** Every other test in the suite already needs
node, git and a POSIX shell; npm is in the same class. A conditional skip converts a green run
into an unverified one, which is the failure this file was written to stop.

**Copying Prettier out of a sibling checkout.** It exists, it works, and ADR-031 rules it out for
the same reason it rules out reading skill bodies from `../simt-social`: a suite that passes on
the author's machine and fails on a runner with only this checkout is evidence about the author's
directory.