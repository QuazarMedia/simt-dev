import { git, gitText } from '../sys/git.mjs';
import { GIT_SHA, parseNameLog } from '../sys/git-history.mjs';
import { isTestPath } from '../testing/paths.mjs';
import { cmp } from '../util/sort.mjs';

export const COCHANGE_WINDOW = 500;
const HALF_LIFE = 100;
const SOURCE_CAP = 15;
const TEST_CAP = 8;
const PARTNER_CAP = 12;
const MIN_SUPPORT = 2;
const MIN_CONFIDENCE = 0.25;

export const COCHANGE_DDL = 'create table if not exists cochange('
  + 'src_path text not null, dst_path text not null, confidence real not null, '
  + 'lift real not null, support integer not null, decayed_weight real not null, '
  + 'primary key(src_path, dst_path)) without rowid';

export function parseCochangeLog(raw) {
  return parseNameLog(raw, ['parents']).map(({ sha, paths, parents }) => ({
    sha, paths, parents: parents.split(' ').filter(Boolean),
  }));
}

async function logRange(root, revision, { merges = false, limit = COCHANGE_WINDOW } = {}) {
  const args = ['log', '--topo-order', '--format=%x00%H%x00%P%x00', '--name-only', '--no-renames', '-z',
    '--max-count=' + limit];
  if (!merges) args.push('--no-merges');
  return parseCochangeLog(await git(root, [...args, revision, '--']));
}

function extendsHistory(rows, previous) {
  return rows.length > 0 && rows.length <= COCHANGE_WINDOW && rows.every(({ parents }, index) =>
    parents.length === 1 && parents[0] === (rows[index + 1]?.sha ?? previous));
}

/** Keep the old window only when Git proves the new history is a linear extension. */
export async function updateCochangeHistory(root, prior = null) {
  if (prior?.head && GIT_SHA.test(prior.head)) {
    const range = prior.head + '..HEAD';
    try {
      const updated = await logRange(root, range, { merges: true, limit: COCHANGE_WINDOW + 1 });
      if (extendsHistory(updated, prior.head)) {
        return { head: updated[0].sha, commits: [...updated.map(({ paths }) => paths), ...prior.commits].slice(0, COCHANGE_WINDOW),
          scanned: updated.length, rebuilt: false };
      }
    } catch {
      // A removed revision after a history rewrite cannot anchor the previous window.
    }
  }
  const head = await gitText(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
  if (head === null) return { head: '', commits: [], scanned: 0, rebuilt: prior?.head !== '' };
  if (prior?.head === head) return { ...prior, scanned: 0, rebuilt: false };
  const rows = await logRange(root, head);
  return { head, commits: rows.map(({ paths }) => paths), scanned: rows.length, rebuilt: true };
}

/** The input is newest first. Rejected commits still age the accepted observations. */
export function mineCochange(commits, { root = null, eligible = null } = {}) {
  const weights = new Map();
  const pairs = new Map();
  let total = 0;
  for (const [age, paths] of commits.slice(0, COCHANGE_WINDOW).entries()) {
    const unique = [...new Set(paths)].sort(cmp);
    if (!unique.length || unique.length > SOURCE_CAP + TEST_CAP) continue;
    const tests = unique.filter((path) => isTestPath(path, root)).length;
    if (tests > TEST_CAP || unique.length - tests > SOURCE_CAP) continue;
    const weight = 2 ** (-age / HALF_LIFE) / Math.log2(1 + unique.length);
    total += weight;
    const current = eligible === null ? unique : unique.filter((path) => eligible.has(path));
    for (const [index, path] of current.entries()) {
      weights.set(path, (weights.get(path) ?? 0) + weight);
      for (let next = index + 1; next < current.length; next += 1) {
        const key = path + '\0' + current[next];
        const pair = pairs.get(key) ?? { support: 0, weight: 0 };
        pair.support += 1;
        pair.weight += weight;
        pairs.set(key, pair);
      }
    }
  }

  const byPath = new Map();
  function add(src, dst, support, decayedWeight) {
    const confidence = decayedWeight / weights.get(src);
    if (confidence < MIN_CONFIDENCE) return;
    const lift = confidence * total / weights.get(dst);
    const rows = byPath.get(src) ?? [];
    rows.push({ src, dst, kind: 'cochange', confidence, lift, support, decayedWeight, weight: confidence });
    byPath.set(src, rows);
  }
  for (const [key, { support, weight }] of pairs) {
    if (support < MIN_SUPPORT) continue;
    const [src, dst] = key.split('\0', 2);
    add(src, dst, support, weight);
    add(dst, src, support, weight);
  }
  const rank = (a, b) => b.confidence - a.confidence || b.lift - a.lift || b.support - a.support || cmp(a.dst, b.dst);
  return [...byPath].sort(([a], [b]) => cmp(a, b)).flatMap(([, rows]) => rows.sort(rank).slice(0, PARTNER_CAP));
}

export async function buildCochange(root, prior, paths, { refresh = false } = {}) {
  const history = await updateCochangeHistory(root, prior);
  if (!refresh && prior?.head === history.head) return null;
  return { ...history, rows: mineCochange(history.commits, { root, eligible: paths }) };
}

export function writeCochange(db, history) {
  db.exec(COCHANGE_DDL);
  db.exec('delete from cochange');
  const insert = db.prepare('insert into cochange values (?, ?, ?, ?, ?, ?)');
  for (const { src, dst, confidence, lift, support, decayedWeight } of history.rows) {
    insert.run(src, dst, confidence, lift, support, decayedWeight);
  }
  const meta = db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value');
  meta.run('last_cochange_sha', history.head);
  meta.run('cochange_commits', JSON.stringify(history.commits));
}
