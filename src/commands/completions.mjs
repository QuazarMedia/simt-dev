// `simt completions <shell>` — print a completion script (plan 0003 R51).
//
// The script goes to stdout and nothing else does, because the install is a
// redirect: `source <(simt completions bash)`, or the zsh file dropped onto
// `$fpath`. A report line above it would be a report line in the user's shell
// config.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { SHELLS, renderCompletions } from '../completions.mjs';

export async function completionsCommand(args, flags, commands) {
  const shell = args[0];
  if (shell === undefined) {
    return fail('completions needs a shell', EXIT.USAGE, `one of: ${SHELLS.join(', ')}`);
  }
  if (!SHELLS.includes(shell)) {
    return fail(`unknown shell \`${shell}\``, EXIT.USAGE, `one of: ${SHELLS.join(', ')}`);
  }

  const script = renderCompletions(shell, commands);
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'completions', shell, script });
    return EXIT.OK;
  }
  emit(script, { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}