// `simt why [path]` lists what governs a file (R25, ADR-093).
//
// With a path, one line per decision, rule, skill, gate and lesson. With no
// path, the Affects tokens that name nothing this tree contains. The file list
// is `git ls-files`. The index is not rebuilt: governance is the records, and
// writing the cache to answer a question would change the tree.

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { FORMATTABLE, GATES } from '../hooks/gates.mjs';
import {
  decisionHits,
  lessonPaths,
  scopeHits,
  scopePaths,
  sortHits,
  sourceRoots,
  unresolvedAffects,
} from '../index/govern.mjs';

const exec = promisify(execFile);

const RULE_DIRS = ['rules', 'rules/stacks', 'rules/mdc', '.simt-dev/profiles'];

export async function whyCommand(args, flags, commands = []) {
  if (args.length > 1) return fail(`unknown why argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} why [path]`);
  const root = flags.root ?? process.cwd();
  const listed = await tracked(root);
  if (listed.error) return listed.error;
  const files = new Set(listed.files);
  const ctx = { files, commands: new Set(commands), roots: sourceRoots(files) };
  const records = await decisions(root);
  const target = args[0];
  if (!target) return reportUnresolved(root, flags, unresolvedAffects(records, ctx));
  if (!files.has(target)) return fail(`not in the tree: ${target}`, EXIT.USAGE, `pass a path git tracks`);
  const corpus = await loadCorpus(root);
  const { hits } = decisionHits(records, target, ctx);
  const items = sortHits([...hits, ...scopeHits(target, corpus)]);
  const payload = { ok: true, command: 'why', root, path: target, items };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const lines = items.map((item) => `${item.kind.padEnd(10)}${item.id}  ${item.detail}`);
  emit(lines.length > 0 ? lines.join('\n') : 'none', { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

function reportUnresolved(root, flags, unresolved) {
  const payload = { ok: true, command: 'why', root, unresolved };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const lines = unresolved.map((item) => `UNRESOLVED-AFFECTS  ${item.token}  ${item.id}`);
  emit([`unresolved  ${unresolved.length}`, ...lines].join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function tracked(root) {
  try {
    const { stdout } = await exec('git', ['ls-files'], { cwd: root, maxBuffer: 16 << 20 });
    return { files: stdout.split('\n').filter(Boolean) };
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

async function decisions(root) {
  const dir = join(root, 'docs', 'decisions');
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => /^ADR-\d{3}-.*\.md$/.test(name)).sort();
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8');
    const id = /^ADR-\d{3}/.exec(name)[0];
    const heading = /^#\s+(.*)$/m.exec(text)?.[1] ?? id;
    const title = heading.replace(/^ADR-\d{3}\s+[—–-]\s+/, '');
    records.push({ id, title, text });
  }
  return records;
}

async function loadCorpus(root) {
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

async function ruleScopes(root) {
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

async function lessonScopes(root) {
  const dir = join(root, 'docs', 'lessons');
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const lessons = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8');
    const paths = lessonPaths(text);
    if (paths.length === 0) continue;
    const id = name.replace(/\.md$/, '');
    const detail = /^#\s+(.*)$/m.exec(text)?.[1] ?? id;
    lessons.push({ id, detail, paths });
  }
  return lessons;
}

async function gateCommands(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
    const commands = parsed?.gates?.commands;
    return commands && typeof commands === 'object' ? commands : {};
  } catch {
    return {};
  }
}
