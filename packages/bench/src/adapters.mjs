// How a benchmarked harness is driven, and how its output is read.
//
// Adapter v1 was a bag of fields with two behaviours compiled into the runner: the Gemini
// CLI's per-model token totals, and the event names that three JSONL streams happen to use
// for a turn and a tool call. Both are properties of one harness, so both belong in the
// adapter's own record and not in the runner (ADR-013). Adapter v2 declares prompt
// delivery, the environment allowlist, the timeout, the usage counters and the transcript
// sources; the runner reads that declaration and knows no harness by name.
//
// A v1 entry is normalised rather than refused: `args` becomes argv delivery, `format` and
// `fields` become the usage counter, and a bare `env` array becomes the allowlist.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI } from '../../../src/name.mjs';
import { sanitizedEnv, spawnBounded } from '../../../src/sys/proc.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_PATH = join(BENCH_DIR, 'adapters.json');

export const ADAPTER_SCHEMA_VERSION = 2;
export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

/** The isolation levels a run may record; `sandbox` is declared, not implemented. */
const ISOLATION_LEVELS = new Set(['none', 'env', 'sandbox']);

/**
 * What every benchmarked agent inherits from the operator's shell.
 *
 * `PATH` and the locale are what a CLI needs to run at all. Nothing here names a
 * credential or a state directory: those come from the adapter's own `env.allow` list.
 */
const ENV_BASELINE = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'USER',
];

let cachedAdapters = null;

/**
 * The event vocabulary adapter v1 compiled into the runner, as the contract a v1 entry
 * was written against. It applies only to a record that declares no `usage.events`, so a
 * v2 adapter decides its own counters and this table is never consulted for one.
 */
const V1_EVENT_DEFAULTS = {
  turns: [{ type: 'turn.completed' }, { type: 'step_finish' }, { event: 'message_send' }],
  toolCalls: [
    { type: 'tool_use' },
    { type: 'item.completed', 'item.type': ['command_execution', 'tool_call', 'mcp_tool_call'] },
  ],
};

/**
 * Bring one adapter entry to v2. Pure and total: an entry missing a section keeps the
 * documented default rather than a half-filled field.
 *
 * @param {object} raw a v1 or v2 adapter entry
 * @returns {object} the v2 entry
 */
function normaliseAdapter(raw = {}) {
  const id = String(raw.id ?? '');
  const kind = raw.kind === 'builtin' || raw.kind === 'oracle' ? 'oracle' : 'agent';
  const prompt = raw.prompt ?? {};
  const env = raw.env ?? {};
  const usage = raw.usage ?? {};
  const allow = Array.isArray(env) ? env : Array.isArray(env?.allow) ? env.allow : [];
  const timeoutMs = Number(raw.timeoutMs ?? prompt.timeoutMs);
  const format = String(usage.format ?? raw.format ?? (kind === 'oracle' ? 'none' : 'json'));
  return {
    id,
    label: String(raw.label ?? id),
    kind,
    bin: raw.bin ?? null,
    oracle: kind === 'oracle' ? { from: raw.oracle?.from ?? (id === 'gold' ? 'vault' : 'none') } : null,
    prompt: {
      delivery: prompt.delivery ?? 'argv',
      args: [...(prompt.args ?? raw.args ?? [])].map(String),
      modelArgs: [...(prompt.modelArgs ?? raw.modelArgs ?? [])].map(String),
      file: prompt.file ?? null,
    },
    env: {
      allow: allow.map(String),
      extra: { ...(env.extra ?? {}) },
    },
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_AGENT_TIMEOUT_MS,
    isolation: ISOLATION_LEVELS.has(raw.isolation) ? raw.isolation : 'none',
    usage: {
      format,
      fields: { ...(usage.fields ?? raw.fields ?? {}) },
      totals: [...(usage.totals ?? [])],
      fixed: { ...(usage.fixed ?? {}) },
      events: {
        turns: [...(usage.events?.turns ?? V1_EVENT_DEFAULTS.turns)],
        toolCalls: [...(usage.events?.toolCalls ?? V1_EVENT_DEFAULTS.toolCalls)],
      },
    },
    transcript: {
      sources: [...(raw.transcript?.sources ?? (kind === 'oracle' ? [] : ['stdout']))].map(String),
    },
  };
}

/**
 * Load the declarative harness adapter table (`src/bench/adapters.json`).
 *
 * @returns {Promise<Record<string, object>>}
 */
export async function loadAdapters() {
  if (cachedAdapters) return cachedAdapters;
  const raw = JSON.parse(await readFile(ADAPTERS_PATH, 'utf8'));
  const table = {};
  for (const [key, entry] of Object.entries(raw.adapters ?? {})) {
    table[key] = normaliseAdapter({ id: key, ...entry });
  }
  cachedAdapters = table;
  return cachedAdapters;
}

/**
 * The environment an arm's agent sees: the baseline, the adapter's declared keys, and
 * nothing else.
 *
 * The agent used to inherit everything the operator had — the vault directory, the cache
 * root, `HOME`, and every credential in the shell. A run that can read the vault can read
 * the hidden tests it is graded against, and a run sharing the operator's HOME writes into
 * their own configuration, so the number it produced described the machine rather than the
 * arm (review 0003 Q49).
 *
 * @param {object} adapter a v1 or v2 adapter entry
 * @param {{home?: string, extra?: Record<string, string>, base?: NodeJS.ProcessEnv}} [options]
 * @returns {Record<string, string>}
 */
export function agentEnv(adapter, { home, extra = {}, base = process.env } = {}) {
  const declared = adapter?.env;
  const allow = Array.isArray(declared) ? declared : (declared?.allow ?? []);
  const allowed = new Set([...ENV_BASELINE, ...allow]);
  const env = {};
  for (const key of allowed) {
    if (typeof base[key] === 'string') env[key] = base[key];
  }
  const adapterExtra = Array.isArray(declared) ? {} : (declared?.extra ?? {});
  for (const [key, value] of Object.entries({ ...adapterExtra, ...extra })) {
    if (typeof value === 'string') env[key] = value;
  }
  if (typeof home === 'string' && home.length > 0) env.HOME = home;
  env.SIMT_DEV_WORKSPACE = 'off';
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) delete env[key];
  }
  return env;
}

/**
 * The isolation an adapter's runs provide, as the record states it.
 *
 * @param {object} adapter
 * @returns {'none'|'env'|'sandbox'}
 */
export function adapterIsolation(adapter) {
  const declared = adapter?.isolation;
  return ISOLATION_LEVELS.has(declared) ? declared : 'none';
}

function getByPath(obj, pathStr) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const part of String(pathStr).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstNumeric(obj, paths = []) {
  for (const pathStr of paths) {
    const value = getByPath(obj, pathStr);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (candidate.startsWith('{') && candidate.endsWith('}')) {
        try {
          return JSON.parse(candidate);
        } catch {
          // try an earlier line
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

/** A declared event condition: every named field equals the declared value (a list is any). */
function matchesWhen(event, when) {
  const keys = Object.keys(when ?? {});
  if (keys.length === 0) return false;
  for (const key of keys) {
    const got = getByPath(event, key);
    const wanted = Array.isArray(when[key]) ? when[key] : [when[key]];
    if (!wanted.includes(got)) return false;
  }
  return true;
}

function emptyUsage() {
  return {
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, toolCalls: 0 },
    costUsd: null,
  };
}

/**
 * Parse token usage, turns, tool calls and USD cost from a harness's output.
 *
 * The counter is the adapter's: a JSON object read through `usage.fields` with
 * `usage.totals` summed over nested per-model blocks, or a JSONL stream whose turns and
 * tool calls are the declared `usage.events` conditions. No harness is named here.
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
      ? (cachedAdapters?.[adapterOrId] ?? normaliseAdapter({ id: adapterOrId }))
      : normaliseAdapter(adapterOrId ?? { id: 'unknown' });

  if (adapter.usage.format === 'none') {
    for (const [metric, value] of Object.entries(adapter.usage.fixed ?? {})) {
      if (metric in result.usage) result.usage[metric] = Number(value) || 0;
    }
    return result;
  }

  const fields = adapter.usage.fields ?? {};

  if (adapter.usage.format === 'json') {
    const obj = parseJsonObject(stdoutText);
    if (!obj || typeof obj !== 'object') return result;

    result.usage.input = firstNumeric(obj, fields.input) ?? 0;
    result.usage.cacheWrite = firstNumeric(obj, fields.cacheWrite) ?? 0;
    result.usage.cacheRead = firstNumeric(obj, fields.cacheRead) ?? 0;
    result.usage.output = firstNumeric(obj, fields.output) ?? 0;
    result.usage.turns = firstNumeric(obj, fields.turns) ?? 0;
    result.usage.toolCalls = firstNumeric(obj, fields.toolCalls) ?? 0;
    result.costUsd = firstNumeric(obj, fields.costUsd) ?? null;

    // A harness that nests its totals per model (Gemini's `stats.models.<name>.tokens`)
    // declares that block; the counter sums it only where the flat field was absent.
    for (const block of adapter.usage.totals ?? []) {
      const group = getByPath(obj, block.root ?? '');
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      for (const [metric, key] of Object.entries(block.keys ?? {})) {
        if (!(metric in result.usage) || result.usage[metric] !== 0) continue;
        let sum = 0;
        for (const entry of Object.values(group)) {
          sum += Number(getByPath(entry, key) ?? 0) || 0;
        }
        if (sum !== 0) result.usage[metric] = sum;
      }
    }
    return result;
  }

  const rawStream = adapter.usage.format === 'analytics-log' && analyticsText ? analyticsText : stdoutText;
  const lines = String(rawStream ?? '')
    .split('\n')
    .map((line) => line.trim())
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
    if (cost !== null) result.costUsd = (result.costUsd ?? 0) + cost;

    if (turns !== null) {
      result.usage.turns = Math.max(result.usage.turns, turns);
    } else if (adapter.usage.events.turns.some((when) => matchesWhen(event, when))) {
      result.usage.turns += 1;
    }

    if (toolCalls !== null) {
      result.usage.toolCalls = Math.max(result.usage.toolCalls, toolCalls);
    } else if (adapter.usage.events.toolCalls.some((when) => matchesWhen(event, when))) {
      result.usage.toolCalls += 1;
    }
  }

  if (result.costUsd !== null) result.costUsd = Number(result.costUsd.toFixed(6));
  return result;
}

function runCmd(cmd, args, { cwd, env, input = null, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS } = {}) {
  return spawnBounded(cmd, args, { cwd, env: sanitizedEnv(env), input, timeoutMs });
}

/**
 * Apply a patch to a workspace, falling back to a three-way merge.
 *
 * The gold oracle and the regrade path land operator-supplied bytes the same way. They
 * used to disagree (`--binary` on one side only), so a patch that applied under one read
 * as unreproducible under the other (review 0003 Q59).
 *
 * @param {string} workDir
 * @param {Buffer|string} patch
 * @param {{timeoutMs?: number}} [options]
 */
export async function applyPatch(workDir, patch, { timeoutMs = DEFAULT_AGENT_TIMEOUT_MS } = {}) {
  if (!patch || patch.length === 0) return { code: 0 };
  const applied = await runCmd('git', ['apply', '--binary', '-'], { cwd: workDir, input: patch, timeoutMs });
  if (applied.code === 0) return applied;
  return runCmd('git', ['apply', '--3way', '-'], { cwd: workDir, input: patch, timeoutMs });
}

function buildAdapterArgs(adapter, { prompt, turns, model, analyticsLog, promptFile }) {
  const replaceToken = (token) =>
    String(token)
      .replaceAll('{prompt}', prompt)
      .replaceAll('{turns}', String(turns))
      .replaceAll('{model}', String(model ?? ''))
      .replaceAll('{analyticsLog}', String(analyticsLog ?? ''))
      .replaceAll('{promptFile}', String(promptFile ?? ''));

  const args = adapter.prompt.args.map(replaceToken);
  if (model && model !== 'default' && model !== adapter.id && adapter.prompt.modelArgs.length > 0) {
    args.push(...adapter.prompt.modelArgs.map(replaceToken));
  }
  return args;
}

/**
 * Drive one adapter against one task in `workDir`.
 *
 * An oracle adapter scripts the workspace instead of asking an agent: `from: 'vault'`
 * applies the task's reference patch, `from: 'none'` changes nothing. An agent adapter
 * receives its prompt through the declared delivery — argv, stdin or a file.
 *
 * @param {object} adapter a v2 adapter entry
 * @param {string} workDir
 * @param {object} task
 * @param {{vaultRoot: string, model?: string, maxTurns?: number, env?: object,
 *   timeoutMs?: number, slotDir: string, promptPrefix?: string}} options
 * @returns {Promise<{usage: object, costUsd: number|null, transcript: string,
 *   agent: {exitCode: number, timedOut: boolean, wallMs: number}}>}
 */
export async function executeAdapter(
  adapter,
  workDir,
  task,
  { vaultRoot, model, maxTurns = 25, env, timeoutMs, slotDir, promptPrefix = '' },
) {
  // A caller may hand over a stored v1 entry or a partial stub; the runner reads one
  // shape, so the normalisation happens at the boundary rather than in every branch.
  adapter = normaliseAdapter(adapter ?? {});
  const runTimeout = timeoutMs ?? adapter.timeoutMs;
  if (adapter.kind === 'oracle') {
    if (adapter.oracle?.from === 'vault') {
      const startedAt = Date.now();
      const goldPatch = await readFile(join(vaultRoot, task.id, 'gold.patch'));
      await applyPatch(workDir, goldPatch, { timeoutMs: runTimeout });
      return {
        ...parseAdapterUsage(adapter, ''),
        transcript: '',
        agent: { exitCode: 0, timedOut: false, wallMs: Date.now() - startedAt },
      };
    }
    return {
      ...parseAdapterUsage(adapter, ''),
      transcript: '',
      agent: { exitCode: 0, timedOut: false, wallMs: 0 },
    };
  }

  const analyticsLog = join(slotDir, 'analytics.jsonl');
  // The arm's context arrives as a prefix rather than a file the agent must be told to
  // read, so the prompt an adapter receives is the whole thing it was given.
  const prompt = [String(promptPrefix ?? ''), String(task.prompt ?? '')]
    .filter((part) => part.length > 0)
    .join('\n\n');
  const delivery = adapter.prompt.delivery;
  const promptFile = delivery === 'file' ? join(workDir, adapter.prompt.file ?? `.-prompt.md`) : null;
  if (promptFile !== null) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(promptFile, `${prompt}\n`, 'utf8');
  }
  const args = buildAdapterArgs(adapter, { prompt, turns: maxTurns, model, analyticsLog, promptFile });
  const outcome = await runCmd(adapter.bin, args, {
    cwd: workDir,
    env: agentEnv(adapter, { home: slotDir, extra: env }),
    input: delivery === 'stdin' ? `${prompt}\n` : null,
    timeoutMs: runTimeout,
  });
  // A binary that could not start produced no run. Grading its empty workspace would
  // record an unresolved arm instead of the missing harness it is (review 0003 Q47).
  if (outcome.spawnError) {
    throw new Error(`harness ${adapter.id} could not start ${adapter.bin}: ${outcome.spawnError}`);
  }
  const stdoutText = outcome.stdout.toString('utf8');
  const analyticsText =
    adapter.usage.format === 'analytics-log' ? await readFile(analyticsLog, 'utf8').catch(() => '') : '';
  const sources = { stdout: stdoutText, stderr: outcome.stderr.toString('utf8'), analytics: analyticsText };
  const transcript = adapter.transcript.sources
    .map((source) => sources[source] ?? '')
    .filter((text) => text.length > 0)
    .join('\n');
  return {
    ...parseAdapterUsage(adapter, stdoutText, analyticsText),
    transcript,
    // A run's own exit code, deadline and wall time belong in its record: the old one
    // stored none, so a timed-out run was indistinguishable from a completed one.
    agent: { exitCode: outcome.code, timedOut: outcome.timedOut, wallMs: outcome.wallMs },
  };
}
