import { cmp } from '../util/sort.mjs';
import { collectFileTerms, SIGNATURE_TERMS, smoothedIdf, sparseTfIdfCosine } from './lexical.mjs';
import { readSqliteBatch, readSqliteRows } from './persist.mjs';

const SCHEMA = `
create table if not exists lexical_files(source_id integer primary key);
create table if not exists file_terms(
  source_id integer not null,
  term text not null,
  tf integer not null check(tf > 0),
  primary key (source_id, term)
) without rowid;
create table if not exists term_stats(
  term text primary key,
  df integer not null check(df >= 0),
  cf integer not null check(cf >= df)
) without rowid;
create index if not exists idx_term_stats_empty on term_stats(df) where df = 0;
create index if not exists idx_file_terms_term on file_terms(term, source_id);
create view if not exists file_signatures as
  with weights as (
    select s.path, ft.term,
      ln(1.0 + ft.tf) * ln(1.0 + (corpus.documents - ts.df + 0.5) / (ts.df + 0.5)) as weight
    from file_terms ft
    join sources s on s.id = ft.source_id
    join term_stats ts on ts.term = ft.term
    cross join (select count(*) as documents from lexical_files) corpus
  ), ranked as (
    select path, term, weight, row_number() over (partition by path order by weight desc, term) as position
    from weights
  )
  select path, term, weight, position from ranked where position <= ${SIGNATURE_TERMS};
`;

/** Prepared per build so reindexing a file does not scan the old term corpus. */
export function lexicalWriter(db, { enabled, invalidated }) {
  db.exec(SCHEMA);
  if (invalidated) db.exec('delete from file_terms; delete from term_stats; delete from lexical_files');
  if (!enabled) return null;

  const decrement = db.prepare(`update term_stats set df = df - 1,
    cf = cf - (select tf from file_terms where source_id = ?1 and file_terms.term = term_stats.term)
    where term in (select term from file_terms where source_id = ?1)`);
  const removeTerms = db.prepare('delete from file_terms where source_id = ?');
  const removeFile = db.prepare('delete from lexical_files where source_id = ?');
  const addFile = db.prepare('insert into lexical_files(source_id) values (?)');
  const addTerms = db.prepare('insert into file_terms(source_id, term, tf) select ?, key, value from json_each(?)');
  const increase = db.prepare(`insert into term_stats(term, df, cf)
    select key, 1, value from json_each(?) where true
    on conflict(term) do update set df = df + 1, cf = cf + excluded.cf`);
  const trim = db.prepare('delete from term_stats where df = 0');
  return {
    drop(sourceId) {
      decrement.run({ 1: sourceId });
      removeTerms.run(sourceId);
      removeFile.run(sourceId);
    },
    add(sections, ids) {
      for (const [path, terms] of collectFileTerms(sections)) {
        const sourceId = ids.get(path)?.sourceId;
        if (sourceId === undefined) continue;
        const data = JSON.stringify(Object.fromEntries(terms));
        addFile.run(sourceId);
        addTerms.run(sourceId, data);
        increase.run(data);
      }
      trim.run();
    },
  };
}

export async function readLexicalStats(root) {
  const { results, error } = await readSqliteBatch(root, [
    ['select count(*) as documents from lexical_files'],
    ['select term, df, cf from term_stats order by term'],
  ]);
  const [counts, terms] = results ?? [[], []];
  return {
    documents: counts[0]?.documents ?? 0,
    terms: new Map(terms.map(({ term, df, cf }) => [term, { df, cf }])),
    error,
  };
}

export async function nativeConceptualPartners(root, sources, { limit = 60 } = {}) {
  const list = [...sources].sort(cmp);
  if (!list.length) return [];
  const json = JSON.stringify(list);
  const { rows, error } = await readSqliteRows(root,
    `with anchor_sources as (
       select id, path from sources where kind = 'blob' and path in (select value from json_each(?))
     ), corpus as (
       select count(*) as documents from lexical_files
     ), anchor_weights as (
       select a.path as path, ft.term, ft.tf, ts.df, c.documents,
         ln(1.0 + ft.tf) * ln(1.0 + (c.documents - ts.df + 0.5) / (ts.df + 0.5)) as weight
       from anchor_sources a
       join file_terms ft on ft.source_id = a.id
       join term_stats ts on ts.term = ft.term
       cross join corpus c
     ), anchor_top as (
       select path, term, tf, df, documents,
         row_number() over (partition by path order by weight desc, term) as pos
       from anchor_weights
     ), anchor as materialized (
       select path, term, tf, df, documents from anchor_top where pos <= ${SIGNATURE_TERMS}
     ), rare_terms as materialized (
       select distinct term from anchor where df <= max(64, cast(documents * 0.15 as integer))
     ), cand_sources as (
       select ft.source_id as id, s.path, count(*) as overlap
       from rare_terms rt
       cross join file_terms ft indexed by idx_file_terms_term on ft.term = rt.term
       cross join sources s on s.id = ft.source_id
       where s.kind = 'blob'
         and s.path not in (select value from json_each(?))
       group by ft.source_id
       order by overlap desc, s.path asc
       limit 48
     ), cand_weights as (
       select cs.path, ft.term, ft.tf, ts.df, c.documents,
         ln(1.0 + ft.tf) * ln(1.0 + (c.documents - ts.df + 0.5) / (ts.df + 0.5)) as weight
       from cand_sources cs
       join file_terms ft on ft.source_id = cs.id
       join term_stats ts on ts.term = ft.term
       cross join corpus c
     ), cand_top as (
       select path, term, tf, df, documents,
         row_number() over (partition by path order by weight desc, term) as pos
       from cand_weights
     )
     select 'anchor' as role, path, term, tf, df, documents from anchor
     union all
     select 'cand' as role, path, term, tf, df, documents from cand_top where pos <= ${SIGNATURE_TERMS}`,
    [json, json],
    { legacySql: null });
  if (error || !rows.length) return [];
  const anchors = new Map();
  const cands = new Map();
  for (const { role, path, term, tf, df, documents } of rows) {
    const target = role === 'anchor' ? anchors : cands;
    let listForPath = target.get(path);
    if (!listForPath) { listForPath = []; target.set(path, listForPath); }
    listForPath.push({ term, weight: Math.log1p(tf) * smoothedIdf(documents, df) });
  }
  const scored = [];
  for (const [candPath, candSig] of cands) {
    for (const [source, anchorSig] of anchors) {
      const score = sparseTfIdfCosine(anchorSig, candSig);
      if (score > 0) scored.push({ path: candPath, source, score });
    }
  }
  return scored
    .sort((a, b) => (a.score !== b.score ? (a.score < b.score ? 1 : -1) : cmp(a.path, b.path) || cmp(a.source, b.source)))
    .slice(0, limit);
}

export async function readFileSignatures(root, paths) {
  const { rows, error } = await readSqliteRows(root,
    `with target as (
       select id, path from sources where kind = 'blob' and path in (select value from json_each(?))
     ), corpus as (
       select count(*) as documents from lexical_files
     ), weights as (
       select t.path, ft.term,
         ln(1.0 + ft.tf) * ln(1.0 + (c.documents - ts.df + 0.5) / (ts.df + 0.5)) as weight
       from target t
       join file_terms ft on ft.source_id = t.id
       join term_stats ts on ts.term = ft.term
       cross join corpus c
     ), ranked as (
       select path, term, weight,
         row_number() over (partition by path order by weight desc, term) as position
       from weights
     )
     select path, term, weight from ranked where position <= ${SIGNATURE_TERMS}
     order by path, position`,
    [JSON.stringify(paths)]);
  const signatures = new Map();
  for (const { path, term, weight } of rows) {
    const signature = signatures.get(path) ?? [];
    signature.push({ term, weight });
    signatures.set(path, signature);
  }
  return { signatures, error };
}
