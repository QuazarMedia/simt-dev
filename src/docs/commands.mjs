// The README's command list, rendered from the spec (review 0003 Q60).
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
import { CLI } from '../name.mjs';

export const README_FILE = 'README.md';
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
    '<!-- Rendered from the spec by `simt docs readme --yes`; do not edit by hand. -->',
    '',
    '```sh',
    ...lines,
    '```',
    END,
  ].join('\n');
}

/**
 * Replace the region between the markers, or return null when the file carries none.
 *
 * Null rather than an appended block: a README without the markers has the list somewhere
 * else, and writing a second one beside it is the duplicated list this rendering exists
 * to remove.
 */
export function replaceBlock(text, block) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
}
