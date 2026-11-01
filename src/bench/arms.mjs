// Experimental arms: what a run is measured against, and how it is materialised.
//
// An arm used to be a prefix-parsing chain followed by an if/else over names, so adding
// one meant editing the runner in two places and the second place was easy to miss. An
// arm kind is now a record in one registry — `match` recognises its spelling, `describe`
// says what it is in words a report can print, and `materialise` puts it in a workspace.
// The custom-arm JSON file is the data format the registry already stores, not a fourth
// branch beside three named arms (review 0003 Q78).
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { assembleBrief } from '../brief/assemble.mjs';
import { DEFAULT_BRIEF_BYTES } from '../brief/packet.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { plan } from '../projection/project.mjs';
import { parse as parseRegion } from '../projection/markers.mjs';
import { ablateSectionInWorkspace, parseAblationArmName } from './ablate.mjs';
import { applyVariantInWorkspace, parseVariantArmName } from './variants.mjs';

/** The arms every repository has without writing a file. */
export const BUILTIN_ARMS = new Set(['bare', 'current', 'kernel', 'brief']);

function assertContained(workDir, relPath) {
  const target = resolve(workDir, relPath);
  if (target !== workDir && !target.startsWith(`${workDir}${sep}`)) {
    throw new Error(`arm path "${relPath}" escapes workspace`);
  }
  return target;
}

async function stripRegionFile(filePath, style) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return false;
  }
  const state = parseRegion(text, style);
  if (state.status !== 'ok') return false;
  const remaining = `${state.before.trimEnd()}\n${state.after.trimStart()}`.trim();
  if (!remaining) {
    await unlink(filePath).catch(() => {});
  } else {
    await writeFile(filePath, `${remaining}\n`, 'utf8');
  }
  return true;
}

async function stripBareArm(workDir) {
  await stripRegionFile(join(workDir, 'AGENTS.md'), 'html');
  await stripRegionFile(join(workDir, '.editorconfig'), 'hash');
  await stripRegionFile(join(workDir, '.gitattributes'), 'hash');

  const surfaceDirs = ['.cursor/rules', '.claude/rules', '.github/instructions', '.agents/rules'];
  for (const relDir of surfaceDirs) {
    const absDir = join(workDir, relDir);
    const entries = await readdir(absDir).catch(() => []);
    for (const entry of entries) {
      const full = join(absDir, entry);
      const text = await readFile(full, 'utf8').catch(() => null);
      if (text !== null && parseRegion(text, 'html').status === 'ok') {
        await unlink(full).catch(() => {});
      }
    }
  }

  for (const rel of ['.githooks', '.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'docs/lessons']) {
    await rm(join(workDir, rel), { recursive: true, force: true }).catch(() => {});
  }

  if (!existsSync(join(workDir, 'AGENTS.md'))) {
    for (const mirror of ['CLAUDE.md', 'GEMINI.md']) {
      const full = join(workDir, mirror);
      const stat = await lstat(full).catch(() => null);
      if (stat?.isSymbolicLink()) {
        await unlink(full).catch(() => {});
      }
    }
  }
}

async function applyProjectionMode(workDir, mode) {
  const manifestRes = await readManifest(workDir);
  const agentsText = await readFile(join(workDir, 'AGENTS.md'), 'utf8').catch(() => null);
  const hasRegion = agentsText !== null && parseRegion(agentsText, 'html').status === 'ok';

  // If the repository is neither adopted via manifest nor carrying a generated region,
  // `current` leaves its hand-written files as-is, while `kernel` projects a kernel
  // region only when the repo is adopted or already carries a region.
  if (!manifestRes.exists && !hasRegion) return;

  const manifestPath = manifestRes.path ?? join(workDir, MANIFEST_FILE);
  const hadManifest = manifestRes.exists;
  const originalManifestBytes = hadManifest ? await readFile(manifestPath, 'utf8').catch(() => null) : null;

  const baseManifest = manifestRes.data ?? {
    schemaVersion: 1,
    projection: { sha: '0000000000000000000000000000000000000000', sources: [] },
    gates: { preCommit: [], prePush: [] },
  };
  const nextManifest = { ...baseManifest };
  if (mode === 'kernel') nextManifest.mode = 'kernel';
  else delete nextManifest.mode;

  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');

  const p = await plan(workDir);
  for (const target of p.targets ?? []) {
    if (target.action !== 'unchanged' && typeof target.text === 'string') {
      await mkdir(dirname(target.path), { recursive: true });
      await writeFile(target.path, target.text, 'utf8');
    }
  }

  if (!hadManifest) {
    await unlink(manifestPath).catch(() => {});
  } else if (originalManifestBytes !== null && mode !== 'kernel') {
    await writeFile(manifestPath, originalManifestBytes, 'utf8');
  }
}

/**
 * The `brief` arm's context: the packet `simt brief` delivers, assembled by the same
 * function the command and the prompt-submit hook call.
 *
 * The arm used to re-implement the packet from `registry.skills` — a property the
 * registry does not have, so every run reported "(none matched)" while the real command
 * resolved skills — and wrote it to a file no agent was told to read. An arm meant to
 * measure the packet measured a different artefact (review 0003 Q49).
 */
async function buildBriefPrefix(workDir, task) {
  // A packet is built from git's answer; a directory that is not a repository has none,
  // and asking would print a failure into a bench log for no measurement.
  if (!existsSync(join(workDir, '.git'))) return '';
  const assembled = await assembleBrief({
    root: workDir,
    task: String(task?.prompt ?? ''),
    paths: '',
    budget: DEFAULT_BRIEF_BYTES,
    build: true,
    federate: false,
  }).catch(() => null);
  if (!assembled || assembled.error || assembled.cold) return '';
  return assembled.packed?.text ?? '';
}

/**
 * The built-in projections, by name. A table rather than a branch: `describe` is what a
 * report prints and what a reader can check, and adding a projection is one entry.
 */
const ARM_TRANSFORMS = {
  bare: {
    describe: 'the repository with every projected artefact removed',
    run: (workDir) => stripBareArm(workDir),
  },
  current: {
    describe: 'the repository as `simt sync` leaves it',
    run: (workDir) => applyProjectionMode(workDir, 'full'),
  },
  kernel: {
    describe: 'the current projection, kernel class only',
    run: (workDir) => applyProjectionMode(workDir, 'kernel'),
  },
  brief: {
    describe: 'the current projection with the `simt brief` packet prepended to the prompt',
    run: (workDir, task) => buildBriefPrefix(workDir, task),
  },
};

async function parseCustomArm(spec, cwd) {
  const eq = spec.indexOf('=');
  if (eq === -1) return null;
  const name = spec.slice(0, eq).trim();
  const relPath = spec.slice(eq + 1).trim();
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid custom arm name "${name}"`);
  }
  if (!relPath) {
    throw new Error(`custom arm "${name}" is missing a JSON file path`);
  }

  const fullPath = resolve(cwd, relPath);
  let data;
  try {
    data = JSON.parse(await readFile(fullPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read arm file ${relPath}: ${error.message ?? error}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`arm file ${relPath} must contain a JSON object`);
  }
  if (data.base !== undefined && data.base !== null && !BUILTIN_ARMS.has(data.base)) {
    throw new Error(`arm file ${relPath} has unknown base "${data.base}"`);
  }
  if (data.write !== undefined && (typeof data.write !== 'object' || data.write === null || Array.isArray(data.write))) {
    throw new Error(`arm file ${relPath} field "write" must be an object mapping paths to strings`);
  }
  if (data.remove !== undefined && !Array.isArray(data.remove)) {
    throw new Error(`arm file ${relPath} field "remove" must be an array of paths`);
  }
  if (data.env !== undefined && (typeof data.env !== 'object' || data.env === null || Array.isArray(data.env))) {
    throw new Error(`arm file ${relPath} field "env" must be an object mapping env keys to strings`);
  }

  const write = {};
  for (const [key, value] of Object.entries(data.write ?? {})) write[key] = String(value);
  const remove = (data.remove ?? []).map((path) => String(path));
  const env = {};
  for (const [key, value] of Object.entries(data.env ?? {})) env[key] = String(value);

  return { name, base: data.base ?? null, source: relPath, write, remove, env };
}

/**
 * The arm kinds, in match order. The first kind that recognises a spelling owns it.
 *
 * `match` answers the arm's own fields (or `null`), and `materialise` puts it in a
 * workspace and answers the prompt prefix it contributes. A kind that changes files but
 * says nothing in a prompt returns no prefix.
 */
const ARM_KINDS = [
  {
    kind: 'ablation',
    match: (spec) => parseAblationArmName(spec),
    describe: (arm) => `the current projection without the \`${arm.ablate?.section ?? 'named'}\` section`,
    materialise: (workDir, arm) => ablateSectionInWorkspace(workDir, arm.ablate),
  },
  {
    kind: 'variant',
    match: (spec) => parseVariantArmName(spec),
    describe: (arm) =>
      `rule slot \`${arm.variant?.slot ?? 'named'}\` set to \`${arm.variant?.variant ?? 'named'}\``,
    materialise: (workDir, arm) => applyVariantInWorkspace(workDir, arm.variant),
  },
  {
    kind: 'builtin',
    match: (spec) => (BUILTIN_ARMS.has(spec) ? { name: spec, base: spec } : null),
    describe: (arm) => ARM_TRANSFORMS[arm.base].describe,
    materialise: (workDir, arm, task) => ARM_TRANSFORMS[arm.base].run(workDir, task),
  },
  {
    kind: 'custom',
    match: parseCustomArm,
    describe: (arm) => `a custom arm from ${arm.source ?? 'a JSON file'}`,
    materialise: (workDir, arm, task) =>
      arm.base ? ARM_TRANSFORMS[arm.base].run(workDir, task) : '',
  },
];

/**
 * Parse an `--arm` specification into the arm it names.
 *
 * @param {string} rawSpec `bare`, `current`, `kernel`, `brief`, an ablation or variant
 *   name, or `name=path/to/arm.json`
 * @param {string} [cwd]
 * @returns {Promise<object>} `{name, kind, base, write, remove, env}`
 */
export async function parseArmSpec(rawSpec, cwd = process.cwd()) {
  const spec = String(rawSpec ?? '').trim();
  if (!spec) throw new Error('empty --arm specification');

  for (const entry of ARM_KINDS) {
    const matched = await entry.match(spec, cwd);
    if (!matched) continue;
    return {
      name: matched.name,
      kind: entry.kind,
      base: matched.base ?? null,
      ...(matched.ablate ? { ablate: matched.ablate } : {}),
      ...(matched.variant ? { variant: matched.variant } : {}),
      ...(matched.source ? { source: matched.source } : {}),
      write: matched.write ?? {},
      remove: matched.remove ?? [],
      env: matched.env ?? {},
    };
  }

  throw new Error(
    `unknown arm "${spec}"; built-in arms are: ${[...BUILTIN_ARMS].join(', ')} (or pass --arm name=path/to/arm.json)`,
  );
}

/**
 * What an arm is, in words a report can print.
 *
 * @param {object} armSpec
 * @returns {string}
 */
export function describeArm(armSpec) {
  const entry = ARM_KINDS.find((candidate) => candidate.kind === armSpec?.kind);
  if (!entry) return 'an arm this version does not know how to describe';
  return entry.describe(armSpec);
}

/**
 * Materialise an experimental arm in `workDir`.
 *
 * @param {string} workDir
 * @param {object} armSpec
 * @param {object} [task]
 * @returns {Promise<{env: Record<string, string>, promptPrefix: string}>}
 */
export async function materialiseArm(workDir, armSpec, task = {}) {
  // A spec read from a stored `.arm.json`, or passed by a caller that only knows the
  // arm's name, names no kind. Inferring it here keeps one code path: every arm is a
  // registry entry, and a legacy spec is resolved into one rather than branched around.
  const base = armSpec.base ?? (BUILTIN_ARMS.has(armSpec.name) ? armSpec.name : null);
  const entry =
    ARM_KINDS.find((candidate) => candidate.kind === armSpec.kind) ??
    (armSpec.ablate
      ? ARM_KINDS.find((candidate) => candidate.kind === 'ablation')
      : armSpec.variant
        ? ARM_KINDS.find((candidate) => candidate.kind === 'variant')
        : base
          ? ARM_KINDS.find((candidate) => candidate.kind === 'builtin')
          : ARM_KINDS.find((candidate) => candidate.kind === 'custom'));
  const prefix = await entry.materialise(workDir, { ...armSpec, base }, task);

  for (const relPath of armSpec.remove ?? []) {
    const target = assertContained(workDir, relPath);
    await rm(target, { recursive: true, force: true }).catch(() => {});
  }

  for (const [relPath, content] of Object.entries(armSpec.write ?? {})) {
    const target = assertContained(workDir, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, String(content), 'utf8');
  }

  return { env: { ...(armSpec.env ?? {}) }, promptPrefix: typeof prefix === 'string' ? prefix : '' };
}
