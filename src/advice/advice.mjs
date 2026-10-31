// Model and effort advice, read from the repository's own bench history (plan 0003 R40).
//
// The mapping the design row asks for — task features to the cheapest tier that resolved
// similar tasks — is data, not opinion: the records `bench run` stored on disk already say
// which model classes resolved which mined tasks and what those runs cost. So the tier
// ladder is the estate's own evidence sorted by price, and no vendor name is written into
// the code: a repository whose history has one class of run gets advice about that class,
// and one whose history has three gets a ladder with three steps.
//
// The properties this exists to keep:
//
//   * Advice, never a choice. The output is a sentence in the brief header along with the
//     bench numbers behind it; the agent (or the human) names the model, not simt-dev
//     (P2). Nothing here writes a model id into a config, a lock or a command.
//   * Deterministic. No model, no network, no clock (P1): the same runs directory yields
//     the same advice, so a reviewable claim about cost is possible.
//   * Quiet in thin evidence. A neighborhood with no resolved run yields a caution, not a
//     made-up tier; a history with no runs at all yields no advice line.
//
// The measure of "cheapest" follows the bench's own report: cost in dollars when the run
// records or a prices table price the tokens, total tokens otherwise. Ordering by a number
// that does not exist for any run would be nondeterminism, not economics.
import { classifyTask } from '../brief/kind.mjs';
import { computeRunCost, isRunResolved, loadPrices, loadRunRecords } from '../bench/report.mjs';
import { loadTasks } from '../bench/tasks.mjs';
import { CONFIG_DIR } from '../name.mjs';

/**
 * Every advice report carries its row's accept bar (ADR-076: a metric is a measurement or
 * it is not claimed).
 */
export const METRIC_NOTE =
  'advice is advisory until a held-out bench shows >= 25% cost cut at delta R >= -2 (plan 0003 R40)';

const TIERS = ['small', 'default', 'frontier'];

/**
 * The ladder can specialize beyond kind only while there is still evidence to stand on:
 * below this many same-kind tasks the kind is the whole neighborhood, and a narrower
 * window makes evidence worse, not "more similar".
 */
const NARROW_MIN_POOL = 6;

/** The narrowed window needs at least these resolved runs or it is not evidence either. */
const NARROW_MIN_RESOLVED = 3;

/** A file window is a step from the estimate in either direction — a factor of two in size. */
const WINDOW_HALF = 2;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Tier for a rank in the cheapest-first ladder: thirds, not absolute cost — an estate's
 * "frontier" relative to its own history means more than a number the code guessed.
 * The cheapest of two observed classes is 'small' and the dearer one 'default'; a class
 * is 'frontier' only once a ladder has three steps, because a two-step ladder cannot
 * name a top third honestly.
 */
export function tierOfRank(rank, count) {
  if (count < 3) return rank === 0 ? TIERS[0] : TIERS[1];
  if (rank * 3 < count) return TIERS[0];
  if (rank * 3 >= count * 2) return TIERS[2];
  return TIERS[1];
}

/**
 * Total tokens a usage report carries — the measure that exists even with no prices file.
 */
function tokensOf(usage = {}) {
  const num = (v) => Number(v ?? 0);
  return num(usage.input) + num(usage.cacheWrite ?? usage.cache_write) + num(usage.cacheRead ?? usage.cache_read) + num(usage.output);
}

/**
 * Load bench history as advice-ready run rows.
 *
 * A descriptor missing for a run leaves the row with `kind: null`; such a run can join no
 * neighborhood, which is the honest answer — a task whose prompt was never mined is a
 * task whose kind would be a guess.
 */
export async function loadHistory(root) {
  const [records, prices, tasks] = await Promise.all([
    loadRunRecords(root),
    // An unreadable prices file would throw out of a brief, whose callers only asked for
    // a packet; the bench has its own report for surfacing a broken prices file loudly.
    loadPrices(root).catch(() => null),
    loadTasks(root),
  ]);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const runs = records.map((record) => {
    const descriptor = byId.get(record.task) ?? null;
    return {
      task: record.task,
      model: record.model,
      resolved: isRunResolved(record),
      cost: computeRunCost(record, prices).usd,
      tokens: tokensOf(record.usage),
      toolCalls: Number(record?.usage?.toolCalls ?? record?.usage?.tool_calls ?? 0),
      files: Number(descriptor?.gold?.files ?? record?.diff?.files ?? 0),
      kind: descriptor ? classifyTask(descriptor.prompt ?? '', { paths: [] }).kind : null,
    };
  });
  return { runs };
}

/**
 * Advise from bench history for one task's features.
 *
 * @param {{kind: string, files: number}} features the task kind, and the estimate of how
 *   many files it will touch (the brief's scope size; a history run carries the mined
 *   task's gold stat in the same role)
 * @param {{runs: object[]}} history rows from loadHistory
 * @returns null when the history holds no runs; otherwise `{ picked, caution }` where
 *   `picked` is `{ line, basis, metric }` when a tier was named (and `caution` null), and
 *   `caution` explains the missing neighborhood when no tier can honestly be named
 */
export function advise(features, history) {
  const runs = history?.runs ?? [];
  if (runs.length === 0) return null;
  const kind = features.kind;
  const sameKind = runs.filter((run) => run.kind === kind);
  const taskCount = new Set(sameKind.map((run) => run.task)).size;
  if (sameKind.length === 0) {
    return {
      picked: null,
      caution: `bench history holds no ${kind} task, so no cheap tier was advised`,
    };
  }

  // The measure is chosen once, across all resolved history: a ladder built on dollars
  // while the pick ran on tokens would compare a number with a different number's name.
  const measure = runs.some((run) => run.resolved && run.cost > 0) ? 'cost' : 'tokens';

  // Kind decides the neighborhood. The file window only specializes a neighborhood that
  // has already got evidence to spare (NARROW_MIN_*): a factor-of-two window around the
  // estimate refines "bugfix" to "small bugfix" when the kind has runs to lend, and says
  // nothing when it has not.
  let pool = sameKind;
  if (features.files > 0 && sameKind.length >= NARROW_MIN_POOL) {
    const near = sameKind.filter(
      (run) =>
        run.files > 0 &&
        run.files >= Math.ceil(features.files / WINDOW_HALF) &&
        run.files <= features.files * WINDOW_HALF,
    );
    if (near.filter((run) => run.resolved).length >= NARROW_MIN_RESOLVED) pool = near;
  }
  const poolTaskCount = new Set(pool.map((run) => run.task)).size;

  // The ladder orders every model class the estate ever ran, cheapest first, so the
  // advice can say where its pick sits in the estate's whole history. Uncost evidence is
  // still cost position: a class that never resolved one of these tasks occupies a rung
  // in the price ladder, and the resolved floor below — not the ladder — decides whether
  // the pick is allowed to stand on it.
  const ladderValues = new Map();
  for (const run of runs) {
    const v = measure === 'cost' ? run.cost : run.tokens;
    if (v === null) continue; // an un-costed run cannot ground a cost floor
    const values = ladderValues.get(run.model) ?? [];
    values.push(v);
    ladderValues.set(run.model, values);
  }
  const ladderNames = [...ladderValues.keys()].sort(
    (a, b) => median(ladderValues.get(a)) - median(ladderValues.get(b)) || a.localeCompare(b),
  );

  const resolvedByModel = new Map();
  for (const run of pool) {
    if (!run.resolved) continue;
    const v = measure === 'cost' ? run.cost : run.tokens;
    if (v === null) continue;
    const values = resolvedByModel.get(run.model) ?? [];
    values.push(v);
    resolvedByModel.set(run.model, values);
  }

  // "Resolved similar tasks" is a floor, not a style: a class that never resolved one of
  // these tasks is cheaper because it failed for less money.
  const qualifying = ladderNames.filter((model) => resolvedByModel.has(model));
  if (qualifying.length === 0) {
    return {
      picked: null,
      caution: `no model resolved any of the ${taskCount} ${kind} task${taskCount === 1 ? '' : 's'} in bench history, so no cheap tier was advised`,
    };
  }

  // Ties break on the model name, so the same history always yields the same pick (P4).
  const cheapest = [...qualifying].sort(
    (a, b) => median(resolvedByModel.get(a)) - median(resolvedByModel.get(b)) || a.localeCompare(b),
  )[0];
  const ladderRank = ladderNames.indexOf(cheapest);
  const tier = tierOfRank(ladderRank, ladderNames.length);

  // Effort advice is relative to the estate too: heavier turns of tool use than the
  // estate's own resolved median is what "plan first" means here.
  const resolvedRuns = runs.filter((run) => run.resolved);
  const estateToolCalls = median(resolvedRuns.map((run) => run.toolCalls));
  const resolvedRunsOfCheapest = pool.filter((run) => run.resolved && run.model === cheapest);
  const pickToolCalls = median(resolvedRunsOfCheapest.map((run) => run.toolCalls));
  const effort = estateToolCalls > 0 && pickToolCalls > estateToolCalls ? 'plan first' : 'no plan mode';

  const pickMedian = median(resolvedByModel.get(cheapest));
  const pickUnit = measure === 'cost' ? `cost $${pickMedian.toFixed(4)}` : `tokens ${Math.round(pickMedian)}`;

  return {
    picked: {
      line: `${tier} model, ${effort}`,
      basis: `from ${poolTaskCount} ${kind} task${poolTaskCount === 1 ? '' : 's'} in bench history; cheapest that resolved: ${cheapest} (median ${pickUnit}); a human picks the model, this only ranks classes`,
      metric: METRIC_NOTE,
    },
    caution: null,
  };
}

/**
 * The brief's door into advice (plan 0003 R40): history on disk in, advice out, or null
 * when the history has no runs at all — a brief in a repository without bench history
 * carries every other section and no made-up opinion about models.
 *
 * `kind` comes in already classified when the caller is the brief itself, so the packet
 * never carries two opinions about one task.
 */
export async function briefAdvice(root, { task = '', scope = [], kind = null } = {}) {
  const history = await loadHistory(root);
  if (history.runs.length === 0) return null;
  const known = kind ?? classifyTask(task, { paths: scope }).kind;
  return advise({ kind: known, files: scope.length }, history);
}
