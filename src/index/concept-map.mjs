import { tokenizeIdentifiers } from '../text/identifiers.mjs';
import { STOPWORDS } from '../text/tokens.mjs';
import { cmp } from '../util/sort.mjs';
import { isUntangledCommit } from './commit-ir.mjs';

export const CONCEPT_MAP_DDL = `create table if not exists concept_map(
  prose_term text not null,
  code_term text not null,
  ppmi real not null,
  support integer not null,
  primary key(prose_term, code_term)
) without rowid`;

export const CONCEPT_SOURCES_DDL = `create table if not exists concept_sources(
  source_id integer primary key references sources(id) on delete cascade,
  prose_terms text not null,
  code_terms text not null
)`;

const CODE_NOISE = new Set([
  'async', 'await', 'bool', 'boolean', 'class', 'const', 'default', 'else', 'enum',
  'error', 'export', 'extends', 'false', 'func', 'function', 'impl', 'import', 'interface',
  'null', 'number', 'object', 'private', 'public', 'return', 'static', 'string', 'struct',
  'super', 'switch', 'this', 'throw', 'true', 'type', 'typeof', 'undefined', 'void', 'while',
]);

const PATH_NOISE = new Set([
  'app', 'apps', 'cjs', 'doc', 'docs', 'index', 'java', 'js', 'json', 'jsx', 'kt', 'lib',
  'main', 'md', 'mjs', 'pkg', 'py', 'rs', 'spec', 'src', 'test', 'tests', 'toml', 'ts',
  'tsx', 'txt', 'yaml', 'yml',
]);

const PROSE_CAP = 80;
const CODE_CAP = 48;
const MAX_TARGETS_PER_PROSE = 8;
const MAX_QUERY_TRANSLATIONS = 3;
const MIN_SUPPORT = 2;
const MIN_PPMI = 1.5;
const SMOOTH_DELTA = 0.25;

const round = (value) => Math.round(value * 1e6) / 1e6;

function normalizeTerms(text, { noise = CODE_NOISE, cap = PROSE_CAP } = {}) {
  const out = new Set();
  for (const { token: raw } of tokenizeIdentifiers(text)) {
    const token = raw.replaceAll('ς', 'σ');
    if (token.length < 3 || STOPWORDS.has(token) || noise.has(token) || /^\d+$/.test(token)) continue;
    out.add(token);
    if (out.size >= cap) break;
  }
  return [...out].sort(cmp);
}

export function extractProseText(text, lang) {
  const input = String(text ?? '');
  if (!input) return '';
  if (lang === 'markdown' || lang === 'text' || lang === 'unknown') {
    return input.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  }
  const chunks = [];
  const lineComments = lang === 'python' || lang === 'ruby' || lang === 'shell' || lang === 'yaml' || lang === 'toml'
    ? /#([^\n]*)/g
    : /\/\/([^\n]*)/g;
  for (const match of input.matchAll(lineComments)) chunks.push(match[1]);
  if (lang !== 'python' && lang !== 'ruby') {
    for (const match of input.matchAll(/\/\*([\s\S]*?)\*\//g)) chunks.push(match[1].replace(/^\s*\*/gm, ' '));
  }
  if (lang === 'python') {
    for (const match of input.matchAll(/(?:"""|''')([\s\S]*?)(?:"""|''')/g)) chunks.push(match[1]);
  }
  return chunks.join('\n');
}

export function extractCodeTerms(filePath, symbols = []) {
  const pathText = String(filePath ?? '')
    .split('/')
    .filter((seg) => !PATH_NOISE.has(seg.toLowerCase()))
    .join(' ');
  const exported = (symbols ?? []).filter((sym) => sym?.exported);
  const pool = exported.length ? exported : (symbols ?? []);
  const symText = pool.map((sym) => sym?.name ?? '').filter(Boolean).join(' ');
  const out = new Set();
  for (const token of normalizeTerms(pathText, { noise: PATH_NOISE, cap: CODE_CAP })) out.add(token);
  for (const token of normalizeTerms(symText, { noise: CODE_NOISE, cap: CODE_CAP })) {
    out.add(token);
    if (out.size >= CODE_CAP) break;
  }
  return [...out].sort(cmp);
}

export function extractConceptFileTerms(filePath, text, lang, symbols = []) {
  const proseTerms = normalizeTerms(extractProseText(text, lang), { noise: CODE_NOISE, cap: PROSE_CAP });
  const codeTerms = extractCodeTerms(filePath, symbols);
  return { proseTerms, codeTerms };
}

export function buildConceptObservations({
  fileEntries = [],
  commitRecords = [],
  governancePairs = [],
  root = null,
} = {}) {
  const observations = [];
  const codeByPath = new Map();
  const proseByPath = new Map();

  for (const { path, proseTerms, codeTerms } of fileEntries) {
    const prose = Array.isArray(proseTerms) ? proseTerms : String(proseTerms ?? '').split(' ').filter(Boolean);
    const code = Array.isArray(codeTerms) ? codeTerms : String(codeTerms ?? '').split(' ').filter(Boolean);
    if (code.length) codeByPath.set(path, code);
    if (prose.length) proseByPath.set(path, prose);
    if (prose.length && code.length) observations.push({ proseTerms: prose, codeTerms: code });
  }

  for (const record of commitRecords ?? []) {
    const paths = [...new Set(record?.paths ?? [])];
    if (!isUntangledCommit(paths, root)) continue;
    const prose = normalizeTerms(`${record.subject ?? ''}\n${record.body ?? ''}`, { noise: CODE_NOISE, cap: PROSE_CAP });
    if (!prose.length) continue;
    const codeSet = new Set();
    for (const path of paths) {
      for (const term of codeByPath.get(path) ?? extractCodeTerms(path, [])) codeSet.add(term);
    }
    if (codeSet.size) observations.push({ proseTerms: prose, codeTerms: [...codeSet].sort(cmp) });
  }

  for (const { docPath, proseText, targetPath } of governancePairs ?? []) {
    const prose = docPath && proseByPath.has(docPath)
      ? proseByPath.get(docPath)
      : normalizeTerms(proseText ?? '', { noise: CODE_NOISE, cap: PROSE_CAP });
    const code = codeByPath.get(targetPath) ?? extractCodeTerms(targetPath, []);
    if (prose?.length && code.length) observations.push({ proseTerms: prose, codeTerms: code });
  }

  return observations;
}

export function buildConceptMap(observations) {
  const n = observations?.length ?? 0;
  if (n < 2) return [];
  const proseDf = new Map();
  const codeDf = new Map();
  const pairCount = new Map();

  for (const obs of observations) {
    const prose = [...new Set(obs.proseTerms ?? [])];
    const code = [...new Set(obs.codeTerms ?? [])];
    if (!prose.length || !code.length) continue;
    for (const w of prose) proseDf.set(w, (proseDf.get(w) ?? 0) + 1);
    for (const t of code) codeDf.set(t, (codeDf.get(t) ?? 0) + 1);
    for (const w of prose) {
      for (const t of code) {
        if (w === t) continue;
        const key = `${w}\0${t}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  const maxCodeRatio = n >= 20 ? 0.15 : 0.45;
  const byProse = new Map();
  for (const [key, support] of pairCount) {
    if (support < MIN_SUPPORT) continue;
    const [proseTerm, codeTerm] = key.split('\0', 2);
    const cw = proseDf.get(proseTerm) ?? 0;
    const ct = codeDf.get(codeTerm) ?? 0;
    if (!cw || !ct) continue;
    if (ct / n > maxCodeRatio || (n > 2 && ct >= n)) continue;
    const ppmi = Math.log2(((support - SMOOTH_DELTA) * n) / (cw * ct));
    if (!(ppmi >= MIN_PPMI)) continue;
    const list = byProse.get(proseTerm) ?? [];
    list.push({ proseTerm, codeTerm, ppmi: round(ppmi), support });
    byProse.set(proseTerm, list);
  }

  const rows = [];
  for (const proseTerm of [...byProse.keys()].sort(cmp)) {
    const ranked = byProse.get(proseTerm)
      .sort((a, b) => b.ppmi - a.ppmi || b.support - a.support || cmp(a.codeTerm, b.codeTerm))
      .slice(0, MAX_TARGETS_PER_PROSE);
    rows.push(...ranked);
  }
  return rows;
}

export function selectConceptExpansions(conceptRows, queryTerms, { maxPerTerm = MAX_QUERY_TRANSLATIONS } = {}) {
  const querySet = new Set(queryTerms ?? []);
  const byProse = new Map();
  for (const row of conceptRows ?? []) {
    const prose = row.proseTerm ?? row.prose_term;
    const code = row.codeTerm ?? row.code_term;
    const ppmi = Number(row.ppmi ?? 0);
    const support = Number(row.support ?? 0);
    if (!prose || !code || querySet.has(code) || !(ppmi > 0)) continue;
    const list = byProse.get(prose) ?? [];
    list.push({ from: prose, to: code, ppmi: round(ppmi), support });
    byProse.set(prose, list);
  }

  const selected = [];
  const bestByCode = new Map();
  for (const prose of [...querySet].sort(cmp)) {
    const ranked = (byProse.get(prose) ?? [])
      .sort((a, b) => b.ppmi - a.ppmi || b.support - a.support || cmp(a.to, b.to))
      .slice(0, maxPerTerm);
    for (const item of ranked) {
      selected.push(item);
      const prev = bestByCode.get(item.to);
      if (!prev || item.ppmi > prev.ppmi) bestByCode.set(item.to, item);
    }
  }
  if (!selected.length) return { expansions: [], terms: [] };
  const maxPpmi = Math.max(4.0, ...selected.map(({ ppmi }) => ppmi));
  const expansions = selected.map((item) => ({
    ...item,
    weight: round(0.35 * (item.ppmi / maxPpmi)),
  }));
  const terms = [...bestByCode.values()]
    .sort((a, b) => b.ppmi - a.ppmi || cmp(a.to, b.to))
    .map((item) => ({
      term: item.to,
      weight: round(0.35 * (item.ppmi / maxPpmi)),
    }));
  return { expansions, terms };
}

export function writeConceptSources(db, rows, ids) {
  db.exec(CONCEPT_SOURCES_DDL);
  const upsert = db.prepare(`insert into concept_sources(source_id, prose_terms, code_terms) values (?, ?, ?)
    on conflict(source_id) do update set prose_terms = excluded.prose_terms, code_terms = excluded.code_terms`);
  for (const row of rows ?? []) {
    const entry = ids.get(row.path);
    if (!entry) continue;
    upsert.run(entry.sourceId, row.proseTerms.join(' '), row.codeTerms.join(' '));
  }
}

export function rebuildConceptMapTable(db) {
  db.exec(CONCEPT_MAP_DDL);
  db.exec(CONCEPT_SOURCES_DDL);
  const fileEntries = db.prepare(`select s.path, cs.prose_terms as proseTerms, cs.code_terms as codeTerms
    from concept_sources cs join sources s on s.id = cs.source_id and s.kind = 'blob'
    order by s.path`).all();
  let commitRecords = [];
  const rawRecords = db.prepare("select value from meta where key = 'commit_ir_records'").get()?.value;
  if (rawRecords) {
    try {
      const parsed = JSON.parse(rawRecords);
      if (Array.isArray(parsed)) commitRecords = parsed;
    } catch {
      commitRecords = [];
    }
  }
  let governancePairs = [];
  const hasGov = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'governance_edges'").get();
  if (hasGov) {
    const filePaths = fileEntries.map(({ path }) => path);
    const edges = db.prepare(`select n.kind, n.id, n.detail, e.dst as targetPath
      from governance_edges e join governance_nodes n on n.key = e.src
      where e.kind = 'governs_path' and n.kind in ('decision', 'rule', 'lesson')`).all();
    governancePairs = edges.map(({ kind, id, detail, targetPath }) => {
      const docPath = kind === 'decision'
        ? filePaths.find((path) => path.includes(`/${id}-`) || path.startsWith(`${id}-`))
        : filePaths.find((path) => path.endsWith(`/${id}.md`) || path.endsWith(`/${id}.mdc`));
      return { docPath, proseText: detail, targetPath };
    });
  }
  const observations = buildConceptObservations({ fileEntries, commitRecords, governancePairs });
  const rows = buildConceptMap(observations);
  db.exec('delete from concept_map');
  const insert = db.prepare('insert into concept_map(prose_term, code_term, ppmi, support) values (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.proseTerm, row.codeTerm, row.ppmi, row.support);
  db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
    .run('concept_map', '1');
  return rows.length;
}
