// Walking the registry to the files on disk, so the conformance checker sees text.
//
// `graph lint` already resolves every skill to a path and measures it; this module does
// the same walk for a different reason - it needs the bytes, not the count - and it is
// separate rather than folded into that pass because one of the two questions may run
// without the other.

import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { checkSkill } from './spec.mjs';

/**
 * Check every skill the registry names against the Agent Skills specification.
 *
 * Only the canonical source is checked, because a skill with two bodies would give two
 * answers to one question and the reader would have to know which is which. A skill
 * whose body cannot be read is a warning and not an error: the registry pass already
 * reports a path that does not exist as an error, and saying it twice with two exit
 * paths is the "two commands, two answers" defect this repository exists to end.
 *
 * @param {{skills: object[]}} registry
 * @param {string} workspaceRoot
 * @returns {Promise<{errors: string[], warnings: string[], checked: number}>}
 */
export async function lintSpec(registry, workspaceRoot) {
  const errors = [];
  const warnings = [];
  let checked = 0;

  for (const skill of registry.skills ?? []) {
    const source = (skill.sources ?? []).find((s) => s.role === 'canonical');
    if (!source?.repo || !source?.path) continue;
    const at = `${skill.name}: ${source.repo}/${source.path}`;
    const full = join(workspaceRoot, source.repo, source.path);

    let info;
    try {
      info = await stat(full);
    } catch {
      warnings.push(`${at}: the conformance pass could not read it; the registry pass above reports the path`);
      continue;
    }

    // A skill directory holds its instructions in SKILL.md. A single file is the flat
    // form ADR-009 says will be wrapped: it is still checked, because its frontmatter
    // breaks the same rules, and the file name is reported as one of them.
    const file = info.isDirectory() ? join(full, 'SKILL.md') : full;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      warnings.push(`${at}: no SKILL.md in the directory, so there is nothing to check`);
      continue;
    }

    const report = checkSkill({
      directoryName: info.isDirectory() ? basename(full) : undefined,
      fileName: basename(file),
      text,
      at,
    });
    errors.push(...report.errors);
    warnings.push(...report.warnings);
    checked += 1;
  }
  return { errors, warnings, checked };
}
