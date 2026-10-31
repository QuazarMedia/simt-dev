import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '../graph/load.mjs';
import { extractOpenedSkills, matchSkillsForPaths } from '../graph/compile.mjs';
import { matchGlob } from '../index/govern.mjs';
import { formatLessonParagraph, listPromotedLessons } from '../memory/lessons.mjs';
import { MANIFEST_FILE, STATE_DIR } from '../name.mjs';
import { LOCAL_DIR } from '../state.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { plan } from '../projection/project.mjs';
import { parse as parseRegion } from '../projection/markers.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { rankSkills, tokenize } from '../resolve/resolve.mjs';
import { gradeWorkspace } from './grade.mjs';
import { resolveVaultDir } from './mine.mjs';
import { loadTasks } from './tasks.mjs';
import { ablateSectionInWorkspace, parseAblationArmName } from './ablate.mjs';
import { applyVariantInWorkspace, parseVariantArmName } from './variants.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_PATH = join(BENCH_DIR, 'adapters.json');

export const BUILTIN_ARMS = new Set(['bare', 'current', 'kernel', 'brief']);

const DEFAULT_REPS = 3;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
const DEFAULT_CONCURRENCY = 4;

let cachedAdapters = null;

/**
 * Load the declarative harness adapter table (`src/bench/adapters.json`).
 *
 * @returns {Promise<Record<string, object>>}
 */
export async function loadAdapters() {
  if (cachedAdapters) return cachedAdapters;
  const raw = JSON.parse(await readFile(ADAPTERS_PATH, 'utf8'));
  cachedAdapters = raw.adapters;
  return cachedAdapters;
}

function sanitizedEnv(extra = {}) {
  const env = { ...process.env, SIMT_DEV_WORKSPACE: 'off', ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) delete env[key];
  }
  return env;
}

function runCmd(cmd, args, { cwd, env, input = null, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS } = {}) {
  return new Promise((resolveOutcome) => {
    const child = spawn(cmd, args, {
      cwd,
      env: sanitizedEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolveOutcome({
        code: 1,
        timedOut,
        stdout: Buffer.concat(out),
        stderr: Buffer.from(String(error.message ?? error)),
      });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolveOutcome({
        code: timedOut ? 124 : (code ?? 1),
        timedOut,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      });
    });

    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function getByPath(obj, pathStr) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = pathStr.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstNumeric(obj, paths = []) {
  for (const p of paths) {
    const val = getByPath(obj, p);
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  }
  return null;
}

function emptyUsage() {
  return {
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, toolCalls: 0 },
    costUsd: null,
  };
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').reverse();
    for (const line of lines) {
      const s = line.trim();
      if (s.startsWith('{') && s.endsWith('}')) {
        try {
          return JSON.parse(s);
        } catch {
          // try earlier line
        }
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Parse token usage, turns, tool calls and USD cost from a harness's output.
 *
 * Uses the field paths declared in `src/bench/adapters.json` and supports single-JSON
 * outputs (`claude`, `gemini`, `cursor`), JSONL event streams (`codex`, `opencode`),
 * and `--analytics-log` JSONL files (`aider`).
 *
 * @param {string|object} adapterOrId
 * @param {string} stdoutText
 * @param {string} [analyticsText]
 * @returns {{usage: {input: number, cacheWrite: number, cacheRead: number, output: number, turns: number, toolCalls: number}, costUsd: number|null}}
 */
export function parseAdapterUsage(adapterOrId, stdoutText = '', analyticsText = '') {
  const result = emptyUsage();
  const adapter =
    typeof adapterOrId === 'string'
      ? (cachedAdapters?.[adapterOrId] ?? { id: adapterOrId, format: 'json', fields: {} })
      : (adapterOrId ?? { id: 'unknown', format: 'json', fields: {} });

  if (adapter.format === 'builtin') {
    if (adapter.id === 'gold') {
      result.usage.turns = 1;
      result.usage.toolCalls = 1;
    }
    return result;
  }

  const fields = adapter.fields ?? {};

  if (adapter.format === 'json') {
    const obj = parseJsonObject(stdoutText);
    if (!obj || typeof obj !== 'object') return result;

    result.usage.input = firstNumeric(obj, fields.input) ?? 0;
    result.usage.cacheWrite = firstNumeric(obj, fields.cacheWrite) ?? 0;
    result.usage.cacheRead = firstNumeric(obj, fields.cacheRead) ?? 0;
    result.usage.output = firstNumeric(obj, fields.output) ?? 0;
    result.usage.turns = firstNumeric(obj, fields.turns) ?? 0;
    result.usage.toolCalls = firstNumeric(obj, fields.toolCalls) ?? 0;
    result.costUsd = firstNumeric(obj, fields.costUsd) ?? null;

    // Gemini CLI also nests per-model token totals under `stats.models.<name>.tokens`.
    const models = obj?.stats?.models;
    if (models && typeof models === 'object') {
      let promptSum = 0;
      let cachedSum = 0;
      let candidatesSum = 0;
      for (const m of Object.values(models)) {
        promptSum += Number(m?.tokens?.prompt ?? 0) || 0;
        cachedSum += Number(m?.tokens?.cached ?? 0) || 0;
        candidatesSum += Number(m?.tokens?.candidates ?? 0) || 0;
      }
      if (result.usage.input === 0 && promptSum > 0) result.usage.input = promptSum;
      if (result.usage.cacheRead === 0 && cachedSum > 0) result.usage.cacheRead = cachedSum;
      if (result.usage.output === 0 && candidatesSum > 0) result.usage.output = candidatesSum;
    }

    return result;
  }

  const rawStream = adapter.format === 'analytics-log' && analyticsText ? analyticsText : stdoutText;
  const lines = String(rawStream ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;

    const input = firstNumeric(event, fields.input);
    const cacheWrite = firstNumeric(event, fields.cacheWrite);
    const cacheRead = firstNumeric(event, fields.cacheRead);
    const output = firstNumeric(event, fields.output);
    const turns = firstNumeric(event, fields.turns);
    const toolCalls = firstNumeric(event, fields.toolCalls);
    const cost = firstNumeric(event, fields.costUsd);

    if (input !== null) result.usage.input += input;
    if (cacheWrite !== null) result.usage.cacheWrite += cacheWrite;
    if (cacheRead !== null) result.usage.cacheRead += cacheRead;
    if (output !== null) result.usage.output += output;
    if (cost !== null) result.costUsd += cost;

    if (turns !== null) {
      result.usage.turns = Math.max(result.usage.turns, turns);
    } else if (
      event.type === 'turn.completed' ||
      event.type === 'step_finish' ||
      event.event === 'message_send'
    ) {
      result.usage.turns += 1;
    }

    if (toolCalls !== null) {
      result.usage.toolCalls = Math.max(result.usage.toolCalls, toolCalls);
    } else if (
      event.type === 'tool_use' ||
      (event.type === 'item.completed' &&
        (event.item?.type === 'command_execution' ||
          event.item?.type === 'tool_call' ||
          event.item?.type === 'mcp_tool_call'))
    ) {
      result.usage.toolCalls += 1;
    }
  }

  if (result.costUsd !== null) result.costUsd = Number(result.costUsd.toFixed(6));
  return result;
}

/**
 * Parse an `--arm` specification (`bare`, `current`, `kernel`, `brief`, or `name=path/to/arm.json`).
 *
 * @param {string} rawSpec
 * @param {string} [cwd]
 * @returns {Promise<{name: string, kind: 'builtin'|'custom', base: string|null, write: Record<string, string>, remove: string[], env: Record<string, string>}>}
 */
export async function parseArmSpec(rawSpec, cwd = process.cwd()) {
  const spec = String(rawSpec ?? '').trim();
  if (!spec) throw new Error('empty --arm specification');

  const eq = spec.indexOf('=');
  if (eq === -1) {
    const ablateSpec = parseAblationArmName(spec);
    if (ablateSpec) {
      return {
        ...ablateSpec,
        write: {},
        remove: [],
        env: {},
      };
    }
    const variantSpec = parseVariantArmName(spec);
    if (variantSpec) {
      return {
        ...variantSpec,
        write: {},
        remove: [],
        env: {},
      };
    }
    if (!BUILTIN_ARMS.has(spec)) {
      throw new Error(
        `unknown arm "${spec}"; built-in arms are: ${[...BUILTIN_ARMS].join(', ')} (or pass --arm name=path/to/arm.json)`,
      );
    }
    return {
      name: spec,
      kind: 'builtin',
      base: spec,
      write: {},
      remove: [],
      env: {},
    };
  }

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
  for (const [k, v] of Object.entries(data.write ?? {})) write[k] = String(v);
  const remove = (data.remove ?? []).map((p) => String(p));
  const env = {};
  for (const [k, v] of Object.entries(data.env ?? {})) env[k] = String(v);

  return {
    name,
    kind: 'custom',
    base: data.base ?? null,
    write,
    remove,
    env,
  };
}

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

  const surfaceDirs = [
    '.cursor/rules',
    '.claude/rules',
    '.github/instructions',
    '.agents/rules',
  ];
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
      const st = await lstat(full).catch(() => null);
      if (st?.isSymbolicLink()) {
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
  for (const t of p.targets ?? []) {
    if (t.action !== 'unchanged' && typeof t.text === 'string') {
      await mkdir(dirname(t.path), { recursive: true });
      await writeFile(t.path, t.text, 'utf8');
    }
  }

  if (!hadManifest) {
    await unlink(manifestPath).catch(() => {});
  } else if (originalManifestBytes !== null && mode !== 'kernel') {
    await writeFile(manifestPath, originalManifestBytes, 'utf8');
  }
}

async function writeTaskBrief(workDir, task) {
  const prompt = String(task?.prompt ?? '');
  const taskTokens = tokenize(prompt);
  const taskTokenSet = new Set(taskTokens);
  const [registry, fp, lessons] = await Promise.all([
    loadRegistry().catch(() => ({ skills: [] })),
    fingerprint(workDir).catch(() => ({ stacks: [], facts: new Set() })),
    listPromotedLessons(workDir).catch(() => []),
  ]);
  const skillsList = Array.isArray(registry.skills)
    ? registry.skills
    : Object.values(registry.skills ?? {});
  const { selected = [] } = rankSkills(skillsList, {
    taskTokens,
    paths: [],
    repoStack: fp.stack ?? [],
  });
  const ranked = selected.slice(0, 5);

  const taskPaths = Array.isArray(task?.paths) ? task.paths : [];
  const matchingLessons = lessons.filter((lesson) => {
    const lessonGlobs = Array.isArray(lesson.paths) ? lesson.paths : [];
    if (taskPaths.some((p) => lessonGlobs.some((glob) => matchGlob(glob, p)))) return true;
    if (lessonGlobs.some((glob) => prompt.includes(glob.replace(/\/\*\*$/, '')))) return true;
    const kw = Array.isArray(lesson.keywords) ? lesson.keywords : [];
    return kw.some((k) => taskTokenSet.has(String(k).toLowerCase()));
  });

  const lines = [
    `# Task Brief: ${task?.id ?? 'task'}`,
    '',
    `Prompt: ${prompt}`,
    '',
    '## Ranked Skills',
    ...(ranked.length > 0
      ? ranked.map((r) => `- ${r.skill.name} (score ${r.score}): ${r.skill.description ?? ''}`)
      : ['- (none matched)']),
    ...(matchingLessons.length > 0
      ? [
          '',
          '## Lessons',
          ...matchingLessons.map((l) => `- ${formatLessonParagraph(l)}`),
        ]
      : []),
    '',
  ];
  const briefPath = join(workDir, LOCAL_DIR, 'brief.md');
  await mkdir(dirname(briefPath), { recursive: true });
  await writeFile(briefPath, lines.join('\n'), 'utf8');
}

/**
 * Materialise an experimental arm (`bare`, `current`, `kernel`, `brief`, or custom) in `workDir`.
 *
 * @param {string} workDir
 * @param {{name: string, kind?: string, base?: string|null, write?: Record<string, string>, remove?: string[], env?: Record<string, string>}} armSpec
 * @param {object} [task]
 * @returns {Promise<{env: Record<string, string>}>}
 */
export async function materialiseArm(workDir, armSpec, task = {}) {
  const ablate = armSpec.ablate ?? parseAblationArmName(armSpec.name)?.ablate ?? null;
  const variant = armSpec.variant ?? parseVariantArmName(armSpec.name)?.variant ?? null;
  const base = armSpec.base ?? (BUILTIN_ARMS.has(armSpec.name) ? armSpec.name : null);
  if (ablate) {
    await ablateSectionInWorkspace(workDir, ablate);
  } else if (variant) {
    await applyVariantInWorkspace(workDir, variant);
  } else if (base === 'bare') {
    await stripBareArm(workDir);
  } else if (base === 'current') {
    await applyProjectionMode(workDir, 'full');
  } else if (base === 'kernel') {
    await applyProjectionMode(workDir, 'kernel');
  } else if (base === 'brief') {
    await applyProjectionMode(workDir, 'full');
    await writeTaskBrief(workDir, task);
  }

  for (const relPath of armSpec.remove ?? []) {
    const target = assertContained(workDir, relPath);
    await rm(target, { recursive: true, force: true }).catch(() => {});
  }

  for (const [relPath, content] of Object.entries(armSpec.write ?? {})) {
    const target = assertContained(workDir, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, String(content), 'utf8');
  }

  return { env: { ...(armSpec.env ?? {}) } };
}

/**
 * Export `baseSha` from `root` via `git archive` into a fresh temp directory, materialise
 * `armSpec`, and initialize a single-commit git repository so `git rev-list --all` has
 * exactly one commit and the object store shares nothing with `root`.
 *
 * @param {string} root
 * @param {string} baseSha
 * @param {object} armSpec
 * @param {object} [task]
 * @param {{parentDir?: string}} [options]
 * @returns {Promise<{slotDir: string, workDir: string, initialHead: string, env: Record<string, string>}>}
 */
export async function prepareIsolatedWorkspace(root, baseSha, armSpec, task = {}, { parentDir } = {}) {
  const slotDir = await mkdtemp(join(parentDir ?? tmpdir(), 'bench-run-'));
  const workDir = join(slotDir, 'workspace');
  await mkdir(workDir, { recursive: true });

  const archiveRes = await runCmd('git', ['archive', '--format=tar', baseSha], { cwd: root });
  if (archiveRes.code !== 0) {
    await rm(slotDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `git archive failed for ${baseSha}: ${archiveRes.stderr.toString('utf8').trim()}`,
    );
  }

  const tarRes = await runCmd('tar', ['-xf', '-', '-C', workDir], {
    cwd: workDir,
    input: archiveRes.stdout,
  });
  if (tarRes.code !== 0) {
    await rm(slotDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`tar unpack failed for ${baseSha}: ${tarRes.stderr.toString('utf8').trim()}`);
  }

  const rootLessonsDir = join(root, 'docs', 'lessons');
  const rootLessonFiles = (await readdir(rootLessonsDir).catch(() => [])).filter((f) => f.endsWith('.md'));
  if (rootLessonFiles.length > 0) {
    const destLessonsDir = join(workDir, 'docs', 'lessons');
    await mkdir(destLessonsDir, { recursive: true });
    for (const file of rootLessonFiles) {
      const target = join(destLessonsDir, file);
      if (!existsSync(target)) {
        const text = await readFile(join(rootLessonsDir, file), 'utf8');
        await writeFile(target, text, 'utf8');
      }
    }
  }

  const rootProfilesDir = join(root, STATE_DIR, 'profiles');
  const rootProfileFiles = (await readdir(rootProfilesDir).catch(() => [])).filter((f) => f.endsWith('.md'));
  if (rootProfileFiles.length > 0) {
    const destProfilesDir = join(workDir, STATE_DIR, 'profiles');
    await mkdir(destProfilesDir, { recursive: true });
    for (const file of rootProfileFiles) {
      const text = await readFile(join(rootProfilesDir, file), 'utf8');
      await writeFile(join(destProfilesDir, file), text, 'utf8');
    }
  }

  const { env } = await materialiseArm(workDir, armSpec, task);

  await runCmd('git', ['init', '-q'], { cwd: workDir });
  await runCmd('git', ['config', 'user.name', 'bench'], { cwd: workDir });
  await runCmd('git', ['config', 'user.email', 'bench@local'], { cwd: workDir });
  await runCmd('git', ['config', 'commit.gpgsign', 'false'], { cwd: workDir });
  await runCmd('git', ['add', '-A'], { cwd: workDir });
  const commitRes = await runCmd(
    'git',
    ['commit', '-qm', 'base', '--allow-empty', '--no-verify'],
    { cwd: workDir },
  );
  if (commitRes.code !== 0) {
    await rm(slotDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`git commit failed in isolated workspace: ${commitRes.stderr.toString('utf8').trim()}`);
  }

  const headRes = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: workDir });
  const initialHead = headRes.stdout.toString('utf8').trim();

  return { slotDir, workDir, initialHead, env };
}

function buildAdapterArgs(adapter, { prompt, turns, model, analyticsLog }) {
  const replaceToken = (token) =>
    String(token)
      .replaceAll('{prompt}', prompt)
      .replaceAll('{turns}', String(turns))
      .replaceAll('{model}', String(model ?? ''))
      .replaceAll('{analyticsLog}', String(analyticsLog ?? ''));

  const args = (adapter.args ?? []).map(replaceToken);
  if (model && model !== 'default' && model !== adapter.id && Array.isArray(adapter.modelArgs)) {
    args.push(...adapter.modelArgs.map(replaceToken));
  }
  return args;
}

async function executeAdapter(adapter, workDir, task, { vaultRoot, model, maxTurns, env, timeoutMs, slotDir }) {
  if (adapter.id === 'noop') return { ...parseAdapterUsage(adapter, ''), transcript: '' };
  if (adapter.id === 'gold') {
    const goldPatch = await readFile(join(vaultRoot, task.id, 'gold.patch'));
    if (goldPatch.length > 0) {
      const applyRes = await runCmd('git', ['apply', '-'], { cwd: workDir, input: goldPatch, timeoutMs });
      if (applyRes.code !== 0) {
        await runCmd('git', ['apply', '--3way', '-'], { cwd: workDir, input: goldPatch, timeoutMs });
      }
    }
    return { ...parseAdapterUsage(adapter, ''), transcript: '' };
  }

  const analyticsLog = join(slotDir, 'analytics.jsonl');
  const args = buildAdapterArgs(adapter, { prompt: String(task.prompt ?? ''), turns: maxTurns, model, analyticsLog });
  const outcome = await runCmd(adapter.bin, args, { cwd: workDir, env, timeoutMs });
  const stdoutText = outcome.stdout.toString('utf8');
  const analyticsText = adapter.format === 'analytics-log' ? await readFile(analyticsLog, 'utf8').catch(() => '') : '';
  return { ...parseAdapterUsage(adapter, stdoutText, analyticsText), transcript: `${stdoutText}\n${analyticsText}` };
}

// loadTasks lives in tasks.mjs (the advice engine became a second reader, so the loader
// was extracted rather than copied — ADR-002).

function runIdFor(harness, armName, rep) {
  return `${harness}-${armName}-r${rep}`;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const count = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

/**
 * Run benchmark tasks across one or more arms and repetitions.
 */
export async function runBench(
  root,
  {
    apply = false,
    arms = ['current'],
    harness = 'gold',
    model,
    reps = DEFAULT_REPS,
    tasks: filterTaskIds = [],
    vaultRoot = resolveVaultDir(root),
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    maxTurns = DEFAULT_MAX_TURNS,
    concurrency = DEFAULT_CONCURRENCY,
    cwd = process.cwd(),
  } = {},
) {
  const adapters = await loadAdapters();
  const adapter = adapters[harness];
  if (!adapter) {
    throw new Error(
      `unknown harness "${harness}"; known harnesses: ${Object.keys(adapters).sort().join(', ')}`,
    );
  }

  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error(`--reps must be a positive integer, received ${reps}`);
  }

  const armSpecs = [];
  for (const raw of arms.length > 0 ? arms : ['current']) {
    armSpecs.push(await parseArmSpec(raw, cwd));
  }

  const tasks = await loadTasks(root, filterTaskIds);
  if (tasks.length === 0 && (apply || filterTaskIds.length > 0)) {
    throw new Error(
      filterTaskIds.length > 0
        ? `no mined tasks matched: ${filterTaskIds.join(', ')}`
        : `no mined tasks found in .simt/bench/tasks`,
    );
  }

  const resolvedModel = model ?? (adapter.kind === 'builtin' ? adapter.id : 'default');
  const plannedRuns = [];
  for (const armSpec of armSpecs) {
    for (let rep = 1; rep <= reps; rep += 1) {
      const runId = runIdFor(harness, armSpec.name, rep);
      for (const task of tasks) {
        plannedRuns.push({
          runId,
          armSpec,
          rep,
          task,
        });
      }
    }
  }

  if (!apply) {
    return {
      applied: false,
      root,
      harness,
      model: resolvedModel,
      arms: armSpecs.map((a) => a.name),
      reps,
      taskCount: tasks.length,
      runs: plannedRuns.map((item) => ({
        schemaVersion: 1,
        runId: item.runId,
        task: item.task.id,
        arm: item.armSpec.name,
        harness,
        model: resolvedModel,
        rep: item.rep,
        resolved: null,
        gatesPassed: null,
        usage: emptyUsage().usage,
        costUsd: null,
        diff: { files: 0, outsideBlastRadius: 0 },
        probe: null,
      })),
    };
  }

  const runsBaseDir = join(root, LOCAL_DIR, 'bench', 'runs');
  for (const armSpec of armSpecs) {
    for (let rep = 1; rep <= reps; rep += 1) {
      const runDir = join(runsBaseDir, runIdFor(harness, armSpec.name, rep));
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, '.arm.json'), `${JSON.stringify(armSpec, null, 2)}\n`, 'utf8');
    }
  }

  const regRes = await loadRegistry().catch(() => ({ registry: { skills: [] } }));
  const registrySkills = regRes?.registry?.skills ?? [];
  const knownSkillNames = new Set(registrySkills.map((s) => s.name));
  const parentDir = await mkdtemp(join(tmpdir(), 'bench-batch-'));
  try {
    const records = await mapPool(plannedRuns, concurrency, async (item) => {
      const { slotDir, workDir, initialHead, env } = await prepareIsolatedWorkspace(
        root,
        item.task.base,
        item.armSpec,
        item.task,
        { parentDir },
      );
      try {
        const { usage, costUsd, transcript } = await executeAdapter(adapter, workDir, item.task, {
          vaultRoot,
          model: resolvedModel,
          maxTurns,
          env,
          timeoutMs,
          slotDir,
        });

        const grade = await gradeWorkspace(workDir, item.task, {
          vaultRoot,
          initialHead,
          timeoutMs,
        });
        const expectedSkills = matchSkillsForPaths(registrySkills, grade.goldFiles ?? []);
        const openedSkills =
          adapter.id === 'gold'
            ? expectedSkills
            : adapter.id === 'noop'
              ? []
              : extractOpenedSkills(transcript, knownSkillNames);

        const record = {
          schemaVersion: 1,
          task: item.task.id,
          arm: item.armSpec.name,
          harness,
          model: resolvedModel,
          rep: item.rep,
          resolved: grade.resolved,
          gatesPassed: grade.gatesPassed,
          usage,
          costUsd,
          diff: grade.diff,
          skills: { expected: expectedSkills, opened: openedSkills },
          probe: null,
        };

        const runDir = join(runsBaseDir, item.runId);
        await Promise.all([
          writeFile(join(runDir, `${item.task.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
          writeFile(join(runDir, `${item.task.id}.patch`), grade.agentPatch),
        ]);

        return { ...record, runId: item.runId };
      } finally {
        await rm(slotDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    return {
      applied: true,
      root,
      harness,
      model: resolvedModel,
      arms: armSpecs.map((a) => a.name),
      reps,
      taskCount: tasks.length,
      runs: records,
    };
  } finally {
    await rm(parentDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveRegradeTargets(root, target) {
  const runsBaseDir = join(root, LOCAL_DIR, 'bench', 'runs');
  const direct = resolve(root, target);
  const candidate = existsSync(direct) ? direct : join(runsBaseDir, target);

  if (target === 'all') {
    const dirs = (await readdir(runsBaseDir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => join(runsBaseDir, d.name))
      .sort();
    const files = [];
    for (const dir of dirs) {
      const entries = (await readdir(dir).catch(() => []))
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .sort();
      for (const entry of entries) files.push(join(dir, entry));
    }
    return files;
  }

  const st = await stat(candidate).catch(() => null);
  if (!st) {
    throw new Error(`stored run not found: ${target}`);
  }
  if (st.isFile()) return [candidate];
  if (st.isDirectory()) {
    const entries = (await readdir(candidate).catch(() => []))
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort();
    return entries.map((f) => join(candidate, f));
  }
  return [];
}

/**
 * Re-grade a stored run (or run directory) deterministically from its saved agent patch
 * and verify that the reproduced grade matches the stored record.
 *
 * @param {string} root
 * @param {string} target
 * @param {{apply?: boolean, vaultRoot?: string, timeoutMs?: number, concurrency?: number}} [options]
 */
export async function regradeRun(
  root,
  target,
  {
    apply = false,
    vaultRoot = resolveVaultDir(root),
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
  } = {},
) {
  const files = await resolveRegradeTargets(root, target);
  if (files.length === 0) {
    throw new Error(`no stored task runs found under ${target}`);
  }

  const tasksDir = join(root, LOCAL_DIR, 'bench', 'runs');
  const taskDefsDir = join(root, '.simt', 'bench', 'tasks');
  const parentDir = await mkdtemp(join(tmpdir(), 'bench-regrade-'));

  try {
    const results = await mapPool(files, concurrency, async (runFilePath) => {
      const stored = JSON.parse(await readFile(runFilePath, 'utf8'));
      const runDir = dirname(runFilePath);
      const runId = runDir.startsWith(tasksDir)
        ? runDir.slice(tasksDir.length + 1)
        : dirname(runFilePath).split(sep).pop();

      const taskPath = join(taskDefsDir, `${stored.task}.json`);
      const task = JSON.parse(await readFile(taskPath, 'utf8'));

      const armMetaPath = join(runDir, '.arm.json');
      const armSpec = await readFile(armMetaPath, 'utf8')
        .then((s) => JSON.parse(s))
        .catch(() => ({
          name: stored.arm,
          kind: BUILTIN_ARMS.has(stored.arm) ? 'builtin' : 'custom',
          base: BUILTIN_ARMS.has(stored.arm) ? stored.arm : null,
          write: {},
          remove: [],
          env: {},
        }));

      const patchPath = runFilePath.replace(/\.json$/, '.patch');
      const agentPatch = await readFile(patchPath).catch(() => Buffer.alloc(0));

      const { slotDir, workDir, initialHead } = await prepareIsolatedWorkspace(
        root,
        task.base,
        armSpec,
        task,
        { parentDir },
      );
      try {
        if (agentPatch.length > 0) {
          const applyRes = await runCmd('git', ['apply', '--binary', '-'], {
            cwd: workDir,
            input: agentPatch,
            timeoutMs,
          });
          if (applyRes.code !== 0) {
            await runCmd('git', ['apply', '--3way', '-'], {
              cwd: workDir,
              input: agentPatch,
              timeoutMs,
            });
          }
        }

        const grade = await gradeWorkspace(workDir, task, {
          vaultRoot,
          initialHead,
          timeoutMs,
        });

        const reproduced =
          grade.resolved === stored.resolved &&
          grade.gatesPassed === stored.gatesPassed &&
          grade.diff.files === stored.diff?.files &&
          grade.diff.outsideBlastRadius === stored.diff?.outsideBlastRadius;

        const updated = {
          ...stored,
          resolved: grade.resolved,
          gatesPassed: grade.gatesPassed,
          diff: grade.diff,
        };

        if (apply) {
          await writeFile(runFilePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
        }

        return {
          ...updated,
          runId,
          reproduced,
        };
      } finally {
        await rm(slotDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    return {
      applied: apply,
      root,
      target,
      regraded: results.length,
      reproducedCount: results.filter((r) => r.reproduced).length,
      allReproduced: results.every((r) => r.reproduced),
      runs: results,
    };
  } finally {
    await rm(parentDir, { recursive: true, force: true }).catch(() => {});
  }
}
