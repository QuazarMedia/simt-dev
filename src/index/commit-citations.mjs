import { git, gitText } from '../sys/git.mjs';
import { GIT_SHA, parseNameLog } from '../sys/git-history.mjs';

const HISTORY_LIMIT = 500;
const META = 'last_commit_citations_sha';

export const CITATIONS_BASIS_SQL = `select value from meta where key = '${META}'`;
export const CITATIONS_PATH_SQL = `select path, adr_id as adr, sha from commit_citations
  where path in (select value from json_each(?)) order by position desc, path, adr_id`;

async function citedLog(root, revision) {
  const actual = ['log', '--no-merges', '--no-renames',
    '--format=%x00%H%x00%B%x00', '--name-only', '-z', `--max-count=${HISTORY_LIMIT + 1}`, revision, '--'];
  return parseNameLog(await git(root, actual), ['message']).map(({ sha, paths: files, message }) => ({
    sha, paths: files,
    ids: [...new Set(message.match(/\bADR-\d{3,}\b/giu)?.map((id) => id.toUpperCase()) ?? [])].sort(),
  }));
}

function rowsOf(commits) {
  return commits.flatMap(({ sha, ids, paths }) => paths.flatMap((path) => ids.map((adr) => ({ path, adr, sha }))));
}

export async function prepareCitations(root, old) {
  const head = await gitText(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true }) ?? '';
  if (head === old) return null;
  let append = Boolean(head && old && GIT_SHA.test(old) &&
    await git(root, ['merge-base', '--is-ancestor', old, head], { allowFailure: true }) !== null);
  const commits = head ? await citedLog(root, append ? `${old}..${head}` : head) : [];
  if (commits.length > HISTORY_LIMIT) append = false;
  return { head, append, commits: commits.slice(0, HISTORY_LIMIT).reverse() };
}

export async function readUnindexedCitations(root, paths) {
  if (!paths.length) return [];
  const head = await gitText(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
  const wanted = new Set(paths);
  return head ? rowsOf((await citedLog(root, head)).slice(0, HISTORY_LIMIT)).filter(({ path }) => wanted.has(path)) : [];
}

export function writeCitations(db, { head, append, commits }) {
  db.exec(`create table if not exists commit_citations(
    path text not null, adr_id text not null, sha text not null, position integer not null,
    primary key(path, adr_id, sha)
  ) without rowid;`);
  if (!append) db.exec('delete from commit_citations');
  const insert = db.prepare('insert or ignore into commit_citations values (?, ?, ?, ?)');
  const readMeta = db.prepare('select value from meta where key = ?');
  const latest = append ? Number(readMeta.get('commit_citations_position')?.value ?? 0) : 0;
  for (const [offset, commit] of commits.entries()) {
    for (const { path, adr, sha } of rowsOf([commit])) insert.run(path, adr, sha, latest + offset + 1);
  }
  const position = latest + commits.length;
  db.prepare('delete from commit_citations where position <= ?').run(position - HISTORY_LIMIT);
  const upsert = db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value');
  upsert.run(META, head);
  upsert.run('commit_citations_position', String(position));
}
