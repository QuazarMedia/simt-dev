import { cmp } from '../util/sort.mjs';
import { DEFAULT_BRIEF_BYTES, SECTIONS } from './packet.mjs';

const DEFAULT_WEIGHTS = Object.freeze({
  FILES: 2, TESTS: 1.4, DECISIONS: 1.25, SKILLS: 1.1, LESSONS: 1.1,
  CAUTIONS: 1.4, KNOWLEDGE: 1.2, FEDERATION: 1, ADVICE: 0.8,
});

function candidateOrder(a, b) {
  return a.order - b.order || a.subject - b.subject || cmp(a.id, b.id);
}

function heap(compare) {
  const rows = [];
  return {
    push(item) {
      let index = rows.length;
      rows.push(item);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (compare(rows[parent], item) <= 0) break;
        rows[index] = rows[parent];
        index = parent;
      }
      rows[index] = item;
    },
    pop() {
      const top = rows[0];
      const last = rows.pop();
      if (!rows.length) return top;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        if (left >= rows.length) break;
        const right = left + 1;
        const child = right < rows.length && compare(rows[right], rows[left]) < 0 ? right : left;
        if (compare(rows[child], last) >= 0) break;
        rows[index] = rows[child];
        index = child;
      }
      rows[index] = last;
      return top;
    },
  };
}

function prepare(items, { facetWeights = {}, taskWeights = {}, saturation = {}, facetFloors = {} }) {
  const sectionOrder = new Map(SECTIONS.map((section, index) => [section, index]));
  const dimensions = new Map();
  const groups = new Map();
  const ids = new Set();

  function dimension(key) {
    if (!dimensions.has(key)) dimensions.set(key, dimensions.size);
    return dimensions.get(key);
  }

  function effect(key, duplicate, score, weight, beta) {
    const dim = dimension(key);
    const identity = JSON.stringify([dim, duplicate]);
    if (!groups.has(identity)) groups.set(identity, groups.size);
    return { dim, group: groups.get(identity), score, weight, beta };
  }

  const rows = items.map((item) => {
    const { id, section, priority, duplicateKey } = item;
    const bytes = item.bytes ?? Buffer.byteLength(item.text ?? '');
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('packet items must have unique string IDs');
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('packet item bytes must be a non-negative integer');
    ids.add(id);
    const relevance = new Map();
    let subject = Infinity;
    for (const row of item.relevance ?? []) {
      const { subtask, score, facet = section } = row;
      if (!Number.isFinite(score) || score <= 0) continue;
      const key = JSON.stringify([subtask, facet]);
      if ((relevance.get(key)?.score ?? 0) < score) relevance.set(key, { subtask, facet, score });
      if (Number.isFinite(subtask)) subject = Math.min(subject, subtask);
    }
    const effects = [];
    for (const [key, { subtask, facet, score }] of [...relevance].sort(([a], [b]) => cmp(a, b))) {
      const weight = (facetWeights[facet] ?? DEFAULT_WEIGHTS[facet] ?? 1) * (taskWeights[subtask] ?? 1);
      const beta = saturation[facet] ?? 1;
      if (weight > 0 && beta > 0 && Number.isFinite(weight) && Number.isFinite(beta)) {
        effects.push(effect(key, duplicateKey ?? id, score, weight, beta));
      }
    }
    const floor = facetFloors[section];
    if (Number.isFinite(floor) && floor > 0 && relevance.size) {
      effects.push(effect(JSON.stringify(['floor', section]), 'first', 1, floor, 1));
    }
    return { id, bytes, effects, order: sectionOrder.get(section) ?? SECTIONS.length, subject, hard: priority === 'hard' };
  }).sort(candidateOrder);
  return { rows, dimensions: dimensions.size, groups: groups.size };
}

function objective(model) {
  const totals = new Float64Array(model.dimensions);
  const best = new Float64Array(model.groups);
  return (row, apply = false) => {
    let utility = 0;
    for (const { dim, group, score, weight, beta } of row.effects) {
      const increase = score - best[group];
      if (increase <= 0) continue;
      utility += weight * Math.log1p(beta * increase / (1 + beta * totals[dim]));
      if (apply) {
        totals[dim] += increase;
        best[group] = score;
      }
    }
    return utility;
  };
}

function density(gain, bytes) {
  return bytes === 0 ? (gain > 0 ? Infinity : 0) : gain / bytes;
}

function record(row, gain) {
  return { id: row.id, bytes: row.bytes, gain, gainPerByte: Number.isFinite(density(gain, row.bytes))
    ? density(gain, row.bytes) : null, priority: row.hard ? 'hard' : 'soft' };
}

function better(candidate, best) {
  return candidate.utility > best.utility || (candidate.utility === best.utility
    && (candidate.bytes < best.bytes || (candidate.bytes === best.bytes
      && cmp(candidate.trace.map(({ id }) => id).join('\0'), best.trace.map(({ id }) => id).join('\0')) < 0)));
}

function greedy(model, hard, soft, budget, { regularizer = 0, augment = false } = {}) {
  const delta = objective(model);
  const trace = hard.map((row) => record(row, delta(row, true)));
  let bytes = trace.reduce((sum, row) => sum + row.bytes, 0);
  let utility = trace.reduce((sum, row) => sum + row.gain, 0);
  let best = { trace: [...trace], bytes, utility };
  const used = new Set();
  const compare = (a, b) => a.priority === b.priority ? candidateOrder(a.row, b.row) : b.priority - a.priority;
  const byDensity = heap(compare);
  const byGain = augment ? heap(compare) : null;
  for (const row of soft) {
    if (row.bytes > budget - bytes) continue;
    const gain = delta(row);
    if (gain <= 0) continue;
    byDensity.push({ row, gain, epoch: 0, priority: density(gain, row.bytes + regularizer) });
    byGain?.push({ row, gain, epoch: 0, priority: gain });
  }

  let epoch = 0;
  function take(queue, weight) {
    for (;;) {
      const entry = queue.pop();
      if (entry === undefined) return undefined;
      if (used.has(entry.row.id) || entry.row.bytes > budget - bytes) continue;
      if (entry.epoch === epoch) return entry;
      const gain = delta(entry.row);
      if (gain > 0) queue.push({ row: entry.row, gain, epoch, priority: weight(gain, entry.row.bytes) });
    }
  }

  for (;;) {
    if (augment) {
      const entry = take(byGain, (gain) => gain);
      if (entry) {
        const candidate = {
          utility: utility + entry.gain, bytes: bytes + entry.row.bytes,
          trace: [...trace, record(entry.row, entry.gain)],
        };
        if (better(candidate, best)) best = candidate;
        byGain.push(entry);
      }
    }
    const entry = take(byDensity, (gain, cost) => density(gain, cost + regularizer));
    if (!entry) break;
    const gain = delta(entry.row, true);
    used.add(entry.row.id);
    utility += gain;
    bytes += entry.row.bytes;
    trace.push(record(entry.row, gain));
    epoch += 1;
  }
  const final = { trace, bytes, utility };
  return better(final, best) ? final : best;
}

/**
 * Select evidence under a modular byte budget. Repeated evidence contributes
 * the strongest relevance for each subtask/facet, which preserves monotonicity.
 * The density arm and the regularized density-plus-singleton arm share the
 * same mandatory floor and compare utility under the same objective.
 */
export function packSubmodular(items, { budget = DEFAULT_BRIEF_BYTES, ...weights } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('budget must be a non-negative integer');
  const model = prepare(items, weights);
  const hard = model.rows.filter((row) => row.hard);
  const soft = model.rows.filter((row) => !row.hard);
  const floor = hard.reduce((sum, row) => sum + row.bytes, 0);
  let result;
  let method;
  if (budget === 0 || floor > budget) {
    const delta = objective(model);
    const rows = budget === 0 ? model.rows : hard;
    const trace = rows.map((row) => record(row, delta(row, true)));
    result = {
      trace,
      bytes: trace.reduce((sum, row) => sum + row.bytes, 0),
      utility: trace.reduce((sum, row) => sum + row.gain, 0),
    };
    method = budget === 0 ? 'unlimited' : 'floor';
  } else {
    const densityOnly = greedy(model, hard, soft, budget);
    const regularized = greedy(model, hard, soft, budget, {
      regularizer: Math.max(1, (budget - floor) / Math.max(1, soft.length)), augment: true,
    });
    const preferRegularized = better(regularized, densityOnly);
    result = preferRegularized ? regularized : densityOnly;
    method = preferRegularized ? 'regularized' : 'density';
  }
  const selected = new Set(result.trace.map(({ id }) => id));
  return {
    ...result, method, feasible: budget === 0 || floor <= budget,
    kept: model.rows.filter(({ id }) => selected.has(id)).map(({ id }) => id),
    cut: model.rows.filter(({ id }) => !selected.has(id)).map(({ id }) => id),
  };
}
