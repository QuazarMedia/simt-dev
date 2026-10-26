// simt plugin <claude|gemini|cursor> --out <dir> [--yes]
//
// Build one harness package from the same tables `agent-hooks install` writes into a
// repository, so a package and a repository install cannot drift apart. A dry run prints
// the plan and writes nothing; --yes copies the runtime and writes every generated file.
// The package is self-contained — it carries its own copy of the runtime — so it installs
// into a clean profile that has never seen this tool (plan 0003 R43).

import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { buildPackage, PLUGIN_KINDS } from '../plugins.mjs';

export async function pluginCommand(args, flags) {
  const kind = args[0];
  if (!kind || !PLUGIN_KINDS.includes(kind)) {
    return fail(
      kind ? `unknown package kind \`${kind}\`` : 'plugin needs a kind',
      EXIT.USAGE,
      `one of: ${PLUGIN_KINDS.join(', ')}`,
    );
  }

  const out = flags.out;
  if (!out) {
    return fail('plugin needs --out <dir>', EXIT.USAGE, 'where the generated package lands');
  }

  const { apply } = writeMode(flags);
  const root = flags.root ?? process.cwd();
  const plan = await buildPackage(kind, { root, out, apply });

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: `plugin ${kind}`,
      out,
      dryRun: !apply,
      runtime: plan.runtime,
      files: plan.files,
      notes: plan.notes,
    });
    return EXIT.OK;
  }

  const runtimeTarget = plan.runtime.target === '.' ? '(the package root)' : `${plan.runtime.target}/`;
  emit(
    [
      `kind     ${kind}`,
      `out      ${out}`,
      `runtime  copies ${plan.runtime.parts.join(', ')} into ${runtimeTarget}`,
      ...plan.files.map((f) => `${apply ? 'WRITE' : 'PLAN '}  ${f.path}`),
      ...plan.notes.map((n) => `note     ${n}`),
      '',
      apply
        ? `WROTE    ${plan.files.length} generated file(s) plus the runtime`
        : `PLAN     nothing written; apply with: ${CLI} plugin ${kind} --out ${out} --yes`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}
