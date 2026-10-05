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
      bytes: Buffer.byteLength(text),
    });
  }

  return { ok: errors.length === 0, decisions, errors };
}

/** Index by id, for a lookup per cited ADR. */
export function byId(decisions) {
  return new Map(decisions.map((d) => [d.id, d]));
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