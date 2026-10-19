// What governs a file (R25, ADR-093).
//
// A decision governs the files its Affects line names. The line is prose, so the
// only tokens that count are the ones in backticks, joined across the lines the
// paragraph wraps onto. A rule governs a file its scope matches. A skill, a gate
// and a lesson do the same with their own path list. Nothing here is stored: the
// answer is the records on disk.

import { parseDecisionFrontmatter, splitFrontmatter } from '../memory/decide.mjs';

const SIBLING = /^\*{0,2}[A-Z][\w-]*(?:[ \t]+[\w-]+){0,3}:\*{0,2}(?:[ \t]|$)/;
const HEADING = /^#{1,6}\s/;
const TOOL = /^(?:simt-dev|simt)\b/;

/**
 * Affected tokens of a decision record: reads `simt-affects:` frontmatter first (R34),
 * falling back to backticked tokens of the `Affects:` paragraph (R25).
 */
export function affectsTokens(text) {
  const fm = parseDecisionFrontmatter(text);
  const { body } = splitFrontmatter(text);
  const lines = String(body).split('\n');
  const start = lines.findIndex((line) => /^\s*\*{0,2}Affects:\*{0,2}/.test(line));
  const proseTokens = [];
  if (start >= 0) {
    const parts = [lines[start].replace(/^\s*\*{0,2}Affects:\*{0,2}\s*/, '')];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '' || SIBLING.test(line) || HEADING.test(line)) break;
      parts.push(line);
    }
    proseTokens.push(...[...parts.join('\n').matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean));
  }
  if (fm.hasAffects) {
    return [...new Set([...fm.affects, ...proseTokens])];
  }
  return proseTokens;
}

/**
 * Directories named src. A path written from inside one (`hooks/dispatcher.mjs`)
 * resolves against each of them, after the repo root has already been tried.
 * @param {Iterable<string>} files
 */
export function sourceRoots(files) {
  const roots = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (parts[i] === 'src') roots.add(parts.slice(0, i + 1).join('/'));
    }
  }
  return [...roots].sort();
}

/**
 * One Affects token.
 *
 * A prefixed command (`simt-dev init`, `simt hooks run`) is a command only when
 * that command exists. The tool name on its own is not a command and not a path.
 * Anything else is a path or a glob, at the repo root and then under each source
 * root. A token that is none of those is unresolved.
 *
 * @param {string} token
 * @param {{files: Set<string>, commands: Set<string>, roots: string[]}} ctx
 * @returns {{kind: 'command', id: string}|{kind: 'paths', paths: string[]}|{kind: 'unresolved', token: string}}
 */
export function resolveToken(token, { files, commands, roots }) {
  const text = token.trim();
  const command = commandOf(text, commands);
  if (command !== undefined) {
    return command === null ? { kind: 'unresolved', token: text } : { kind: 'command', id: command };
  }
  const paths = new Set();
  for (const candidate of candidates(text, roots)) {
    if (hasGlob(candidate)) {
      for (const file of files) if (matchGlob(candidate, file)) paths.add(file);
    } else if (files.has(candidate)) paths.add(candidate);
  }
  if (paths.size > 0) return { kind: 'paths', paths: [...paths].sort() };
  return { kind: 'unresolved', token: text };
}

/** Decisions whose Affects line names this file, and tokens that named nothing. */
export function decisionHits(records, file, ctx) {
  const hits = [];
  const unresolved = [];
  for (const record of records) {
    let named = false;
    for (const token of affectsTokens(record.text)) {
      const resolved = resolveToken(token, ctx);
      if (resolved.kind === 'unresolved') unresolved.push({ token: resolved.token, id: record.id });
      else if (resolved.kind === 'paths' && resolved.paths.includes(file)) named = true;
    }
    if (named) hits.push({ kind: 'decision', id: record.id, detail: record.title });
  }
  return { hits, unresolved };
}

/** Every unresolved Affects token, one per record. */
export function unresolvedAffects(records, ctx) {
  const found = [];
  for (const record of records) {
    for (const token of affectsTokens(record.text)) {
      const resolved = resolveToken(token, ctx);
      if (resolved.kind === 'unresolved') found.push({ token: resolved.token, id: record.id });
    }
  }
  found.sort((a, b) => cmp(a.token, b.token) || cmp(a.id, b.id));
  return found;
}

/** Rules, skills, gates and lessons whose path list matches this file. */
export function scopeHits(file, { rules = [], skills = [], gates = [], lessons = [], commands = {} }) {
  const hits = [];
  for (const rule of rules) {
    if (rule.paths.some((glob) => matchGlob(glob, file))) hits.push({ kind: 'rule', id: rule.id, detail: rule.detail });
  }
  for (const skill of skills) {
    if (skill.paths.some((glob) => matchGlob(glob, file))) hits.push({ kind: 'skill', id: skill.id, detail: skill.detail });
  }
  for (const gate of gates) {
    const declared = commands[gate.id];
    const byExt = gate.extensions ? gate.extensions.has(extension(file)) : false;
    const byCommand = typeof declared === 'string' && declared.split(/\s+/).includes(file);
    if (byExt || byCommand) hits.push({ kind: 'gate', id: gate.id, detail: gate.detail });
  }
  for (const lesson of lessons) {
    if (lesson.paths.some((glob) => matchGlob(glob, file))) hits.push({ kind: 'lesson', id: lesson.id, detail: lesson.detail });
  }
  return hits;
}

export function sortHits(hits) {
  const order = { decision: 0, rule: 1, skill: 2, gate: 3, lesson: 4 };
  return [...hits].sort((a, b) => (order[a.kind] - order[b.kind]) || cmp(a.id, b.id));
}

/** Path globs from a `simt-scope` list, plus an applies entry that is itself a path. */
export function scopePaths(text) {
  const front = frontmatter(text);
  if (!front) return [];
  const paths = quotedList(front, 'simt-scope');
  for (const entry of quotedList(front, 'simt-applies')) {
    if (entry.includes('/') || entry.includes('*') || entry.startsWith('.')) paths.push(entry);
  }
  return paths;
}

/** `paths` inside a lesson's trigger, either inline or as a YAML list. */
export function lessonPaths(text) {
  const front = frontmatter(text);
  if (!front) return [];
  const inline = front.match(/paths:\s*\[([^\]]*)\]/);
  if (inline) return [...inline[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const paths = [];
  let on = false;
  for (const line of front.split('\n')) {
    if (/paths:\s*$/.test(line)) {
      on = true;
      continue;
    }
    if (!on) continue;
    const item = /^\s*-\s+['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (!item) break;
    paths.push(item[1]);
  }
  return paths;
}

export function matchGlob(glob, file) {
  return expandBraces(glob).some((one) => globRegExp(one).test(file));
}

function commandOf(token, commands) {
  if (!TOOL.test(token)) return commands.has(token) ? token : undefined;
  const rest = token.replace(TOOL, '').trim();
  if (rest === '') return null;
  return commands.has(rest) ? rest : null;
}

function candidates(token, roots) {
  const norm = token.replaceAll('\\', '/').replace(/^\.\//, '');
  return [norm, ...roots.map((root) => `${root}/${norm}`)];
}

function hasGlob(token) {
  return token.includes('*') || token.includes('?') || token.includes('{');
}

function expandBraces(glob) {
  const match = /\{([^{}]+)\}/.exec(glob);
  if (!match) return [glob];
  return match[1].split(',').flatMap((alt) => expandBraces(glob.replace(match[0], alt)));
}

function globRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?';
        i += 1;
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return new RegExp(`${re}$`);
}

function extension(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot);
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(String(text));
  return match ? match[1] : '';
}

function quotedList(front, key) {
  const match = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(front);
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
}

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
