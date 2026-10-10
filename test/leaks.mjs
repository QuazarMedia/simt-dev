// The guard for the rule in AGENTS.md: every byte simt-dev ships into another
// repository must be readable and actionable by someone who has only the receiving
// repository.
//
// It is its own module because the second thing simt-dev ships arrived before this
// one did: the CI workflow is the first file it writes that a human has to be able to
// read and argue with in a review, and it is subject to exactly the same rule as the
// rule bodies. A third shipped surface gets the import, not a third copy.

import assert from 'node:assert/strict';
import { ESTATE_NAME } from '../src/decisions/index.mjs';

/**
 * Paths and phrases that only mean something inside simt-dev's own tree.
 *
 * `docs/plans/` is deliberately absent. It appears in intake-questions as a
 * substitution DEFAULT: "your plans live here, relative to you". A repo reading
 * it resolves it against itself, which is correct. The defect class is a path
 * that resolves against *this* repository, not a path that resembles one.
 */
export const LEAKS = [
  { re: /docs\/decisions\//, what: 'a decision-record path' },
  { re: /rules\/stacks\//, what: 'this repository\'s rule layout' },
  { re: /rules\/core\.md/, what: 'this repository\'s rule layout' },
  { re: /rules\/mdc\//, what: 'this repository\'s rule layout' },
  { re: ESTATE_NAME, what: 'a repository from this estate' },
  { re: /\bthe estate\b|\ball 16 repos\b|\bthis audit\b/i, what: 'an investigation artefact' },
];

/** Text addressed to whoever maintains the rules, projected into a repo nobody maintains. */
export const AUTHOR_ADDRESSED = [
  { re: /edit the source/i, what: 'an instruction to edit upstream source' },
  { re: /edits here are overwritten/i, what: 'an instruction to edit upstream source' },
  { re: /this file is projected/i, what: 'narration about the projection itself' },
];

/**
 * Provenance lines the tool writes about itself.
 *
 * `<!-- simt:sources=rules/core.md -->` is namespaced under the command, is an HTML
 * comment an agent never reads, and is the one thing that tells a maintainer which
 * files produced a region. It is tool metadata, not prose addressed to the reader -
 * so it is exempt from the path check and nothing else.
 *
 * The namespace moved with the command (ADR-056), and both spellings are exempt: the
 * tool reads regions stamped with either, and a guard that flagged one of its own two
 * accepted shapes would train people to ignore it.
 *
 * The `#` arm is the same line in a file whose comment character is not `<`. A
 * baseline cannot use HTML comments without becoming invalid in its own format, so
 * the exemption has to follow the syntax or the guard would flag the tool's own
 * provenance as a leak - which trains people to ignore the guard.
 */
export const NAMESPACED_PROVENANCE =
  /^\s*(?:<!--\s*(?:simt|simt-dev):[^>]*-->|#\s*(?:simt|simt-dev):.*)\s*$/gm;

export function assertClean(where, text) {
  // Author-addressed text is checked everywhere, including comments: the old header
  // said "edit the source in simt-dev" from inside a comment, and that was a real
  // leak to a real reader.
  for (const { re, what } of AUTHOR_ADDRESSED) {
    const m = re.exec(text);
    assert.equal(m, null, `${where} ships ${what}: ${JSON.stringify(m?.[0])}\n\n${text}`);
  }
  const prose = text.replace(NAMESPACED_PROVENANCE, '');
  for (const { re, what } of LEAKS) {
    const m = re.exec(prose);
    assert.equal(m, null, `${where} ships ${what}: ${JSON.stringify(m?.[0])}\n\n${text}`);
  }
}
