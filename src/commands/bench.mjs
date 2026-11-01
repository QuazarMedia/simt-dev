// `simt bench ...` when the bench is not part of this installation.
//
// The bench left the core package (review 0003 Q79/Q84): it is ~5k lines that measure an
// agent against a mined corpus, and a repository that wants the rules and the gate should
// not carry them. The commands themselves live in `packages/bench/src/commands.mjs`, and
// this module loads that on demand - so a checkout keeps working exactly as before, and an
// installation without the package gets one sentence naming what is missing instead of a
// module-not-found stack from inside a command the spec still lists.
import { EXIT, fail } from '../output/index.mjs';

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
export const benchVariantsCommand = (args, flags) => run('benchVariantsCommand', args, flags);
export const benchExportCommand = (args, flags) => run('benchExportCommand', args, flags);
export const benchImportCommand = (args, flags) => run('benchImportCommand', args, flags);
// The critic resolves `Affects command:` tokens through the registry, so dispatch hands
// it the same list it hands `why` and `impact`.
export const benchCriticCommand = (args, flags, commands) => run('benchCriticCommand', args, flags, commands);
