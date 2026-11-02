# simt bench

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt bench ablate --yes` | `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task` | measure one arm of the brief against its ablation |
| `simt bench critic` | `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task` | score the review critic against the labelled bench set |
| `simt bench export --yes` | `--yes`, `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task` | write the sealed bench corpus as one signed document |
| `simt bench import` | `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task` | verify a sealed corpus and load it into the vault |
| `simt bench mine --yes` | `--yes`, `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task` | mine tasks out of a repository history |
| `simt bench probes --yes` | `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task`, `--yes` | run the deterministic probes against a workspace |
| `simt bench report [--compare a b]` | `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task` | summarise the runs recorded in the vault |
| `simt bench run --yes` | `--all`, `--arm`, `--compare`, `--cross-group`, `--harness`, `--labels`, `--model`, `--regrade`, `--replace`, `--reps`, `--task`, `--yes` | run agents against the mined tasks |

Writes to the repository: `simt bench export`, `simt bench mine`, `simt bench probes`, `simt bench run`. Each prints its plan and writes nothing without `--yes`.