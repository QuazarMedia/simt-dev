// The tracker's shape is data, because it belongs to the repository being read.
//
// Hardcoding docs/plans, the word "review", or the column State would index
// this package's own documents and misread everyone else's. The file
// templates/plan/simt-dev.json is the format delivered with the tool. A
// repository that needs a different one writes simt-plan.json at its root,
// and any section it leaves out stays as the delivered file has it.
//
// That file is not a key of simt.json. init rewrites the manifest from the
// fields it owns, and a repository that has not adopted has no manifest at
// all; the template has to survive both.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI } from '../name.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILTIN_DIR = join(PACKAGE_ROOT, 'templates', 'plan');

export const DEFAULT_TEMPLATE = 'simt-dev';
export const USER_PLAN_FILE = 'simt-plan.json';

const KNOWN = new Set(['$comment', 'name', 'directories', 'id', 'columns', 'states', 'ready', 'dependency', 'wave', 'section']);
const ID_KEYS = new Set(['pattern', 'headers']);
const COLUMN_KEYS = new Set(['state', 'depends', 'title', 'evidence']);
const DIRECTORY_KEYS = new Set(['kind', 'word', 'path']);
const STATE_KEYS = new Set(['id', 'write', 'read', 'satisfies']);
const DEPENDENCY_KEYS = new Set(['empty', 'separators', 'notes', 'group']);
const WAVE_KEYS = new Set(['label', 'members']);
const SECTION_KEYS = new Set(['depth']);

// Read once, at load. Help and the parser have to name the same directories,
// and a second copy of this JSON in code would be the one that drifted.
const DEFAULT_BODY = readJson(join(BUILTIN_DIR, `${DEFAULT_TEMPLATE}.json`));

export const DEFAULT_DIRECTORIES = Array.isArray(DEFAULT_BODY?.directories)
  ? DEFAULT_BODY.directories.map((dir) => dir.path)
  : [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`the ${DEFAULT_TEMPLATE} plan template could not be read (${error.message})`);
  }
}

function remedyFor(source) {
  if (source === USER_PLAN_FILE) return `fix ${USER_PLAN_FILE}, or remove it to use the ${DEFAULT_TEMPLATE} template`;
  return `run: ${CLI} --help`;
}

function bad(source, message) {
  return { error: `${source}: ${message}`, remedy: remedyFor(source) };
}

function overlay(base, extra) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = overlay(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function headers(source, value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) return bad(source, `${field} must be a list of column headers`);
  const names = [];
  for (const header of value) {
    if (typeof header !== 'string' || header.trim() === '') return bad(source, `${field} has a header that is not text`);
    const name = header.trim().toLowerCase().replace(/\s+/g, ' ');
    if (/[|\n\r]/.test(name)) return bad(source, `${field} has a header containing a pipe or a newline`);
    names.push(name);
  }
  if (!allowEmpty && names.length === 0) return bad(source, `${field} needs at least one header`);
  return { names };
}

function pattern(source, value, field, flags = '') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    return bad(source, `${field} must be a pattern of at most 200 characters`);
  }
  try {
    return { re: new RegExp(value, flags) };
  } catch (error) {
    return bad(source, `${field} is not a valid pattern (${error.message})`);
  }
}

function directoryPath(root, value) {
  if (typeof value !== 'string' || value === '' || isAbsolute(value)) return null;
  const rel = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  const abs = resolve(root, rel);
  const back = relative(resolve(root), abs);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) return null;
  return back.split(sep).join('/');
}

function singular(kind) {
  return kind.endsWith('s') && kind.length > 1 ? kind.slice(0, -1) : kind;
}

function compileDirectories(source, value, root) {
  if (!Array.isArray(value) || value.length === 0) return bad(source, 'directories must list at least one directory');
  const directories = [];
  const kinds = new Set();
  const words = new Set();
  const paths = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    const where = `directories[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return bad(source, `${where} must be an object`);
    const extra = unknownKeys(entry, DIRECTORY_KEYS);
    if (extra.length > 0) return bad(source, `${where} has unknown ${extra.join(', ')}`);
    if (typeof entry.kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.kind)) {
      return bad(source, `${where}.kind must be a lower-case word`);
    }
    const path = directoryPath(root, entry.path);
    if (!path) return bad(source, `${where}.path must be a directory inside the repository`);
    const word = entry.word == null ? singular(entry.kind) : String(entry.word).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(word)) return bad(source, `${where}.word must be a lower-case word`);
    if (kinds.has(entry.kind)) return bad(source, `kind ${entry.kind} is listed twice`);
    if (words.has(word)) return bad(source, `word ${word} is listed twice`);
    if (paths.has(path)) return bad(source, `path ${path} is listed twice`);
    kinds.add(entry.kind);
    words.add(word);
    paths.add(path);
    directories.push({ kind: entry.kind, word, path });
  }
  return { directories };
}

function compileStates(source, value) {
  if (!Array.isArray(value) || value.length === 0) return bad(source, 'states must list at least one state');
  const read = new Map();
  const write = new Map();
  const known = new Set();
  const satisfies = new Set();
  const order = [];
  const stateNames = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    const where = `states[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return bad(source, `${where} must be an object`);
    const extra = unknownKeys(entry, STATE_KEYS);
    if (extra.length > 0) return bad(source, `${where} has unknown ${extra.join(', ')}`);
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.id)) return bad(source, `${where}.id must be a lower-case word`);
    if (typeof entry.write !== 'string' || entry.write.trim() === '' || /[|\n\r]/.test(entry.write)) {
      return bad(source, `${where}.write must be text without a pipe or a newline`);
    }
    if (!Array.isArray(entry.read) || entry.read.length === 0) return bad(source, `${where}.read must list the words that mean this state`);
    if (known.has(entry.id)) return bad(source, `state ${entry.id} is listed twice`);
    const display = entry.write.trim();
    const aliases = new Set([entry.id, display.toLowerCase()]);
    for (const alias of entry.read) {
      if (typeof alias !== 'string' || alias.trim() === '') return bad(source, `${where}.read has a word that is not text`);
      aliases.add(alias.trim().toLowerCase());
    }
    for (const alias of aliases) {
      if (read.has(alias) || write.has(alias)) return bad(source, `the word ${alias} is already a state`);
    }
    for (const alias of aliases) {
      read.set(alias, entry.id);
      write.set(alias, display);
    }
    known.add(entry.id);
    order.push(entry.id);
    stateNames.push(display);
    if (entry.satisfies === true) satisfies.add(entry.id);
    else if (entry.satisfies != null && entry.satisfies !== false) return bad(source, `${where}.satisfies must be true or false`);
  }
  if (satisfies.size === 0) return bad(source, 'one state must have satisfies true, or nothing can ever be ready');
  return { read, write, known, satisfies, order, stateNames };
}

function compile(body, source, root) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(source, 'the template must be a JSON object');
  const extra = unknownKeys(body, KNOWN);
  if (extra.length > 0) return bad(source, `unknown ${extra.join(', ')}`);
  for (const [key, allowed] of [
    ['id', ID_KEYS],
    ['columns', COLUMN_KEYS],
    ['dependency', DEPENDENCY_KEYS],
    ['wave', WAVE_KEYS],
    ['section', SECTION_KEYS],
  ]) {
    const value = body[key];
    if (value == null) return bad(source, `${key} is missing`);
    if (typeof value !== 'object' || Array.isArray(value)) return bad(source, `${key} must be an object`);
    const unexpected = unknownKeys(value, allowed);
    if (unexpected.length > 0) return bad(source, `${key} has unknown ${unexpected.join(', ')}`);
  }

  const directories = compileDirectories(source, body.directories, root);
  if (directories.error) return directories;
  const states = compileStates(source, body.states);
  if (states.error) return states;

  const idHeaders = headers(source, body.id.headers, 'id.headers');
  if (idHeaders.error) return idHeaders;
  const stateHeaders = headers(source, body.columns.state, 'columns.state');
  if (stateHeaders.error) return stateHeaders;
  const dependsHeaders = headers(source, body.columns.depends, 'columns.depends', { allowEmpty: true });
  if (dependsHeaders.error) return dependsHeaders;
  const titleHeaders = headers(source, body.columns.title, 'columns.title', { allowEmpty: true });
  if (titleHeaders.error) return titleHeaders;
  const evidenceHeaders = headers(source, body.columns.evidence, 'columns.evidence', { allowEmpty: true });
  if (evidenceHeaders.error) return evidenceHeaders;
  const waveLabel = headers(source, body.wave.label, 'wave.label');
  if (waveLabel.error) return waveLabel;
  const waveMembers = headers(source, body.wave.members, 'wave.members');
  if (waveMembers.error) return waveMembers;

  const idRe = pattern(source, body.id.pattern, 'id.pattern');
  if (idRe.error) return idRe;
  const groupRe = pattern(source, body.dependency.group, 'dependency.group', 'i');
  if (groupRe.error) return groupRe;

  if (!Array.isArray(body.dependency.empty)) return bad(source, 'dependency.empty must be a list of words');
  const empty = new Set();
  for (const token of body.dependency.empty) {
    if (typeof token !== 'string' || token.trim() === '') return bad(source, 'dependency.empty has a word that is not text');
    empty.add(token.trim().toLowerCase());
  }
  if (typeof body.dependency.separators !== 'string' || body.dependency.separators.length === 0 || body.dependency.separators.length > 8) {
    return bad(source, 'dependency.separators must be one to eight characters');
  }
  if (/[A-Za-z0-9\s\\]/.test(body.dependency.separators)) {
    return bad(source, 'dependency.separators must be punctuation');
  }
  if (typeof body.dependency.notes !== 'boolean') return bad(source, 'dependency.notes must be true or false');

  const depth = body.section.depth;
  if (!Number.isInteger(depth) || depth < 1 || depth > 6) return bad(source, 'section.depth must be from 1 to 6');
  const ready = body.ready;
  if (typeof ready !== 'string' || !states.known.has(ready)) return bad(source, 'ready must name a state');

  const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : source;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(name)) return bad(source, 'name must be a short word');

  // Longer words first, so a word that starts another (`plan` and `planning`)
  // is not cut off at the shorter one.
  const words = [...directories.directories].sort((a, b) => b.word.length - a.word.length).map((dir) => dir.word);
  let crossRe;
  try {
    crossRe = new RegExp(`^(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})s?\\s+(\\d+)\\s+(.+)$`, 'i');
  } catch (error) {
    return bad(source, `the directory words are not a valid reference (${error.message})`);
  }

  const byWord = new Map(directories.directories.map((dir) => [dir.word, dir.kind]));
  const doneWrite = body.states.find((entry) => entry.satisfies === true).write.trim();
  const { read, write } = states;

  return {
    format: {
      name,
      source,
      directories: directories.directories,
      byWord,
      order: states.order,
      ready,
      doneWrite,
      stateNames: states.stateNames,
      satisfies: states.satisfies,
      known: states.known,
      empty,
      separators: body.dependency.separators,
      notes: body.dependency.notes,
      idRe: idRe.re,
      idHeaders: idHeaders.names,
      stateHeaders: stateHeaders.names,
      dependsHeaders: dependsHeaders.names,
      titleHeaders: titleHeaders.names,
      evidenceHeaders: evidenceHeaders.names,
      waveLabel: waveLabel.names,
      waveMembers: waveMembers.names,
      crossRe,
      groupRe: groupRe.re,
      headingRe: new RegExp(`^(#{1,${depth}})\\s+(.*\\S)\\s*$`),
      readState(raw) {
        const plain = String(raw ?? '').replace(/\*\*/g, '').trim().toLowerCase();
        if (read.has(plain)) return read.get(plain);
        const token = plain.split(/[\s(]/)[0];
        return read.get(token) ?? (token || 'unknown');
      },
      canonical(input) {
        return write.get(String(input ?? '').trim().toLowerCase()) ?? null;
      },
    },
  };
}

/**
 * The format for this repository.
 *
 * The delivered template applies when the repository has no simt-plan.json.
 * A file that is present replaces the sections it names. A file that cannot
 * be read is an error: falling back to the delivered template would index
 * the wrong directories and mark the wrong row.
 *
 * @returns {Promise<{format: object}|{error: string, remedy: string}>}
 */
export async function loadFormat(root) {
  if (!DEFAULT_BODY || typeof DEFAULT_BODY !== 'object') {
    return bad(`the ${DEFAULT_TEMPLATE} plan template`, 'is not a JSON object');
  }
  const path = join(root, USER_PLAN_FILE);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return compile(DEFAULT_BODY, `the ${DEFAULT_TEMPLATE} plan template`, root);
    return bad(USER_PLAN_FILE, 'could not be read');
  }
  let user;
  try {
    user = JSON.parse(text);
  } catch (error) {
    return bad(USER_PLAN_FILE, `is not valid JSON (${error.message})`);
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) return bad(USER_PLAN_FILE, 'must be a JSON object');
  const body = overlay(DEFAULT_BODY, user);
  if (typeof user.name !== 'string' || user.name.trim() === '') body.name = 'simt-plan';
  return compile(body, USER_PLAN_FILE, root);
}
