import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { sourceRoots } from '../index/govern.mjs';
import { candidatePaths, loadLiveGraph } from '../index/live.mjs';
import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { readChanges } from '../sys/changes.mjs';
import { cmp } from '../util/sort.mjs';

/**
 * The tracked file a token names, however the reader spelled it.
 *
 * Git lists paths from the repository root, and a reader stands anywhere. Matching the
 * token verbatim meant `why journal.mjs` in `src/`, `./journal.mjs` and an absolute path
 * all answered "no such subject" for a file that is in the tree.
 */
export function resolvePathSubject(token, root, files) {
  // Through links, both sides: on macOS `/var` is `/private/var`, so the root as typed and
  // the cwd the process reports differ by a prefix and every relative path looks outside.
  const canonical = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const base = canonical(resolve(String(root)));
  // The token too: an absolute path handed in by the reader carries the spelling their
  // shell used, which is the prefix the cwd no longer has.
  const abs = canonical(resolve(canonical(process.cwd()), String(token)));
  const rel = relative(base, abs);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  const path = rel.split(sep).join('/');
  if (files.has(path)) return { path };
  try {
    if (statSync(abs).isDirectory()) return { directory: path };
  } catch {
    // Not a directory, not a tracked file: classification decides what else it may be.
  }
  return null;
}

export function witnessLines({ witnesses = {}, truncated }) {
  const rows = [];
  for (const tier of ['command', 'inherited', 'historical']) {
    for (const { id, witness } of witnesses[tier] ?? []) rows.push(`${tier.padEnd(11)}${id}  via ${witness.join(' -> ')}`);
  }
  if (truncated) rows.push('truncated  some witnesses exceeded the report limit');
  return rows;
}

function subjectFiles(token, root, files, symbols) {
  const located = resolvePathSubject(token, root, files);
  const path = located?.path ?? token.replace(/^\.\//u, '');
  if (files.has(path)) return { subject: token, kind: 'path', files: [path] };
  const directory = (located?.directory ?? path).replace(/\/+$/u, '');
  const children = [...files].filter((file) => directory === '.' || file.startsWith(`${directory}/`)).sort(cmp);
  if (children.length > 0) return { subject: token, kind: 'directory', files: children };
  const split = token.lastIndexOf('#');
  const namedPath = split < 0 ? null : token.slice(0, split);
  const name = token.slice(split + 1);
  const matches = [...new Set(symbols.filter((row) => row.name === name && (namedPath === null || row.path === namedPath))
    .map((row) => row.path))].sort(cmp);
  if (matches.length === 1) return { subject: token, kind: 'symbol', symbol: name, files: matches };
  if (matches.length > 1) return { error: `${name} is defined in ${matches.join(', ')}`, remedy: `pass <path>#${name}` };
  return null;
}

export async function reportSubjects(args, flags, { root, commands }, unavailable = null) {
  let graph;
  let changed = [];
  try {
    if (flags.changed === true) changed = candidatePaths((await readChanges(root)).files.map((path) => ({ path }))).map(({ path }) => path);
    if (flags.changed === true && changed.length === 0) {
      const payload = { ok: true, command: 'why', root, subjects: [], files: [], items: [], historical: [], witnesses: {},
        counts: [], truncated: false };
      if (isJson(flags)) emitJson(payload);
      else emit('no changed files');
      return EXIT.OK;
    }
    graph = await loadLiveGraph(root, { retainTargets: changed });
    if (graph.broken) throw new Error(graph.indexError?.message ?? 'the index cannot be read');
  } catch (error) {
    return fail(`could not read governance subjects (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a Git repository');
  }
  const files = new Set([...graph.files.map(({ path }) => path), ...changed]);
  const subjects = [];
  for (const token of flags.changed === true ? changed : args) {
    const found = subjectFiles(token, root, files, graph.symbols) ?? unavailable;
    if (!found || found.error) return fail(found?.error ?? `no such subject: ${token}`, EXIT.USAGE, found?.remedy);
    subjects.push(found);
  }
  const paths = [...new Set(subjects.flatMap((subject) => subject.files))].sort(cmp);
  const { explainGovernance } = await import('../index/why-graph.mjs');
  const facts = await explainGovernance(root, paths, { files, commands: new Set(commands), roots: sourceRoots(files) }, { graph });
  const counted = new Map();
  for (const path of paths) {
    for (const item of facts.current.get(path)) {
      const key = JSON.stringify([item.kind, item.id]);
      const row = counted.get(key) ?? { ...item, fileCount: 0 };
      row.fileCount += 1;
      counted.set(key, row);
    }
  }
  const counts = [...counted.values()].sort((a, b) => b.fileCount - a.fileCount || cmp(a.kind, b.kind) || cmp(a.id, b.id));
  const { basis, graphBasis, witnesses, truncated } = facts;
  const payload = { ok: true, command: 'why', root, subjects, files: paths, counts, witnesses, basis, graphBasis, truncated };
  if (isJson(flags)) emitJson(payload);
  else emit([`files     ${paths.length}`, ...counts.map(({ kind, id, fileCount }) => `${kind.padEnd(10)}${id}  ${fileCount} file(s)`),
    ...witnessLines(payload)].join('\n'));
  return EXIT.OK;
}
