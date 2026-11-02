# Exit codes

The exit code is the contract a hook and a CI workflow read. `src/output/index.mjs` holds the
constants; this page is their meaning.

| Code | Name | When |
| --- | --- | --- |
| 0 | `OK` | the command did what it was asked, or reported nothing to fix |
| 1 | `FAIL` | a gate failed: drift, a policy violation, a missing piece of evidence |
| 2 | `USAGE` | the arguments were wrong; the remedy is in the message |
| 3 | `CONFIG` | `simt.json` is missing or invalid |
| 4 | `REGISTRY` | the skill registry is invalid: an orphan, a dangling edge, a cycle |
| 5 | `UNSUPPORTED` | the request cannot be satisfied on this platform or in this repository |

Two rules follow from the list. A command that finds a problem it can name exits `FAIL`, not
`USAGE`: the invocation was right, the tree was not. And a command that only reports — a
budget overrun, a deferred rule, an advisory review — exits 0 with the finding in its output,
because a non-zero code is a claim that the gate is red.
