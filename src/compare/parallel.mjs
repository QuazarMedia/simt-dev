// Capped parallelism for estate-wide work (review 0003 Q38).
//
// Two callers need it - row building and estate learning - and a third copy of
// the same worker pool would be the defect ADR-002 names, so it lives here.
// Order-preserving: results land at their input index, because both callers
// diff their output between runs and completion order would scramble it.

/**
 * How many estate items to work on at once.
 *
 * The work is process-spawn bound (git, file reads), so unbounded parallelism
 * is a burst of subprocesses with no speedup, and sequential work is what took
 * `compare` 48 s over MCP for 17 repos. Four overlaps the wait while keeping
 * the burst bounded.
 */
export const DEFAULT_CONCURRENCY = 4;

export function resolveConcurrency(flags = {}) {
  const raw = flags?.concurrency ?? process.env.SIMT_CONCURRENCY ?? DEFAULT_CONCURRENCY;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CONCURRENCY;
}

/**
 * Map `items` through async `fn` with at most `concurrency` in flight.
 *
 * @param {unknown[]} items
 * @param {(item: unknown, index: number) => Promise<unknown>} fn
 * @param {{concurrency?: number, signal?: AbortSignal|null, onItem?: ((done: number, total: number) => void)|null}} options
 * @returns {Promise<unknown[]>} results in input order
 * @throws the first worker failure, or a CANCELLED error when `signal` aborts
 */
export async function mapCapped(items, fn, { concurrency = DEFAULT_CONCURRENCY, signal = null, onItem = null } = {}) {
  const list = [...(items ?? [])];
  const out = new Array(list.length);
  const cap = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY;
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < list.length) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled by client'), { code: 'CANCELLED' });
      const i = next++;
      out[i] = await fn(list[i], i);
      done += 1;
      if (onItem) onItem(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, list.length) }, () => worker()));
  return out;
}
