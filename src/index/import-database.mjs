/** Run a relational query over the import edges the caller has already observed. */
export async function withImportDatabase(edges, query) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`create table imports(src text not null, dst text not null, primary key(src, dst)) without rowid;
      create index import_by_destination on imports(dst, src);
      begin;`);
    const insert = db.prepare('insert or ignore into imports values (?, ?)');
    for (const { src, dst, kind } of edges) {
      if (!kind || kind === 'import') insert.run(src, dst);
    }
    db.exec('commit');
    return query(db);
  } finally {
    db.close();
  }
}
