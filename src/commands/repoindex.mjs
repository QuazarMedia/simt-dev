// `simt index` rebuilds the local cache from git. The cache is not repository
// content: it is gitignored, and a second run with the same blobs writes the same
// rows (ADR-089).

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { SQLITE_FILE, reindex } from '../index/store.mjs';
import { openIndex } from '../index/open.mjs';
import { commandRoot } from '../repo-root.mjs';
import { git } from '../sys/git.mjs';

export async function indexCommand(args, flags) {
  if (args.length > 0) return fail(`unknown index argument ${args[0]}`, EXIT.USAGE, `run: ${CLI} index`);
  const root = commandRoot(flags);
  // The cache's own query surface. `search` and `rank` were reachable only by importing the
  // handle, so the only way to ask the index a question was to rebuild it and read the files.
  const wantsSearch = typeof flags.search === 'string' && flags.search !== '';
  const wantsRank = typeof flags.rank === 'string' && flags.rank !== '';
  if (wantsSearch || wantsRank) {
    if (wantsSearch && wantsRank) {
      return fail('index takes one of --search or --rank', EXIT.USAGE, `run: ${CLI} index --search "<task>"`);
    }
    const task = wantsSearch ? flags.search : flags.rank;
    const limit = flags.limit === undefined ? undefined : Number(flags.limit);
    const opened = await openIndex(root, { build: false });
    if (opened.ok !== true) {
      return fail(`could not open the index (${opened.error.message})`, EXIT.FAIL, `run: ${CLI} index`);
    }
    try {
      const answer = wantsSearch ? await opened.search(task, { limit }) : await opened.rank(task, { limit });
      if (answer.ok !== true) return fail(answer.error.message, EXIT.FAIL, `run: ${CLI} index`);
      const rows = Array.isArray(answer.data) ? answer.data : [];
      const payload = { ok: true, command: 'index', root, asked: wantsSearch ? 'search' : 'rank', task, rows };
      if (isJson(flags)) {
        emitJson(payload);
        return EXIT.OK;
      }
      const lines = rows.map((row) => `${String(row.score ?? 0).padStart(8)}  ${row.path}${row.kind === undefined ? '' : `  ${row.kind}`}`);
      emit(lines.length === 0 ? '(no rows)' : lines.join('\n'));
      return EXIT.OK;
    } finally {
      if (typeof opened.close === 'function') opened.close();
    }
  }
  // `--open` asks what the index already holds instead of rebuilding it. The cache is a
  // question-answering structure, and before this the only way to ask it was to pay for a
  // rebuild: an empty answer and a stale answer looked the same from outside.
  if (flags.open === true) {
    const opened = await openIndex(root, { build: false });
    if (opened.ok !== true) {
      return fail(`could not open the index (${opened.error.message})`, EXIT.FAIL, `run: ${CLI} index`);
    }
    try {
      const status = await opened.status();
      if (status.ok !== true) return fail(status.error.message, EXIT.FAIL, `run: ${CLI} index`);
      const payload = { ok: true, command: 'index', root, open: true, ...status.data };
      if (isJson(flags)) {
        emitJson(payload);
        return EXIT.OK;
      }
      emit([
        `files    ${status.data.counts.files}`,
        `symbols  ${status.data.counts.symbols}`,
        `edges    ${status.data.counts.edges}`,
        `stale    ${status.data.stale ? 'yes - run: simt index' : 'no'}`,
      ].join('\n'));
      return EXIT.OK;
    } finally {
      if (typeof opened.close === 'function') await opened.close();
    }
  }
  let result;
  try {
    result = await reindex(root, {
      embed: flags.embed === true,
      allowRemote: flags.allowRemote === true,
    });
  } catch (error) {
    if (error?.code === 'INDEX_BUSY') {
      return fail(`could not index this repository (${error.message})`, EXIT.FAIL, 'wait a moment and run the index again');
    }
    return fail(
      `could not index this repository (${error.message})`,
      EXIT.UNSUPPORTED,
      'run this inside a git repository',
    );
  }
  const file = SQLITE_FILE;
  const ignored = await isIgnored(root, file);
  const payload = { ok: true, command: 'index', root, file, ignored, ...result };
  if (isJson(flags)) {
    emitJson(payload);
    return EXIT.OK;
  }
  const lines = [
    `files    ${result.files}`,
    `updated  ${result.updated}`,
    `removed  ${result.removed}`,
    `skipped  ${result.skipped ?? 0}`,
    `symbols  ${result.symbols}`,
    `edges    ${result.edges}`,
    `ms       ${result.ms}`,
  ];
  if (result.parsers === 'missing') lines.push('note     index.parsers did not load, so the built-in extractors ran');
  if (!ignored) lines.push(`note     ${file} is not gitignored, and the cache is not meant to be committed`);
  emit(lines.join('\n'));
  return EXIT.OK;
}

async function isIgnored(root, file) {
  try {
    await git(root, ['check-ignore', '-q', '--', file]);
    return true;
  } catch {
    return false;
  }
}
