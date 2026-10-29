// simt plugin <claude|gemini|cursor|opencode> --out <dir> [--yes]
//
// Build one harness package from the same tables `agent-hooks install` writes into a
// repository, so a package and a repository install cannot drift apart. A dry run prints
// the plan and writes nothing; --yes copies the runtime and writes every generated file.
// The package is self-contained — it carries its own copy of the runtime — so it installs
// into a clean profile that has never seen this tool (plan 0003 R43).

import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { buildPackage, PLUGIN_KINDS } from '../plugins.mjs';
import { diffField, emitDiffs } from '../diff.mjs';

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

  // The `--diff` pairs: the generated files, created or refreshed (R50). The
  // before-sides ride on the plan from `buildPackage`, read before anything was
  // written, so the diff is true in preview and in apply alike.
  const diffs =
    flags.diff === true
      ? plan.files.map((f) => ({ path: f.path, before: f.before ?? null, after: f.text }))
      : [];
  // The file bytes travel in `diff`, not in the file list: a payload that
  // carried every generated file twice would be a document nobody diffs.
  const publicFiles = plan.files.map(({ text, before, ...rest }) => rest);

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: `plugin ${kind}`,
      out,
      dryRun: !apply,
      runtime: plan.runtime,
      files: publicFiles,
      notes: plan.notes,
      ...diffField(diffs, flags),
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
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  return EXIT.OK;
}
