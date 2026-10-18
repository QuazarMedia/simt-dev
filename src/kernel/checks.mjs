// A marked line is enforced by a checker, so the projection keeps its name and not
// its prose (plan 0003 R19, ADR-088).
//
// The unit is one list item, including the wrapped lines under it. A blank-line
// block would be the whole section: the core rules are consecutive bullets, and
// marking one of them must not take its neighbours with it.
//
// `import-direction` records nothing about which way an import may point. The
// index has the edges (R21). A direction still has to be named before the prose
// can leave, or the line would say Enforced and nothing would be enforcing it.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const CHECK_MARKER = 'simt-check';

/** Checkers this tool can run. `import-direction` is recognised and waits on a named direction. */
const RUNNABLE = new Set(['max-file-lines', 'forbid-regex', 'forbidden-path-edit', 'required-file']);

const MARKER = /<!--\s*simt-check:\s*([^>]*?)\s*-->/g;
const MARKER_AT = /\s*<!--\s*simt-check:\s*[^>]*?-->/g;
const HAS_MARKER = /<!--\s*simt-check:/;
const ITEM_START = /^(\s*)(?:[-*]|\d+\.)\s+/;

/** ADR-005's two tiers, used when a repository has not named its own. */
const DEFAULT_WARN = 400;
const DEFAULT_ERROR = 1000;

/**
 * What is wrong with the markers in a body, or null. The same field as a
 * frontmatter defect, so `check` needs no second way to see a broken rule.
 */
export function checkDefect(body) {
  for (const unit of units(body)) {
    if (fenced(unit)) continue;
    const found = markersIn(unit);
    if (found.length === 0) continue;
    if (found.length > 1) {
      return `carries more than one ${CHECK_MARKER} marker on one line; one line is one checker`;
    }
    const parsed = parseCheck(found[0]);
    if (parsed.error) return parsed.error;
  }
  return null;
}

/**
 * Replace each runnable check with one `Enforced:` line. A body with no marker
 * is returned unchanged, so a rule nobody marked does not move a byte.
 *
 * @returns {{body: string, enforced: {name: string}[], changed: boolean}}
 */
export function foldChecks(body) {
  if (checkDefect(body) !== null || !HAS_MARKER.test(body)) {
    return { body, enforced: [], changed: false };
  }
  const enforced = [];
  const kept = [];
  for (const unit of units(body)) {
    const found = fenced(unit) ? [] : markersIn(unit);
    if (found.length === 0) {
      kept.push(unit);
      continue;
    }
    const parsed = parseCheck(found[0]);
    if (!parsed.runnable) {
      kept.push(stripMarkers(unit));
      continue;
    }
    const indent = ITEM_START.exec(unit)?.[1] ?? '';
    const bullet = ITEM_START.test(unit) ? '- ' : '';
    kept.push(`${indent}${bullet}Enforced: ${parsed.name}`);
    enforced.push({ name: parsed.name });
  }
  const next = kept.join('\n');
  return { body: next, enforced, changed: next !== body };
}

/**
 * Run the checkers the selected rules declare. A directory that is not a git
 * repository has no tracked tree and no diff, so the checkers that need one
 * report nothing rather than failing a repository they cannot see.
 *
 * @param {string} root
 * @param {{id: string, source: string, body: string}[]} rules
 * @param {object|null} manifest
 */
export async function runDeclaredChecks(root, rules, manifest) {
  const declared = [];
  const seen = new Set();
  for (const rule of rules) {
    if (checkDefect(rule.body) !== null) continue;
    for (const unit of units(rule.body)) {
      if (fenced(unit)) continue;
      for (const expr of markersIn(unit)) {
        const parsed = parseCheck(expr);
        if (parsed.error) continue;
        const key = `${parsed.name}\0${parsed.arg}`;
        if (seen.has(key)) continue;
        seen.add(key);
        declared.push({ ...parsed, source: rule.source });
      }
    }
  }
  const findings = [];
  for (const check of declared) {
    findings.push(...(await runOne(root, check, manifest)));
  }
  return findings;
}

async function runOne(root, check, manifest) {
  if (check.name === 'import-direction') {
    return [{
      file: check.source,
      status: 'check-unbuilt',
      detail: 'import-direction has no direction to enforce; the index records imports and no rule names which way they may point',
      remedy: 'leave the instruction in the rule until a direction is named',
    }];
  }
  if (check.name === 'max-file-lines') return fileLines(root, check, manifest);
  if (check.name === 'required-file') return requiredFile(root, check);
  const diff = await workDiff(root);
  if (diff === null) return [];
  if (check.name === 'forbid-regex') return forbidRegex(check, diff);
  return forbiddenPath(check, diff);
}

async function fileLines(root, check, manifest) {
  const limits = manifest?.limits?.fileLines ?? {};
  const generated = limits.generated;
  if (generated !== undefined && !Array.isArray(generated)) {
    return [{
      file: 'simt.json',
      status: 'invalid',
      detail: 'limits.fileLines.generated must be a list of paths',
      remedy: 'name each generated path, or remove the key',
    }];
  }
  const warnAt = Number.isInteger(limits.warn) ? limits.warn : DEFAULT_WARN;
  const errorAt = Number.isInteger(limits.error) ? limits.error : DEFAULT_ERROR;
  const files = await tracked(root);
  if (files === null) return [];
  const findings = [];
  const prefixes = Array.isArray(generated) ? generated.filter((g) => typeof g === 'string' && g !== '') : [];
  for (const rel of files) {
    // A committed dependency is not a file this repository wrote. Counting it
    // fails every install of this package, because the package's own sources
    // are longer than the ceiling the consumer declared.
    if (rel.split('/').includes('node_modules')) continue;
    if (exempt(rel, prefixes)) continue;
    let text;
    try {
      text = await readFile(resolve(root, rel));
    } catch {
      continue;
    }
    if (text.includes(0)) continue;
    const source = text.toString('utf8');
    // The region marker is this tool naming itself as the generator. A path the
    // repository names is the other exemption; a filename that looks generated is not.
    if (source.includes('simt:generated')) continue;
    const lines = lineCount(source);
    if (lines > errorAt) {
      findings.push({
        file: rel,
        status: 'file-lines',
        detail: `${lines} lines, over the ceiling of ${errorAt}`,
        remedy: 'split the file, or name its generator in limits.fileLines.generated',
      });
    } else if (lines > warnAt) {
      findings.push({
        file: rel,
        status: 'file-lines-warn',
        detail: `${lines} lines, over the review trigger of ${warnAt}`,
        remedy: 'say why the file stays whole, or split it',
      });
    }
  }
  return findings;
}

async function requiredFile(root, check) {
  const full = resolve(root, check.arg);
  const rel = relative(root, full);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return [{
      file: check.source,
      status: 'required-file',
      detail: `${check.arg} is outside the repository`,
      remedy: 'name a path inside the repository',
    }];
  }
  const info = await stat(full).catch(() => null);
  if (info?.isFile()) return [];
  return [{
    file: check.arg,
    status: 'required-file',
    detail: 'a rule requires this file and it is absent',
    remedy: `add ${check.arg}`,
  }];
}

function forbidRegex(check, diff) {
  let pattern;
  try {
    pattern = new RegExp(check.arg);
  } catch {
    return [];
  }
  const findings = [];
  for (const file of diff.files) {
    if (file.added.some((line) => pattern.test(line))) {
      findings.push({
        file: file.path,
        status: 'forbid-regex',
        detail: `an added line matches ${check.arg}`,
        remedy: 'take the match out of the change',
      });
    }
  }
  return findings;
}

function forbiddenPath(check, diff) {
  const hit = diff.files.find((file) => file.path === check.arg || file.path.startsWith(`${check.arg}/`));
  if (!hit) return [];
  return [{
    file: hit.path,
    status: 'forbidden-path',
    detail: `${check.arg} is a path a rule says not to edit`,
    remedy: 'edit the source the rule names, and leave this path unchanged',
  }];
}

function parseCheck(expr) {
  const parts = String(expr).trim().split(/\s+/);
  const name = parts[0] ?? '';
  const arg = parts.slice(1).join(' ');
  if (name === 'import-direction') {
    if (arg !== '') return { error: `${CHECK_MARKER} import-direction takes no argument` };
    return { name, arg: '', runnable: false };
  }
  if (!RUNNABLE.has(name)) {
    return { error: `${CHECK_MARKER} names "${name}", which is not a checker; the checkers are ${[...RUNNABLE, 'import-direction'].sort().join(', ')}` };
  }
  if (name !== 'max-file-lines' && arg === '') {
    return { error: `${CHECK_MARKER} ${name} needs its argument` };
  }
  if (name === 'max-file-lines' && arg !== '') {
    return { error: `${CHECK_MARKER} max-file-lines takes the repository's limits.fileLines, not an argument` };
  }
  if (name === 'forbid-regex') {
    try {
      RegExp(arg);
    } catch (error) {
      return { error: `${CHECK_MARKER} forbid-regex is not a regular expression (${error.message})` };
    }
  }
  if ((name === 'forbidden-path-edit' || name === 'required-file') && (arg.startsWith('/') || arg.split('/').includes('..'))) {
    return { error: `${CHECK_MARKER} ${name} needs a path inside the repository` };
  }
  return { name, arg, runnable: true };
}

function fenced(unit) {
  return /^\s*(```|~~~)/.test(unit);
}

function markersIn(unit) {
  return [...unit.matchAll(MARKER)].map((m) => m[1]);
}

function stripMarkers(unit) {
  return unit.replace(MARKER_AT, '').replace(/[ \t]+$/gm, '');
}

/** Lines of a body, fences kept whole, list items split from their neighbours. */
function units(body) {
  const lines = String(body ?? '').split('\n');
  const out = [];
  let fenced = false;
  let current = [];
  const flush = () => {
    if (current.length > 0) out.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fenced) flush();
      current.push(line);
      fenced = !fenced;
      if (!fenced) flush();
      continue;
    }
    if (fenced) {
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      out.push(line);
      continue;
    }
    if (ITEM_START.test(line) && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return out;
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function exempt(rel, prefixes) {
  return prefixes.some((prefix) => rel === prefix || rel.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

async function tracked(root) {
  try {
    const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root });
    return stdout.split('\0').filter((p) => p !== '');
  } catch {
    return null;
  }
}

async function workDiff(root) {
  let text = '';
  try {
    const { stdout } = await exec('git', ['diff', '--no-ext-diff', '--unified=0', 'HEAD'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    text = stdout;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    text = typeof error.stdout === 'string' ? error.stdout : '';
  }
  const files = parseDiff(text);
  let untracked = [];
  try {
    const { stdout } = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root });
    untracked = stdout.split('\0').filter((p) => p !== '');
  } catch {
    return { files };
  }
  for (const path of untracked) {
    let raw;
    try {
      raw = await readFile(resolve(root, path));
    } catch {
      continue;
    }
    if (raw.includes(0)) continue;
    files.push({ path, added: raw.toString('utf8').split('\n') });
  }
  return { files };
}

function parseDiff(text) {
  const files = [];
  let current = null;
  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2], added: [] };
      files.push(current);
      continue;
    }
    if (current && line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
  }
  return files;
}
