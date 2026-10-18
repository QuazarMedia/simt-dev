// `simt index` rebuilds the local cache from git. The cache is not repository
// content: it is gitignored, and a second run with the same blobs writes the same
// rows (ADR-089).

import { execFile } from 'node:child_process';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { JSONL_FILE, SQLITE_FILE, reindex } from '../index/store.mjs';

export async function indexCommand(args, flags) {
  if (args.length > 0) return fail(`unknown index argument ${args[0]}`, EXIT.USAGE, `run: ${CLI} index`);
  const root = flags.root ?? process.cwd();
  let result;
  try {
    result = await reindex(root);
  } catch (error) {
    return fail(
      `could not index this repository (${error.message})`,
      EXIT.UNSUPPORTED,
      'run this inside a git repository',
    );
  }
  const file = result.backend === 'sqlite' ? SQLITE_FILE : JSONL_FILE;
  const ignored = await isIgnored(root, file);
  const payload = { ok: true, command: 'index', root, file, ignored, ...result };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const lines = [
    `index    ${result.backend}`,
    `files    ${result.files}`,
    `updated  ${result.updated}`,
    `removed  ${result.removed}`,
    `ms       ${result.ms}`,
  ];
  if (!ignored) lines.push(`note     ${file} is not gitignored, and the cache is not meant to be committed`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

function isIgnored(root, file) {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', '--', file], { cwd: root }, (error) => {
      resolve(!error);
    });
  });
}
