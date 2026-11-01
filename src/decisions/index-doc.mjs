// The decisions index document, rendered from the records.
//
// The file was 590 hand-written lines: a table of every ADR kept in step by whoever
// remembered. It agreed with the records until it did not, and nothing read it, so
// nothing noticed - the failure the generated rule regions exist to prevent, one
// directory over. The table is output now: this module renders it, `simt rules
// decisions --yes` writes it, and test/decisions-index.test.mjs fails on drift.
//
// The narrative that trailed the table moved to docs/architecture/history.md: prose a
// reader consults is not prose a command rewrites.

const HEADER = `# Decisions

Architecture decision records for the SIMT development ecosystem. One canonical home per
decision; nothing here is duplicated into a repo's \`AGENTS.md\`.

A decision is superseded by writing a new ADR with a higher number and editing the old
record's status line — never by editing the ruling in place.

This table is generated from the records: \`simt rules decisions --yes\` writes it, and
\`test/decisions-index.test.mjs\` fails when it drifts. The history behind the numbers is
in [architecture/history.md](architecture/history.md).

| ADR | Decision | Status |
|---|---|---|
`;

/**
 * The index document, from the records.
 *
 * Ordered by number, not by filename: the number IS the order, and a directory listing
 * is not (`ADR-100` sorts before `ADR-99` as text).
 *
 * @param {{id: string, title: string, status: string, file: string}[]} rows
 * @returns {string}
 */
export function renderDecisionsIndex(rows) {
  const ordered = [...rows].sort((a, b) => number(a.id) - number(b.id));
  const lines = ordered.map((row) => `| [${number(row.id)}](decisions/${row.file}) | ${row.title} | ${row.status} |`);
  return `${HEADER}${lines.join('\n')}\n`;
}

/** `ADR-007` -> `007`, the number the table and the ordering both use. */
function number(id) {
  return id.replace(/^ADR-/i, '').padStart(3, '0');
}
