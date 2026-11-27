import { cmp } from '../util/sort.mjs';

const EPS = 1e-9;
const COMBMNZ_GAMMA = 0.15;
const CONFIDENT_PHI = 0.8;
const RRF_K = 40;

const round = (value) => Math.round(value * 1e6) / 1e6;
const clamp = (low, high, value) => Math.min(high, Math.max(low, value));

export function computeQppMetrics(items, baseWeight) {
  if (!Array.isArray(items) || !items.length || !(baseWeight > 0)) {
    return { count: 0, nqc: 0, topGap: 0, phi: 0, effectiveWeight: 0, minScore: 0, maxScore: 0 };
  }
  const scores = items.map((entry, index) => (
    typeof entry === 'object' && typeof entry?.score === 'number' && Number.isFinite(entry.score)
      ? entry.score
      : 1 / (index + 1)
  ));
  const sorted = [...scores].sort((a, b) => b - a);
  const maxScore = sorted[0];
  const minScore = sorted[sorted.length - 1];

  if (sorted.length === 1) {
    const phi = maxScore > 0 ? 1 : 0.25;
    return {
      count: 1,
      nqc: 0,
      topGap: maxScore > 0 ? 1 : 0,
      phi,
      effectiveWeight: round(baseWeight * phi),
      minScore,
      maxScore,
    };
  }

  const k = Math.min(10, sorted.length);
  const m = Math.min(30, sorted.length);
  const topSlice = sorted.slice(0, k);
  const tailSlice = sorted.slice(0, m);
  const meanTail = tailSlice.reduce((sum, value) => sum + value, 0) / tailSlice.length + EPS;
  const meanTop = topSlice.reduce((sum, value) => sum + value, 0) / topSlice.length;
  const variance = topSlice.reduce((sum, value) => sum + (value - meanTop) ** 2, 0) / topSlice.length;
  const nqc = Math.sqrt(variance) / meanTail;
  const fifth = sorted[Math.min(4, sorted.length - 1)];
  const topGap = maxScore > 0 ? Math.max(0, (maxScore - fifth) / maxScore) : 0;
  const rawPhi = 0.6 * Math.min(2.0, nqc) + 0.4 * (2.0 * topGap);
  const phi = round(clamp(0.25, 2.0, rawPhi));

  return {
    count: sorted.length,
    nqc: round(nqc),
    topGap: round(topGap),
    phi,
    effectiveWeight: round(baseWeight * phi),
    minScore,
    maxScore,
  };
}

export function fuseQppChannels(lists, { k = RRF_K, gamma = COMBMNZ_GAMMA } = {}) {
  const fused = new Map();
  const bestScore = new Map();
  const confidentSum = new Map();
  const channelStats = {};

  for (const list of lists ?? []) {
    const { id, qppId, items = [], weight = 1, maxPhi = 2.0 } = list;
    if (!Array.isArray(items) || !(weight > 0) || !items.length) continue;
    const rawMetrics = computeQppMetrics(items, weight);
    const phi = clamp(0.25, maxPhi, rawMetrics.phi);
    const metrics = {
      ...rawMetrics,
      phi,
      effectiveWeight: round(weight * phi),
    };
    const key = qppId ?? (Object.hasOwn(channelStats, id) ? `${id}_2` : id);
    channelStats[key] = {
      baseWeight: round(weight),
      nqc: metrics.nqc,
      topGap: metrics.topGap,
      phi: metrics.phi,
      effectiveWeight: metrics.effectiveWeight,
    };
    const span = metrics.maxScore - metrics.minScore;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i];
      const path = typeof entry === 'string' ? entry : entry?.path;
      if (!path) continue;
      const rawScore = typeof entry === 'object' && typeof entry?.score === 'number' && Number.isFinite(entry.score)
        ? entry.score
        : 1 / (i + 1);
      const normScore = span > EPS
        ? (rawScore - metrics.minScore) / span
        : (items.length === 1 && metrics.maxScore > 0 ? 1 : (metrics.maxScore > 0 ? 0.5 : 0));
      const contrib = metrics.effectiveWeight * (0.7 / (k + i + 1) + 0.3 * normScore);
      fused.set(path, (fused.get(path) ?? 0) + contrib);
      if (metrics.phi >= CONFIDENT_PHI) {
        confidentSum.set(path, (confidentSum.get(path) ?? 0) + metrics.phi);
      }
      if (typeof entry === 'object' && typeof entry?.score === 'number') {
        bestScore.set(path, Math.max(bestScore.get(path) ?? 0, entry.score));
      }
    }
  }

  const ranked = [...fused.entries()]
    .map(([path, base]) => {
      const mnz = 1 + gamma * (confidentSum.get(path) ?? 0);
      return {
        path,
        rank: Math.round(base * mnz * 1e9) / 1e9,
        score: bestScore.get(path) ?? 0,
      };
    })
    .sort((a, b) => (a.rank !== b.rank ? (a.rank < b.rank ? 1 : -1) : cmp(a.path, b.path)));

  return { ranked, qpp: channelStats };
}
