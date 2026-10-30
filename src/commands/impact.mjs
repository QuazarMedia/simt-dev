// `simt impact` reports who a file or an export reaches (R23, ADR-096).
//
// Importers, the tests that cover them, the decisions and rules that govern
// the file, the CODEOWNERS line, and — when a workspace is configured —
// another repository that references a contract this change touches.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { discover } from '../compare/discover.mjs';
import { extract } from '../index/extract.mjs';
import { importEdges, readEntries } from '../index/gate.mjs';
import {
  contractReferences,
  dependents,
  filesExporting,
  isContractPath,
  ownersOf,
  relatedContracts,
} from '../index/impact.mjs';
import { decisionHits, scopeHits, sortHits, sourceRoots } from '../index/govern.mjs';
import { decisionRecords, ruleScopes } from './why.mjs';
import { resolveWorkspace } from '../workspace.mjs';

const exec = promisify(execFile);
const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'yaml', 'yml', 'md', 'toml', 'xml', 'py', 'go', 'kt', 'java', 'rs']);
const READ_CAP = 256 * 1024;
const FILE_CAP = 2000;

export async function impactCommand(args, flags, commands = []) {
  if (args.length > 1) return fail(`unknown impact argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} impact <file|symbol>`);
  const target = args[0];
  if (!target) return fail(`a file or a symbol is required`, EXIT.USAGE, `run: ${CLI} impact <file|symbol>`);
  const root = flags.root ?? process.cwd();
  const listed = await tracked(root);
  if (listed.error) return listed.error;
  const files = new Set(listed.files);
  const entries = await readEntries(root, files);
  const imports = importEdges(entries);
  const symbols = entries.flatMap((entry) => (entry.lang ? extract(entry.path, entry.text, entry.lang).symbols : []));
  const resolved = resolveTarget(target, files, symbols);
  if (resolved.error) return resolved.error;
  const reach = dependents(resolved.file, imports);
  const governs = await governance(root, resolved.file, files, commands);
  const owners = await readOwners(root, resolved.file);
  const contracts = await contractsFor(root, listed.files, resolved, reach.importers);
  const consumers = await consumersFor(root, flags, basename(root), contracts);
  const truncated = reach.truncated || consumers.truncated;
  const payload = {
    ok: true,
    command: 'impact',
    root,
    file: resolved.file,
    symbol: resolved.symbol,
    importers: reach.importers,
    tests: reach.tests,
    governs,
    owners,
    consumers: consumers.references,
    truncated,
  };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  emit(render(payload), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

function resolveTarget(target, files, symbols) {
  if (files.has(target)) return { file: target, symbol: '' };
  const exported = filesExporting(target, symbols);
  if (exported.length === 1) return { file: exported[0], symbol: target };
  if (exported.length === 0) {
    return { error: fail(`not a file or an export: ${target}`, EXIT.USAGE, `pass a path git tracks, or the name of one export`) };
  }
  return {
    error: fail(
      `${target} is exported by ${exported.join(', ')}`,
      EXIT.USAGE,
      `pass the path of the export you mean`,
    ),
  };
}

async function governance(root, file, files, commands) {
  const records = await decisionRecords(root);
  const rules = await ruleScopes(root);
  const ctx = { files, commands: new Set(commands), roots: sourceRoots(files) };
  const { hits } = decisionHits(records, file, ctx);
  return sortHits([...hits, ...scopeHits(file, { rules })]);
}

async function readOwners(root, file) {
  for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    try {
      return ownersOf(await readFile(join(root, path), 'utf8'), file);
    } catch {
      // The next location may hold the file. GitHub reads the first that exists.
    }
  }
  return [];
}

async function contractsFor(root, files, resolved, importers) {
  const contracts = [];
  for (const path of files) {
    if (!isContractPath(path) && !mightSniff(path)) continue;
    let text = '';
    try {
      text = await readFile(join(root, path), 'utf8');
    } catch {
      continue;
    }
    if (!isContractPath(path) && !sniffs(text)) continue;
    contracts.push({ path, text });
  }
  return relatedContracts(contracts, { file: resolved.file, symbol: resolved.symbol, importers });
}

async function consumersFor(root, flags, repoName, contracts) {
  if (contracts.length === 0) return { references: [], truncated: false };
  const workspace = await resolveWorkspace(flags);
  if (!workspace.root) return { references: [], truncated: false };
  const found = await discover(workspace.root);
  if (found.shape !== 'workspace') return { references: [], truncated: false };
  const here = resolve(root);
  const files = [];
  let truncated = false;
  for (const repo of found.repos) {
    if (resolve(repo) === here) continue;
    const listed = await tracked(repo);
    if (listed.error) continue;
    const name = basename(repo);
    let read = 0;
    for (const path of listed.files) {
      if (!textExt(path)) continue;
      if (read >= FILE_CAP) {
        truncated = true;
        break;
      }
      read += 1;
      try {
        const text = await readFile(join(repo, path), 'utf8');
        if (text.length > READ_CAP) continue;
        files.push({ repo: name, path, text });
      } catch {
        // A file git lists and the worktree no longer has is not a consumer.
      }
    }
  }
  const refs = contractReferences(contracts, repoName, files);
  return { references: refs.references, truncated: truncated || refs.truncated };
}

function render(payload) {
  const lines = [`file      ${payload.file}`];
  if (payload.symbol) lines.push(`symbol    ${payload.symbol}`);
  for (const path of payload.importers) lines.push(`importer  ${path}`);
  for (const path of payload.tests) lines.push(`test      ${path}`);
  for (const hit of payload.governs) lines.push(`${hit.kind.padEnd(10)}${hit.id}  ${hit.detail}`);
  for (const owner of payload.owners) lines.push(`owner     ${owner}`);
  for (const consumer of payload.consumers) lines.push(`consumer  ${consumer.repo}/${consumer.path}  ${consumer.contract}`);
  if (payload.truncated) lines.push('truncated  1');
  return lines.join('\n');
}

function mightSniff(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext === 'json' || ext === 'yaml' || ext === 'yml';
}

function sniffs(text) {
  const head = text.slice(0, 500);
  return head.includes('"openapi"') || head.includes('"$schema"');
}

function textExt(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return TEXT_EXT.has(base.slice(dot + 1).toLowerCase());
}

async function tracked(root) {
  try {
    // `-z`: without it git C-quotes a non-ASCII path and the reader's real
    // filename never matches it (review 0003 Q39).
    const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 16 << 20 });
    return { files: stdout.split('\0').filter(Boolean) };
  } catch (error) {
    return {
      error: fail(
        `could not read the tree (${error.message})`,
        EXIT.UNSUPPORTED,
        'run this inside a git repository',
      ),
    };
  }
}
