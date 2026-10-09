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

/** Split a task string into comparable tokens. */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
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
  let score = 0;

  // --- path signal: strongest, because the diff is ground truth ----------------
  for (const glob of skill.paths ?? []) {
    if (paths.some((p) => matchesGlob(p, glob))) {
      score += W.path;
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
      score += W.capability;
      reasons.push(`capability:${cap}`);
    }
  }

  // --- keyword signal ---------------------------------------------------------
  const keywords = new Set(skill.keywords ?? []);
  const summaryWords = new Set(tokenize(skill.summary));
  const nameWords = new Set(tokenize(skill.name));
  for (const token of taskTokens) {
    if (keywords.has(token)) {
      score += W.keyword;
      reasons.push(`keyword:${token}`);
    } else if (nameWords.has(token)) {
      score += W.name;
      reasons.push(`name:${token}`);
    } else if (summaryWords.has(token)) {
      score += W.summary;
      reasons.push(`summary:${token}`);
    }
  }

  // --- stack signal -----------------------------------------------------------
  const overlap = (skill.stack ?? []).filter((tag) => repo.has(tag));
  if (overlap.length > 0) {
    score += W.stack * Math.min(overlap.length, 3);
    reasons.push(`stack:${overlap.join('+')}`);
  }

  return { score, reasons };
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
    const { score, reasons } = scoreSkill(skill, context);
    if (isForced) {
      selected.push({ skill, score: Infinity, reasons: ['forced'] });
      continue;
    }
    if (score === 0) {
      excluded.push({ skill, reason: 'no matching signal' });
      continue;
    }
    selected.push({ skill, score, reasons });
  }

  selected.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  excluded.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
  return { selected, excluded };
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