import { realpath } from 'node:fs/promises';

import { coverage } from '../index/coverage.mjs';
import { importEdges } from '../index/gate.mjs';
import { langOf } from '../index/store.mjs';
import { readLocalBytes } from '../knowledge/collect.mjs';
import { ALWAYS_DENIED } from '../knowledge/corpus.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { readChanges } from '../sys/changes.mjs';
import { git, gitPaths } from '../sys/git.mjs';
import { resolveScope } from '../work/artifacts.mjs';
import { readWork } from '../work/effective.mjs';
import { resolveWorkValidator } from '../work/validators.mjs';
import { selectVerification } from './select.mjs';

const markdown = (path) => /\.(?:md|markdown)$/i.test(path);
const denied = (path) => path.split('/').some((part) =>
  ALWAYS_DENIED.includes(part) || /^(?:\.env(?:\.|$)|\.ssh$|\.gnupg$)/.test(part));

const changedPair = (rows, path) => rows.find(({ from, to }) => from === path || to === path);

function typedKinds(text, kind, gone) {
  const kinds = ['structure', 'semantic-review'];
  if (gone || /\]\(|^\s*\[[^\]]+\]:/m.test(text)) kinds.push('links');
  if (/^sources\s*:|<!--\s*claim:/m.test(text)) kinds.push('source-support');
  if (/^type:\s*["']?template\b|generated[^\n]*do not edit/im.test(text)) kinds.push('generation');
  if (kind === 'recipe' || /^type:\s*["']?procedure\b|^#\s*@recipe\s/m.test(text)) kinds.push('procedure');
  if (kind === 'remote-object') kinds.push('remote-check');
  return kinds;
}

async function codeClosure({ root, paths, indexed, read, work, scope, live, imports }) {
  const sourcePaths = paths.filter((path) => langOf(path, root) !== '');
  if (sourcePaths.length === 0) return new Map();
  const allowed = (path) => {
    const owner = resolveScope(work.scopes, path);
    return !denied(path) && !owner.ignored && (owner.scope === scope.id || owner.error?.kind === 'none');
  };
  if (imports) {
    imports = imports.filter(({ src, dst }) => allowed(src) && allowed(dst));
  } else {
    const entries = [];
    for (const path of new Set([...indexed.keys(), ...sourcePaths])) {
      if (!allowed(path)) continue;
      const lang = langOf(path, root);
      if (lang === '') continue;
      entries.push({ path, lang, text: await read(path) ?? '' });
    }
    imports = importEdges(entries);
  }
  return new Map(sourcePaths.map((path) => [
    path, coverage({ imports }, [path], { root }).filter(live),
  ]));
}

export async function selectLocalVerification(inputRoot, { scopeId, staged = false, extraPaths = [], changes, imports, work }) {
  const root = await realpath(inputRoot);
  work ??= await readWork(root);
  if (!work.ok) return { error: work.problems[0].message, remedy: work.problems[0].remedy };
  const scope = work.scopes.find(({ id }) => id === scopeId);
  if (scope === undefined) return { error: `no declared work scope ${scopeId}`, remedy: 'run simt work inspect to see the declared scopes' };

  changes ??= await readChanges(root, { staged });
  const index = await gitPaths(root, ['ls-files', '--stage']);
  const indexed = new Map();
  for (const row of index) {
    const tab = row.indexOf('\t');
    const [mode, blob, stage] = row.slice(0, tab).split(' ');
    if (tab !== -1 && /^100[67]/.test(mode) && stage === '0') indexed.set(row.slice(tab + 1), blob);
  }

  const pending = [];
  const paths = [];
  let omitted = 0;
  for (const path of [...new Set([...changes.files, ...extraPaths])].sort()) {
    const owner = resolveScope(work.scopes, path);
    if (denied(path) || owner.ignored) {
      omitted += 1;
      continue;
    }
    if (owner.scope === scopeId) paths.push(path);
    else pending.push({ path, reason: owner.error?.kind === 'conflict' ? 'ambiguous-scope'
      : owner.scope === null ? 'unmapped-path' : 'outside-selected-scope' });
  }

  const deleted = new Set(changes.deleted);
  const renamedFrom = new Set(changes.renames.map(({ from }) => from));
  const live = (path) => !deleted.has(path) && !renamedFrom.has(path);
  const read = async (path) => {
    if (!indexed.has(path) || !live(path)) return null;
    if (staged) return git(root, ['cat-file', 'blob', indexed.get(path)], { allowFailure: true, maxBuffer: 256 * 1024 });
    return (await readLocalBytes(root, path))?.toString('utf8') ?? null;
  };
  const closures = await codeClosure({ root, paths, indexed, read, work, scope, live, imports: staged ? undefined : imports });
  const obligations = [];
  for (const path of paths) {
    const tests = closures.get(path) ?? [];
    if (tests.length > 0) {
      obligations.push({ id: `source:${path}`, kind: 'source', paths: [path], tests, needsIndependent: false });
      continue;
    }
    if (!markdown(path) && scope.kind !== 'remote-object') {
      pending.push({ path, reason: 'unmapped-path' });
      continue;
    }
    const rename = changedPair(changes.renames, path);
    const text = await read(path);
    if (live(path) && text === null && !rename && scope.kind !== 'remote-object') {
      pending.push({ path, reason: 'source-unavailable' });
    }
    const kinds = typedKinds(text ?? '', scope.kind, !live(path) || rename !== undefined);
    for (const kind of kinds) {
      obligations.push({ id: `${kind}:${path}`, kind, paths: [path], needsIndependent: scope.independent?.includes(kind) ?? false });
    }
  }

  const { manifest } = await loadManifest(root);
  const declarations = [
    ...scope.validators.map((command, i) => ({
      id: `legacy-validator-${i + 1}`, command, covers: ['structure'], mandatory: true,
    })),
    ...(scope.checks ?? []),
  ];
  const checks = await Promise.all(declarations.map((check) => resolveWorkValidator(root, check, manifest?.gates?.commands)));
  const typed = obligations.filter(({ kind }) => kind !== 'source');
  const local = checks.filter(({ available }) => available).map((check) => ({
    ...check, class: 'document',
    covers: typed.filter(({ kind }) => check.coverage.includes(kind)).map(({ id }) => id),
  }));
  const sourceTests = [...new Set([...closures.values()].flat())].sort();
  const selection = selectVerification({ changed: paths, closure: sourceTests, typed, validators: local });
  const obligationsById = new Map(typed.map((obligation) => [obligation.id, obligation]));
  for (const item of selection.unverified) {
    const obligation = obligationsById.get(item.obligation);
    const declared = checks.filter(({ coverage }) => coverage.includes(obligation.kind));
    if (obligation.kind === 'semantic-review') item.reason = 'human-review-required';
    else if (obligation.kind === 'remote-check') item.reason = 'remote-check-unavailable-locally';
    else if (item.reason === 'no-admissible-validator' && declared.length > 0) {
      item.reason = declared.map(({ reason }) => reason).filter(Boolean).sort().join(',') || item.reason;
    }
  }
  if (pending.length > 0) selection.status = 'unverified';
  selection.claimsGreen = false;
  return {
    root, scope: scopeId, basis: staged ? 'staged' : 'worktree',
    selection, obligations, checks,
    selectedChecks: local.filter(({ id }) => selection.selected.document.includes(id)),
    pending, omitted, sourceTests,
    renames: changes.renames.filter(({ from, to }) => paths.includes(from) && paths.includes(to)),
    deleted: changes.deleted.filter((path) => paths.includes(path)),
    executed: false,
  };
}
