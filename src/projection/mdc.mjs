// Project `.mdc` rules as generated regions.
//
// The estate carried three always-on `.mdc` rule families across the Social repos
// in eight files, and no two were byte-identical. The worst pair differed by one
// byte while three semantically loaded lines changed, so no size-, hash- or
// line-count-based duplicate detector could ever have flagged it. This module is
// the answer to that finding: one canonical body, projected.
//
// Two decisions are load-bearing and neither is obvious:
//
//   1. VARIANT IS THE WRONG SHAPE FOR THIS CONTENT. The two divergent BLOCK
//      bullets in `test-gate` are complementary (one catches a consumer that
//      requires an unshipped field, the other a producer that ships an untested
//      one), and the two divergent Requirements bullets in
//      `preview-postflight` are complementary too (a build-config instruction and
//      a credential-handling prohibition). Choosing one per repo would keep the
//      estate's worst bug — a rule file that quietly stops catching half of what
//      it exists to catch. So the canonical body carries BOTH, unconditionally.
//
//   2. WHAT ACTUALLY VARIES IS SUBSTRATE, NOT POLICY. A plan-tracker glob, a test
//      path, a production domain. Those become declared substitutions with
//      defaults, so an unconfigured repo still receives a correct, complete rule
//      and the defaults are visible rather than guessed at render time.

import { readFile, readdir } from 'node:fs/promises';

import { frontmatterBlock } from './surfaces.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from './markers.mjs';

// ROOT is computed here rather than imported: project.mjs is the caller of every
// function below, so importing it back would create a cycle for the sake of one
// constant.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MDC_DIR = join(ROOT, 'rules', 'mdc');

/**
 * The keys a canonical `.mdc` may declare: ours prefixed, the editor's as documented
 * (ADR-022).
 *
 * The allowlist earns its place twice. It is what tells a reader of the file which
 * reader owns a key, and it is what turns an unprefixed simt key into a reported
 * defect — which is the failure ADR-016 shipped once, a rule that reached no repo
 * because `applies` was absent, silently and with a test green.
 */
/** Frontmatter keys this tool reads, ADR-022. Exported so the one authority on the
 *  tool's own vocabulary is also the one a guard subtracts, rather than a second copy. */
export const KNOWN_KEYS = new Set([
  'simt-id',
  'simt-target',
  'simt-title',
  'simt-applies',
  'simt-opt-in',
  'simt-substitutions',
  'description',
  'alwaysApply',
]);

/** A bare key beside a prefixed one is the typo this rule exists to catch. */
function unknownKey(key) {
  const prefixed = `simt-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  return KNOWN_KEYS.has(prefixed)
    ? `key "${key}" is this tool's own, not the editor's; it is spelled "${prefixed}"`
    : `unrecognised frontmatter key "${key}"; simt-dev's own keys are simt-id, simt-target, simt-title, simt-applies, simt-opt-in, simt-substitutions`;
}

/**
 * Read every canonical `.mdc` rule with its frontmatter parsed.
 *
 * A rule without `simt-id` or `simt-target` is a defect rather than a default:
 * `simt-id` is what a manifest keys its substitutions on, and `simt-target` is the
 * only thing saying where the projected file goes. A rule that silently wrote nowhere
 * would look like a successful sync.
 */
export async function loadMdcRules() {
  let names;
  try {
    names = (await readdir(MDC_DIR)).filter((n) => n.endsWith('.mdc')).sort();
  } catch {
    return [];
  }

  const out = [];
  for (const file of names) {
    const text = await readFile(join(MDC_DIR, file), 'utf8');
    const meta = parseFrontmatter(text);
    // `simt-substitutions:` is a YAML list of maps, which the shared line-based
    // frontmatter parser cannot express, so it is parsed separately and strictly.
    const subs = parseSubstitutions(text);
    const unknown = Object.keys(meta).filter((k) => !KNOWN_KEYS.has(k));
    out.push({
      file,
      source: `rules/mdc/${file}`,
      id: meta['simt-id'] ?? null,
      target: meta['simt-target'] ?? null,
      title: meta['simt-title'] ?? null,
      description: meta.description ?? null,
      alwaysApply: meta.alwaysApply === true,
      // `simt-applies` is 'always' or a tag array; `simt-opt-in` means the repo must name
      // this rule in its manifest rather than matching on a detected signal. A rule that
      // names one product's Workers and secrets cannot be selected by stack, because
      // detection cannot distinguish a Workers repo that has that problem from one
      // that does not.
      applies:
        meta['simt-applies'] === 'always'
          ? 'always'
          : Array.isArray(meta['simt-applies'])
            ? meta['simt-applies']
            : [],
      optIn: meta['simt-opt-in'] === true,
      // A rule with no `simt-substitutions:` block has no placeholders, so an empty
      // list is the correct answer. (This was `substitutions` — an undefined binding
      // that would only have fired on a future rule without the block, which is
      // exactly the kind of latent crash a new rule is most likely to trigger.)
      substitutions: subs,
      bytes: Buffer.byteLength(text),
      body: stripFrontmatter(text),
      error:
        meta['simt-id'] === null
          ? 'missing simt-id in frontmatter'
          : meta['simt-target'] === null
            ? 'missing simt-target in frontmatter'
            : unknown.length > 0
              ? unknownKey(unknown[0])
              : null,
    });
  }
  return out;
}

/** `simt-substitutions:` is a list of `- key: x` blocks. Any deviation is reported
 *  rather than skipped, because a silently-dropped substitution projects a rule
 *  containing a literal `{{placeholder}}`. */
function parseSubstitutions(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return [];
  const block = m[1];
  if (!/^simt-substitutions:/m.test(block)) return [];

  const out = [];
  const re = /^\s*-\s*key:\s*(\S+)\s*$/gm;
  const hits = [...block.matchAll(re)];
  for (const hit of hits) {
    const start = hit.index + hit[0].length;
    const tail = block.slice(start);
    const next = /^\s*-\s*key:/m.exec(tail.slice(1));
    const scope = next ? tail.slice(0, next.index + 1) : tail;
    const def = /^\s*default:\s*(.*)$/m.exec(scope);
    const desc = /^\s*describe:\s*(.*)$/m.exec(scope);
    out.push({
      key: hit[1],
      default: def ? unquote(def[1].trim()) : '',
      describe: desc ? unquote(desc[1].trim()) : '',
    });
  }
  return out;
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    // `simt-substitutions:` opens a nested block this parser cannot represent, so
    // it and its list items are skipped here and read by parseSubstitutions.
    if (/^\s*-\s/.test(line)) continue;
    const kv = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === '') continue;
    if (raw === 'always') out[key] = 'always';
    else if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw.startsWith('[')) {
      out[key] = raw
        .slice(1, raw.lastIndexOf(']'))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else out[key] = unquote(raw.trim());
  }
  return out;
}

function unquote(s) {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function stripFrontmatter(text) {
  return text
    .replace(/^---\n[\s\S]*?\n---\n*/, '')
    .replace(/^#\s+.*\n+/, '')
    .trim();
}

/**
 * Substitute declared placeholders.
 *
 * An empty-string default is a deliberate "this repo has nothing to add here"
 * and the line it sits on is DROPPED. That is how `preview-postflight` reaches
 * a repository without printing an empty bullet, and how a repo with no
 * production-domain note gets a clean document instead of a blank one.
 *
 * A placeholder with neither a declared nor a default value is a defect: the
 * rendered rule would ship a literal `{{key}}`, which reads as a finished rule
 * and is not one.
 */
export function renderMdc(rule, declared = {}) {
  const problems = [];
  let body = rule.body;

  for (const sub of rule.substitutions) {
    const has = Object.prototype.hasOwnProperty.call(declared, sub.key);
    const provided = has ? declared[sub.key] : undefined;

    if (has && provided === '') {
      // A repo declared this key and declared it empty: the line it sits on is
      // removed. This is how preview-postflight reaches a repository without
      // printing a blank bullet.
      body = dropOrReplace(body, sub.key, '');
      continue;
    }

    if (provided === undefined || provided === null || provided === '') {
      // Fall back to the default. An empty DEFAULT is also a drop instruction,
      // which is how the same file serves a repo that has nothing to add.
      if (sub.default === '') {
        body = dropOrReplace(body, sub.key, '');
        continue;
      }
      if (sub.default === undefined) {
        problems.push(`substitution ${sub.key} has no default and none declared`);
        continue;
      }
      body = dropOrReplace(body, sub.key, sub.default);
      continue;
    }

    body = dropOrReplace(body, sub.key, String(provided));
  }

  // A key that was already reported as unsubstitutable is not reported a second
  // time as a leftover placeholder. Two messages for one fault trains a reader
  // to skim past problems, and the first message is the actionable one.
  const reported = new Set(
    problems
      .filter((p) => /^substitution /.test(p))
      .map((p) => /^substitution ([^ ]+) /.exec(p)?.[1]),
  );
  const leftover = [...body.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)].map((m) => m[1]);
  for (const key of new Set(leftover)) {
    if (reported.has(key)) continue;
    problems.push(`placeholder {{${key}}} was never substituted`);
  }

  return { body, problems };
}

/**
 * Replace every `{{key}}`, or remove the whole bullet when the value is empty.
 *
 * "Whole bullet" rather than "the line containing the token": an empty value on a
 * wrapped bullet leaves its continuation lines behind, and the rule then reads as
 * half a sentence starting with a lowercase word. A markdown bullet is the token's
 * line plus every more-indented line that follows it.
 *
 * One placeholder per line is a rule on the content side, not a preference. Dropping
 * a line removes EVERY token on it, so `{{a}}{{b}}` with `a` empty deletes `b` too —
 * silently, and with no leftover placeholder left to report. Two independent optional
 * clauses on one line lose one clause with no diagnostic at all.
 */
function dropOrReplace(text, key, value) {
  const token = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
  if (value !== '') return text.replace(token, value);
  // A second, non-global pattern for the line scan: reusing a `/g` regex with
  // `.test()` carries `lastIndex` between lines, so every other line would be
  // tested against the wrong offset.
  const probe = new RegExp(`\\{\\{${key}\\}\\}`);

  const kept = [];
  let dropping = false;
  for (const line of text.split('\n')) {
    if (probe.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping) {
      // A continuation of the bullet just dropped: indented, and not itself the
      // start of a new block element.
      const indent = /^(\s*)/.exec(line)[1].length;
      if (line.trim() === '') continue;
      if (indent > 0 && !/^\s*([-*+]|\d+\.)\s/.test(line)) continue;
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The frontmatter a projected `.mdc` keeps. `alwaysApply` and `description` are
 *  read by the editor before any rule text, so they belong outside the region. */
export function mdcFrontmatter(rule) {
  return frontmatterBlock([
    `description: ${rule.description ?? `Canonical ${rule.id} rule managed by simt-dev`}`,
    `alwaysApply: ${rule.alwaysApply ? 'true' : 'false'}`,
  ]);
}


/**
 * The rule's bare name, taken from the path it declares.
 *
 * `simt-target` is the canonical declaration and predates the surface table; deriving
 * every other surface's path from its basename means a rule names itself once and
 * a rename moves every editor's file with it, instead of four paths that can
 * disagree about which rule a file holds.
 */
export function ruleName(rule) {
  if (typeof rule.target !== 'string' || rule.target === '') return null;
  const base = rule.target.slice(rule.target.lastIndexOf('/') + 1);
  return base.replace(/\.mdc$/, '');
}

export { MDC_DIR, parse as parseRegion };