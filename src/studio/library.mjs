// The Library's two shelves and one reading pane, read from the doors themselves.
//
// `lessons list` separates candidates from promoted lessons; `skills index` carries the
// registry's byte sizes and deferred flags. The library copies neither shape, so its byte
// labels and its reading pane cannot drift from the commands.

import { run, renderJson } from '../run.mjs';

export async function libraryPayload(root) {
  const [lessonsRun, skillsRun] = await Promise.all([
    run('lessons list', { flags: { json: true }, root }),
    run('skills index', { flags: { json: true }, root }),
  ]);
  const lessons = renderJson(lessonsRun);
  const skills = renderJson(skillsRun);
  // `skills index` emits its facts without the command name; the dispatcher adds it to
  // every document, so the library document must carry the same field.
  if (skills && typeof skills === 'object' && !Array.isArray(skills) && skills.command === undefined) skills.command = 'skills index';
  return {
    ok: lessons?.ok !== false && skills?.ok !== false,
    command: 'library',
    root,
    lessons,
    skills,
  };
}

export async function librarySkill(root, name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'skills show needs a skill name', remedy: 'choose a skill from the index' };
  }
  const result = await run('skills show', { args: [name], flags: { json: true }, root });
  return renderJson(result) ?? { ok: false, error: result.error?.message ?? 'skills show refused', remedy: result.error?.remedy ?? 'run: simt skills show <name>' };
}
