// Gold-corpus evaluation: run each case through the resolver and score it.
//
// Plan 0002 section 9: "A resolver that is not measured is a resolver that is merely
// felt." The corpus (test/fixtures/eval-corpus.json) states, for real repository signals
// and tasks, which skills must come back and which must not. Two callers must never
// disagree about the score - `simt skills eval` reports it to a reader, and
// test/eval.test.mjs asserts it in CI - so the arithmetic lives here once (ADR-002).

import { rankSkills, tokenize } from './resolve.mjs';

/** The skill names the resolver selects for one case's declared signals and task. */
function selectForCase(registry, c) {
  const context = {
    repoStack: c.repo?.stack ?? [],
    paths: c.repo?.paths ?? [],
    taskTokens: tokenize(c.task ?? ''),
  };
  const { selected } = rankSkills(registry.skills, context);
  return selected.map((e) => e.skill.name);
}

/** Skill names the corpus cites that the registry does not declare. */
export function unknownSkills(registry, corpus) {
  const names = new Set(registry.skills.map((s) => s.name));
  return [
    ...new Set(
      corpus.cases.flatMap((c) => [...(c.select ?? []), ...(c.reject ?? [])]).filter((n) => !names.has(n)),
    ),
  ];
}

/**
 * Score the whole corpus: per-case detail plus precision and recall.
 *
 * `unexpected` is the half of precision that named negatives cannot see: a case whose
 * truth is "nothing" names only a sample of what must not come back, so for those the
 * whole selected set is the miss. `clean` is what the exit code rests on; the two
 * ratios are measurements, and a case can break `clean` while both still read 1.0 -
 * the first version of this arithmetic scored that case a perfect precision (S19).
 */
export function scoreCorpus(registry, corpus) {
  let expected = 0;
  let negatives = 0;
  const cases = corpus.cases.map((c) => {
    expected += c.select?.length ?? 0;
    negatives += c.reject?.length ?? 0;
    const got = new Set(selectForCase(registry, c));
    const missing = (c.select ?? []).filter((n) => !got.has(n));
    const wronglySelected = (c.reject ?? []).filter((n) => got.has(n));
    return {
      name: c.name,
      selected: [...got],
      missing,
      wronglySelected,
      unexpected: c.select?.length === 0 ? [...got] : wronglySelected,
    };
  });
  const missed = cases.reduce((n, c) => n + c.missing.length, 0);
  const wrong = cases.reduce((n, c) => n + c.wronglySelected.length, 0);
  const recall = expected === 0 ? 1 : (expected - missed) / expected;
  const precision = negatives === 0 ? 1 : (negatives - wrong) / negatives;
  const clean = missed === 0 && cases.every((c) => c.unexpected.length === 0);
  return { cases, expected, missed, negatives, wrong, recall, precision, clean };
}
