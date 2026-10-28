// `simt pr-body [--base <ref>]` (plan 0003 R55).
//
// The report layer over `src/prbody.mjs`: a markdown PR body on stdout, one
// JSON document under `--json`. Read-only like `evidence` and `review` — it
// names the tree, reads the ledger and the check cache, and writes nothing,
// so there is no `--yes`, no `--diff` and no journal entry to record.
//
// The exit code never carries the verdict. A report that failed when the body
// said BLOCK would be a gate by another name (the same reason `review`
// exits 0 on an unverified reply), and a gate this command never asked to be.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { buildPrBody, renderPrBody } from '../prbody.mjs';

export async function prBodyCommand(args, flags) {
  const root = flags.root ?? process.cwd();
  if (args.length > 0) {
    return fail(`pr-body takes no positional arguments`, EXIT.USAGE, `run: ${CLI} pr-body [--base <ref>]`);
  }
  const report = await buildPrBody(root, { base: flags.base ?? null });
  if (report.error !== null) {
    return fail(report.error, EXIT.USAGE, `run: ${CLI} pr-body --base <ref> with a ref git knows`);
  }
  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: 'pr-body',
        base: report.base,
        tree: report.tree,
        evidence: report.evidence,
        decisions: report.decisions,
        paths: report.paths,
        gates: report.gates,
        verdict: report.verdict,
        unreviewed: report.unreviewed,
      },
      { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }
  emit(renderPrBody(report), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}
