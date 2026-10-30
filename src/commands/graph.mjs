// `simt graph lint` - verify the hand-authored registry against reality.
//
// Implementation sequence step 2. This command is the reason hand-authoring the
// registry is safe: 38 nodes across 6 repos is bookkeeping that rots silently.
//
// Output is line-oriented and bounded (plan 0002 section 6). A lint failure names
// the offending node, the file it disagrees with, and both numbers.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { loadRegistry } from '../graph/load.mjs';
import { lintSpec } from '../graph/speccheck.mjs';
import { SPEC, SPEC_SOURCE } from '../graph/spec.mjs';
import { CLI } from '../name.mjs';

export async function lintCommand(positional, flags) {
  const spec = flags.spec ?? null;
  if (spec !== null && spec !== SPEC) {
    return fail(`unknown --spec "${spec}"`, EXIT.USAGE, `the one specification this lints is: ${SPEC}`);
  }

  // The resolved path comes back from the loader, because when no positional is given it
  // falls back to the member that holds the registry in this workspace (ADR-061) - and the
  // reader should see where it actually looked, not a constant that no longer exists.
  const { ok, registry, errors, warnings, verified, workspace, path } = await loadRegistry(
    positional[0] ?? null,
    flags,
  );

  // The conformance pass is separate from the registry pass on purpose. The registry
  // answers "does the bookkeeping match the files"; the specification answers "would a
  // client accept these files", and the second question needs no registry at all. A
  // reader with no registry can still lint a skill directory, so the two are additive
  // rather than one gating the other.
  //
  // The pass runs only when asked for (`--spec`) and only against a verified
  // registry: without it the default lint reported 37 warnings for a pass the
  // payload claimed never ran (`spec: null`), and `ok` stayed true over errors
  // the spec pass had just found (review 0003 Q35).
  let specReport = { errors: [], warnings: [], checked: 0 };
  if (spec !== null) {
    if (registry && verified && workspace?.root) {
      specReport = await lintSpec(registry, workspace.root);
    } else {
      warnings.push(
        'spec pass skipped: it needs --spec against a registry verified on disk (see `verified` above)',
      );
    }
  }
  errors.push(...specReport.errors);
  warnings.push(...specReport.warnings);
  const finalOk = ok && errors.length === 0;

  if (isJson(flags)) {
    emitJson(
      {
        ok: finalOk,
        registry: path,
        capabilities: registry?.capabilities?.length ?? 0,
        skills: registry?.skills?.length ?? 0,
        // `verified: false` means the byte counts in the registry were NOT
        // checked against files on disk. It is not a failure - it is the difference
        // between "the registry is right" and "the registry could not be checked",
        // and an agent that cannot see the difference will trust a number nobody
        // measured (ADR-014).
        verified,
        workspace,
        // Present only when asked for, so a reader of the default output is not told
        // about a pass that never ran. `null` is the honest value; `true` would be a
        // claim about conformance nobody checked.
        spec: spec === null ? null : { name: SPEC, source: SPEC_SOURCE, checked: specReport.checked },
        errors,
        warnings,
      },
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return finalOk ? EXIT.OK : EXIT.REGISTRY;
  }

  if (!registry) {
    // The default remedy for this exit code is `run: simt graph lint`, which from
    // inside `graph lint` is circular: the reader just ran it and got this. Name the
    // argument the command takes, because an explicit path is the way out (ADR-061).
    return fail(errors[0] ?? `${path}: unreadable`, EXIT.REGISTRY, `run: ${CLI} graph lint <path-to-registry>`);
  }

  const lines = [
    `registry  ${path}`,
    `nodes     ${registry.skills.length} skills, ${registry.capabilities.length} capabilities`,
    `verified  ${verified ? 'byte counts checked against disk' : 'NOT checked - see WARN below'}`,
  ];
  if (spec !== null) {
    lines.push(
      `spec      ${specReport.checked} skills checked against ${SPEC_SOURCE}` +
        `${specReport.checked === 0 ? ' (none had a readable SKILL.md)' : ''}`,
    );
  }

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

  lines.push('', verified ? 'OK no findings' : 'OK structural checks only');
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}