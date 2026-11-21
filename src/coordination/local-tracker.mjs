import { readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { readLocalBytes } from '../knowledge/collect.mjs';
import { loadPlanState, splitRow } from '../plan/index.mjs';
import { git, gitPaths } from '../sys/git.mjs';
import { parseFrontmatter } from '../text/frontmatter.mjs';
import { selectLocalVerification } from '../verify/local-selection.mjs';
import { localVerificationStatus } from '../verify/local-run.mjs';
import { resolveScope } from '../work/artifacts.mjs';
import { readWork } from '../work/effective.mjs';
import { schedule } from './workgraph.mjs';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LIMIT = 256;
const fields = ['id', 'state', 'dependsOn', 'priority', 'artifacts', 'writes', 'receipts'];
const list = (value) => Array.isArray(value) ? value : typeof value === 'string' && value.trim() !== '' && !/^(?:—|-)$/u.test(value.trim())
  ? value.split(',').map((item) => item.trim()).filter(Boolean)
  : [];
const pair = (key, value) => [key, /^[["]/.test(value) ? JSON.parse(value) : value];
const sourceKey = (tracker) => ({ kind: tracker.kind, path: tracker.path, visibility: tracker.visibility });

function fromFrontmatter(text) {
  const { front } = parseFrontmatter(text);
  if (front === null) return {};
  return Object.fromEntries(front.split('\n').flatMap((line) => {
    const match = /^([\w]+):\s*(.*)$/.exec(line);
    return match && fields.includes(match[1]) ? [pair(match[1], match[2].trim())] : [];
  }));
}

function fromTable(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => line.trim().startsWith('|') && splitRow(line).some((key) => key.toLowerCase() === 'id'));
  if (header === -1) throw new Error('Markdown tracker requires an ID column');
  const keys = splitRow(lines[header]).map((key) => key.toLowerCase().replace(/[\s_-]/g, ''));
  const divider = lines[header + 1];
  if (!divider || !splitRow(divider).every((cell) => /^:?-+:?$/.test(cell))) throw new Error('Markdown tracker requires a table divider');
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    rows.push(Object.fromEntries(fields.flatMap((field) => {
      const index = keys.indexOf(field.toLowerCase());
      return index === -1 ? [] : [[field, cells[index] ?? '']];
    })));
  }
  return rows;
}

async function readRows(root, tracker, tracked, problems) {
  const allowed = (path) => tracker.visibility === 'private' || tracked.has(path);
  const read = async (path) => allowed(path) ? (await readLocalBytes(root, path))?.toString('utf8') ?? null : null;
  if (tracker.kind === 'plan') {
    if (await read(tracker.path) === null) throw new Error('the plan tracker is unavailable');
    const loaded = await loadPlanState(root);
    if (loaded.error) throw new Error(loaded.error);
    return loaded.slices.filter((slice) => relative(root, slice.docPath) === tracker.path).map((slice) => {
      const cells = slice.doc.rows.find((row) => row.line === slice.line)?.cells ?? [];
      const state = loaded.format.satisfies.has(slice.state) ? 'complete' : loaded.format.ready === slice.state ? 'queued' : slice.state;
      return { id: slice.id, state, dependsOn: [...slice.resolvedDeps.map(({ id }) => id), ...slice.unknownDeps],
        writes: slice.laneKey === '' ? [] : [slice.laneKey], commit: /\b[0-9a-f]{40,64}\b/.exec(cells[slice.evidenceIdx] ?? '')?.[0] ?? null,
        source: tracker.path };
    });
  }
  if (tracker.kind === 'markdown-items') {
    const named = join(root, tracker.path);
    if (await realpath(named).catch(() => null) !== named) throw new Error('the item directory is unavailable');
    const entries = (await readdir(named, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > LIMIT) throw new Error(`the item directory exceeds ${LIMIT} Markdown files`);
    const rows = [];
    for (const { name } of entries) {
      const path = join(tracker.path, name);
      const text = await read(path);
      if (text === null) problems.push({ code: 'unreadable-item', source: path });
      else {
        try {
          rows.push({ ...fromFrontmatter(text), source: path });
        } catch {
          problems.push({ code: 'invalid-item-metadata', source: path });
        }
      }
    }
    return rows;
  }

  const text = await read(tracker.path);
  if (text === null) throw new Error('the configured tracker is unavailable');
  const rows = tracker.kind === 'markdown-table' ? fromTable(text) : jsonRows(text);
  return rows.map((row) => ({ ...row, source: tracker.path }));
}

function jsonRows(text) {
  const doc = JSON.parse(text);
  if (doc?.version !== 1 || !Array.isArray(doc.tasks)) throw new Error('a tracker export needs version 1 and a tasks array');
  const isValid = (field, value) => {
    if (value === undefined) return true;
    if (['dependsOn', 'artifacts', 'writes', 'receipts'].includes(field)) {
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    }
    return field === 'priority' ? Number.isSafeInteger(value) : typeof value === 'string';
  };
  return doc.tasks.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        !fields.every((field) => isValid(field, row[field]))) return { invalid: true };
    return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
  });
}

function normaliseRows(rows, work, scope, problems) {
  const tasks = [];
  const counts = new Map();
  for (const row of rows) {
    if (typeof row.id === 'string' && TASK_ID.test(row.id)) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  const duplicate = new Set();
  for (const row of rows) {
    if (row.invalid) problems.push({ code: 'invalid-task', source: row.source });
    else if (!counts.has(row.id)) problems.push({ code: 'missing-task-id', source: row.source });
    else if (counts.get(row.id) > 1) {
      if (!duplicate.has(row.id)) problems.push({ code: 'duplicate-task-id', id: row.id });
      duplicate.add(row.id);
    } else {
      const state = String(row.state ?? '').trim().toLowerCase();
      const artifacts = list(row.artifacts);
      const outside = artifacts.some((path) => {
        const owner = resolveScope(work.scopes, path);
        return owner.scope !== scope.id || owner.ignored;
      });
      const priority = Number(row.priority ?? 0);
      const blockedBy = [];
      if (!['queued', 'ready', 'open'].includes(state)) blockedBy.push(state || 'missing state');
      if (outside) blockedBy.push('artifact scope unavailable');
      if (outside) problems.push({ code: 'artifact-outside-scope', id: row.id });
      tasks.push({ id: row.id, state, priority: Number.isSafeInteger(priority) ? priority : 0,
        dependsOn: list(row.dependsOn), artifacts: outside ? [] : artifacts, writes: list(row.writes),
        receipts: list(row.receipts), commit: row.commit ?? null, source: row.source, blockedBy });
    }
  }
  return tasks;
}

export async function localTracker(inputRoot, scopeId, { publicOnly = false } = {}) {
  const root = await realpath(inputRoot);
  const work = await readWork(root);
  if (!work.ok) return { error: work.problems[0].message, remedy: work.problems[0].remedy };
  const scope = work.scopes.find(({ id }) => id === scopeId);
  if (!scope?.tracker) return { error: `no tracker is configured for scope ${scopeId}`, remedy: 'declare a tracker in the scope or use work schedule --input' };
  const tracker = scope.tracker;
  if (publicOnly && tracker.visibility === 'private') return { withheld: true, tasks: [], evidence: {}, problems: [] };

  const tracked = new Set(await gitPaths(root, ['ls-files']));
  const problems = [];
  const rows = await readRows(root, tracker, tracked, problems);
  if (rows.length > LIMIT) return { error: `the configured tracker exceeds ${LIMIT} tasks`, remedy: 'select a smaller tracker' };
  const tasks = normaliseRows(rows, work, scope, problems);
  const evidence = Object.create(null);
  const status = tasks.some(({ receipts }) => receipts.length > 0)
    ? await selectLocalVerification(root, { scopeId }).then(async (plan) => plan.error ? null : localVerificationStatus(plan))
    : null;
  const current = new Set(status?.results.filter(({ state }) => state === 'pass').map(({ id }) => id) ?? []);
  for (const task of tasks) {
    if (!['complete', 'closed', 'done'].includes(task.state)) continue;
    const basis = task.commit === null ? 'verification-receipts' : 'tracker-commit';
    const verified = task.commit === null
      ? task.receipts.length > 0 && task.receipts.every((id) => current.has(id))
      : await git(root, ['merge-base', '--is-ancestor', task.commit, 'HEAD'], { allowFailure: true }) !== null;
    evidence[task.id] = { current: verified, basis };
  }
  return { root, scope: scopeId, tracker: sourceKey(tracker), tasks, evidence, problems, withheld: false };
}

export async function scheduleLocal(root, scope, options = {}) {
  const context = await localTracker(root, scope, options);
  if (context.error) return context;
  const result = schedule({ tasks: context.tasks, evidence: context.evidence });
  if (options.publicOnly) {
    return {
      withheld: context.withheld,
      tasks: context.tasks.map(({ id, state, priority }) => ({ id, state, priority })),
      dispatch: result.dispatch, waitingCount: result.waiting.length, executed: false,
    };
  }
  return { ...context, ...result, executed: false };
}
