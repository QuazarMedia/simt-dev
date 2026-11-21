import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildCapsule, checkResume, reopenFor } from './handoff.mjs';
import { localTracker } from './local-tracker.mjs';
import { readLeases } from '../lease.mjs';
import { readLedger } from '../ledger/index.mjs';
import { digestOf } from '../knowledge/observations.mjs';
import { gitPaths, gitText } from '../sys/git.mjs';
import { canonicalJson } from '../util/canonical.mjs';
import { localVerificationStatus } from '../verify/local-run.mjs';
import { selectLocalVerification } from '../verify/local-selection.mjs';

const digest = (value) => digestOf(canonicalJson(value));
const worktreeId = (root) => digest(['worktree', root]);
const obligationId = (id) => digest(['obligation', id]);
const emptyLedger = { entries: [], errors: [] };

async function projectAt(root) {
  const common = await gitText(root, ['rev-parse', '--git-common-dir']);
  return digest(['git-family', await realpath(resolve(root, common))]);
}

async function originOf(root, id) {
  const paths = await gitPaths(root, ['worktree', 'list', '--porcelain']);
  for (const row of paths) {
    if (!row.startsWith('worktree ')) continue;
    const candidate = await realpath(row.slice('worktree '.length)).catch(() => null);
    if (candidate !== null && worktreeId(candidate) === id) return candidate;
  }
  return null;
}

async function taskChecks(root, scopeId, task, ledger = null) {
  const plan = await selectLocalVerification(root, { scopeId, extraPaths: task.artifacts });
  if (plan.error) return { error: plan.error, remedy: plan.remedy };
  const status = await localVerificationStatus(plan, [], { ledger });
  const named = new Set(task.artifacts);
  const results = status.results.filter(({ paths }) => paths.some((path) => named.has(path)));
  if (results.length > 16) return { error: 'the selected task exceeds the capsule obligation limit', remedy: 'split the task scope into smaller artifact groups' };
  return { results, status };
}

async function leaseAt(root, task) {
  const loaded = await readLeases(root);
  if (loaded.error) return { error: loaded.error };
  const matches = loaded.leases.filter((lease) => lease.slice === task.id ||
    task.artifacts.some((path) => path === lease.path || path.startsWith(`${lease.path}/`)));
  matches.sort((a, b) => b.expiresAt - a.expiresAt);
  return matches[0] ?? null;
}

const leaseId = (record) => record === null ? null : digest([record.path, record.session, record.slice]);
const allowedState = (state) => ['queued', 'ready', 'open', 'in progress', 'in-progress', 'active'].includes(state);
const taskIntent = (task) => digest([task.id, task.artifacts.slice().sort(), task.dependsOn.slice().sort(), task.writes.slice().sort()]);
const dependenciesOf = (task, evidence) => task.dependsOn.map((id) => ({ id, current: evidence[id]?.current === true }));

export async function localHandoff(root, scopeId, taskId, session = null) {
  const board = await localTracker(root, scopeId);
  if (board.error) return board;
  const task = board.tasks.find(({ id }) => id === taskId);
  if (!task) return { error: `no task ${taskId} in scope ${scopeId}`, remedy: `run simt work schedule --scope ${scopeId}` };
  if (task.artifacts.length === 0) return { error: 'the task has no permitted artifact scope', remedy: 'name its repository artifact paths in the configured tracker' };
  const origin = board.root;
  const lease = await leaseAt(origin, task);
  if (lease?.error) return { error: lease.error, remedy: 'inspect the local lease file' };
  const checked = await taskChecks(origin, scopeId, task);
  if (checked.error) return checked;
  const completed = [];
  const uncertainty = [];
  for (const result of checked.results) {
    const id = obligationId(result.id);
    const proof = result.runs?.filter((run) => run.state === 'pass').map((run) => run.receipt).filter(Boolean) ?? [];
    if (result.state === 'pass' && proof.length > 0) completed.push({ obligation: id, receipt: digest(proof), revision: result.inputDigest });
    else uncertainty.push({ id, reason: result.state });
  }
  const now = Date.now();
  const lacksLease = lease !== null && (session === null || session !== lease.session);
  const dependencies = dependenciesOf(task, board.evidence);
  const permission = !allowedState(task.state) || lacksLease
    ? { denied: true, reason: lacksLease ? 'the selected task is leased to another session' : 'the task state does not allow continuation' }
    : null;
  const local = { project: await projectAt(origin), worktree: worktreeId(origin),
    scope: scopeId, task: task.id, lease: leaseId(lease) };
  const resumable = checkResume({}, { permission, dependencies, lease, now });
  const capsule = buildCapsule({
    goal: task.id, intent: { digest: taskIntent(task) }, local,
    snapshot: { digest: digest(checked.results.map(({ inputDigest }) => inputDigest)),
      revision: await gitText(origin, ['rev-parse', 'HEAD']) },
    completed, uncertainty, next: { action: 'review-current-obligations', admissible: resumable.resumable },
  });
  return { capsule, resume: resumable, duplicates: null, reopened: null };
}

export async function localResume(root, scopeId, capsule, session = null) {
  if (!capsule?.local || capsule.target !== null || capsule.local.scope !== scopeId) {
    return { error: 'the capsule has no matching local scope', remedy: 'use the scope and capsule supplied by work handoff' };
  }
  const { digest: recorded, ...body } = capsule;
  if (recorded !== digest(body) || !Array.isArray(capsule.completed)) return { error: 'the local capsule digest does not match', remedy: 'recreate the capsule with work handoff' };
  const board = await localTracker(root, scopeId);
  if (board.error) return board;
  if (capsule.local.project !== await projectAt(board.root)) return { error: 'the capsule belongs to another local Git repository', remedy: 'resume in the original checkout or one of its worktrees' };
  const task = board.tasks.find(({ id }) => id === capsule.local.task);
  if (!task || task.artifacts.length === 0) return { error: 'the task or its artifact scope is unavailable', remedy: 'check the configured tracker and work scope' };

  const origin = await originOf(board.root, capsule.local.worktree);
  const ledger = origin === null ? emptyLedger : await readLedger(origin);
  const checked = await taskChecks(board.root, scopeId, task, ledger);
  if (checked.error) return checked;
  const byId = new Map(checked.results.map((result) => [obligationId(result.id), result]));
  const revisions = Object.create(null);
  const retained = [];
  const unproved = [];
  for (const entry of capsule.completed) {
    const result = byId.get(entry.obligation);
    revisions[entry.obligation] = result?.inputDigest ?? 'unavailable';
    if (!result || revisions[entry.obligation] !== entry.revision) continue;
    const proof = result.runs?.filter((run) => run.state === 'pass').map((run) => run.receipt).filter(Boolean) ?? [];
    if (result.state === 'pass' && digest(proof) === entry.receipt) retained.push(entry.obligation);
    else unproved.push({ obligation: entry.obligation, reason: 'the recorded receipt is unavailable or no longer current' });
  }
  const lease = origin === null ? null : await leaseAt(origin, task);
  const currentLease = origin === board.root ? lease : await leaseAt(board.root, task);
  let leaseFailure = null;
  if (lease?.error || currentLease?.error) leaseFailure = 'the applicable local lease could not be read';
  else if (capsule.local.lease !== null && leaseId(lease) !== capsule.local.lease) leaseFailure = 'the original lease expired, changed or was released';
  else if ([lease, currentLease].some((entry) => entry && entry.session !== session)) leaseFailure = 'the task is leased to another session';
  const permission = !allowedState(task.state) || taskIntent(task) !== capsule.intent?.digest
    ? { denied: true, reason: 'the tracked task state, artifact scope or dependencies changed' }
    : null;
  const resume = checkResume(capsule, {
    permission, dependencies: dependenciesOf(task, board.evidence), lease: currentLease ?? lease, now: Date.now(),
  });
  if (leaseFailure !== null) {
    resume.failures.push({ check: 'lease', reason: leaseFailure });
    resume.resumable = false;
  }
  const { reopened } = reopenFor({ capsule, revisions });
  return {
    resume, duplicates: { safe: true, duplicates: [] },
    reopened: { reopened: [...reopened, ...unproved].sort((a, b) => a.obligation.localeCompare(b.obligation)), retained },
  };
}
