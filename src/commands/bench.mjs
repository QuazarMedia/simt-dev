// `simt bench ...` when the bench is not part of this installation.
//
// The bench left the core package: it is ~5k lines that measure an
// agent against a mined corpus, and a repository that wants the rules and the gate should
// not carry them. The commands themselves live in `packages/bench/src/commands.mjs`, and
// this module loads that on demand - so a checkout keeps working exactly as before, and an
// installation without the package gets one sentence naming what is missing instead of a
// module-not-found stack from inside a command the spec still lists.
import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { readJsonDocument } from './doc-input.mjs';
import { metamorphic, offline, replayable } from '../bench/replay.mjs';
import { autonomy, calibration } from '../bench/calibration.mjs';

async function load() {
  try {
    return { module: await import('../../packages/bench/src/commands.mjs') };
  } catch (error) {
    return { error };
  }
}

function unavailable(error) {
  return fail(
    `the bench is not installed (${error.code ?? error.message})`,
    EXIT.UNSUPPORTED,
    'run this command from a simt-dev source checkout, or install the bench package alongside it',
  );
}

async function run(exported, args, flags, commands) {
  const loaded = await load();
  if (loaded.error) return unavailable(loaded.error);
  const handler = loaded.module[exported];
  if (typeof handler !== 'function') return fail(`the bench package has no ${exported}`, EXIT.FAIL, null);
  return handler(args, flags, commands);
}

export const benchMineCommand = (args, flags) => run('benchMineCommand', args, flags);
export const benchRunCommand = (args, flags) => run('benchRunCommand', args, flags);
export const benchReportCommand = (args, flags) => run('benchReportCommand', args, flags);
export const benchAblateCommand = (args, flags) => run('benchAblateCommand', args, flags);
export const benchProbesCommand = (args, flags) => run('benchProbesCommand', args, flags);
export const benchExportCommand = (args, flags) => run('benchExportCommand', args, flags);
export const benchImportCommand = (args, flags) => run('benchImportCommand', args, flags);
export const benchCompatCommand = (args, flags) => run('benchCompatCommand', args, flags);
export const benchCorpusCommand = (args, flags) => run('benchCorpusCommand', args, flags);
export const benchWorldCommand = (args, flags) => run('benchWorldCommand', args, flags);
// W45 and W46 are evaluation logic rather than measurement of an agent, so they live in the
// shipped sources and answer from a document: replaying a trace and calibrating a judge are
// offline computations, and neither is a live acceptance run.
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

// The critic resolves `Affects command:` tokens through the registry, so dispatch hands
// it the same list it hands `why` and `impact`.
export const benchCriticCommand = (args, flags, commands) => run('benchCriticCommand', args, flags, commands);
