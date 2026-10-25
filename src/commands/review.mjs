// `simt review [--local]` (plan 0003 R39).
//
// The critic's report layer: the deterministic path prints the brief (staged diff
// plus what governs it); `--local` adds the model verdict, which always arrives as
// a proposal a human reads — nothing here is a gate, and the exit code never
// carries the verdict, because a critic that fails the run would be a gate by
// another name (ADR-090, principle P2: the reply's text is model output and never
// lands in projected or committed text).

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, isJson } from '../output/index.mjs';
import { reviewTarget } from '../review/critic.mjs';

function governsLine(items) {
  if (items.length === 0) return 'none';
  const ids = items.slice(0, 8).map((item) => item.id);
  const more = items.length > ids.length ? ` …+${items.length - ids.length}` : '';
  return ids.join(', ') + more;
}

export async function reviewCommand(args, flags, commands = []) {
  const result = await reviewTarget(args, flags, { commands });
  if (typeof result === 'number') return result;

  if (isJson(flags)) {
    emitJson(result, { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  const lines = [
    `staged    ${result.staged.files.length} files, ${result.staged.bytes} bytes`,
    `governs   ${governsLine(result.governs)}`,
  ];
  // The branch keys on the path, not on the verdict: a local run whose reply
  // lacked a verdict line still carries faults and a proposal, and hiding them
  // behind the "needs --local" reading would erase the model's failure.
  if (result.brief !== undefined) {
    // The nothing-staged run is a plain answer, not an invitation to rerun with
    // --local: there is no brief yet, so there is nothing for the critic to read.
    if (result.staged.files.length === 0) {
      lines.push('verdict   none (nothing is staged)');
    } else {
      lines.push(
        `verdict   needs ${CLI} review --local  (advisory; a critic is never a gate)`,
      );
    }
  } else {
    if (result.verdict !== null) {
      lines.push(
        `verdict   ${result.verdict} (${result.verified ? 'verified' : 'unverified'})`,
        `findings  ${result.findings}`,
      );
    } else {
      lines.push('verdict   absent (unverified)');
    }
    if (!result.verified) {
      for (const fault of result.faults) lines.push(`unverified ${fault}`);
    }
    lines.push(`proposal  ${result.proposal.path}  (${result.proposal.state}, ${result.proposal.bytes} bytes)`);
  }
  if (result.metric) lines.push(`metric    ${result.metric.note}`);

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}
