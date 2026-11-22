import { bindSymbols } from './bind.mjs';
import { canonicalJson } from '../util/canonical.mjs';

const EDGE_SQL = `select e.src_id as srcId, src.key as src, e.kind, e.dst_key as dst,
  e.dst_id as dstId, e.props, s.path
  from edges e join nodes src on src.id = e.src_id join sources s on s.id = e.owner_source_id
  where e.props is not null and e.props != ''`;

function edgeIdentity({ src, kind, dst }) {
  return JSON.stringify([src, kind, dst]);
}

export function persistSymbolGraph(db) {
  const files = db.prepare(`select path, lang, json_extract(props, '$.bindings') as bindings
    from sources where kind = 'blob' order by path`).all().map(({ path, lang, bindings }) => ({
    path, lang, ...(bindings == null ? {} : JSON.parse(bindings)),
  }));
  const symbols = db.prepare(`select s.path, n.name, n.line, json_extract(n.props, '$.sig') as sig,
    json_extract(n.props, '$.exported') as exported
    from nodes n join sources s on s.id = n.source_id
    where s.kind = 'blob' and n.kind = 'symbol' order by s.path, n.line, n.name`).all();
  const { ownerRows, bindingCoverage, unresolved } = bindSymbols(files, symbols);
  const nodeIds = new Map();
  const owners = new Map();
  for (const row of db.prepare(`select n.id, n.key, s.id as ownerId, s.path, n.kind
    from nodes n join sources s on s.id = n.source_id
    where s.kind = 'blob' and n.kind in ('file', 'symbol', 'binding_symbol')`).all()) {
    nodeIds.set(row.key, row.id);
    owners.set(row.path, row.ownerId);
  }

  const addNode = db.prepare(`insert into nodes(key, kind, source_id, name, line, trust)
    values (?, 'binding_symbol', ?, ?, ?, 'observed')`);
  for (const [path, { nodes }] of ownerRows) {
    for (const { key, name, line } of nodes) {
      if (nodeIds.has(key)) continue;
      const { lastInsertRowid } = addNode.run(key, owners.get(path), name, line);
      nodeIds.set(key, lastInsertRowid);
    }
  }

  // A changed target can keep the same key but receive a different node ID.
  // Reconcile that edge along with changed bindings, keeping unaffected rows.
  const oldEdges = new Map(db.prepare(EDGE_SQL).all().map((row) => [edgeIdentity(row), row]));
  const upsert = db.prepare(`insert into edges(src_id, kind, dst_key, dst_id, weight, owner_source_id, trust, props)
    values (?, ?, ?, ?, 1, ?, 'observed', ?)
    on conflict(src_id, kind, dst_key) do update set dst_id = excluded.dst_id, props = excluded.props`);
  for (const [path, { edges }] of ownerRows) {
    for (const row of edges) {
      const identity = edgeIdentity(row);
      const old = oldEdges.get(identity);
      oldEdges.delete(identity);
      const src = nodeIds.get(row.src);
      const dst = nodeIds.get(row.dst);
      if (src === undefined || dst === undefined) continue;
      const props = canonicalJson({ viaBarrels: row.viaBarrels, lines: row.lines });
      if (old?.srcId === src && old.dstId === dst && old.props === props) continue;
      upsert.run(src, row.kind, row.dst, dst, owners.get(path), props);
    }
  }
  const drop = db.prepare('delete from edges where src_id = ? and kind = ? and dst_key = ?');
  for (const row of oldEdges.values()) drop.run(row.srcId, row.kind, row.dst);
  const upsertMeta = db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value');
  upsertMeta.run('binding_coverage', canonicalJson(bindingCoverage));
  upsertMeta.run('binding_unresolved', canonicalJson(unresolved));
}

export const SYMBOL_GRAPH_QUERIES = [
  [`${EDGE_SQL} order by src, e.kind, dst`],
  ["select key, value from meta where key in ('binding_coverage', 'binding_unresolved')"],
];
