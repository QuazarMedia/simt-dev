export const GOVERNANCE_BASIS_KEY = 'governance_basis';

export function writeGovernance(db, snapshot) {
  db.exec(`create table if not exists governance_nodes(
    key text primary key, kind text not null, id text not null, detail text not null, superseded_by text
  ) without rowid;
  create table if not exists governance_edges(
    src text not null, kind text not null, dst text not null, primary key(src, kind, dst)
  ) without rowid;
  create index if not exists governance_by_subject on governance_edges(kind, dst, src);
  delete from governance_edges;
  delete from governance_nodes;`);
  const insertNode = db.prepare('insert into governance_nodes values (?, ?, ?, ?, ?)');
  for (const { key, kind, id, detail, supersededBy } of snapshot.nodes.values()) insertNode.run(key, kind, id, detail, supersededBy);
  const insertEdge = db.prepare('insert into governance_edges values (?, ?, ?)');
  for (const { src, kind, dst } of snapshot.edges) insertEdge.run(src, kind, dst);
  db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(GOVERNANCE_BASIS_KEY, snapshot.basis);
}
