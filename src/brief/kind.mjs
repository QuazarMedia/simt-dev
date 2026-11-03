// What a task is, and which part of the command card that kind needs.
//
// A classification nobody can audit is an opinion. Every branch below names the pattern
// it matched and the field it matched in, and `--explain` prints exactly that, so "why is
// this a bugfix" has an answer that is a string rather than a shrug.
//
// Nothing here reads a clock, the environment or the network. The same task text and the
// same paths give the same kind on every machine, which is the first property the packet
// needs: byte-stable input, byte-stable output.
//
// `classifyIntent` is the v2 reading of the same question, and it returns a vector rather
// than a label. "Fix the docs" is one task with two true descriptions, and "document the
// mutation" is a third: it needs the state observed and does not need it changed. A single
// label forces a choice between them, and the choice is invisible to the reader. `kind`
// stays exactly as it was beside the vector, because a client that reads one label must
// keep working when the tool learns to read several.

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

/** The v2 intent vector's schema version. A caller that knows v1 keeps reading `kind`. */
export const INTENT_VERSION = 2;

/** The intents a task can carry at once. Nothing here is a stack name. */
export const INTENTS = Object.freeze(['research', 'generate', 'validate', 'operate', 'change-code']);

/**
 * What a routed task obliges, in the order a report should read them.
 *
 * `effect:authorize` is a requirement to obtain a grant, never a grant. Nothing in this
 * module can produce a permission, which is why the list contains no field that says an
 * effect is allowed.
 */
export const OBLIGATIONS = Object.freeze([
  'intent:discover',
  'sources:read',
  'artifact:validate',
  'artifact:regenerate',
  'state:observe',
  'effect:authorize',
  'code:test',
]);

/** Executable extensions, for the path evidence a task carries with it. */
const CODE_EXT = new Set(['mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'py', 'kt', 'kts', 'java', 'rb', 'go', 'rs', 'sh']);

/** A generator produces an artifact, so its change invalidates that artifact too. */
const GENERATOR_NAME = /(^|[-_.])(?:generate|generator|render|build|export)([-_.]|$)/i;

/** Evidence is bounded so a long path list cannot flood a packet or a report. */
const MAX_EVIDENCE = 8;

/**
 * The task terms each intent listens for. Order is the table's order, not a priority: a
 * rule that matches adds its weight, and a rule that does not adds nothing.
 *
 * The two operation rules are the distinction the slice exists for. `operate-describe`
 * matches a task that talks about an operation and requires its state to be observed;
 * `operate-execute` matches a verb that would change it and adds the requirement to obtain
 * authorization. "Document the mutation" matches the first and not the second, because
 * `document` is not in the execute list.
 */
const RULES = [
  {
    id: 'research-terms',
    intent: 'research',
    weight: 1,
    pattern: /\b(?:research|investigate|compare|survey|gather|find out|look up)\b/i,
    obligations: ['sources:read'],
  },
  {
    id: 'generate-terms',
    intent: 'generate',
    weight: 1,
    pattern: /\b(?:regenerate|generate|draft|render|produce|publish|write up)\b/i,
    obligations: ['artifact:validate'],
  },
  {
    id: 'document-verb',
    intent: 'generate',
    weight: 1,
    pattern: /\b(?:document|documenting)\b/i,
    obligations: ['artifact:validate'],
  },
  {
    id: 'correct-document',
    intent: 'generate',
    weight: 1,
    pattern: /\b(?:fix|correct|revise|amend|update)\b[^.!?]*\b(?:docs?|documentation|readme|figures?|typos?|wording|prose|chapters?|reports?|rates?)\b/i,
    obligations: ['artifact:validate'],
  },
  {
    id: 'validate-terms',
    intent: 'validate',
    weight: 1,
    pattern: /\b(?:validate|verify|check|audit|review)\b/i,
    obligations: ['artifact:validate'],
  },
  {
    id: 'operate-describe',
    intent: 'operate',
    weight: 1,
    pattern: /\b(?:document|documenting|describe|explain|inspect|show|read)\b[^.!?]*\b(?:mutations?|operations?|recipes?|endpoints?|objects?|targets?)\b/i,
    obligations: ['state:observe'],
  },
  {
    id: 'operate-execute',
    intent: 'operate',
    weight: 1,
    pattern: /\b(?:apply|create|delete|deploy|provision|execute|invoke|mutate|run)\b[^.!?]*\b(?:mutations?|operations?|recipes?|endpoints?|objects?|targets?|migrations?)\b/i,
    obligations: ['state:observe', 'effect:authorize'],
  },
  {
    id: 'change-code-terms',
    intent: 'change-code',
    weight: 1,
    pattern: /\b(?:implement|refactor|rename|extract|deduplicate|add a test|unit test)\b/i,
    obligations: ['code:test'],
  },
];

const isText = (value) => typeof value === 'string' && value.length > 0;

/** A bounded, sorted copy of a caller's list: the same input gives the same evidence order. */
function bounded(list) {
  return (Array.isArray(list) ? list.filter(isText) : []).sort().slice(0, MAX_EVIDENCE);
}

function scoreboard() {
  const entries = new Map(INTENTS.map((intent) => [intent, { intent, score: 0, evidence: [] }]));
  const required = new Set();
  return {
    add(intent, weight, basis, obligations = []) {
      const entry = entries.get(intent);
      entry.score += weight;
      entry.evidence.push(basis);
      for (const obligation of obligations) required.add(obligation);
    },
    intents() {
      return [...entries.values()].filter((entry) => entry.score > 0);
    },
    obligations() {
      return OBLIGATIONS.filter((obligation) => required.has(obligation));
    },
  };
}

function extensionOf(path) {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Route a task to the intents it carries, with the evidence for each and what it obliges.
 *
 * @param {string} task
 * @param {{paths?: string[], artifactIds?: string[], operationIds?: string[], override?: string|null}} [options]
 * @returns {{version: number, kind: string, basis: string, intents: {intent: string, score: number, evidence: string[]}[], leaders: string[], ambiguous: boolean, unknown: boolean, obligations: string[], reasons: string[]}}
 */
export function classifyIntent(task, { paths = [], artifactIds = [], operationIds = [], override = null } = {}) {
  if (override !== null && !INTENTS.includes(override)) {
    throw new Error(`override must be one of ${INTENTS.join(', ')}, not ${JSON.stringify(override)}`);
  }
  const text = String(task ?? '');
  const legacy = classifyTask(text, { paths });
  const board = scoreboard();

  for (const rule of RULES) {
    if (rule.pattern.test(text)) board.add(rule.intent, rule.weight, `the task matches ${rule.pattern}`, rule.obligations);
  }

  for (const path of bounded(paths)) {
    if (isDocPath(path)) {
      board.add('generate', 1, `path ${path} is documentation`, ['artifact:validate']);
    } else if (CODE_EXT.has(extensionOf(path))) {
      board.add('change-code', 1, `path ${path} is executable`, ['code:test']);
      // A generator is source that produces an artifact: changing it is a code change and
      // an invalidation of what it generated, which is a different pair of checks from
      // editing the artifact by hand.
      if (GENERATOR_NAME.test(path.split('/').pop() ?? path)) {
        board.add('generate', 1, `path ${path} generates an artifact`, ['artifact:regenerate']);
      }
    }
  }

  // A declared id outranks a guessed term, because the repository said it. Naming an
  // artifact does not say whether it is written or checked; naming an operation does not
  // say whether it is observed or performed. Only the verbs add those requirements.
  for (const id of bounded(artifactIds)) board.add('generate', 2, `artifact ${id} is declared`, ['artifact:validate']);
  for (const id of bounded(operationIds)) board.add('operate', 2, `operation ${id} is declared`, ['state:observe']);

  if (override !== null) board.add(override, 1, `the caller overrode the classification with ${override}`, []);

  const intents = board.intents().sort((a, b) => {
    if (a.intent === override) return -1;
    if (b.intent === override) return 1;
    return b.score - a.score || a.intent.localeCompare(b.intent);
  });

  const unknown = override === null && intents.length === 0;
  const leaders = unknown ? [] : override !== null ? [override] : intents.filter((entry) => entry.score === intents[0].score).map((entry) => entry.intent);
  const ambiguous = !unknown && leaders.length > 1;

  const required = new Set(board.obligations());
  if (unknown || ambiguous) required.add('intent:discover');

  const reasons = intents.flatMap((entry) => entry.evidence.map((basis) => `${entry.intent}: ${basis}`));
  if (override !== null) reasons.push(`routing: the caller's override chose ${override}, and the vector still reports the rest`);
  if (ambiguous) reasons.push(`routing: ${leaders.join(' and ')} are tied, so the task is routed to discovery rather than to one of them`);
  if (unknown) reasons.push('routing: nothing in the task or the paths chose an intent, so the task is routed to discovery');

  return {
    version: INTENT_VERSION,
    kind: legacy.kind,
    basis: legacy.basis,
    intents: intents.map((entry) => ({ ...entry })),
    leaders,
    ambiguous,
    unknown,
    obligations: OBLIGATIONS.filter((obligation) => required.has(obligation)),
    reasons,
  };
}

/**
 * Score a labelled corpus by intent.
 *
 * Precision and recall are reported per intent and then micro-averaged, and a denominator
 * of zero reports `null` rather than a perfect zero - a corpus with no `operate` example
 * proves nothing about `operate`, and a detector that never answers must not look accurate.
 * Ambiguous and unknown examples are listed by name, because a corpus that hides them reads
 * as a cleaner result than it is.
 *
 * @param {{task: string, expect: string|string[], options?: object}[]} corpus
 * @returns {{version: number, examples: number, perIntent: object[], precision: number|null, recall: number|null, ambiguous: object[], unknown: object[]}}
 */
export function evaluateIntent(corpus = []) {
  const rows = new Map(INTENTS.map((intent) => [intent, { intent, expected: 0, predicted: 0, correct: 0 }]));
  const ambiguous = [];
  const unknown = [];
  const entries = Array.isArray(corpus) ? corpus : [];

  for (const entry of entries) {
    const expected = new Set(Array.isArray(entry.expect) ? entry.expect : [entry.expect]);
    const result = classifyIntent(entry.task, entry.options ?? {});
    const predicted = new Set(result.intents.map((row) => row.intent));
    if (result.ambiguous) ambiguous.push({ task: entry.task, between: [...result.leaders] });
    if (result.unknown) unknown.push({ task: entry.task });
    for (const intent of expected) rows.get(intent).expected += 1;
    for (const intent of predicted) rows.get(intent).predicted += 1;
    for (const intent of predicted) if (expected.has(intent)) rows.get(intent).correct += 1;
  }

  const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
  const perIntent = [...rows.values()].map((row) => ({
    ...row,
    precision: ratio(row.correct, row.predicted),
    recall: ratio(row.correct, row.expected),
  }));

  return {
    version: INTENT_VERSION,
    examples: entries.length,
    perIntent,
    precision: ratio(perIntent.reduce((sum, row) => sum + row.correct, 0), perIntent.reduce((sum, row) => sum + row.predicted, 0)),
    recall: ratio(perIntent.reduce((sum, row) => sum + row.correct, 0), perIntent.reduce((sum, row) => sum + row.expected, 0)),
    ambiguous,
    unknown,
  };
}
