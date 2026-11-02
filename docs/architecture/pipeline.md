# Detection, selection, projection, gates

## How a rule is chosen

Detection reads dependency manifests, build files and CI workflows, and ranks rules by
path, keyword, name, capability and stack. The ranking is a score. A pull request can
diff it.

A repository whose ecosystem has no profile yet is still adopted: it gets the core rules
and no gates, until gate templates exist for it. A hook that would run nothing is not
installed.

## What each stage reads and writes

| Stage | Reads | Writes |
| --- | --- | --- |
| detect | the repository's own manifests, build files, workflows | the `facts` the resolution scores against |
| select | the rule catalogue, the facts, the manifest's `surfaces` and `budget` | the rule set, and the region body |
| project | the selected rules, the substitutions | `AGENTS.md`'s region, the per-surface rule files, the baselines, `simt.lock.json` |
| gate | the manifest's `gates`, the dispatcher | `.simt/ledger.jsonl`, and the exit code git reads |

Content is data; the engine is code. A new ecosystem arrives as a profile file and, where
detection cannot see it, a `has-*` fact — never as a branch in the projection (ADR-013).

## The gates

Two, and both are the repository's own commands:

- **at git time**, the pre-commit hook the dispatcher installs runs the gates the manifest
  declares, and the pre-push hook runs what the repository says it runs.
- **before a tool call**, the agent hook decides one call against the same policies, and
  refuses with a remedy rather than a warning.

A gate is declared only if the repository can run it (ADR-017). The evidence ledger records
what actually ran, against the tree it ran on, so a commit message claiming a passing run
this tree does not have is a finding rather than a trust exercise (ADR-120).

## Determinism

The default path uses no model and opens no socket. Resolution ranks by path, keyword,
name, capability and stack so a pull request can meaningfully diff the result; anything
that would need a heuristic a score cannot explain belongs behind a record, not in the
resolver. Local models and federated servers are opt-in blocks in `simt.json`, and they
propose rather than write projected text.
