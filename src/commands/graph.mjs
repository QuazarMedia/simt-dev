// `simt graph lint` - verify the hand-authored registry against reality.
//
// Implementation sequence step 2. This command is the reason hand-authoring the
// registry is safe: 38 nodes across 6 repos is bookkeeping that rots silently.
//
// Output is line-oriented and bounded (plan 0002 section 6). A lint failure names
// the offending node, the file it disagrees with, and both numbers.

import { EXIT, emit, fail, isJson } from '../output/index.mjs';
import { loadRegistry, REGISTRY_PATH } from '../graph/load.mjs';

export async function lintCommand(positional, flags) {
  const path = positional[0] ?? REGISTRY_PATH;
  const { ok, registry, errors, warnings } = await loadRegistry(path);

  if (isJson(flags)) {
    emit(
      `${JSON.stringify(
        {
          ok,
          registry: path,
          capabilities: registry?.capabilities?.length ?? 0,
          skills: registry?.skills?.length ?? 0,
          errors,
          warnings,
        },
        null,
        2,
      )}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return ok ? EXIT.OK : EXIT.REGISTRY;
  }

  if (!registry) {
    return fail(errors[0] ?? `${path}: unreadable`, EXIT.REGISTRY);
  }

  const lines = [
    `registry ${path}`,
    `nodes     ${registry.skills.length} skills, ${registry.capabilities.length} capabilities`,
  ];

  const deferred = registry.skills.filter((s) => s.deferred);
  lines.push(
    `deferred  ${deferred.length} over ${registry.deferredThreshold} bytes ` +
      `(${deferred.map((s) => s.name).join(', ') || 'none'})`,
  );

  if (warnings.length > 0) {
    lines.push('', `WARN ${warnings.length}`);
    for (const warning of warnings) lines.push(`  ${warning}`);
  }

  if (errors.length > 0) {
    lines.push('', `FAIL ${errors.length}`);
    for (const error of errors) lines.push(`  ${error}`);
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.REGISTRY;
  }

  lines.push('', 'OK no findings');
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}