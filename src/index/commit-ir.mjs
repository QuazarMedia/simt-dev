import { isTestPath } from '../testing/paths.mjs';
import { cmp } from '../util/sort.mjs';
import { fieldQueryTerms, fieldTokens, ftsQuote, scoreFieldRows } from './bm25f.mjs';

export const COMMIT_SOURCE_CAP = 15;
export const COMMIT_TEST_CAP = 8;
export const COMMIT_BODY_BYTES = 512;
const AGE_HALF_LIFE = 150;
export const COMMIT_FTS_LIMIT = 80;

export const COMMIT_FTS_DDL = `create virtual table if not exists commit_fts using fts5(
  sha UNINDEXED,
  age UNINDEXED,
  file_count UNINDEXED,
  files_json UNINDEXED,
  subject,
  body,
  tokenize = "unicode61 remove_diacritics 2"
)`;

const round = (value) => Math.round(value * 1e6) / 1e6;

export function truncateUtf8(text, maxBytes = COMMIT_BODY_BYTES) {
  const input = String(text ?? '');
  if (Buffer.byteLength(input) <= maxBytes) return input;
  let used = 0;
  let out = '';
  for (const ch of input) {
    const next = Buffer.byteLength(ch);
    if (used + next > maxBytes) break;
    used += next;
    out += ch;
  }
  return out;
}

export function isUntangledCommit(paths, root = null) {
  const unique = [...new Set(paths)];
  if (!unique.length || unique.length > COMMIT_SOURCE_CAP + COMMIT_TEST_CAP) return false;
  const tests = unique.filter((path) => isTestPath(path, root)).length;
  return tests <= COMMIT_TEST_CAP && unique.length - tests <= COMMIT_SOURCE_CAP;
}

export function buildCommitFtsRows(commitRecords, { root = null, eligible = null } = {}) {
  const rows = [];
  for (const [age, record] of (commitRecords ?? []).entries()) {
    const unique = [...new Set(record?.paths ?? [])].sort(cmp);
    if (!isUntangledCommit(unique, root)) continue;
    const liveFiles = eligible === null ? unique : unique.filter((path) => eligible.has(path));
    if (!liveFiles.length) continue;
    const subject = fieldTokens(record.subject ?? '');
    const body = fieldTokens(truncateUtf8(record.body ?? '', COMMIT_BODY_BYTES));
    if (!subject && !body) continue;
    rows.push({
      sha: record.sha ?? '',
      age,
      fileCount: unique.length,
      filesJson: JSON.stringify(liveFiles),
      subject,
      body,
      rawSubject: String(record.subject ?? '').trim(),
    });
  }
  return rows;
}

export function writeCommitFts(db, commitFtsRows) {
  db.exec(COMMIT_FTS_DDL);
  db.exec('delete from commit_fts');
  const insert = db.prepare(
    'insert into commit_fts(sha, age, file_count, files_json, subject, body) values (?, ?, ?, ?, ?, ?)',
  );
  for (const row of commitFtsRows ?? []) {
    insert.run(row.sha, row.age, row.fileCount, row.filesJson, row.subject, row.body);
  }
  db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
    .run('commit_fts', '1');
}

function aggregateCommitHits(scoredCommits, allowPath, limit) {
  const byFile = new Map();
  for (const { sha, age, fileCount, files, bm25, subject } of scoredCommits) {
    if (!(bm25 > 0) || !Array.isArray(files) || !files.length) continue;
    const decay = 2 ** (-Math.max(0, Number(age) || 0) / AGE_HALF_LIFE);
    const sizePenalty = 1 / Math.log2(1 + Math.max(1, Number(fileCount) || files.length));
    const commitScore = bm25 * decay * sizePenalty;
    if (!(commitScore > 0)) continue;
    for (const path of files) {
      if (allowPath && !allowPath(path)) continue;
      const list = byFile.get(path) ?? [];
      list.push({ sha, score: commitScore, subject });
      byFile.set(path, list);
    }
  }
  const hits = [];
  for (const [path, commits] of byFile) {
    commits.sort((a, b) => b.score - a.score || cmp(a.sha, b.sha));
    const max1 = commits[0]?.score ?? 0;
    const max2 = commits[1]?.score ?? 0;
    const score = round(0.70 * max1 + 0.30 * max2);
    if (score > 0) {
      hits.push({
        path,
        score,
        commits: commits.slice(0, 2).map(({ sha, score: s, subject }) => ({
          sha, score: round(s), ...(subject ? { subject } : {}),
        })),
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score || cmp(a.path, b.path)).slice(0, limit);
}

export function scoreCommitRows(rows, task, { allowPath = null, limit = 30 } = {}) {
  const terms = fieldQueryTerms(task);
  if (!terms.length || !Array.isArray(rows) || !rows.length) return [];
  const scores = scoreFieldRows(rows, terms, {
    columns: ['subject', 'body'],
    weights: [2.0, 1.0],
    bParams: { subject: 0.40, body: 0.65 },
  });
  const scored = rows.map((row, index) => ({
    sha: row.sha ?? '',
    age: row.age ?? 0,
    fileCount: row.fileCount ?? row.file_count ?? 1,
    files: row.files ?? (typeof row.filesJson === 'string' ? JSON.parse(row.filesJson) : []),
    bm25: scores[index] ?? 0,
    subject: row.rawSubject ?? row.subject ?? '',
  }));
  return aggregateCommitHits(scored, allowPath, limit);
}

export function commitIrQuery(task) {
  const terms = fieldQueryTerms(task);
  if (!terms.length) return null;
  return terms.map(ftsQuote).join(' OR ');
}

export function scoreCommitMatches(matched, { allowPath = null, limit = 30 } = {}) {
  if (!Array.isArray(matched) || !matched.length) return [];
  const scored = matched.map((row) => {
    let files = [];
    try {
      const parsed = JSON.parse(row.files_json ?? '[]');
      if (Array.isArray(parsed)) files = parsed;
    } catch {
      files = [];
    }
    return {
      sha: row.sha,
      age: row.age,
      fileCount: row.file_count,
      files,
      bm25: row.score,
    };
  });
  return aggregateCommitHits(scored, allowPath, limit);
}
