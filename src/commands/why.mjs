// `simt why <subject>` answers what governs a file, and which decision, rule, skill or
// finding a name stands for (ADR-093).
//
// With a path, one line per decision, rule, skill, gate and lesson. With no subject, the
// Affects tokens that name nothing this tree contains. The file list is `git ls-files`.
// The index is not rebuilt: governance is the records, and writing the cache to answer a
// question would change the tree.
//
// The subject kind is decided here rather than by four commands, because a reader used to
// have to know that a decision is `rules why`, a skill `skills why` and a finding code
// `explain`. Those paths still answer; this only removes the choice. A prefix (`rule:`,
// `skill:`) settles the one case the corpus cannot: a name both kinds carry.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { FORMATTABLE, GATES } from '../hooks/gates.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { decisionsDir } from '../decisions/dir.mjs';
import {
  governs,
  scopePaths,
  sourceRoots,
  unresolvedAffects,
} from '../index/govern.mjs';
import { parseFrontmatter } from '../text/frontmatter.mjs';
import { listPromotedLessons } from '../memory/lessons.mjs';
import { commandRoot } from '../repo-root.mjs';
import { gitPaths } from '../sys/git.mjs';

const RULE_DIRS = ['rules', 'rules/stacks', 'rules/mdc', '.simt/profiles'];

/** Upper case with a hyphen: a finding code, never a rule id or a path. */
const FINDING_SHAPE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const DECISION_SHAPE = /^ADR-\d{3,}$/i;
const PREFIX_SHAPE = /^(rule|skill):(.*)$/i;

/**
 * What a subject token names, from the token and the corpus alone, with no I/O.
 *
 * The corpus arrives as arguments so this rule is a table a test can exercise without a
 * repository. A prefix settles the one ambiguity the corpus can create - a name that is
 * both a rule id and a skill name - because guessing would answer the wrong question with
 * a reply that looks correct.
 *
 * @param {string} raw the token after `why`
 * @param {{ruleIds?: Set<string>, skillNames?: Set<string>, files?: Set<string>}} [corpus]
 * @returns {{kind: string, value: string} | {error: string, remedy: string}}
 */
export function classifySubject(raw, { ruleIds = new Set(), skillNames = new Set(), files = new Set() } = {}) {
  const token = String(raw ?? '').trim();
  if (token === '') {
    return { error: 'why needs a subject', remedy: `one of: a path git tracks, ADR-NNN, rule:<id>, skill:<name>, or a finding code` };
  }
  const prefixed = PREFIX_SHAPE.exec(token);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    const value = prefixed[2].trim();
    if (value === '') {
      return { error: `${kind}: needs a name`, remedy: `run: ${CLI} why ${kind}:<name>` };
    }
    if (kind === 'rule' && !ruleIds.has(value)) {
      return { error: `unknown rule \`${value}\``, remedy: `list them with: ${CLI} rules list` };
    }
    if (kind === 'skill' && !skillNames.has(value)) {
      return { error: `unknown skill \`${value}\``, remedy: `list them with: ${CLI} skills find <query>` };
    }
    return { kind, value };
  }
  if (DECISION_SHAPE.test(token)) return { kind: 'adr', value: token.toUpperCase() };
  if (FINDING_SHAPE.test(token)) return { kind: 'finding', value: token };
  if (files.has(token)) return { kind: 'path', value: token };
  const rule = ruleIds.has(token);
  const skill = skillNames.has(token);
  if (rule && skill) {
    return {
      error: `\`${token}\` names a rule and a skill`,
      remedy: `say which: ${CLI} why rule:${token}  or  ${CLI} why skill:${token}`,
    };
  }
  if (rule) return { kind: 'rule', value: token };
  if (skill) return { kind: 'skill', value: token };
  return {
    error: `no such subject: ${token}`,
    remedy: `one of: a path git tracks, ADR-NNN, rule:<id>, skill:<name>, or a finding code`,
  };
}

/** The corpus a bare token is classified against. Only a bare token pays for it. */
async function classify(token, { root, files }) {
  const bare = typeof token === 'string' && token !== '' && !PREFIX_SHAPE.test(token) && !DECISION_SHAPE.test(token) && !FINDING_SHAPE.test(token);
  const corpus = bare ? await subjectCorpus(root) : { ruleIds: new Set(), skillNames: new Set() };
  return classifySubject(token, { ...corpus, files });
}

async function subjectCorpus(root) {
  const [ruleIds, skillNames] = await Promise.all([knownRuleIds(root), knownSkillNames(root)]);
  return { ruleIds, skillNames };
}

async function knownRuleIds(root) {
  try {
    const { repoContext } = await import('../context.mjs');
    return new Set((await repoContext(root).rules()).map((rule) => rule.id));
  } catch {
    // A repository whose rules cannot be read has no rule ids to resolve, and saying so
    // is better than failing the question a path or an ADR can still answer.
    return new Set();
  }
}

async function knownSkillNames(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'graph', 'skills.graph.json'), 'utf8'));
    return new Set((parsed.skills ?? []).map((skill) => String(skill.name ?? '')));
  } catch {
    return new Set();
  }
}

export async function whyCommand(args, flags, commands = []) {
  if (args.length > 1) return fail(`unknown why argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} why <subject>`);
  const root = commandRoot(flags);
  const listed = await tracked(root);
  if (listed.error) return listed.error;
  const files = new Set(listed.files);
  const target = args[0];
  if (!target) {
    const ctx = { files, commands: new Set(commands), roots: sourceRoots(files) };
    return reportUnresolved(root, flags, unresolvedAffects(await decisionRecords(root), ctx));
  }
  const subject = await classify(target, { root, files });
  if (subject.error) return fail(subject.error, EXIT.USAGE, subject.remedy);
  // Each handler keeps its own envelope and its own remedy, so the answer a reader gets
  // from `why ADR-093` is byte-for-byte the one `rules why ADR-093` prints.
  if (subject.kind === 'adr' || subject.kind === 'rule') return (await import('./rules.mjs')).whyCommand([subject.value], flags);
  if (subject.kind === 'skill') return (await import('./skills.mjs')).whyCommand([subject.value], flags);
  if (subject.kind === 'finding') return (await import('./explain.mjs')).explainCommand([subject.value], flags);
  const ctx = { files, commands: new Set(commands), roots: sourceRoots(files) };
  const records = await decisionRecords(root);
  if (!files.has(target)) return fail(`not in the tree: ${target}`, EXIT.USAGE, `pass a path git tracks`);
  const corpus = await loadCorpus(root);
  const items = governs(target, { records, ...corpus, ctx });
  const payload = { ok: true, command: 'why', root, path: target, items };
  if (isJson(flags)) {
    emitJson(payload);
    return EXIT.OK;
  }
  const lines = items.map((item) => `${item.kind.padEnd(10)}${item.id}  ${item.detail}`);
  emit(lines.length > 0 ? lines.join('\n') : 'none');
  return EXIT.OK;
}

function reportUnresolved(root, flags, unresolved) {
  const payload = { ok: true, command: 'why', root, unresolved };
  if (isJson(flags)) {
    emitJson(payload);
    return EXIT.OK;
  }
  const lines = unresolved.map((item) => `UNRESOLVED-AFFECTS  ${item.token}  ${item.id}`);
  emit([`unresolved  ${unresolved.length}`, ...lines].join('\n'));
  return EXIT.OK;
}

// `async function tracked(root)` (read by `simt why`) becomes `export async`:
// the critic's brief resolves governance the same way without a second copy.
export async function tracked(root) {
  try {
    // `-z`: without it git C-quotes a non-ASCII path and the reader's real
    // filename never matches it.
    return { files: await gitPaths(root, ['ls-files']) };
  } catch (error) {
    return {
      error: fail(
        `could not read what governs files here (${error.message})`,
        EXIT.UNSUPPORTED,
        'run this inside a git repository',
      ),
    };
  }
}

export async function decisionRecords(root) {
  // the repository's own records, wherever it keeps them — not a hard-coded path.
  const dir = join(root, await decisionsDir(root));
  let names = [];
  try {
    names = (await readdir(dir))
      .filter((name) => /^ADR-\d{3,}-.*\.md$/i.test(name))
      .sort((a, b) => Number(/^ADR-(\d{3,})/i.exec(a)[1]) - Number(/^ADR-(\d{3,})/i.exec(b)[1]));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8');
    const { body } = parseFrontmatter(text);
    const id = /^ADR-\d{3,}/i.exec(name)[0].toUpperCase();
    const heading = /^#\s+(.*)$/m.exec(body)?.[1] ?? id;
    const title = heading.replace(/^ADR-\d{3,}\s*[—–-]\s*/i, '').trim();
    records.push({ id, title, text });
  }
  return records;
}

// `async function loadCorpus(root)` (read by `simt why`) becomes `export async`.
export async function loadCorpus(root) {
  const [rules, skills, lessons, commands] = await Promise.all([
    ruleScopes(root),
    skillScopes(root),
    lessonScopes(root),
    gateCommands(root),
  ]);
  const gates = Object.values(GATES).map((gate) => ({
    id: gate.name,
    detail: gate.why,
    extensions: gate.kind === 'staged' ? FORMATTABLE : null,
  }));
  return { rules, skills, gates, lessons, commands };
}

export async function ruleScopes(root) {
  const rules = [];
  for (const dir of RULE_DIRS) {
    let names = [];
    try {
      names = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md') && !name.endsWith('.mdc')) continue;
      const text = await readFile(join(root, dir, name), 'utf8');
      const paths = scopePaths(text);
      if (paths.length === 0) continue;
      const id = /^simt-id:\s*(\S+)/m.exec(text)?.[1] ?? name;
      const detail = /^simt-title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? id;
      rules.push({ id, detail, paths });
    }
  }
  return rules;
}

async function skillScopes(root) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(root, 'graph', 'skills.graph.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed?.skills)) return [];
  return parsed.skills
    .filter((skill) => Array.isArray(skill.paths) && skill.paths.length > 0)
    .map((skill) => ({ id: String(skill.name ?? ''), detail: String(skill.summary ?? ''), paths: skill.paths }));
}

export async function lessonScopes(root) {
  return (await listPromotedLessons(root))
    .filter((lesson) => lesson.paths.length > 0)
    .map((lesson) => ({
      id: lesson.id,
      detail: lesson.title,
      paragraph: lesson.paragraph,
      paths: lesson.paths,
      signature: lesson.signature,
      keywords: lesson.keywords,
    }));
}

async function gateCommands(root) {
  try {
    const commands = (await loadManifest(root)).manifest?.gates?.commands;
    return commands && typeof commands === 'object' ? commands : {};
  } catch {
    return {};
  }
}
