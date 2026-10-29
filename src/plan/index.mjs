// Plan and tracker index (plan 0003 R31).
//
// An agent resuming a long plan should read one slice, not the document. Which
// directories are read, which columns count, and which words count as done are
// the repository's template (src/plan/template.mjs). The tracker template
// delivered with the tool reads docs/plans and docs/reviews and treats `done`
// as complete.
// A dependency may name another document (`review 0002 S41`) or one of its
// waves (`review 0002 Wave 0`). Ids that follow a document prefix stay in that
// document: `review 0002 S41, S50` is two slices of the review. A parenthetical
// is a note, not a dependency — `S47 (optional)` waits on S47, and the pack
// test named beside S01 is not a ninth wave member. The words `review` and
// `wave` are the delivered template's; another template names its own.
//
// Only a state the template marks as satisfying a dependency unblocks anything.
// In the delivered template that is `complete`, which the older tracker wrote
// as `done`. `accepted` means the slice was left open on purpose.
//
// The section is located when a slice is chosen, from headings recorded while
// the file was read. Status and dependency checks never touch it: a 1 MB
// section that belongs to a later slice is not copied into the index.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CLI } from '../name.mjs';
import { commitJournal, journaledWriteFile } from '../journal.mjs';
import { loadFormat } from './template.mjs';

function clean(cell) {
  return String(cell ?? '').replace(/\*\*/g, '').trim();
}

function normHeader(cell) {
  return clean(cell).toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drop parenthetical notes, repeatedly, so a note that itself contains a note goes too. */
function stripNotes(value) {
  let text = clean(value);
  let previous;
  do {
    previous = text;
    text = text.replace(/\s*\([^()]*\)/g, ' ');
  } while (text !== previous);
  return text.replace(/\s+/g, ' ').trim();
}

function splitList(text, separators) {
  const parts = [];
  let current = '';
  for (const char of text) {
    if (separators.includes(char)) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function tokensOf(fmt, cell) {
  const stripped = fmt.notes ? stripNotes(cell) : clean(cell);
  if (stripped === '' || fmt.empty.has(stripped.toLowerCase())) return [];
  return splitList(stripped, fmt.separators);
}

function keysOf(label) {
  const plain = clean(label).toLowerCase();
  const keys = new Set();
  for (const digits of plain.match(/\d+/g) ?? []) keys.add(digits);
  const flat = plain.replace(/[^a-z0-9]+/g, '');
  if (flat) keys.add(flat);
  return [...keys];
}

function idsOf(fmt, cell) {
  const stripped = fmt.notes ? stripNotes(cell) : clean(cell);
  return splitList(stripped, fmt.separators).filter((part) => fmt.idRe.test(part));
}

function docNumber(name) {
  const match = name.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function sliceKey(path, id) {
  return `${path}\0${id}`;
}

/**
 * Split a markdown table row.
 *
 * A leading empty cell is the pipe that opens the row. Exactly one trailing
 * empty cell is the pipe that closes it. A further empty cell is real: the
 * evidence column is often blank, and stripping every trailing empty would
 * delete it and shift the state into the wrong column.
 *
 * A pipe inside a code span is content, not a separator: an evidence cell may
 * carry a command line with a pipe in it, and splitting there shifts every
 * later cell left by one (review 0003 Q25). Backticks toggle the span; a
 * `\|` escape is content in either mode.
 */
function splitRow(line) {
  const cells = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      current += char + line[i + 1];
      i += 1;
      continue;
    }
    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (line.trim()) cells.push(current);
  let out = cells.map((cell) => cell.trim());
  if (out[0] === '') out = out.slice(1);
  if (out.length > 1 && out[out.length - 1] === '') out = out.slice(0, -1);
  return out;
}

function isSeparator(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && /^[\s|:-]+$/.test(trimmed) && trimmed.includes('---');
}

function findColumn(columns, names, fallback) {
  for (const name of names) {
    const index = columns.indexOf(name);
    if (index >= 0) return index;
  }
  if (!fallback) return -1;
  return columns.findIndex((column) => fallback.test(column));
}

function buildTable(pending) {
  const columns = splitRow(pending[0].line).map(normHeader);
  const rows = [];
  for (let i = 1; i < pending.length; i += 1) {
    if (isSeparator(pending[i].line)) continue;
    const cells = splitRow(pending[i].line);
    if (cells.every((cell) => cell === '')) continue;
    rows.push({ cells, line: pending[i].no });
  }
  return { columns, rows };
}

function isTracker(fmt, table) {
  const idIdx = findColumn(table.columns, fmt.idHeaders);
  const stateIdx = findColumn(table.columns, fmt.stateHeaders);
  if (idIdx < 0 || stateIdx < 0 || table.rows.length === 0) return false;
  let ids = 0;
  let states = 0;
  for (const row of table.rows) {
    if (fmt.idRe.test(clean(row.cells[idIdx] ?? ''))) ids += 1;
    if (fmt.known.has(fmt.readState(row.cells[stateIdx] ?? ''))) states += 1;
  }
  const need = Math.min(2, table.rows.length);
  // Both thresholds, so a prose table that happens to contain one id-shaped
  // cell and the word "done" is not an index. One row is a tracker only when
  // that row is an id in a known state.
  return ids >= need && states >= need;
}

function trackerRows(fmt, table) {
  const columns = table.columns;
  const idIdx = findColumn(columns, fmt.idHeaders);
  const stateIdx = findColumn(columns, fmt.stateHeaders);
  const depsIdx = findColumn(columns, fmt.dependsHeaders);
  const titleIdx = findColumn(columns, fmt.titleHeaders);
  const evidenceIdx = findColumn(columns, fmt.evidenceHeaders);
  const rows = [];
  for (const row of table.rows) {
    const id = clean(row.cells[idIdx] ?? '');
    if (!fmt.idRe.test(id)) continue;
    rows.push({
      id,
      line: row.line,
      idIdx,
      stateIdx,
      depsIdx,
      titleIdx: titleIdx === idIdx ? -1 : titleIdx,
      evidenceIdx,
      columnCount: columns.length,
      cells: row.cells,
    });
  }
  return rows;
}

function waveRows(fmt, table) {
  const waveIdx = findColumn(table.columns, fmt.waveLabel);
  const slicesIdx = findColumn(table.columns, fmt.waveMembers);
  if (waveIdx < 0 || slicesIdx < 0) return [];
  return table.rows.map((row) => ({
    keys: keysOf(row.cells[waveIdx] ?? ''),
    ids: idsOf(fmt, row.cells[slicesIdx] ?? ''),
  }));
}

function parseDocument(fmt, text) {
  const lines = text.split('\n');
  const headings = [];
  const tables = [];
  let offset = 0;
  let fence = false;
  let pending = null;
  const flush = () => {
    if (pending?.length) tables.push(buildTable(pending));
    pending = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      fence = !fence;
      flush();
    } else if (!fence && trimmed.startsWith('|')) {
      (pending ??= []).push({ line, no: i + 1 });
    } else if (!fence) {
      flush();
      const heading = fmt.headingRe.exec(line);
      if (heading) headings.push({ depth: heading[1].length, text: heading[2], pos: offset });
    }
    offset += line.length + 1;
  }
  flush();
  const rows = [];
  const waves = [];
  for (const table of tables) {
    if (isTracker(fmt, table)) rows.push(...trackerRows(fmt, table));
    else waves.push(...waveRows(fmt, table));
  }
  return { headings, rows, waves };
}

function sectionFor(doc, id) {
  // A heading that starts with the id is the slice. A later mention of the same
  // id (`Phase 1` while the id is `1`) is only a fallback, and only when nothing
  // starts with it — otherwise the earlier heading wins and the section is the
  // wrong one.
  const word = new RegExp(`\\b${escapeRegExp(id)}\\b`);
  let best = null;
  for (const heading of doc.headings) {
    const stripped = heading.text.replace(/^\d+[.)]\s+/, '');
    const starts = stripped === id
      || stripped.startsWith(`${id} `)
      || stripped.startsWith(`${id}—`)
      || stripped.startsWith(`${id}–`)
      || stripped.startsWith(`${id}-`)
      || stripped.startsWith(`${id}:`);
    const rank = starts ? 0 : word.test(heading.text) ? 1 : 2;
    if (rank === 2) continue;
    if (!best || rank < best.rank || (rank === best.rank && heading.pos < best.pos)) {
      best = { ...heading, rank };
    }
  }
  if (!best) return null;
  const next = doc.headings.find((heading) => heading.pos > best.pos && heading.depth <= best.depth);
  return doc.text.slice(best.pos, next ? next.pos : doc.text.length).replace(/\s+$/, '');
}

async function readKind(root, dir, fmt) {
  let names;
  try {
    names = (await readdir(join(root, dir.path))).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      return [name, await readFile(join(root, dir.path, name), 'utf8')];
    } catch {
      return null;
    }
  }));
  const docs = [];
  for (const entry of loaded) {
    if (!entry) continue;
    const [name, text] = entry;
    const parsed = parseDocument(fmt, text);
    if (parsed.rows.length === 0) continue;
    docs.push({
      kind: dir.kind,
      name,
      path: join(root, dir.path, name),
      number: docNumber(name),
      text,
      ...parsed,
    });
  }
  return docs;
}

async function readDocs(root, fmt) {
  const groups = await Promise.all(fmt.directories.map((dir) => readKind(root, dir, fmt)));
  return groups.flat();
}

function findDoc(docs, word, number, fmt) {
  const kind = fmt.byWord.get(word.toLowerCase());
  if (!kind) return null;
  const hits = docs.filter((doc) => doc.kind === kind && doc.number === number);
  // Two documents with the same number would make `review 0002` a guess.
  // Missing is an unknown dependency, which blocks, and a guess would unblock
  // a slice against the wrong tracker.
  return hits.length === 1 ? hits[0] : null;
}

function wavesByLabel(doc, label) {
  const want = new Set(keysOf(label));
  const ids = [];
  const seen = new Set();
  let hit = false;
  for (const wave of doc.waves) {
    if (!wave.keys.some((key) => want.has(key))) continue;
    hit = true;
    for (const id of wave.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return hit ? ids : null;
}

function pushWave(ids, doc, byKey, targets, unknown) {
  for (const id of ids) {
    if (byKey.has(sliceKey(doc.path, id))) targets.push({ id, doc: doc.name, path: doc.path });
    else unknown.push(id);
  }
}

function resolveDeps(doc, cell, docs, byKey, fmt) {
  const targets = [];
  const unknown = [];
  let scope = null;
  for (const token of tokensOf(fmt, cell)) {
    const cross = fmt.crossRe.exec(token);
    if (cross) {
      const target = findDoc(docs, cross[1], Number(cross[2]), fmt);
      const rest = cross[3].trim();
      if (!target) {
        unknown.push(token);
        scope = null;
        continue;
      }
      scope = target;
      const wave = fmt.groupRe.exec(rest);
      if (wave) {
        const ids = wavesByLabel(target, wave[1]);
        if (ids) pushWave(ids, target, byKey, targets, unknown);
        else unknown.push(token);
      } else if (byKey.has(sliceKey(target.path, rest))) {
        targets.push({ id: rest, doc: target.name, path: target.path });
      } else {
        unknown.push(rest);
      }
      continue;
    }
    const wave = fmt.groupRe.exec(token);
    const home = scope ?? doc;
    if (wave) {
      const ids = wavesByLabel(home, wave[1]);
      if (ids) pushWave(ids, home, byKey, targets, unknown);
      else unknown.push(token);
      continue;
    }
    if (byKey.has(sliceKey(home.path, token))) {
      targets.push({ id: token, doc: home.name, path: home.path });
    } else if (scope && byKey.has(sliceKey(doc.path, token))) {
      targets.push({ id: token, doc: doc.name, path: doc.path });
    } else {
      unknown.push(token);
    }
  }
  return { targets, unknown };
}

function linkSlices(docs, fmt) {
  const slices = [];
  const byKey = new Map();
  for (const doc of docs) {
    for (const row of doc.rows) {
      const stateRaw = row.stateIdx >= 0 ? clean(row.cells[row.stateIdx] ?? '') : '';
      const slice = {
        id: row.id,
        docName: doc.name,
        docPath: doc.path,
        line: row.line,
        title: row.titleIdx >= 0 ? clean(row.cells[row.titleIdx] ?? '') : '',
        stateRaw,
        state: fmt.readState(stateRaw),
        dependsOn: row.depsIdx >= 0 ? clean(row.cells[row.depsIdx] ?? '') : '',
        idIdx: row.idIdx,
        stateIdx: row.stateIdx,
        evidenceIdx: row.evidenceIdx,
        columnCount: row.columnCount,
        prefix: (row.id.match(/^[A-Za-z]+/) ?? [''])[0],
        number: Number((row.id.match(/\d+/) ?? ['0'])[0]),
        doc,
      };
      slices.push(slice);
      const key = sliceKey(doc.path, slice.id);
      if (!byKey.has(key)) byKey.set(key, slice);
    }
  }
  for (const slice of slices) {
    const { targets, unknown } = resolveDeps(slice.doc, slice.dependsOn, docs, byKey, fmt);
    slice.resolvedDeps = targets;
    slice.unknownDeps = unknown;
    slice.depsComplete = unknown.length === 0 && targets.every((dep) => fmt.satisfies.has(byKey.get(sliceKey(dep.path, dep.id))?.state));
    slice.ready = slice.state === fmt.ready && slice.depsComplete;
  }
  return slices;
}

function compareSlice(a, b) {
  if (a.docName !== b.docName) return a.docName < b.docName ? -1 : 1;
  if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
  if (a.number !== b.number) return a.number - b.number;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function rankCounts(counts, order) {
  return Object.keys(counts).sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    return a < b ? -1 : 1;
  });
}

export async function loadPlanState(root) {
  const loaded = await loadFormat(root);
  if (loaded.error) return { root, error: loaded.error, remedy: loaded.remedy };
  const docs = await readDocs(root, loaded.format);
  const slices = linkSlices(docs, loaded.format);
  return { root, docs, slices, format: loaded.format };
}

function hitsFor(slices, id) {
  return slices.filter((slice) => slice.id === id);
}

function missing(id) {
  return { error: `no tracked slice named ${id}`, remedy: `run: ${CLI} plan status` };
}

function ambiguous(id, hits) {
  const names = hits.map((hit) => hit.docName).join(', ');
  return {
    error: `${id} appears in ${hits.length} documents: ${names}`,
    remedy: `run: ${CLI} plan status`,
    candidates: hits.map((hit) => hit.docName),
  };
}

export async function planStatus(root) {
  const loaded = await loadPlanState(root);
  if (loaded.error) return loaded;
  const { slices, docs, format } = loaded;
  const documents = docs.map((doc) => {
    const own = slices.filter((slice) => slice.docPath === doc.path);
    const counts = {};
    for (const slice of own) counts[slice.state] = (counts[slice.state] ?? 0) + 1;
    return { name: doc.name, path: doc.path, kind: doc.kind, number: doc.number, slices: own.length, counts };
  });
  const totals = {};
  for (const doc of documents) {
    for (const [state, count] of Object.entries(doc.counts)) totals[state] = (totals[state] ?? 0) + count;
  }
  return {
    root,
    template: format.name,
    directories: format.directories.map((dir) => dir.path),
    stateOrder: format.order,
    documents,
    totals,
    ready: slices.filter((slice) => slice.ready).length,
  };
}

function publicSlice(slice) {
  const section = sectionFor(slice.doc, slice.id);
  return {
    id: slice.id,
    doc: slice.docName,
    path: slice.docPath,
    title: slice.title,
    state: slice.state,
    dependsOn: slice.dependsOn,
    unknownDependencies: slice.unknownDeps,
    section,
    sectionBytes: Buffer.byteLength(section ?? '', 'utf8'),
  };
}

export async function planNext(root, id = null) {
  const loaded = await loadPlanState(root);
  if (loaded.error) return loaded;
  const { slices, format } = loaded;
  if (id) {
    const hits = hitsFor(slices, id);
    if (hits.length === 0) return { root, ...missing(id) };
    if (hits.length > 1) return { root, ...ambiguous(id, hits) };
    return { root, next: publicSlice(hits[0]), reason: null };
  }
  const ready = slices.filter((slice) => slice.ready).sort(compareSlice);
  if (ready.length > 0) return { root, next: publicSlice(ready[0]), reason: null };
  const waiting = slices.filter((slice) => slice.state === format.ready).sort(compareSlice);
  const label = (format.stateNames[format.order.indexOf(format.ready)] ?? format.ready).toLowerCase();
  const reason = waiting.length === 0 ? `no ${label} slices` : `no ${label} slice has its dependencies complete`;
  return {
    root,
    next: null,
    reason,
    blocked: waiting.map((slice) => ({
      id: slice.id,
      doc: slice.docName,
      dependsOn: slice.dependsOn,
      unknownDependencies: slice.unknownDeps,
    })),
  };
}

function replaceState(cell, display) {
  const trimmed = String(cell ?? '').trim();
  if (trimmed === '') return display;
  const paren = trimmed.indexOf(' (');
  const head = paren >= 0 ? trimmed.slice(0, paren) : trimmed;
  const tail = paren >= 0 ? trimmed.slice(paren) : '';
  const bold = head.startsWith('**');
  return `${bold ? '**' : ''}${display}${bold ? '**' : ''}${tail}`;
}

function evidenceValue(fmt, existing, sha, test) {
  if (existing.includes(sha)) return { value: existing, recorded: false, note: 'already recorded' };
  const addition = test ? `${sha} · test: ${test}` : sha;
  const plain = clean(existing).toLowerCase();
  const blank = plain === '' || fmt.empty.has(plain);
  return { value: blank ? addition : `${existing} — ${addition}`, recorded: true, note: null };
}

function badCell(value, name) {
  if (value == null || value === '') return null;
  if (/[|\n\r]/.test(value)) return `${name} cannot contain a pipe or a newline`;
  return null;
}

function locate(text, slice) {
  const lines = text.split('\n');
  const idAt = (index) => {
    const line = lines[index];
    if (!line?.trim().startsWith('|')) return null;
    return clean(splitRow(line)[slice.idIdx] ?? '');
  };
  if (idAt(slice.line - 1) === slice.id) return { lines, index: slice.line - 1 };
  for (let i = 0; i < lines.length; i += 1) {
    if (idAt(i) === slice.id) return { lines, index: i };
  }
  return null;
}

export async function planDone(root, id, { sha = null, test = null, state = null, dryRun = false } = {}) {
  if (!id) return { root, error: 'plan done needs a slice id', remedy: `run: ${CLI} plan next` };
  const shaError = badCell(sha, 'sha');
  if (shaError) return { root, id, error: shaError, remedy: `run: ${CLI} plan done ${id} --yes` };
  const testError = badCell(test, 'test');
  if (testError) return { root, id, error: testError, remedy: `run: ${CLI} plan done ${id} --yes` };

  const loaded = await loadPlanState(root);
  if (loaded.error) return { root, id, error: loaded.error, remedy: loaded.remedy };
  const { slices, format } = loaded;
  const display = state == null || state === '' ? format.doneWrite : format.canonical(state);
  if (!display) {
    return {
      root,
      id,
      error: `unknown state ${state}`,
      remedy: `states: ${format.stateNames.join(', ')}`,
    };
  }
  const hits = hitsFor(slices, id);
  if (hits.length === 0) return { root, id, ...missing(id) };
  if (hits.length > 1) return { root, id, ...ambiguous(id, hits) };
  const slice = hits[0];
  const found = locate(slice.doc.text, slice);
  if (!found) {
    return { root, id, error: `${id} is no longer on line ${slice.line} of ${slice.docName}`, remedy: `run: ${CLI} plan status` };
  }

  const original = found.lines[found.index];
  const cells = splitRow(original);
  if (cells.length !== slice.columnCount) {
    return {
      root,
      id,
      error: `the row for ${id} has ${cells.length} cells; the table declares ${slice.columnCount}`,
      remedy: `fix the row in ${slice.docName} — an unescaped pipe splits it — and retry`,
    };
  }
  const from = cells[slice.stateIdx] ?? '';
  cells[slice.stateIdx] = replaceState(from, display);

  let evidenceRecorded = false;
  let evidenceNote = null;
  if (sha && slice.evidenceIdx >= 0) {
    const next = evidenceValue(format, cells[slice.evidenceIdx] ?? '', sha, test);
    cells[slice.evidenceIdx] = next.value;
    evidenceRecorded = next.recorded;
    evidenceNote = next.note;
  } else if (sha) {
    evidenceNote = 'no evidence column in this tracker; the sha was not recorded';
  }

  // The rebuilt line keeps the original's ending: a CRLF file must not gain
  // one LF-terminated line among its CRLF lines (review 0003 Q25).
  const eol = original.endsWith('\r') ? '\r' : '';
  const rebuilt = `| ${cells.join(' | ')} |${eol}`;
  const changedCells = splitRow(original).join('\0') !== cells.join('\0');
  const newLine = changedCells ? rebuilt : original;
  const wouldChange = newLine !== original;
  if (wouldChange && !dryRun) {
    found.lines[found.index] = newLine;
    const journal = [];
    await journaledWriteFile(root, journal, slice.docPath, found.lines.join('\n'));
    await commitJournal(root, 'plan', journal);
  }

  const apply = `run: ${CLI} plan done ${id}${sha ? ` ${sha}` : ''}${display === format.doneWrite ? '' : ` --state ${JSON.stringify(display)}`}${test ? ` --test ${JSON.stringify(test)}` : ''} --yes`;
  return {
    root,
    id,
    doc: slice.docName,
    file: slice.docPath,
    line: found.index + 1,
    from,
    to: cells[slice.stateIdx],
    // The `--diff` sides for the one changed row (plan 0003 R50). The full file
    // is not carried: one table row is the whole write, and a context-less hunk
    // over the row says exactly what changed. Captured pre-write, so the diff
    // is true in preview and in apply alike.
    beforeLine: original,
    afterLine: newLine,
    state: format.readState(display),
    wouldChange,
    changed: wouldChange && !dryRun,
    dryRun,
    evidenceRecorded,
    evidenceNote,
    sha: sha || null,
    test: test || null,
    remedy: wouldChange && dryRun ? apply : null,
  };
}

export function formatCounts(counts, order = []) {
  const keys = rankCounts(counts, order);
  return keys.map((key) => `${key}=${counts[key]}`).join(' ');
}
