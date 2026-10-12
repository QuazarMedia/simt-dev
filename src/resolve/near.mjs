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
 * A substring hit is always included: `skill` is a real answer for a query of
 * `slice-commit`, and the distance test alone would rank it below noise.
 */
export function nearMatches(needle, candidates, { max = 3, limit = 3 } = {}) {
  if (!needle) return [];
  const lower = needle.toLowerCase();

  const scored = [];
  for (const candidate of candidates) {
    const cl = candidate.toLowerCase();
    if (cl.includes(lower) || lower.includes(cl)) {
      scored.push({ candidate, distance: 0 });
      continue;
    }
    const distance = editDistance(lower, cl, max);
    if (distance <= max) scored.push({ candidate, distance });
  }

  scored.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map((s) => s.candidate);
}