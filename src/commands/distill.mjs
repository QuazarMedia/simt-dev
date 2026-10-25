// `simt distill <skill|doc>` (plan 0003 R38).
//
// A budgeted summary with citations to source line ranges, written to
// `.simt/distilled/` as a proposal a human merges. The deterministic engine
// is the default; a local model proposes only when the caller asks for it and the
// manifest names one (ADR-090, ADR-075). Model output never lands anywhere
// projected or committed text does — that is the direction this command cannot
// take (principle P2).

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, isJson } from '../output/index.mjs';
import { distillTarget } from '../distill/distill.mjs';

export async function distillCommand(args, flags) {
  const result = await distillTarget(args, flags);
  if (typeof result === 'number') return result;

  if (isJson(flags)) {
    emitJson(result, { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  emit(
    [
      `source    ${result.target.kind}  ${result.target.source} (${result.target.bytes} bytes, ${result.target.lines} lines)`,
      `digest    ${result.digest}`,
      `engine    ${result.engine}`,
      `budget    ${result.budget} bytes`,
      `citations ${result.citations}`,
      ...(result.verified === true ? [] : result.faults.map((f) => `unverified ${f}`)),
      `proposal  ${result.proposal.path}  (${result.proposal.state}, ${result.proposal.bytes} bytes)`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}
