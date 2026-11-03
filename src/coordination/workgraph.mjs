// Dependency-aware work graph and budgets (W38).
//
// The graph helps an existing orchestrator decide what may run at once; it never spawns anything
// itself. The failures it exists to prevent:
//
//   * a predecessor's prose "done" treated as evidence, so a dependent started on work that was
//     never verified;
//   * a stale predecessor proof staying valid, so dependents never reopened;
//   * two tasks writing the same document section or remote object running together;
//   * a cycle reported as "waiting", which reads like progress;
//   * a budget exhausted while the run was reported as approved;
//   * independent research serialized for no reason, which costs capacity and gains nothing.

export const GRAPH_SCHEMA = 'simt.workgraph/1';

/** Why a task is not dispatchable. */
export const READINESS = Object.freeze(['ready', 'waiting', 'blocked', 'cycle']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value.filter(isText) : []);

/**
 * Whether a predecessor's evidence is current. Prose is not evidence.
 *
 * @param {object} evidence
 * @param {string} id
 */
export function predecessorCurrent(evidence, id) {
  const record = evidence?.[id];
  if (record === undefined) return false;
  if (typeof record === 'boolean') return record;
  return record?.current === true;
}

/**
 * The ready set, with each waiting task's exact missing evidence.
 *
 * @param {{tasks?: object[], evidence?: object}} input
 */
export function readyTasks({ tasks = [], evidence = {} } = {}) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((task) => isObject(task) && isText(task.id));
  const ids = new Set(list.map((task) => task.id));
  const ready = [];
  const waiting = [];
  for (const task of list) {
    const missing = [];
    for (const dependency of listOf(task.dependsOn)) {
      if (!ids.has(dependency)) missing.push(`${dependency} (unknown predecessor)`);
      else if (!predecessorCurrent(evidence, dependency)) missing.push(`${dependency} (evidence not current)`);
    }
    if (listOf(task.blockedBy).length > 0) {
      waiting.push({ id: task.id, state: 'blocked', missing: listOf(task.blockedBy).map((blocker) => `${blocker} (declared blocker)`) });
      continue;
    }
    if (missing.length > 0) waiting.push({ id: task.id, state: 'waiting', missing });
    else ready.push(task.id);
  }
  return { ready: ready.sort(), waiting: waiting.sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * Strongly connected components, so a cycle is named rather than reported as waiting.
 *
 * @param {object[]} tasks
 */
export function stronglyConnected(tasks = []) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((entry) => isObject(entry) && isText(entry.id));
  const ids = new Set(list.map((task) => task.id));
  // Two passes: filtering edges against a map that is still being filled silently dropped every
  // forward dependency, which made every cycle look acyclic.
  const edges = new Map();
  for (const task of list) edges.set(task.id, listOf(task.dependsOn).filter((dependency) => ids.has(dependency)));
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let counter = 0;

  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || (edges.get(node) ?? []).includes(node)) components.push(component.sort());
    }
  };

  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return components;
}

/**
 * A dispatch proposal for the existing orchestrator.
 *
 * Independent ready tasks run in parallel up to capacity; tasks that write the same resource are
 * serialized in id order, and a task inside a cycle is reported as such.
 *
 * @param {{tasks?: object[], evidence?: object, capacity?: number, spent?: object}} input
 */
export function schedule({ tasks = [], evidence = {}, capacity = 2, spent = {} } = {}) {
  const cycles = stronglyConnected(tasks);
  const inCycle = new Set(cycles.flat());
  const { ready, waiting } = readyTasks({ tasks, evidence });
  const byId = new Map((Array.isArray(tasks) ? tasks : []).map((task) => [task.id, task]));
  const used = new Map();
  const dispatch = [];
  const serialized = [];
  const limited = [];

  for (const id of ready) {
    if (inCycle.has(id)) continue;
    const task = byId.get(id) ?? {};
    const budget = checkBudget({ task, spent: spent?.[id] ?? {} });
    if (!budget.ok) {
      limited.push({ id, reason: budget.reason });
      continue;
    }
    const writes = listOf(task.writes);
    const clash = writes.find((resource) => [...used.entries()].some(([heldBy, held]) => held.includes(resource) && heldBy !== id));
    if (clash) {
      serialized.push({ id, after: [...used.entries()].filter(([, held]) => held.includes(clash)).map(([heldBy]) => heldBy).sort(), resource: clash });
      continue;
    }
    if (dispatch.length >= capacity) {
      serialized.push({ id, after: dispatch.slice(), resource: null });
      continue;
    }
    dispatch.push(id);
    used.set(id, writes);
  }

  return {
    dispatch,
    serialized,
    limited,
    cycle: cycles.map((component) => ({ ids: component, reason: `these tasks depend on each other: ${component.join(' -> ')}` })),
    waiting,
  };
}

/**
 * Whether a task's budget allows another action.
 *
 * @param {{task?: object, spent?: object}} input
 */
export function checkBudget({ task = {}, spent = {} } = {}) {
  const limits = isObject(task.limits) ? task.limits : {};
  const used = isObject(spent) ? spent : {};
  if (Number.isInteger(limits.actions) && (used.actions ?? 0) >= limits.actions) {
    return { ok: false, reason: `the action budget (${limits.actions}) is exhausted; the task stops with its state preserved` };
  }
  if (Number.isInteger(limits.seconds) && (used.seconds ?? 0) >= limits.seconds) {
    return { ok: false, reason: `the time budget (${limits.seconds}s) is exhausted; the task stops with its state preserved` };
  }
  return { ok: true, reason: null };
}

/**
 * A sentence for a blocked task that names the contract, not the symptom.
 *
 * @param {object} task
 * @param {object} evidence
 */
export function explainBlocked(task, evidence = {}) {
  const blockers = listOf(task?.blockedBy);
  if (blockers.length > 0) return `${task.id} is blocked by ${blockers.join(', ')}`;
  const missing = listOf(task?.dependsOn).filter((dependency) => !predecessorCurrent(evidence, dependency));
  return missing.length === 0 ? `${task?.id ?? 'the task'} is ready` : `${task?.id ?? 'the task'} waits on current evidence for ${missing.join(', ')}`;
}
