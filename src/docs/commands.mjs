// The README's command list, rendered from the spec.
//
// The README carried the fifth copy of the command list this review found. The other
// four now come from `spec.mjs`; this one could not, because a README line is a sentence
// for a reader rather than a table row for a parser. It does not need to be: a row's
// `path` is the command and its `summary` is already one phrase, written for help. So the
// list is rendered from those two fields, and `test/docs.test.mjs` fails when the README
// and the spec stop agreeing.
//
// The group comment is the first word of the path, which is what a reader scans for. The
// order is the order the spec lists groups in, so a new group lands where its author put
// it rather than wherever it sorts.
import { SPEC } from '../commands/spec.mjs';
import { EXPLAIN_CODES } from '../explain.mjs';
import { CLI } from '../name.mjs';

export const README_FILE = 'README.md';
export const DOCS_DIR = 'docs/commands';
export const BEGIN = '<!-- simt:commands:begin -->';
export const END = '<!-- simt:commands:end -->';

/** The fenced command list, markers included, exactly as the README must carry it. */
export function renderCommandBlock() {
  const groups = new Map();
  for (const row of SPEC) {
    const group = row.path.split(' ')[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  // The invocation, not the path: `brief` without `"<task>"` is a command a reader has
  // to go and look up, which is what the hand-written list it replaced was for.
  const command = (row) => `${row.path}${row.usage === undefined ? '' : ` ${row.usage}`}`;
  const width = Math.max(...SPEC.map((row) => command(row).length));
  const lines = [];
  for (const [group, rows] of groups) {
    lines.push('', `# ${group}`);
    for (const row of [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      lines.push(`${CLI} ${command(row).padEnd(width)}  # ${row.summary}`);
    }
  }
  // The first group's leading blank line would sit directly under the fence, which reads
  // as a stray newline in the block rather than a separation.
  if (lines[0] === '') lines.shift();
  return [
    BEGIN,
    '<!-- Rendered from the spec by `simt docs commands --yes`; do not edit by hand. -->',
    '',
    '```sh',
    ...lines,
    '```',
    END,
  ].join('\n');
}


/** Escape a cell so a summary containing a pipe cannot break the table. */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|');
}

/**
 * The whole `docs/commands/` tree, rendered from the spec.
 *
 * One page per group and an index that carries the flat list, so a reader who knows the
 * command name and a reader who knows only what they want to do both land on a page the
 * spec wrote. `README.md` used to carry the flat list, which made the front page 240 lines
 * of reference before its first paragraph of prose.
 */
export function renderCommandPages() {
  const groups = new Map();
  for (const row of SPEC) {
    const group = row.path.split(' ')[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  const pages = new Map();
  const index = [
    '# Commands',
    '',
    'Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.',
    'Every path this binary dispatches is listed here, and nowhere else in the docs.',
    '',
    '| Group | Commands |',
    '| --- | --- |',
    ...[...groups].map(([group, rows]) => `| [${group}](${group}.md) | ${rows.length} |`),
    '',
    '## Every command',
    '',
    renderCommandBlock(),
    '',
  ].join('\n');
  pages.set(`${DOCS_DIR}/README.md`, index);
  for (const [group, rows] of groups) {
    const body = [
      `# simt ${group}`,
      '',
      `Rendered from the command spec by \`simt docs commands --yes\`; do not edit by hand.`,
      '',
      '| Command | Flags | What it does |',
      '| --- | --- | --- |',
      ...rows.map((row) => {
        const invocation = `${CLI} ${row.path}${row.usage === undefined ? '' : ` ${row.usage}`}`;
        const flags = (row.flags ?? []).map((flag) => `\`--${flag}\``).join(', ');
        return `| \`${cell(invocation)}\` | ${flags || '—'} | ${cell(row.summary)} |`;
      }),
      '',
      rowNote(rows),
    ].join('\n');
    pages.set(`${DOCS_DIR}/${group}.md`, body);
  }
  return pages;
}

/** The one sentence a group page owes a reader: what a write does, and whether it asks. */
function rowNote(rows) {
  const writes = rows.filter((row) => row.writes === 'repo');
  if (writes.length === 0) return 'None of these write to the repository.';
  const names = writes.map((row) => `\`simt ${row.path}\``).join(', ');
  return `Writes to the repository: ${names}. Each prints its plan and writes nothing without \`--yes\`.`;
}

/** `docs/reference/findings.md`, rendered from the one table that explains a code. */
function renderFindingsPage() {
  const rows = Object.entries(EXPLAIN_CODES)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, entry]) => `| \`${code.toUpperCase()}\` | ${cell(entry.what)} |`);
  return [
    '# Finding codes',
    '',
    'Rendered from `src/explain.mjs` by `simt docs commands --yes`; do not edit by hand.',
    '`simt explain <CODE>` prints the full record for each: the defect, the ruling behind it,',
    'the command that fixes it, and what a reader sees.',
    '',
    '| Code | What it means |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/** Reference pages rendered from a table rather than written by hand. */
export function renderReferencePages() {
  return new Map([['docs/reference/findings.md', renderFindingsPage()]]);
}
