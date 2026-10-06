// The decision index: what `simt-dev rules why` traces back to.
//
// Rule bodies cite the decision that settled them inline, as `(ADR-001)`. That
// citation is the only thing standing between "a rule someone wrote" and "a rule
// the org decided", so it has to be resolvable: `rules why` reads the citation,
// finds the record, and reports its title and status.
//
// The status matters more than it looks. ADR-011 was accepted and then reversed
// by ADR-012 the same day. Printing ADR-011's ruling without saying so would
// hand a reader a decision that is no longer in force - the failure mode of a
// provenance feature that only proves provenance, not currency.
//
// A rule with NO citation is a finding, not an empty result. It is reported as
// such, because "no decision behind this" is exactly what a reviewer needs to
// see and exactly what an empty output would hide.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DECISIONS_DIR = resolve(HERE, '..', '..', 'docs', 'decisions');

const ADR_IN_TEXT = /\bADR-(\d{3})\b/g;

/**
 * Every ADR cited in a body, sorted and deduped. A citation is matched anywhere
 * in the text, including inside a link, because `Status: ... supersedes
 * [ADR-011](ADR-011-...)` names the same record a rule body would.
 *
 * @returns {string[]} e.g. ['ADR-001', 'ADR-005']
 */
export function citations(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(ADR_IN_TEXT)) {
    found.add(`ADR-${match[1]}`);
  }
  return [...found].sort();
}

/**
 * Load every ADR record once.
 *
 * An unreadable or unparseable record is an error rather than a skipped file: a
 * missing decision is the one thing `rules why` must never report silently.
 *
 * @returns {Promise<{ok: boolean, decisions: object[], errors: string[]}>}
 */
export async function loadDecisions() {
  let names;
  try {
    names = (await readdir(DECISIONS_DIR)).filter((n) => /^ADR-\d{3}-.*\.md$/.test(n)).sort();
  } catch (error) {
    return { ok: false, decisions: [], errors: [`${DECISIONS_DIR}: unreadable (${error.message})`] };
  }

  const decisions = [];
  const errors = [];

  for (const file of names) {
    const text = await readFile(join(DECISIONS_DIR, file), 'utf8');
    const id = /^ADR-(\d{3})/.exec(file)?.[0];
    if (!id) {
      errors.push(`${file}: filename does not start with ADR-NNN`);
      continue;
    }
    const heading = /^#\s+(.*)$/m.exec(text)?.[1] ?? null;
    if (!heading) {
      errors.push(`${file}: no level-1 heading`);
      continue;
    }
    const status = /^Status:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? null;
    if (!status) {
      errors.push(`${file}: no Status: line, so currency cannot be reported`);
      continue;
    }
    // The heading repeats the id; the decision title is what follows the dash.
    const title = heading.replace(/^ADR-\d{3}\s*[—–-]\s*/, '').trim();

    decisions.push({
      id,
      file,
      title,
      status: stripMarkdown(status),
      accepted: status.includes('**accepted**'),
      supersededBy: firstMatch(status, /superseded by \[ADR-(\d{3})\]/i),
      supersedes: [...status.matchAll(/supersedes \[ADR-(\d{3})\]/gi)].map((m) => `ADR-${m[1]}`),
      summary: summarise(text),
      bytes: Buffer.byteLength(text),
    });
  }

  return { ok: errors.length === 0, decisions, errors };
}

/** Index by id, for a lookup per cited ADR. */
export function byId(decisions) {
  return new Map(decisions.map((d) => [d.id, d]));
}

/**
 * What the decision actually says, in the reader's terms.
 *
 * A citation has to be *resolvable*, or it is decoration. Printing only a title and a
 * status answers "does this exist and is it current?" but not "why am I being told
 * this?", which is the only question an agent following `(ADR-005)` actually has. The
 * full record is far too long to print, so this takes the ruling and the alternatives
 * it refused — the two parts that generalise to a repository that owns none of the
 * files the record cites.
 *
 * The `## Context` section is deliberately NOT summarised. It is a survey of what
 * specific repositories used to say, which is exactly what makes an ADR worth writing
 * and exactly what a reader in another repository cannot follow. The rule itself is
 * already in full, in plain language, in the projected content; the citation exists
 * for the reader who doubts it, and that reader needs the ruling, not the estate.
 *
 * Never contains a path, because a record read inside a consumer repo cannot name one.
 *
 * @returns {{ruled: string[], rejected: string[], writtenAgainst: string[]}}
 */
function summarise(text) {
  const section = (name) => {
    const m = new RegExp(`^##\\s+${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?!\\s))`, 'ms').exec(text);
    return m ? m[1] : '';
  };

  // The records are prose under `## Ruling` but numbered clauses under `## Rulings`,
  // and both shapes appear in the same section across the set. Splitting on blank
  // lines alone merged every list item into one paragraph.
  const units = (body) => {
    const blocks = [];
    let current = null;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      const item = line.match(/^(?:\d+\.|[-*])\s+(.*)$/);
      if (item) {
        // A new list item closes the paragraph it was appended to, whether or not
        // there was a blank line between them.
        if (current) blocks.push(current);
        current = [item[1]];
      } else if (current) {
        // A continuation line folds into the item it belongs to.
        current.push(line);
      } else {
        current = [line];
      }
    }
    if (current) blocks.push(current);
    return blocks
      .map((lines) => lines.join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 40 && !p.startsWith('|'));
  };

  const rejected = units(section('Rejected'))
    .slice(0, 3)
    .map((p) => sentence(p));

  // A lead-in ending in a colon introduces what follows it, so on its own it is a
  // sentence with no predicate. Kept only when nothing follows.
  const ruled = units(section('Ruling') || section('Rulings'));
  const withLead = ruled.filter((p, i) => !p.endsWith(':') || i === ruled.length - 1);

  return {
    ruled: withLead.slice(0, 2).map((p) => sentence(p)),
    rejected,
    // Named rather than stripped. A record that cites this org's repositories is still
    // the record; silently deleting the citation would hide which decisions were made in
    // response to what, and would mangle sentences mid-clause.
    writtenAgainst: [...new Set(text.match(ESTATE) ?? [])].sort(),
  };
}

/**
 * Repositories and stacks the records were written about. Reported to the reader, never
 * removed: they are why the record exists, and deleting them mid-sentence would make it
 * claim to be about a rule nobody ever held.
 */
const ESTATE =
  /\b(?:app-ui|bunnyland(?:-server)?|wakt-app|simt-[\w-]+|(?:the )?(?:Social|garmin) repos?)\b/gi;

/** Trim to whole sentences within a budget, never leaving a stub fragment. */
function sentence(text, limit = 260) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const stop = cut.lastIndexOf('. ');
  if (stop > limit * 0.4) return cut.slice(0, stop + 1);
  const word = cut.lastIndexOf(' ');
  return `${cut.slice(0, word).replace(/[,;:]$/, '')}...`;
}

function stripMarkdown(text) {
  // Links are flattened to their label and emphasis markers are dropped: this
  // output is read by agents, and `[ADR-012](ADR-012-windows-support.md)` is a
  // fact an agent cannot use without re-parsing markdown.
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? `ADR-${m[1]}` : null;
}