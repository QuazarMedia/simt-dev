// `simt bench ...` when the bench is not part of this installation.
//
// The bench left the core package: it is ~5k lines that measure an
// agent against a mined corpus, and a repository that wants the rules and the gate should
// not carry them. The commands themselves live in `packages/bench/src/commands.mjs`, and
// this module loads that on demand - so a checkout keeps working exactly as before, and an
// installation without the package gets one sentence naming what is missing instead of a
// module-not-found stack from inside a command the spec still lists.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EXIT, fail } from '../output/index.mjs';

const LOCAL = new URL('../../packages/bench/src/commands.mjs', import.meta.url);

async function load() {
  // A checkout keeps its bench next to the core sources; an installation resolves the
  // separately built `@simt-dev/bench` package. Checking the local file first means a broken
  // local bench is reported as a bench failure, not silently replaced by a stale package.
  if (existsSync(fileURLToPath(LOCAL))) {
    try {
      return { module: await import(LOCAL.href) };
    } catch (error) {
      return { error, local: true };
    }
  }
  try {
    return { module: await import('@simt-dev/bench') };
  } catch (error) {
    return { error };
  }
}

function unavailable(error, local = false) {
  return fail(
    `${local ? 'the bench package could not be loaded' : 'the bench is not installed'} (${error.code ?? error.message})`,
    EXIT.UNSUPPORTED,
    local
      ? 'fix the bench source, or reinstall @simt-dev/bench'
      : 'run this command from a simt-dev source checkout, or install @simt-dev/bench alongside simt-dev',
  );
}

async function run(exported, args, flags, commands) {
  const loaded = await load();
  if (loaded.error) return unavailable(loaded.error, loaded.local === true);
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
export const benchReplayCommand = (args, flags) => run('benchReplayCommand', args, flags);
export const benchCalibrateCommand = (args, flags) => run('benchCalibrateCommand', args, flags);
// The critic resolves `Affects command:` tokens through the registry, so dispatch hands
// it the same list it hands `why` and `impact`.
export const benchCriticCommand = (args, flags, commands) => run('benchCriticCommand', args, flags, commands);
