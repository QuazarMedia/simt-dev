// "Did you mean" resolution for an identifier an agent typed.
//
// A substring test is what most tools use, and it is weak exactly where it is
// needed: a typo in the middle of a name (`slice-commmit` for `slice-commit`)
// shares no substring with the right answer, so the tool says "no such thing"
// and the agent guesses. A bounded edit distance fixes the case that matters and
// stays deterministic, which substring-plus-first-letter heuristics do not.
//
// The bound matters. `coverage-hunt` is 4 edits from `add-country-galaxy`, and a
// suggestion that far away is noise: an agent will install the wrong skill.

/** Levenshtein distance, two-row, with an early exit once the bound is passed. */
function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let best = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    // Every remaining row can only increase the distance along this cell's best
    // path, so once the whole row exceeds the bound nothing can come back under.
    if (best > max) return max + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/**
 * Candidates worth suggesting, nearest first.
 *
 * Two directions of substring, and they are not the same claim about what was typed.
 *
 * **The candidate contains the query** — `slice-commit` for `slice-commmit` — is a
 * hit: the agent typed a prefix. It scores 1, not 0, because zero edits is what an
 * exact match means and a prefix is not one. Scoring both 0 sorted `graph` ahead of
 * `graphs` for the query `graphs`, and an agent that installs the first name in a
 * "did you mean" list installs the wrong one.
 *
 * **The candidate sits inside the query** — `coverage` for `coverage-hunt` — is a hit
 * only when it is at least half the query. Without that, the rule degenerates: `e` is
 * a substring of `test`, so `nearMatches('test', ['e'])` returned `e` at distance 0
 * and the message read `did you mean e?`.
 *
 * The bound also shrinks with the query, which is the same failure from the other side.
 * Three edits is a typo in a name; three edits to a four-character query is a
 * different string, and offering it violates the rule in the header of this file — "a
 * suggestion that far away is noise: an agent will install the wrong skill". Under
 * three characters nothing is a typo, so nothing is offered.
 */
export function nearMatches(needle, candidates, { max = 3, limit = 3 } = {}) {
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const bound = Math.max(1, Math.min(max, Math.floor(lower.length / 3)));

  const scored = [];
  for (const candidate of candidates) {
    const cl = candidate.toLowerCase();
    if (cl === lower) {
      scored.push({ candidate, distance: 0 });
    } else if (cl.includes(lower) || (lower.includes(cl) && cl.length * 2 >= lower.length)) {
      scored.push({ candidate, distance: 1 });
    } else {
      const distance = editDistance(lower, cl, bound);
      if (distance <= bound) scored.push({ candidate, distance });
    }
  }

  scored.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map((s) => s.candidate);
}