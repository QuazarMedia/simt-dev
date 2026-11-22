// Guarded control: a fixed allowlist of the CLI's own writers, previewed and confirmed
// by the digest of the plan a reader actually saw.
//
// The studio never edits a file. Preview runs the writer without `--yes`; apply re-runs
// that same preview before writing, so an edit between the two requests changes the plan
// and is refused rather than merged. The writer then journals and emits its own
// `write.committed`, exactly as the CLI does.

import { createHash } from 'node:crypto';

import { run, renderJson } from '../run.mjs';
import { SPEC } from '../commands/spec.mjs';
import { entryLabel, listJournalSets, readJournalSet } from '../journal.mjs';

export const CONTROL_ALLOWLIST = Object.freeze([
  'work setup',
  'knowledge build',
  'slice start',
  'slice finish',
  'plan done',
  'sync',
  'undo',
]);

function rowFor(command) {
  if (!CONTROL_ALLOWLIST.includes(command)) return null;
  return SPEC.find((row) => row.path === command) ?? null;
}

function scalarFlags(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') return null;
    out[key] = item;
  }
  return out;
}

function requestOf(body) {
  const command = typeof body?.command === 'string' ? body.command : '';
  if (!CONTROL_ALLOWLIST.includes(command)) return { error: `\`${command || '(none)'}\` is not on the control allowlist` };
  const row = rowFor(command);
  const args = body?.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return { error: 'args must be an array of strings' };
  const flags = scalarFlags(body?.flags ?? {});
  if (flags === null) return { error: 'flags must be a flat object of scalar values' };
  const declared = new Set(row?.flags ?? []);
  for (const name of Object.keys(flags)) {
    if (name === 'yes' || name === 'json') continue;
    if (!declared.has(name)) return { error: `\`${name}\` is not a flag of \`${command}\`` };
  }
  delete flags.yes;
  delete flags.json;
  return { command, row, args, flags };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return `sha256-${createHash('sha256').update(text).digest('hex')}`;
}

function pathsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

/** The write plan is the diff the writer already produced, or the paths it named. */
export function planOf(document) {
  const patch = typeof document?.diff === 'string' ? document.diff : null;
  const patchPaths = patch
    ? [...patch.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)].map((match) => match[1])
    : [];
  const diff = Array.isArray(document?.diff)
    ? document.diff
        .filter((entry) => entry && typeof entry.path === 'string')
        .map((entry) => ({ path: entry.path, before: entry.before ?? null, after: entry.after ?? null }))
    : patchPaths.map((path) => ({ path, patch }));
  const files = [...new Set([
    ...diff.map((entry) => entry.path),
    ...pathsFrom(document?.written),
    ...pathsFrom(document?.restores),
    ...pathsFrom(document?.paths),
    ...pathsFrom(document?.targets),
    ...pathsFrom(document?.files),
    ...(Array.isArray(document?.changes)
      ? document.changes.map((change) => change?.path).filter((path) => typeof path === 'string')
      : []),
    ...(typeof document?.next === 'string' && typeof document?.manifest === 'string' ? [document.manifest] : []),
  ])].sort();
  return {
    command: document?.command ?? null,
    changed: document?.changed ?? (diff.length > 0 || files.length > 0),
    files,
    diff,
  };
}

async function previewOf(command, args, flags, root) {
  const row = rowFor(command);
  const previewFlags = { ...flags, json: true };
  if ((row?.flags ?? []).includes('diff')) previewFlags.diff = true;
  const result = await run(command, { args, flags: previewFlags, root });
  const document = renderJson(result);
  if (document === null) {
    return {
      ok: false,
      error: result.error?.message ?? `\`${command}\` refused the preview`,
      remedy: result.error?.remedy ?? `run: simt ${command} ${args.join(' ')}`.trim(),
      exitCode: result.code,
    };
  }
  const plan = planOf(document);
  const digest = sha256(stable({ command, args, flags, plan }));
  return { ok: true, command, args, flags, plan, digest, document };
}

export async function controlPreview(root, body) {
  const request = requestOf(body);
  if (request.error) return { ok: false, error: request.error, remedy: `one of: ${CONTROL_ALLOWLIST.join(', ')}` };
  return previewOf(request.command, request.args, request.flags, root);
}

export async function controlApply(root, body) {
  const request = requestOf(body);
  if (request.error) return { ok: false, error: request.error, remedy: `one of: ${CONTROL_ALLOWLIST.join(', ')}` };
  const digest = typeof body?.digest === 'string' ? body.digest : '';
  if (digest === '') return { ok: false, error: 'apply requires the digest of the previewed plan', remedy: 'preview first, then apply that exact plan' };
  const fresh = await previewOf(request.command, request.args, request.flags, root);
  if (!fresh.ok) return fresh;
  if (fresh.digest !== digest) {
    return {
      ok: false,
      error: 'the write plan changed after preview',
      remedy: 'preview again, read the new diff, then confirm the new digest',
      digest: fresh.digest,
      plan: fresh.plan,
    };
  }

  const before = await listJournalSets(root);
  const applyFlags = { ...request.flags, json: true, yes: true };
  if ((request.row?.flags ?? []).includes('diff')) applyFlags.diff = true;
  const result = await run(request.command, { args: request.args, flags: applyFlags, root });
  const document = renderJson(result);
  if (document === null) {
    return {
      ok: false,
      error: result.error?.message ?? `\`${request.command}\` refused the apply`,
      remedy: result.error?.remedy ?? `run: simt ${request.command} --yes`,
      exitCode: result.code,
    };
  }
  const after = await listJournalSets(root);
  const created = after.find((id) => !before.includes(id)) ?? null;
  let written = fresh.plan.files;
  if (created !== null) {
    const set = await readJournalSet(root, created);
    written = set.entries.map(entryLabel);
  } else if (Array.isArray(document.restored)) {
    written = document.restored;
  }
  return {
    ok: true,
    command: request.command,
    applied: true,
    digest: fresh.digest,
    plan: fresh.plan,
    written,
    journal: created,
    document,
  };
}
