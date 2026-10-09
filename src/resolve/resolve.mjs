// Skill resolution: turn a repo and a task into a ranked, explained selection.
//
// Deterministic by construction (plan 0002 principle 1). No embeddings, no model
// call, no network: the same repo plus the same task always yields the same
// answer in the same order. A rules system whose behaviour changes when the model
// changes is not a rules system.
//
// Every selection carries the signal that produced it, so `skills why` is a
// formatting concern rather than a re-derivation.

import { STACK_TAGS } from './fingerprint.mjs';

/** Signal weights. Deliberately few, so the ranking is explainable. */
const W = {
  path: 100, // the diff touches a path the skill claims
  keyword: 40, // the task names a keyword the skill claims
  capability: 25, // the task maps to a capability the skill covers
  stack: 15, // the repo's stack matches (already required to survive the gate)
  name: 30, // the task names the skill itself
  summary: 8, // weak: a word shared with the summary
};

/**
 * The least score that may select a skill. Set to `capability` on purpose: below that,
 * the only signals available are `summary` at 8 and `stack` at 15, and neither is
 * evidence that the skill is about the task. Compatibility is a precondition - the gate
 * already ran - so a score made only of compatibility is not a weak match, it is no
 * match, and reporting it as one fills the budget with bodies nobody asked for.
 */
export const MIN_SCORE = W.capability;

/**
 * English function words, which appear in every summary this registry has and identify
 * none of them.
 *
 * Applied to the summary signal ONLY. A keyword is an explicit declaration and a name is
 * an identity, so suppressing those would hide something a person wrote on purpose;
 * a summary is prose, and prose is full of words that are there for grammar. Measured:
 * the task "fix a typo in the README" selected four skills on `summary:the` and
 * `summary:in` alone. Hand-authored rather than derived, for the same reason the
 * capability aliases are: a resolver nobody can review is not a resolver.
 */
const STOPWORDS = new Set([
  'about', 'after', 'all', 'also', 'and', 'an', 'any', 'are', 'as', 'at', 'be', 'because',
  'been', 'before', 'being', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'each',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'his', 'how', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'like', 'make', 'many', 'may', 'me', 'more', 'most', 'must', 'my',
  'no', 'not', 'now', 'of', 'off', 'on', 'one', 'only', 'onto', 'or', 'other', 'our', 'out',
  'over', 'own', 'per', 'same', 'see', 'set', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too',
  'two', 'under', 'up', 'us', 'use', 'used', 'using', 'very', 'was', 'way', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'within', 'without', 'would',
  'you', 'your',
]);

/**
 * Split a task string into comparable tokens.
 *
 * Length 2 is kept. The floor used to be 3, and it dropped the most specific words in
 * this domain: `d1`, `r2`, `kv`, `ci` are two-letter vocabulary, not noise, and a task
 * saying "fix d1 migration" lost the one word that identified the change. The cost is
 * that six stopwords of two letters (`in on of or an so`) now reach the summary signal,
 * which is S04's finding and not something this change can resolve on its own - the
 * remedy there is a stopword list, not a longer minimum.
 */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Whether `phrase` occurs in `tokens` as consecutive words.
 *
 * Keywords are compared one token at a time, so a multi-word keyword could never
 * match: "durable object" tokenizes to two tokens, and neither is equal to the keyword
 * as declared, so the declared keyword was unreachable however the task was phrased.
 * 13 of the registry's 232 unique keywords were dead that way, including one declared
 * on four separate skills. Matching as a phrase keeps them checkable and keeps
 * determinism - there is no model and no similarity, only adjacency.
 */
function hasPhrase(tokens, phrase) {
  if (phrase.length === 0) return false;
  if (phrase.length === 1) return tokens.includes(phrase[0]);
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    if (phrase.every((word, j) => tokens[i + j] === word)) return true;
  }
  return false;
}

/**
 * Capability aliases: the words a task uses that mean a capability id.
 * Hand-authored rather than inferred, for the same reason the rest of the
 * resolver is hand-authored - it must be reviewable and stable.
 */
const CAPABILITY_ALIASES = {
  test: ['test', 'tests', 'testing', 'coverage', 'regression', 'e2e'],
  commit: ['commit', 'commitment', 'commitments', 'committing'],
  security: ['security', 'secure', 'auth', 'authentication', 'idor', 'injection', 'csp', 'cors', 'secret', 'secrets'],
  accessibility: ['accessibility', 'a11y', 'wcag', 'screenreader', 'keyboard', 'rtl', 'aria'],
  maps: ['map', 'maps', 'pmtiles', 'maplibre', 'gazetteer', 'atlas', 'country', 'countries', 'galaxy'],
  contract: ['contract', 'openapi', 'schema', 'schemaalignment', 'api'],
  persistence: ['migration', 'migrations', 'database', 'd1', 'room', 'sql', 'schema'],
  build: ['build', 'gradle', 'compile', 'bundle'],
  release: ['release', 'deploy', 'deployment', 'publish', 'ship'],
  observability: ['observability', 'logs', 'logging', 'metrics', 'traces', 'slo', 'alerting'],
  platform: ['wrangler', 'worker', 'workers', 'durable', 'queue', 'r2', 'kv', 'cloudflare'],
  scaffold: ['scaffold', 'module', 'newfeature', 'scaffolding'],
  'feature-slice': ['route', 'endpoint', 'slice', 'feature'],
  seeding: ['seed', 'seeding', 'fixture', 'demo', 'data'],
  orchestration: ['orchestrate', 'coordinate', 'parallel', 'team', 'agents'],
  documentation: ['documentation', 'docs', 'documenting'],
  content: ['post', 'blog', 'article', 'content'],
  positioning: ['press', 'marketing', 'presskit'],
  wear: ['wear', 'watch', 'wearos', 'horologist'],
  'ui-design': ['ui', 'design', 'mockup', 'styling', 'visual'],
  quality: ['quality', 'review', 'audit'],
  auth: ['auth', 'authentication', 'login', 'signup', 'firebase', 'token'],
  knowledge: ['graph', 'graphify', 'knowledge'],
};

/**
 * @param {object} skill      a registry node
 * @param {object} context    { repoStack: string[], taskTokens: string[], paths: string[] }
 * @returns {{score: number, reasons: string[]}} score 0 means "not applicable"
 */
export function scoreSkill(skill, context) {
  const { repoStack = [], taskTokens = [], paths = [] } = context;
  const repo = new Set(repoStack);
  const reasons = [];
  let evidence = 0;

  // --- path signal: strongest, because the diff is ground truth ----------------
  for (const glob of skill.paths ?? []) {
    if (paths.some((p) => matchesGlob(p, glob))) {
      evidence += W.path;
      reasons.push(`path:${glob}`);
      break;
    }
  }

  // --- capability signal ------------------------------------------------------
  const wanted = new Set();
  for (const cap of skill.capabilities ?? []) {
    for (const alias of CAPABILITY_ALIASES[cap] ?? [cap]) {
      if (taskTokens.includes(alias)) wanted.add(cap);
    }
  }
  for (const cap of skill.capabilities ?? []) {
    if (wanted.has(cap)) {
      evidence += W.capability;
      reasons.push(`capability:${cap}`);
    }
  }

  // --- keyword signal ---------------------------------------------------------
  // A declared keyword is matched as a phrase, so the reason quotes the declaration
  // rather than a token of it: `keyword:durable object` is what a reader can check
  // against the registry, and `keyword:durable` would be a keyword nobody declared.
  const keywords = skill.keywords ?? [];
  const summaryWords = new Set(tokenize(skill.summary));
  const nameWords = new Set(tokenize(skill.name));
  for (const keyword of keywords) {
    if (hasPhrase(taskTokens, tokenize(keyword))) {
      evidence += W.keyword;
      reasons.push(`keyword:${keyword}`);
    }
  }
  for (const token of taskTokens) {
    if (nameWords.has(token)) {
      evidence += W.name;
      reasons.push(`name:${token}`);
    } else if (summaryWords.has(token) && !STOPWORDS.has(token)) {
      evidence += W.summary;
      reasons.push(`summary:${token}`);
    }
  }

  // --- stack signal -----------------------------------------------------------
  const overlap = (skill.stack ?? []).filter((tag) => repo.has(tag));
  const stackScore = overlap.length > 0 ? W.stack * Math.min(overlap.length, 3) : 0;
  if (stackScore > 0) reasons.push(`stack:${overlap.join('+')}`);

  // `evidence` is the score without the stack contribution. Carrying both is what lets
  // the selection rule exclude stack from its own threshold: with two overlapping tags,
  // stack alone is 30, which clears a threshold of 25 on a skill the task never named.
  return { score: evidence + stackScore, evidence, reasons };
}

/**
 * Hard gate: a skill whose tags the repo does not have cannot be selected,
 * unless it was forced. This is what stops the Cloudflare reference from being
 * offered to a Kotlin repo, and it is why `d1` lives in keywords rather than
 * stack - a tag fingerprint() cannot emit would gate on nothing.
 *
 * `repoSignals` is stack ∪ facts, so a skill may declare a platform tag or an
 * observable fact and be gated correctly either way (ADR-013).
 */
export function stackCompatible(skill, repoSignals) {
  if (repoSignals.length === 0) return true; // unknown repo: do not exclude
  const repo = new Set(repoSignals);
  return (skill.stack ?? []).some((tag) => repo.has(tag));
}

/**
 * A short, human-readable reason for excluding a skill. The NOT SELECTED block is
 * only useful if the agent can see *why* - "not in repo" is unactionable when the
 * agent knows it is standing in that repo, so name the overlapping tag when there
 * is one and say plainly when there is not.
 */
export function stackReason(skill, repoSignals) {
  if (repoSignals.length === 0) return 'repo signals undetected, not excluded';
  const repo = new Set(repoSignals);
  const overlap = (skill.stack ?? []).filter((tag) => repo.has(tag));
  if (overlap.length > 0) return `signal overlap ${overlap.join('+')}`;
  return `needs one of ${(skill.stack ?? []).slice(0, 3).join('|')}, repo is ${repoSignals.slice(0, 3).join('|')}`;
}

// Bounded by the registry's distinct globs, because the only caller of matchesGlob
// passes `skill.paths`. Compiling per call was the old behaviour and cost one RegExp
// construction per path per glob per skill.
const globCache = new Map();

function translateSegment(segment) {
  // `?` is escaped rather than read as a single-character wildcard: nothing in the
  // registry uses it, and reading it as a quantifier made `a?.ts` match `.ts`. A glob
  // the matcher cannot honour now fails `syntheticPathFor` below instead of silently
  // matching the wrong paths.
  return segment.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*');
}

/**
 * Translate a glob segment by segment: a leading star-star is any number of leading
 * directories, a middle one is any number of middle ones, a trailing one is anything
 * beneath, and a bare one is everything. (Written without the literal glob, because
 * its slash closes the comment that is describing it.)
 *
 * This used to rewrite only a TRAILING star-star, so a glob that started with one
 * compiled to an anchored pattern beginning `**` - an invalid regex, swallowed by a
 * `catch` that returned `false`. 13 of the registry's 65 globs start that way, and
 * path is the strongest signal the resolver has (weight 100), so those skills could
 * never be selected by a diff.
 */
export function compileGlob(glob) {
  const cached = globCache.get(glob);
  if (cached) return cached;

  const segments = glob.split('/');
  let pattern = '';
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1;
    if (segment !== '**') {
      if (i > 0 && segments[i - 1] !== '**') pattern += '/';
      pattern += translateSegment(segment);
      continue;
    }
    // A `**` owns the separators on both sides of itself, so the next segment must
    // not add one: that is why the `segments[i - 1] !== '**'` test above exists.
    pattern += i === 0 ? (last ? '.*' : '(?:.*/)?') : last ? '(?:/.*)?' : '(?:.*/)?';
  }

  const regex = new RegExp(`^${pattern}$`);
  globCache.set(glob, regex);
  return regex;
}

/** Minimal glob matcher: `**` any depth, `*` any run within one segment. */
export function matchesGlob(filePath, glob) {
  return compileGlob(glob).test(filePath);
}

/**
 * The paths a glob is required to match, built from the glob itself.
 *
 * The registry is hand-authored, so a glob nobody ever compiled is a glob that can
 * never select anything, and it is invisible: `graph lint` reported the registry
 * clean while 13 of its globs matched nothing. A declared glob has to be shown the
 * paths it claims to cover. A star-star is expanded once in each of its two shapes,
 * because a glob only ever checked against the empty expansion is the exact defect
 * this exists for.
 */
export function syntheticPathFor(glob) {
  const join = (parts) => parts.filter(Boolean).join('/');
  const paths = [''];
  for (const segment of glob.split('/')) {
    const next = [];
    for (const prefix of paths) {
      if (segment === '**') {
        // Empty segments are dropped rather than joined, so a glob whose star-star
        // sits at either end yields `migrations` and not `migrations/` - a path that
        // would match only by accident, through the same optional group the real one
        // uses.
        next.push(join([prefix]), join([prefix, 'deep/nested']));
      } else {
        next.push(join([prefix, segment.replace(/\*/g, 'sample').replace(/\?/g, 'q')]));
      }
    }
    paths.length = 0;
    paths.push(...next);
  }
  return paths.filter((p) => p !== '');
}

/**
 * Whether a score may select, or the reason it may not.
 *
 * One place, because three commands answer this question and the S10 contract table
 * cannot assert a rule that three files each hold a copy of. `null` means select.
 *
 * Both halves are needed and neither is sufficient alone. `stack` is 15 per tag, so a
 * repo matching three of a skill's tags scores 45 with nothing said about the task -
 * a score threshold alone does not exclude it. Conversely the two-letter tokens S03
 * restored put stopwords into the summary signal, and a substance rule alone would let
 * `summary:the` through. Stack is a precondition, not evidence: the gate has already
 * asked it, and asking twice is how "compatible" came to mean "relevant".
 */
export function selectionVerdict(evidence, reasons) {
  if (reasons.length === 0) return 'no matching signal';
  const nonStack = reasons.filter((r) => !r.startsWith('stack:'));
  if (nonStack.length === 0) {
    return 'matches this repo by stack alone, which is compatibility, not evidence about the task';
  }
  if (evidence < MIN_SCORE) {
    return `only ${nonStack.join(' ')}, which scores ${evidence}; ${MIN_SCORE} is the least score that selects`;
  }
  return null;
}

/**
 * Rank skills for a task. Returns only skills that scored above zero or were
 * forced, sorted by score then name so the order is total and stable.
 *
 * @returns {{selected: object[], excluded: object[]}}
 */
export function rankSkills(skills, context, { forced = [] } = {}) {
  const forcedSet = new Set(forced);
  const byName = new Map(skills.map((s) => [s.name, s]));
  const selected = [];
  const excluded = [];

  for (const skill of skills) {
    const isForced = forcedSet.has(skill.name);
    if (!isForced && !stackCompatible(skill, context.repoStack ?? [])) {
      excluded.push({ skill, reason: stackReason(skill, context.repoStack) });
      continue;
    }
    const { score, evidence, reasons } = scoreSkill(skill, context);
    if (isForced) {
      selected.push({ skill, score: Infinity, reasons: ['forced'] });
      continue;
    }
    const verdict = selectionVerdict(evidence, reasons);
    if (verdict !== null) {
      excluded.push({ skill, reason: verdict });
      continue;
    }
    selected.push({ skill, score, reasons });
  }

  selected.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  excluded.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
  return { selected, excluded };
}

/**
 * What actually gets inlined, given a budget.
 *
 * Exists because the arithmetic was written twice — once in `skills brief`, once in the
 * MCP tool — and the two copies had already drifted, which is ADR-035's shape one level
 * down: a promise about a *set* of readers holds only while something checks the set, and
 * here the set was two loops that each read `entry.via.size > 0` and meant something
 * slightly different by it.
 *
 * Three rules, each of which was previously implicit or wrong:
 *
 * 1. **Dependencies are counted against the budget.** The old loops let any dependency in
 *    regardless of size, on the reasoning that "a skill that is useless without its
 *    dependency is worse than a large context, because it silently misleads". That
 *    reasoning is right about *silently misleading* and wrong about the conclusion: the
 *    fix for a missing dependency is a line in the output, not an unbounded budget. For
 *    `--skill parallel-feature-team --budget 2000` the old arithmetic resolved 13,503
 *    bytes of skills against a 2,000-byte budget — 6.7× over, with no note.
 * 2. **A group that does not fit is deferred together.** An entry that is a dependency
 *    (`via` is non-empty) takes its parent with it: showing the parent without the thing
 *    it requires is the misleading state rule 1 was written to avoid, and it is now
 *    avoided by dropping the parent rather than by ignoring the budget.
 * 3. **A body that is too large to inline is a different thing.** `deferred` is derived
 *    from `deferredThreshold`, not from the budget, and it means "fetch this with
 *    `skills show`". It does not propagate: `--all` means take everything, and the
 *    pointer to a deferred dependency is exactly what a pointer is for. Only *budget*
 *    pressure moves a parent.
 *
 * @param {{skill: {name: string, bytes: number, deferred?: boolean}, via: Set<string>}[]} entries
 *   the closure, in selection order, parents before their dependencies
 * @param {{budget: number, all?: boolean}} opts
 * @returns {{picked: object[], deferred: object[], used: number}}
 */
export function selectWithinBudget(entries, { budget, all = false }) {
  // 'in' | 'out-budget' | 'out-large'. The distinction is rule 3 and it is the reason
  // this is not one boolean.
  const verdict = new Map();
  for (const e of entries) {
    if (e.skill.deferred) verdict.set(e.skill.name, 'out-large');
    else if (all) verdict.set(e.skill.name, 'in');
  }

  // The byte total is accumulated in order, so the budget is spent by score — the same
  // order the resolver produced, and the reason a later skill cannot take the bytes of an
  // earlier one. `out-large` is left alone: it is not a budget question.
  if (!all) {
    let used = 0;
    for (const e of entries) {
      if (verdict.get(e.skill.name) === 'out-large') continue;
      if (used + e.skill.bytes <= budget) {
        verdict.set(e.skill.name, 'in');
        used += e.skill.bytes;
      } else {
        verdict.set(e.skill.name, 'out-budget');
      }
    }
  }

  // Rule 2, to a fixpoint: a parent whose dependency did not fit is out too, and that can
  // itself be a dependency of something further up.
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of entries) {
      if (verdict.get(e.skill.name) !== 'out-budget') continue;
      for (const parent of e.via) {
        if (verdict.get(parent) === 'in') {
          verdict.set(parent, 'out-budget');
          changed = true;
        }
      }
    }
  }

  const picked = [];
  const deferred = [];
  let used = 0;
  for (const e of entries) {
    if (verdict.get(e.skill.name) === 'in') {
      picked.push(e);
      used += e.skill.bytes;
    } else {
      deferred.push(e);
    }
  }
  return { picked, deferred, used };
}

/** Expand a selection to its `requires` closure, always including hard deps. */
export function closure(selected, skills) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const out = new Map();
  const walk = (entry, via) => {
    const existing = out.get(entry.skill.name);
    if (existing) {
      if (via) existing.via.add(via);
      return;
    }
    out.set(entry.skill.name, { skill: entry.skill, score: entry.score, reasons: new Set(entry.reasons), via: new Set(via ? [via] : []) });
    for (const dep of entry.skill.requires ?? []) {
      const target = byName.get(dep);
      if (target) walk({ skill: target, score: 0, reasons: [] }, entry.skill.name);
    }
  };
  for (const entry of selected) walk(entry, null);
  return [...out.values()];
}

/** Resolve an alias chain to its canonical target. */
export function resolveAlias(name, skills) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  let current = byName.get(name);
  const seen = new Set();
  while (current?.aliasOf) {
    if (seen.has(current.name)) break;
    seen.add(current.name);
    const next = byName.get(current.aliasOf);
    if (!next) break;
    current = next;
  }
  return current ?? byName.get(name);
}

export { STACK_TAGS };