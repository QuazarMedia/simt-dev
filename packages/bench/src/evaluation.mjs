// W45/W46 evaluation commands: counterfactual replay and judge calibration.
//
// Both answer from one input document and neither runs an agent, but they are still bench
// commands: their vocabularies (relations, autonomy bands) are the bench's, and the core
// package must not carry that code for repositories that never measure a model.

import { CLI } from '../../../src/name.mjs';
import { EXIT, fail, present } from '../../../src/output/index.mjs';
import { readJsonDocument } from '../../../src/commands/doc-input.mjs';
import { metamorphic, offline, replayable } from './replay.mjs';
import { autonomy, calibration } from './calibration.mjs';

function renderReplay(payload) {
  const lines = [`replayable ${payload.trace.replayable ? 'yes' : `no: ${payload.trace.missing.join(', ')}`}`];
  for (const entry of payload.metamorphic.results) lines.push(`${entry.holds ? 'HOLDS' : 'FAILS'} ${entry.relation.padEnd(28)} ${entry.reason ?? ''}`);
  lines.push(`holds      ${payload.metamorphic.holds ? 'yes' : 'no'}`);
  lines.push(`reporting  ${payload.measures} only, offline; ${payload.reason}`);
  return lines.join('\n');
}

function renderCalibrate(payload) {
  const lines = [
    `samples    ${payload.measured.samples}`,
    `false      ${payload.measured.falseAccepts}  rate ${payload.measured.falseAcceptRate}`,
    `disagreement ${payload.measured.disagreement}`,
    `decision   ${payload.decision.decision}`,
    ...(payload.decision.bound === null ? [] : [`bound      ${payload.decision.bound}`]),
    `because    ${payload.decision.reason}`,
    'decides    repository policy, not this report',
  ];
  return lines.join('\n');
}

export async function benchReplayCommand(args, flags) {
  const usage = `run: ${CLI} bench replay --input <file>`;
  if (args.length > 0) return fail(`unknown bench replay argument ${args[0]}`, EXIT.USAGE, usage);
  const read = await readJsonDocument(flags, 'input');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, usage);
  const doc = read.doc;
  const payload = {
    ok: true,
    command: 'bench replay',
    trace: replayable(doc.trace ?? {}),
    metamorphic: metamorphic({
      before: doc.before ?? null,
      after: doc.after ?? null,
      relations: Array.isArray(doc.relations) ? doc.relations : [],
      options: doc.options ?? {},
    }),
    ...offline(),
  };
  present(payload, () => renderReplay(payload), flags);
  return payload.trace.replayable && payload.metamorphic.holds ? EXIT.OK : EXIT.FAIL;
}

export async function benchCalibrateCommand(args, flags) {
  const usage = `run: ${CLI} bench calibrate --input <file>`;
  if (args.length > 0) return fail(`unknown bench calibrate argument ${args[0]}`, EXIT.USAGE, usage);
  const read = await readJsonDocument(flags, 'input');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, usage);
  const doc = read.doc;
  let payload;
  try {
    const measured = calibration({ pairs: Array.isArray(doc.pairs) ? doc.pairs : [] });
    const decision = autonomy({
      scope: doc.scope ?? null,
      capability: doc.capability ?? null,
      calibration: measured,
      prereg: doc.prereg ?? null,
      judge: doc.judge ?? null,
      policy: doc.policy ?? {},
    });
    payload = { ok: true, command: 'bench calibrate', measured, decision };
  } catch (error) {
    return fail(error.message, EXIT.USAGE, usage);
  }
  present(payload, () => renderCalibrate(payload), flags);
  return payload.decision.decision === 'blocked' ? EXIT.FAIL : EXIT.OK;
}
