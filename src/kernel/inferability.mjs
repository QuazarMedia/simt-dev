// The inferability filter: a rule line the repository already proves does not ship
// (plan 0003 R09).
//
// The costliest byte in a projection is the one the reader already knows. A Go repository
// with one runner does not need to be told to use it; a repository whose manifest declares
// a format gate does not need to be told how it indents. The evidence is committed — the
// marker files, the declared gates, the command card — so the same repository filters the
// same way on every machine (plan 0003 P4, R13).
//
// Nothing is dropped by guesswork. A rule author marks the line with
// `<!-- simt-inferable-when: <expression> -->`, naming the evidence that makes it
// redundant, and the line leaves only when the repository proves every term. A line nobody
// marked is a line nobody claimed was inferable, and stays.
//
// The unit dropped is the blank-line-delimited block, so a wrapped bullet is marked once
// and leaves whole rather than leaving half a sentence behind. The marker is stripped from
// the region either way: `simt-` vocabulary is for the rule's author, not its reader.

import { gateNames } from '../hooks/gates.mjs';
import { KNOWN_TAGS } from '../resolve/fingerprint.mjs';

import { CARD_VERBS } from './card.mjs';

/**
 * The marker a rule line carries. Named here rather than at its use, because the defect
 * message has to spell the thing the author must type.
 */
export const INFERABLE_MARKER = 'simt-inferable-when';

const MARKER = /<!--\s*simt-inferable-when:\s*([^>]*?)\s*-->/g;

/**
 * Marks the trailing position of a marker on a line, so the text a reader keeps is the
 * line without the comment and not the line with a hole in it.
 */
const MARKER_AT = /\s*<!--\s*simt-inferable-when:\s*[^>]*?-->/g;

/** A non-global probe, because a global regex carries `lastIndex` between calls. */
const HAS_MARKER = /<!--\s*simt-inferable-when:/;

/**
 * Split a body into the units a marker drops. Blank lines separate blocks, except inside a
 * fenced code block, where a blank line is part of the sample and splitting there would
 * cut a fence in half.
 */
function blocks(text) {
  const out = [];
  let current = [];
  let fenced = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (current.length > 0 || fenced) current.push(line);
      fenced = !fenced;
      continue;
    }
    if (!fenced && line.trim() === '') {
      if (current.length > 0) out.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) out.push(current.join('\n'));
  return out;
}

/** Every marker in one block, as `{line, expr}`. More than one is a defect. */
function markers(block) {
  const found = [];
  for (const line of block.split('\n')) {
    for (const match of line.matchAll(MARKER)) found.push({ line, expr: match[1] });
  }
  return found;
}

/**
 * An expression is a conjunction of terms: `term + term`, and nothing else. There is no
 * negation, because every reason a line is redundant is a positive proof the repository
 * offers, and a grammar for a case nobody has is a grammar nobody can be taught.
 */
export function parseInferable(expression) {
  return String(expression ?? '')
    .split('+')
    .map((term) => term.trim())
    .filter((term) => term !== '');
}

/**
 * Whether a term is evidence this tool can check: a fact or stack tag the repository
 * proves by its files, a verb its command card names, or a gate it declares. Anything else
 * is a typo the author has to see, not a term that happens to be unproven — a marker
 * naming evidence the tool never gathered would drop the line on a claim nothing verified.
 */
function knownTerm(term) {
  if (term.startsWith('card:')) return CARD_VERBS.includes(term.slice('card:'.length));
  if (term.startsWith('gate:')) return gateNames().includes(term.slice('gate:'.length));
  return KNOWN_TAGS.has(term);
}

/**
 * The defect in a body's markers, or null. Reported through the same field as a
 * frontmatter defect, so `check` and `rules list` need no second path to a broken rule.
 */
export function inferableDefect(body) {
  for (const block of blocks(body)) {
    const found = markers(block);
    if (found.length === 0) continue;
    if (found.length > 1) {
      return `carries more than one ${INFERABLE_MARKER} marker; a block is dropped whole, so one marker is one claim`;
    }
    const terms = parseInferable(found[0].expr);
    if (terms.length === 0) {
      return `${INFERABLE_MARKER} names no evidence, so nothing can decide whether the line is redundant`;
    }
    for (const term of terms) {
      if (!knownTerm(term)) {
        return `${INFERABLE_MARKER} names "${term}", which is not evidence this repository can prove; use a marker-file fact, card:${CARD_VERBS.join('|card:')} or gate:<name>`;
      }
    }
  }
  return null;
}

/**
 * The evidence a projection may treat as already known. Built from committed bytes only —
 * never PATH or `node_modules` — because a proof read off the machine would make the
 * region differ between a laptop and CI for no reason a diff could explain.
 */
export function inferableProofs({ facts = [], stack = [], card = null, manifest = null } = {}) {
  const proofs = new Set([...facts, ...stack]);
  for (const line of card?.lines ?? []) {
    if (line.verb) proofs.add(`card:${line.verb}`);
  }
  const gates = manifest?.gates ?? {};
  for (const name of [...(gates.preCommit ?? []), ...(gates.prePush ?? [])]) {
    proofs.add(`gate:${name}`);
  }
  return proofs;
}

/** The line a reader would have read, collapsed and clipped for a one-line note. */
function excerpt(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

/** The block without its markers, and without the line a marker stood on alone. */
function stripMarkers(block) {
  const kept = [];
  for (const line of block.split('\n')) {
    const stripped = line.replace(MARKER_AT, '').replace(/\s+$/, '');
    if (stripped === '' && HAS_MARKER.test(line)) continue;
    kept.push(stripped);
  }
  return kept.join('\n');
}

/**
 * Drop every marked block whose expression the repository proves, and strip the markers
 * from the rest.
 *
 * `changed` is false when the body carries no marker, and then `body` is the input by
 * identity: a projection of a rule nobody marked must not move a byte, or every
 * repository in the estate would diff on a change none of them made.
 *
 * @returns {{body: string, removed: {text: string, expr: string}[], changed: boolean}}
 */
export function filterInferable(body, proofs) {
  const parts = blocks(body);
  if (!parts.some((block) => markers(block).length > 0)) {
    return { body, removed: [], changed: false };
  }
  const kept = [];
  const removed = [];
  for (const block of parts) {
    const found = markers(block);
    if (found.length > 0) {
      const terms = parseInferable(found[0].expr);
      if (terms.length > 0 && terms.every((term) => proofs.has(term))) {
        removed.push({ text: excerpt(stripMarkers(block)), expr: found[0].expr.trim() });
        continue;
      }
    }
    const clean = stripMarkers(block).replace(/\s+$/, '');
    if (clean.trim() !== '') kept.push(clean);
  }
  return { body: kept.join('\n\n'), removed, changed: true };
}
