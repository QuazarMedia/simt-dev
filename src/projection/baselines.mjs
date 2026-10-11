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
// editorconfig parser honours it. `.gitattributes` qualifies for the same reason and
// for a stronger one: `#` is a comment to git, and gitattributes is last-match-wins,
// so the shared claim goes first and every repo's own patterns still win beneath it.
// `tsconfig.base.json` and `.prettierrc.json` do not — JSON has no comment syntax — and
// `.nvmrc` is a bare version string. Those three are ruled out by ADR-025 and ADR-026,
// not deferred by accident; a managed region in a JSON file would have to be a string
// literal that prettier and tsc both choke on.
//
// One value is deliberately absent from `.editorconfig`: `end_of_line`. It reads like an
// editor setting and is not one. It decides whether a save rewrites every line of every
// file, which is a claim about what belongs in the repository, and that claim is made in
// `.gitattributes` where git reads it — which is why the second baseline exists. Setting
// it in the editorconfig would have changed every checkout of every repo on the day it
// landed, and the repo that wanted CRLF could only have opted out by deleting the
// indentation baseline with it.
//
// Two values are absent for the same class of reason, and the second one is here
// because it was shipped once and read as settled by two reviews. A formatter's own
// options are not editorconfig properties: this file shipped `[prettier] singleQuote =
// true`, and a section header in editorconfig is a glob over paths, so that section
// matched a file named `prettier` and no key in it is one any reader honours — the
// specification defines nine and `singleQuote` is not among them, and prettier's own
// mapping reads six properties, none of them that one. It was decoration describing an
// artefact that did not exist, and `check` could not see it because the bytes were
// current.
//
// The alternative spelling does exist — prettier reads `quote_type` from a matching
// glob — and it is deliberately not used. Three of five repositories in this estate
// already state `singleQuote` and two do not, so a shared `quote_type = single`
// reformats every source file in those two on the day they adopt the tool. ADR-048
// carries the survey; the sentence is here because the next person who wants to settle a
// formatting argument in this file needs to know it was measured, not guessed at.

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
indent_style = tab`;

/**
 * The shared `.gitattributes` block.
 *
 * `text=auto` and not `text`. This is the whole content of the region, so it is worth
 * saying why it is the cautious half of the choice: `* text eol=lf` forces git to treat
 * every path as text and is the single most common way to corrupt a binary in a
 * repository, because nothing tells git it is wrong. `auto` makes git decide per path
 * from its own content sniffing, so a `.tif`, a `.zip` and a `.mc` file are left exactly
 * as they are and only files that genuinely are text get normalised. One
 * already worked this out on its own, which is the strongest evidence available that
 * the conservative form is the one the estate would have picked.
 *
 * `eol=lf` is the claim ADR-025 deliberately refused to make from `.editorconfig`, and
 * it is made here because this is where git reads it. The effect is on the working tree
 * rather than on the editor, which is what makes it safe to share: a repo that has
 * already committed CRLF gets LF on its next checkout, and nothing rewrites a file the
 * moment the region lands.
 *
 * No `-text` on generated or vendored paths, no LFS filters, and no `linguist` or
 * `diff` driver. Those are per-repo claims about what a file IS; a shared file that
 * asserted them would be wrong in 13 of 16 repositories, and a wrong attribute is
 * silently obeyed.
 */
export const GITATTRIBUTES_BODY = `* text=auto eol=lf`;

/**
 * Every baseline, as a row.
 *
 * `where` and `style` are the file's properties, not the caller's: both files here are
 * last-definition-wins and both speak `#`, so the shared block goes first and a reader's
 * own settings below it keep winning. `check` reports a region that has been moved down,
 * because after the move it stops being true.
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
  {
    file: '.gitattributes',
    style: 'hash',
    body: () => GITATTRIBUTES_BODY,
    why: 'line endings are the estate\'s to normalise and only git can normalise them; thirteen repos have no file that says so, and one asks for the forcing form that corrupts binaries',
    adr: 'ADR-027',
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
      // As on the primary target: the state the file was in, for a caller that must
      // distinguish "no region here" from "this file is small" (ADR-049, S26).
      region: result.region,
      previousBody: result.previousBody,
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