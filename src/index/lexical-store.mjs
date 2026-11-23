import { collectFileTerms, SIGNATURE_TERMS } from './lexical.mjs';

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
