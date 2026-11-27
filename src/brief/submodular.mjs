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
      const { subtask, score, facet = section, duplicateKey: group = duplicateKey ?? id } = row;
      if (!Number.isFinite(score) || score <= 0) continue;
      const key = JSON.stringify([subtask, facet]);
      if ((relevance.get(key)?.score ?? 0) < score) relevance.set(key, { subtask, facet, score, group });
      if (Number.isFinite(subtask)) subject = Math.min(subject, subtask);
    }
    const effects = [];
    for (const [key, { subtask, facet, score, group }] of [...relevance].sort(([a], [b]) => cmp(a, b))) {
      const facetWeight = facetWeights[facet] ?? DEFAULT_WEIGHTS[facet] ?? 1;
      const taskWeight = taskWeights[subtask] ?? 1;
      const weight = facetWeight * taskWeight;
      const beta = saturation[facet] ?? 1;
      if (weight > 0 && beta > 0 && Number.isFinite(weight) && Number.isFinite(beta)) {
        effects.push({
          ...effect(key, group, score, weight, beta),
          subtask,
          facet,
          taskWeight,
          facetWeight,
        });
      }
    }
    const floor = facetFloors[section];
    if (Number.isFinite(floor) && floor > 0 && relevance.size) {
      effects.push({
        ...effect(JSON.stringify(['floor', section]), 'first', 1, floor, 1),
        subtask: 0,
        facet: section,
        taskWeight: 1,
        facetWeight: floor,
        isFloor: true,
      });
    }
    return {
      id, bytes, section, effects, order: sectionOrder.get(section) ?? SECTIONS.length, subject, hard: priority === 'hard',
      covers: item.covers ?? null, densityWeight: item.densityWeight ?? 1,
      utilityWeight: Number.isFinite(item.utilityWeight) && item.utilityWeight > 0 ? item.utilityWeight : 1,
      subtasks: [...relevance.values()].filter(({ subtask }) => Number.isFinite(subtask) && subtask > 0),
    };
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
    return utility * row.utilityWeight;
  };
}

function nashObjective(model, { eps = 0.05, lambda = 0.35 } = {}) {
  const taskTotals = new Map();
  const facetTotals = new Map();
  const taskGroups = new Map();
  const facetGroups = new Map();
  const floorHit = new Set();
  return (row, apply = false) => {
    let utility = 0;
    const seenTask = new Map();
    const seenFacet = new Map();
    for (const eff of row.effects) {
      if (eff.isFloor) {
        if (!floorHit.has(eff.facet)) {
          utility += eff.facetWeight;
          if (apply) floorHit.add(eff.facet);
        }
        continue;
      }
      if (Number.isFinite(eff.subtask) && eff.subtask > 0) {
        const gKey = `${eff.subtask}\0${eff.group}`;
        const prev = seenTask.get(gKey) ?? taskGroups.get(gKey) ?? 0;
        const inc = eff.score - prev;
        if (inc > 0) {
          const cur = (seenTask.get(`_t_${eff.subtask}`) ?? taskTotals.get(eff.subtask) ?? 0);
          utility += eff.weight * (Math.log(eps + cur + inc) - Math.log(eps + cur));
          if (apply) {
            seenTask.set(gKey, eff.score);
            seenTask.set(`_t_${eff.subtask}`, cur + inc);
          }
        }
      }
      const fgKey = `${eff.facet}\0${eff.group}`;
      const fPrev = seenFacet.get(fgKey) ?? facetGroups.get(fgKey) ?? 0;
      const fInc = eff.score - fPrev;
      if (fInc > 0) {
        const fCur = seenFacet.get(`_f_${eff.facet}`) ?? facetTotals.get(eff.facet) ?? 0;
        utility += lambda * eff.facetWeight * (Math.sqrt(fCur + fInc) - Math.sqrt(fCur));
        if (apply) {
          seenFacet.set(fgKey, eff.score);
          seenFacet.set(`_f_${eff.facet}`, fCur + fInc);
        }
      }
    }
    if (apply) {
      for (const [k, v] of seenTask) {
        if (k.startsWith('_t_')) taskTotals.set(Number(k.slice(3)), v);
        else taskGroups.set(k, v);
      }
      for (const [k, v] of seenFacet) {
        if (k.startsWith('_f_')) facetTotals.set(k.slice(3), v);
        else facetGroups.set(k, v);
      }
    }
    return utility * row.utilityWeight;
  };
}

function density(gain, bytes, power = 0.75) {
  return bytes === 0 ? (gain > 0 ? Infinity : 0) : gain / (bytes ** power);
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

function greedy(model, hard, soft, budget, { regularizer = 0, augment = false, power = 0.75, makeObjective = objective } = {}) {
  const delta = makeObjective(model);
  const trace = hard.map((row) => record(row, delta(row, true)));
  let bytes = trace.reduce((sum, row) => sum + row.bytes, 0);
  let utility = trace.reduce((sum, row) => sum + row.gain, 0);
  const used = new Set();
  const coverage = new Set(hard.flatMap(({ covers }) => covers ?? []));
  const eligible = ({ covers }) => covers === null || covers.some((claim) => !coverage.has(claim));

  // Phase 1: round-robin subtask floor for multi-task packets so every subtask
  // receives its strongest fitting FILES item before Phase 2 fills remaining budget.
  const allSubtasks = [...new Set(soft.flatMap(({ subtasks }) => subtasks.map(({ subtask }) => subtask)))].sort((a, b) => a - b);
  if (allSubtasks.length > 1) {
    const coveredFiles = new Set(hard.filter(({ section }) => section === 'FILES')
      .flatMap(({ subtasks }) => subtasks.map(({ subtask }) => subtask)));
    for (const subtask of allSubtasks) {
      if (coveredFiles.has(subtask)) continue;
      const candidates = soft
        .filter((row) => !used.has(row.id) && row.section === 'FILES' && row.bytes <= budget - bytes && eligible(row)
          && row.subtasks.some((entry) => entry.subtask === subtask))
        .sort((a, b) => {
          const sa = (a.subtasks.find((entry) => entry.subtask === subtask)?.score ?? 0) * a.utilityWeight;
          const sb = (b.subtasks.find((entry) => entry.subtask === subtask)?.score ?? 0) * b.utilityWeight;
          return sb - sa || candidateOrder(a, b);
        });
      const pick = candidates[0];
      if (!pick) continue;
      const gain = delta(pick, true);
      if (gain <= 0) continue;
      used.add(pick.id);
      for (const claim of pick.covers ?? []) coverage.add(claim);
      for (const entry of pick.subtasks) coveredFiles.add(entry.subtask);
      utility += gain;
      bytes += pick.bytes;
      trace.push(record(pick, gain));
    }
  }

  let best = { trace: [...trace], bytes, utility };
  const weightedDensity = (gain, row) => density(gain, row.bytes + regularizer, power) * row.densityWeight;
  const compare = (a, b) => a.priority === b.priority ? candidateOrder(a.row, b.row) : b.priority - a.priority;
  const byDensity = heap(compare);
  const byGain = augment ? heap(compare) : null;
  for (const row of soft) {
    if (used.has(row.id) || row.bytes > budget - bytes || !eligible(row)) continue;
    const gain = delta(row);
    if (gain <= 0) continue;
    byDensity.push({ row, gain, epoch: 0, priority: weightedDensity(gain, row) });
    byGain?.push({ row, gain, epoch: 0, priority: gain });
  }

  let epoch = 0;
  function take(queue, weight) {
    for (;;) {
      const entry = queue.pop();
      if (entry === undefined) return undefined;
      if (used.has(entry.row.id) || entry.row.bytes > budget - bytes || !eligible(entry.row)) continue;
      if (entry.epoch === epoch) return entry;
      const gain = delta(entry.row);
      if (gain > 0) queue.push({ row: entry.row, gain, epoch, priority: weight(gain, entry.row) });
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
    const entry = take(byDensity, weightedDensity);
    if (!entry) break;
    const gain = delta(entry.row, true);
    used.add(entry.row.id);
    for (const claim of entry.row.covers ?? []) coverage.add(claim);
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
export function packSubmodular(items, { budget = DEFAULT_BRIEF_BYTES, algorithm = 'auto', ...weights } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('budget must be a non-negative integer');
  const model = prepare(items, weights);
  const hard = model.rows.filter((row) => row.hard);
  const soft = model.rows.filter((row) => !row.hard);
  const floor = hard.reduce((sum, row) => sum + row.bytes, 0);
  let result;
  let method;
  if (budget === 0 || floor > budget) {
    const makeObj = algorithm === 'nash' ? nashObjective : objective;
    const delta = makeObj(model);
    const rows = budget === 0 ? model.rows : hard;
    const trace = rows.map((row) => record(row, delta(row, true)));
    result = {
      trace,
      bytes: trace.reduce((sum, row) => sum + row.bytes, 0),
      utility: trace.reduce((sum, row) => sum + row.gain, 0),
    };
    method = budget === 0 ? 'unlimited' : 'floor';
  } else if (algorithm === 'nash') {
    result = greedy(model, hard, soft, budget, {
      regularizer: Math.max(1, (budget - floor) / Math.max(1, soft.length)),
      augment: true,
      power: 0.75,
      makeObjective: nashObjective,
    });
    method = 'nash';
  } else {
    const densityOnly = greedy(model, hard, soft, budget, { power: 1 });
    if (algorithm === 'density') {
      result = densityOnly;
      method = 'density';
    } else {
      const regularized = greedy(model, hard, soft, budget, {
        regularizer: Math.max(1, (budget - floor) / Math.max(1, soft.length)), augment: true, power: 0.75,
      });
      const preferRegularized = better(regularized, densityOnly);
      result = preferRegularized ? regularized : densityOnly;
      method = preferRegularized ? 'regularized' : 'density';
    }
  }
  const selected = new Set(result.trace.map(({ id }) => id));
  return {
    ...result, method, feasible: budget === 0 || floor <= budget,
    kept: model.rows.filter(({ id }) => selected.has(id)).map(({ id }) => id),
    cut: model.rows.filter(({ id }) => !selected.has(id)).map(({ id }) => id),
  };
}
