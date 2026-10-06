// The tooling baselines: settings that belong to the estate, in files the repo owns.
//
// Plan 1 section 2.2 named these as marker-managed before any of them existed —
// "Same for `.editorconfig`, `.prettierrc`, `.gitattributes`. Local content is never
// clobbered; shared content can never drift silently" — and this module is that
// sentence, restricted to the files whose syntax can actually carry a region.
//
// The restriction is not caution, it is grammar. A region is delimited by comments,
// so it can only live in a file that has them and whose comment character the
// reading tool ignores. `.editorconfig` qualifies: `#` is a comment in INI and every
// editorconfig parser honours it. `tsconfig.base.json` and `.prettierrc.json` do not
// — JSON has no comment syntax — and `.nvmrc` is a bare version string. Those three
// are ruled out by ADR-025, not deferred by accident; a managed region in a JSON file
// would have to be a string literal that prettier and tsc both choke on.
//
// One value is deliberately absent: `end_of_line`. It reads like an editor setting and
// is not one. It decides whether a save rewrites every line of every file, which is a
// claim about what belongs in the repository, and that claim is made in
// `.gitattributes` where git reads it. Setting it here would change every checkout of
// every repo on the day it landed, and the repo that wanted CRLF could only opt out by
// deleting the region — losing the indentation baseline with it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inject, parse } from './markers.mjs';
import { STYLES } from './markers.mjs';

/**
 * The shared `.editorconfig` block.
 *
 * `root = true` is not decoration. An editorconfig search walks parent directories
 * until it finds a `root = true`, so without it this repo's settings depend on
 * whether something above it happens to have one — a baseline that changes meaning
 * depending on where someone cloned it is not a baseline.
 *
 * The language sections carry only what a shared file can know: indentation, which is
 * a property of the language and not of the project. Nothing here is a value any repo
 * would want to argue with, which is the test it has to pass to belong in a file
 * every repo has.
 */
export const EDITORCONFIG_BODY = `root = true

[*]
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
# Two trailing spaces are a hard line break in Markdown. Stripping them there is not
# tidiness; it deletes meaning the author wrote.
trim_trailing_whitespace = false

[*.{js,mjs,cjs,jsx,ts,tsx,json,jsonc,css,scss,html,yml,yaml}]
indent_style = space
indent_size = 2

[*.{py,pyi,java,kt,kts}]
indent_size = 4

[{Makefile,*.mk}]
indent_style = tab

[{*.go,*.proto}]
indent_style = tab

[prettier]
# Prettier reads this section, and only this section, from .editorconfig. Two repos
# that disagree about singleQuote disagree about the bytes, not about the code, so
# the value belongs in the file every repo already has rather than in a second config
# file per repo. A repo with its own prettier config overrides this, and that is the
# right order: the nearer file wins.
#
# No printWidth. Nobody has ruled on one, and a baseline that picks a number nobody
# argued about is a number nobody agreed to.
singleQuote = true`;

/**
 * Every baseline, as a row.
 *
 * `where` and `style` are the file's properties, not the caller's: `.editorconfig`
 * is last-definition-wins and speaks `#`, so the shared block goes first and a
 * reader's own settings below it keep winning. `check` reports a region that has
 * been moved down, because after the move it stops being true.
 *
 * @typedef {{file: string, style: string, body: () => string, why: string, adr: string}} Baseline
 * @type {Baseline[]}
 */
export const BASELINES = [
  {
    file: '.editorconfig',
    style: 'hash',
    body: () => EDITORCONFIG_BODY,
    why: 'ten repos in the estate have no editorconfig at all, so two people opening the same file see two different files',
    adr: 'ADR-025',
  },
];

/**
 * Build the write targets for every baseline.
 *
 * Returns the same shape `targetFor` returns for AGENTS.md, because `sync` writes one
 * list and `check` compares against the same construction. A second shape here would
 * be a second place computing the desired bytes, which is the defect that made the
 * gate report drift on a clean tree before this list existed.
 */
export async function baselineTargets(root, sha) {
  const targets = [];
  for (const b of BASELINES) {
    const path = join(root, b.file);
    let existing = '';
    let exists = true;
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      exists = false;
    }
    const body = b.body();
    // No `sources` in the provenance header. It records where the bytes came from,
    // and for a baseline the file being written IS the source - the module in front
    // of the reader, not a path in a tree they do not have.
    const result = inject(existing, body, { sha }, { style: b.style });
    targets.push({
      file: b.file,
      kind: 'baseline',
      style: b.style,
      path,
      exists,
      action: result.action,
      reason: result.reason,
      line: result.line,
      bytes: Buffer.byteLength(result.text),
      previousBytes: Buffer.byteLength(existing),
      sha,
      body,
      text: result.text,
      previous: existing,
    });
  }
  return { targets };
}

/**
 * Why a baseline is not where this module would put it.
 *
 * A moved region is a silent behaviour change: nothing in the region changed, `check`
 * would call it current, and the repo's own settings would simply have stopped
 * applying. The bytes are right and the meaning is wrong, which is the hardest kind
 * of drift to notice, so it gets its own finding rather than a note.
 */
export function misplaced(region, style = 'hash') {
  if (region.status !== 'ok') return null;
  if (region.before.trim() === '') return null;
  const s = STYLES[style] ?? STYLES.hash;
  return {
    detail:
      'the simt-dev region is not at the top of the file, so it overrides the settings ' +
      'below it; this format takes the last definition that matches, and the repo must win',
    remedy: `move "${s.begin}" and "${s.end}" above your own settings, or delete the region and set what you need`,
  };
}

export { parse };