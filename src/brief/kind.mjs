// What a task is, and which part of the command card that kind needs (plan 0003 R27).
//
// A classification nobody can audit is an opinion. Every branch below names the pattern
// it matched and the field it matched in, and `--explain` prints exactly that, so "why is
// this a bugfix" has an answer that is a string rather than a shrug.
//
// Nothing here reads a clock, the environment or the network. The same task text and the
// same paths give the same kind on every machine, which is the first property the packet
// needs: byte-stable input, byte-stable output (plan 0003 P4).

/** The four kinds a brief knows. */
const KINDS = ['bugfix', 'feature', 'refactor', 'docs'];

/**
 * The default kind is the widest one, and that is deliberate.
 *
 * Guessing `feature` for a task that was really a docs change costs the reader a couple
 * of commands they did not need. Guessing `docs` for a task that was really a feature
 * costs them the build command they did need, and they have no way to notice the
 * absence — the brief looks complete either way.
 */
const DEFAULT_KIND = 'feature';

/**
 * Patterns per kind, tried in this order.
 *
 * The order is the decision. A task that says "fix the docs typo" is a bugfix, not a docs
 * change, because the first pattern that matches wins and `fix` is tried before `docs`.
 * `refactor` is tried before `docs` for the same reason: a rename is a rename even when
 * the file it moves is markdown.
 */
const HINTS = [
  [
    'bugfix',
    [
      /\bfix(?:es|ed|ing)?\b/i,
      /\bbug\b/i,
      /\bregressions?\b/i,
      /\bflaky\b/i,
      /\bcrash(?:es|ed|ing)?\b/i,
      /\bbroken\b/i,
      /\bfail(?:s|ed|ing|ure)?\b/i,
      /\bwrong\b/i,
    ],
  ],
  [
    'refactor',
    [
      /\brefactor(?:s|ed|ing)?\b/i,
      /\brename(?:s|d)?\b/i,
      /\bextract(?:s|ed|ing)?\b/i,
      /\bdeduplicat(?:e|es|ed|ion)\b/i,
      /\brewrite\b/i,
      /\bclean ?up\b/i,
      /\bmove(?:s|d)?\b/i,
      /\bsplit\b/i,
    ],
  ],
  [
    'docs',
    [
      /\bdocs?\b/i,
      /\bdocument(?:s|ed|ing|ation)?\b/i,
      /\breadme\b/i,
      /\bchangelog\b/i,
      /\btyp(?:o|os)\b/i,
      /\bcomments?\b/i,
      /\bwording\b/i,
      /\bprose\b/i,
    ],
  ],
];

/** Extensions that are prose rather than code. */
const DOC_EXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc']);

/** Files whose whole name is prose. `LICENSE` has no extension to look at. */
const DOC_NAMES = new Set(['LICENSE', 'NOTICE', 'COPYING', 'AUTHORS', 'CONTRIBUTING']);

/** Whether a path is documentation. */
function isDocPath(path) {
  const name = String(path ?? '').split('/').pop() ?? '';
  if (DOC_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && DOC_EXT.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The card verbs a kind needs, in the card's own order.
 *
 * `test` is in every list. The command card drops `format`, `typecheck`, `lint` and
 * `build` before it drops `test`, for the reason written in `kernel/card.mjs`: a card
 * that dropped the test command would have dropped the one command it exists to carry. A
 * brief inherits that ruling rather than restating it.
 *
 * A docs change is the narrowest list — there is nothing to build and nothing to
 * type-check — and it still keeps `test`, because a documentation change is not exempt
 * from the command that says the repository still works.
 */
const VERBS_FOR_KIND = {
  bugfix: ['test', 'focused', 'lint', 'format'],
  feature: ['test', 'focused', 'lint', 'format', 'typecheck', 'build'],
  refactor: ['test', 'focused', 'lint', 'format', 'typecheck'],
  docs: ['format', 'lint', 'test'],
};

/** The card verbs a kind needs. An unknown kind gets the widest list. */
export function cardVerbs(kind) {
  return VERBS_FOR_KIND[kind] ?? VERBS_FOR_KIND[DEFAULT_KIND];
}

/**
 * Classify a task.
 *
 * The evidence comes back with the kind, always. A caller that has to re-derive why a
 * task is a bugfix will disagree with this function eventually, and the disagreement
 * will be invisible — which is the failure mode a reasoning string prevents.
 */
export function classifyTask(task, { paths = [] } = {}) {
  const text = String(task ?? '');
  for (const [kind, patterns] of HINTS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return { kind, basis: `the task matches ${pattern}` };
    }
  }
  const named = paths.filter((path) => typeof path === 'string' && path.length > 0);
  if (named.length > 0 && named.every(isDocPath)) {
    return { kind: 'docs', basis: `every path named is documentation (${named.length})` };
  }
  return {
    kind: DEFAULT_KIND,
    basis: 'neither the task nor the paths chose a kind, so the widest one is the default',
  };
}
