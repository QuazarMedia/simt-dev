// Unified diffs of the plan (plan 0003 R50).
//
// Every writer accepts `--diff` and prints what it would change — or, with
// `--yes`, what it changed — as unified diffs, one per file. The engine is
// here, zero dependencies like everything else (a DX tool that needs an
// install step fails on a fresh machine); each command only supplies
// {path, before, after} pairs, read before anything is written.
//
// Two deliberate boundaries:
//
//   - Lines, not bytes. All files this tool writes are text; a binary would
//     diff as one giant replaced line, which says nothing. Callers pass
//     strings (null when the file is absent on that side).
//   - Big files degrade, they do not hang. Past 10,000 lines combined the
//     pair renders as one delete-all/insert-all hunk: still a true statement
//     about what changed, just without the search. Myers is O(ND) and a
//     pathological pair would otherwise own the prompt.

import { readFile } from 'node:fs/promises';

import { emit, isJson } from './output/index.mjs';

const CONTEXT = 3;
const LINE_CAP = 10000;

/**
 * The current bytes of a path, or null when it does not exist. Any other
 * failure propagates: an unreadable file is fail-closed, not treated as
 * absent — a diff against the wrong before would be worse than no diff.
 */
export async function readBefore(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Print a run's pairs as unified diffs, or nothing when the plan changes no
 * bytes (an empty creation, an already-current file). Never changes what the
 * run writes or its exit code — callers invoke it in preview and apply alike.
 *
 * Silent under `--json`: the document is the whole report there, and prose on
 * stdout would break the one-document contract. Callers spread `diffField`
 * into their payload instead, so the JSON answer carries the same bytes.
 */
export function emitDiffs(pairs, flags) {
  if (isJson(flags)) return;
  const text = renderDiffs(pairs);
  if (text !== '') emit(text, { maxBytes: flags.maxBytes ?? 0 });
}

/** The `--diff` bytes for a JSON payload: absent entirely without the flag, so
 *  payloads without it are byte-identical to before. */
export function diffField(pairs, flags) {
  return flags.diff === true ? { diff: renderDiffs(pairs) } : {};
}

/** Split text into lines, remembering whether the last line was terminated. */
function splitLines(text) {
  if (text === '') return { lines: [], terminated: true };
  const terminated = text.endsWith('\n');
  const raw = text.split('\n');
  if (terminated) raw.pop();
  return { lines: raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)), terminated };
}

/**
 * Myers O(ND) edit script as a list of {op, line} with op in keep/del/add.
 * Deterministic: deletions sort before additions at every branch, so the
 * same pair always renders the same hunks.
 */
function script(a, b) {
  const n = a.length;
  const m = b.length;
  if (n + m > LINE_CAP) {
    return [...a.map((line) => ({ op: 'del', line })), ...b.map((line) => ({ op: 'add', line }))];
  }
  const max = n + m;
  const trace = [];
  let v = new Map([[1, 0]]);
  let done = false;
  for (let d = 0; d <= max && !done; d += 1) {
    const cur = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? -1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      cur.set(k, x);
      if (x >= n && y >= m) {
        done = true;
        trace.push(cur);
        break;
      }
    }
    if (!done) trace.push(cur);
    v = cur;
    if (done) break;
  }
  // Walk the trace backwards, emitting the script in reverse.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && (prev.get(k - 1) ?? -1) < (prev.get(k + 1) ?? -1));
    const kPrev = down ? k + 1 : k - 1;
    const xPrev = prev.get(kPrev) ?? 0;
    const yPrev = xPrev - kPrev;
    while (x > xPrev && y > yPrev) {
      ops.push({ op: 'keep', line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (down) {
      ops.push({ op: 'add', line: b[y - 1] });
      y -= 1;
    } else {
      ops.push({ op: 'del', line: a[x - 1] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'keep', line: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/**
 * Group changed ops into hunks with context. Two changes merge when at most
 * 2×CONTEXT unchanged lines sit between them — the trailing context of one
 * is the leading context of the next — and split otherwise.
 */
function hunks(ops) {
  // Line numbers before each op, per side.
  const nums = [];
  let a = 0;
  let b = 0;
  for (const o of ops) {
    nums.push([a, b]);
    if (o.op !== 'add') a += 1;
    if (o.op !== 'del') b += 1;
  }
  const changed = ops.map((o, i) => (o.op === 'keep' ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return [];
  const groups = [];
  let g = [changed[0]];
  for (let i = 1; i < changed.length; i += 1) {
    if (changed[i] - g[g.length - 1] <= CONTEXT * 2) g.push(changed[i]);
    else {
      groups.push(g);
      g = [changed[i]];
    }
  }
  groups.push(g);
  return groups.map((idx) => {
    const start = Math.max(0, idx[0] - CONTEXT);
    const end = Math.min(ops.length - 1, idx[idx.length - 1] + CONTEXT);
    const slice = ops.slice(start, end + 1);
    let aLen = 0;
    let bLen = 0;
    for (const o of slice) {
      if (o.op !== 'add') aLen += 1;
      if (o.op !== 'del') bLen += 1;
    }
    // GNU shape: an empty side starts at the line before (`-0,0`), a single
    // line omits its `,1`.
    const aStart = aLen === 0 ? nums[start][0] : nums[start][0] + 1;
    const bStart = bLen === 0 ? nums[start][1] : nums[start][1] + 1;
    return { aStart, bStart, aLen, bLen, ops: slice };
  });
}

function hunkHeader(h) {
  const a = h.aLen === 1 ? `${h.aStart}` : `${h.aStart},${h.aLen}`;
  const b = h.bLen === 1 ? `${h.bStart}` : `${h.bStart},${h.bLen}`;
  return `@@ -${a} +${b} @@`;
}

/**
 * One file's unified diff, or '' when the two sides are equal. `before` null
 * is a creation, `after` null a removal. An empty creation (or removal of an
 * empty file) has no line changes and renders as '' — the plan already says
 * `created`, and headers with no hunks are noise.
 */
export function unifiedDiff(path, before, after) {
  const b = before ?? null;
  const a = after ?? null;
  if (b === a) return '';
  const bs = b === null ? { lines: [], terminated: true } : splitLines(b);
  const as = a === null ? { lines: [], terminated: true } : splitLines(a);
  const ops = script(bs.lines, as.lines);
  if (ops.every((o) => o.op === 'keep')) {
    // Same lines, different terminator: the bytes still differ, so the last
    // line rewrites rather than vanishing from the diff.
    if (bs.terminated === as.terminated || ops.length === 0) return '';
    const last = ops[ops.length - 1];
    ops.splice(ops.length - 1, 1, { op: 'del', line: last.line }, { op: 'add', line: last.line });
  }
  const head = [
    `diff --git a/${path} b/${path}`,
    b === null ? '--- /dev/null' : `--- a/${path}`,
    a === null ? '+++ /dev/null' : `+++ b/${path}`,
  ];
  const body = [];
  for (const h of hunks(ops)) {
    body.push(hunkHeader(h));
    // Positions inside the hunk, to place the missing-newline markers exactly
    // where GNU does: after the last line of a side that lacks its terminator.
    let ai = h.aStart + (h.aLen === 0 ? 1 : 0);
    let bi = h.bStart + (h.bLen === 0 ? 1 : 0);
    for (const o of h.ops) {
      if (o.op === 'keep') {
        body.push(` ${o.line}`);
        ai += 1;
        bi += 1;
      } else if (o.op === 'del') {
        body.push(`-${o.line}`);
        if (ai === bs.lines.length && !bs.terminated) body.push('\\ No newline at end of file');
        ai += 1;
      } else {
        body.push(`+${o.line}`);
        if (bi === as.lines.length && !as.terminated) body.push('\\ No newline at end of file');
        bi += 1;
      }
    }
  }
  return [...head, ...body].join('\n');
}

/**
 * Render a run's pairs, skipping the equal and the empty. Paths print in the
 * order given — the caller owns the order, usually the write order — and
 * blocks join with one blank line, the way a reader scans them.
 */
export function renderDiffs(pairs) {
  return pairs
    .map(({ path, before, after }) => unifiedDiff(path, before ?? null, after ?? null))
    .filter((d) => d !== '')
    .join('\n\n');
}
