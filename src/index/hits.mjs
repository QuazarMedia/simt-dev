import { isTestPath } from '../testing/paths.mjs';
import { cmp } from '../util/sort.mjs';

const HITS_ITERATIONS = 12;
const round = (value) => Math.round(value * 1e6) / 1e6;

function filePathOfNode(node) {
  if (!node) return null;
  if (node.startsWith('file:')) return node.slice(5);
  if (node.startsWith('sym:')) {
    const hash = node.indexOf('#');
    return hash > 4 ? node.slice(4, hash) : null;
  }
  return node;
}

export function isBarrelFile(file, symbolCount = null) {
  const bindings = file?.bindings ?? null;
  const reexports = bindings?.reexports ?? file?.reexports ?? [];
  if (!Array.isArray(reexports) || !reexports.length) return false;
  const ownScopes = bindings?.chunk?.scopes?.length ?? null;
  if (ownScopes !== null) return ownScopes === 0;
  return symbolCount !== null ? symbolCount === 0 : false;
}

export function computeHitsScores(files, edges, { iterations = HITS_ITERATIONS, root = null, symbolCounts = null } = {}) {
  const nonTest = new Set();
  const barrels = new Set();
  for (const file of files ?? []) {
    const path = typeof file === 'string' ? file : file?.path;
    if (!path || isTestPath(path, root)) continue;
    nonTest.add(path);
    if (typeof file === 'object' && isBarrelFile(file, symbolCounts?.get(path) ?? null)) {
      barrels.add(path);
    }
  }
  const nodes = [...nonTest].sort(cmp);
  if (!nodes.length) return new Map();

  const outgoing = new Map(nodes.map((path) => [path, new Set()]));
  const incoming = new Map(nodes.map((path) => [path, new Set()]));
  for (const edge of edges ?? []) {
    if (!edge || (edge.kind !== 'import' && edge.kind !== 'calls_symbol' && edge.kind !== 'imports_symbol')) continue;
    const src = filePathOfNode(edge.src);
    const dst = filePathOfNode(edge.dst);
    if (!src || !dst || src === dst || !nonTest.has(src) || !nonTest.has(dst)) continue;
    outgoing.get(src).add(dst);
    incoming.get(dst).add(src);
  }

  let auth = new Map(nodes.map((path) => [path, 1]));
  let hub = new Map(nodes.map((path) => [path, 1]));

  for (let iter = 0; iter < iterations; iter += 1) {
    const nextAuth = new Map();
    let authSq = 0;
    for (const dst of nodes) {
      let sum = 0;
      for (const src of incoming.get(dst)) sum += hub.get(src) ?? 0;
      nextAuth.set(dst, sum);
      authSq += sum * sum;
    }
    const authNorm = authSq > 0 ? Math.sqrt(authSq) : 1;
    for (const dst of nodes) nextAuth.set(dst, nextAuth.get(dst) / authNorm);

    const nextHub = new Map();
    let hubSq = 0;
    for (const src of nodes) {
      let sum = 0;
      for (const dst of outgoing.get(src)) sum += nextAuth.get(dst) ?? 0;
      nextHub.set(src, sum);
      hubSq += sum * sum;
    }
    const hubNorm = hubSq > 0 ? Math.sqrt(hubSq) : 1;
    for (const src of nodes) nextHub.set(src, nextHub.get(src) / hubNorm);

    auth = nextAuth;
    hub = nextHub;
  }

  const result = new Map();
  for (const path of nodes) {
    result.set(path, {
      authority: round(auth.get(path) ?? 0),
      hub: round(hub.get(path) ?? 0),
      barrel: barrels.has(path),
    });
  }
  return result;
}

export function persistFileHits(db) {
  const files = db.prepare(`select path, json_extract(props, '$.bindings') as bindings
    from sources where kind = 'blob' order by path`).all().map((row) => ({
    path: row.path,
    bindings: row.bindings ? JSON.parse(row.bindings) : null,
  }));
  const symRows = db.prepare(`select s.path, count(*) as n
    from nodes n join sources s on s.id = n.source_id
    where s.kind = 'blob' and n.kind = 'symbol' group by s.path`).all();
  const symbolCounts = new Map(symRows.map(({ path, n }) => [path, n]));
  const edges = db.prepare(`select sn.key as src, e.kind, coalesce(dn.key, e.dst_key) as dst
    from edges e
    join nodes sn on sn.id = e.src_id
    left join nodes dn on dn.id = e.dst_id
    where e.kind in ('import', 'calls_symbol', 'imports_symbol')`).all();

  const scores = computeHitsScores(files, edges, { symbolCounts });
  const update = db.prepare(`update nodes set props = json_object('authority', ?, 'hub', ?, 'barrel', ?)
    where kind = 'file' and key = 'file:' || ?`);
  for (const [path, { authority, hub, barrel }] of scores) {
    update.run(authority, hub, barrel ? 1 : 0, path);
  }
  db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
    .run('hits_scores', '1');
  return scores.size;
}
