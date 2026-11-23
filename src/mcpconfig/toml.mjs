// A TOML subset: enough to read and write the tables this tool owns, nothing more.
//
// Zero runtime dependencies means no TOML library (ADR-012), and a full parser is a
// surface this tool does not need: codex's `config.toml` is a file the REPOSITORY owns,
// and this tool only reads and writes the tables under its own container. The rule that
// keeps a hand-rolled parser honest: every line this subset cannot parse is reported
// with its number, so a file that grows beyond the subset reads as unreadable - named -
// rather than silently half-read. Lines the tool does not own are preserved raw by the
// writer, which is what makes "subset" safe on a file with a full TOML life of its own.

/**
 * Parse the subset: `[table]` headers (dotted), `key = value` pairs, and values of
 * basic strings, literal strings, booleans, integers and single-line arrays of those.
 *
 * @returns {{tables: Map<string, object>, errors: Array<{line: number, table: string|null, text: string}>}}
 *   `tables` maps a dotted table name to its parsed keys. `errors` names every line the
 *   subset cannot parse; the caller decides which of them make the file unreadable -
 *   an error inside a table this tool owns does, one outside it does not.
 */
export function parseToml(text) {
  const tables = new Map();
  const errors = [];
  let current = null;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = line.match(/^\[([A-Za-z0-9_.\-]+)\]$/);
    if (header) {
      current = header[1];
      if (!tables.has(current)) tables.set(current, {});
      continue;
    }
    // `[[array]]` starts an array of tables: a shape this tool does not read, and the
    // keys under it belong to no table we name, so ownership ends with the header.
    if (line.startsWith('[[')) {
      current = null;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.\-]+)\s*=\s*(.+)$/);
    if (!kv) {
      errors.push({ line: index + 1, table: current, text: line });
      continue;
    }
    const { value, ok } = parseValue(kv[2]);
    if (!ok) {
      errors.push({ line: index + 1, table: current, text: line });
      continue;
    }
    if (current !== null) {
      if (!tables.has(current)) tables.set(current, {});
      setDotted(tables.get(current), kv[1], value);
    }
  }
  return { tables, errors };
}

/** Assign `a.b.c` into a nested object, creating the intermediate tables. */
function setDotted(target, dotted, value) {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === undefined || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

/**
 * One TOML value from the subset. A trailing comment after a string is legal TOML and
 * the only place one can follow, so it is checked where it can occur.
 */
function parseValue(text) {
  const t = text.trim();
  if (t.startsWith('"')) return basicString(t);
  if (t.startsWith("'")) {
    // `''` is the escaped quote inside a literal string; walk it.
    let i = 1;
    while (i < t.length) {
      if (t[i] === "'" && t[i + 1] === "'") { i += 2; continue; }
      if (t[i] === "'") break;
      i += 1;
    }
    if (i >= t.length) return { value: null, ok: false };
    const rest = t.slice(i + 1).trim();
    if (rest !== '' && !rest.startsWith('#')) return { value: null, ok: false };
    return { value: t.slice(1, i).replace(/''/g, "'"), ok: true };
  }
  if (t === 'true') return { value: true, ok: true };
  if (t === 'false') return { value: false, ok: true };
  if (/^-?\d+$/.test(t)) return { value: Number(t), ok: true };
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) return { value: null, ok: false };
    const inner = t.slice(1, -1).trim();
    if (inner === '') return { value: [], ok: true };
    const items = splitArray(inner);
    if (items === null) return { value: null, ok: false };
    const out = [];
    for (const item of items) {
      const { value, ok } = parseValue(item);
      if (!ok) return { value: null, ok: false };
      out.push(value);
    }
    return { value: out, ok: true };
  }
  return { value: null, ok: false };
}

/** Split an array body on commas that are not inside a string. */
function splitArray(inner) {
  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote !== null) {
      current += ch;
      if (ch === '\\' && quote === '"') { current += inner[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  const last = current.trim();
  if (last !== '') items.push(last);
  return items;
}

/** A basic string with escapes, and the check that only a comment may follow it. */
function basicString(t) {
  let out = '';
  let i = 1;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '\\') {
      const next = t[i + 1];
      const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
      if (!(next in escapes)) return { value: null, ok: false };
      out += escapes[next];
      i += 2;
      continue;
    }
    if (ch === '"') {
      const rest = t.slice(i + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) return { value: null, ok: false };
      return { value: out, ok: true };
    }
    out += ch;
    i += 1;
  }
  return { value: null, ok: false };
}
