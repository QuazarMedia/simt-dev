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
 * A line that begins one of the record's other front-matter fields.
 *
 * The status is a paragraph, and its continuation lines are prose that happens to
 * start with a lower-case word or a `[` - the link that carries the ADR it names. A
 * sibling field starts with a capitalised label and a colon, which no continuation
 * line in the corpus does. Getting this wrong is not cosmetic in either direction:
 * stopping early truncates the sentence that says which ruling was overturned (the
 * defect this module was filed for), and reading on swallows `Affects:`, whose value
 * is a list of paths - and `rules why` output is read inside a repository that owns
 * none of them.
 */
const SIBLING_FIELD = /^\*{0,2}[A-Z][\w]*(?:[ \t]+[\w]+){0,3}:\*{0,2}(?:[ \t]|$)/;

/**
 * `ruling N <verb> by <ADR>`, in every form the corpus uses.
 *
 * Four spellings, all of them real: `ruling 3 superseded by ADR-046`, `rulings 1 and 2
 * narrowed by ADR-026`, `rulings 3 and 4 narrowed by the same record`, and `one ruling
 * narrowed by ADR-045` - which names no number at all, because the record does not say
 * which ruling it meant. That last one is carried with `ruling: null` rather than
 * dropped: a clause the tool can see but cannot resolve is reported as unresolved, and
 * the corpus test below pins that there are none.
 */
const PARTIAL_CLAUSE =
  /\b(?:one ruling|rulings?\s+(\d+(?:\s*(?:,|and)\s*\d+)*))\s+(superseded|narrowed|withdrawn)\s+by\s+(ADR-\d{3}|the same record)\b/gi;

/** How a record says a ruling was numbered, when it did not use a digit. */
const ORDINALS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const ORDINAL_NUMBER = new Map(ORDINALS.map((w, i) => [w, i + 1]));

/**
 * The `Status:` field, whole.
 *
 * @returns {string|null} the paragraph, flattened, or null when there is no such field.
 */
function statusParagraph(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^Status:/.test(l));
  if (start === -1) return null;
  const parts = [lines[start].slice('Status:'.length)];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '' || SIBLING_FIELD.test(lines[i])) break;
    parts.push(lines[i]);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Rulings this record no longer stands behind, whole or in part.
 *
 * The shape is the reader's question rather than the writer's grammar: for each ruling
 * a later record moved, which record moved it and what it did. `ruling: null` is a
 * record that says "one ruling" without saying which, which is a fact about the record
 * and is carried rather than resolved by guessing.
 *
 * `by: null` is the same honesty in the other field: "narrowed by the same record"
 * resolves to the last record this status named, and a status that says "the same
 * record" without having named one leaves the question open rather than answering it
 * with the wrong record.
 *
 * @returns {{ruling: number|null, kind: string, by: string|null}[]}
 */
function partialSupersessions(status) {
  const out = [];
  let lastNamed = null;
  for (const m of status.matchAll(PARTIAL_CLAUSE)) {
    const [, list, kind, ref] = m;
    const by = /^ADR-/.test(ref) ? ref : lastNamed;
    if (/^ADR-/.test(ref)) lastNamed = ref;
    const rulings = list ? list.split(/\D+/).filter(Boolean).map(Number) : [null];
    for (const ruling of rulings) out.push({ ruling, kind: kind.toLowerCase(), by });
  }
  return out;
}

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
    const rawStatus = statusParagraph(text);
    if (rawStatus === null) {
      errors.push(`${file}: no Status: line, so currency cannot be reported`);
      continue;
    }
    // Every field below is read off the flattened paragraph, with markdown already
    // removed. The link form and the bare form are then one spelling, so a record that
    // writes `superseded by ADR-046` and one that writes `superseded by
    // [ADR-046](...)` are read by the same line of code rather than by two regexes that
    // have to be kept in step.
    const status = stripMarkdown(rawStatus);
    const partial = partialSupersessions(status);
    // The heading repeats the id; the decision title is what follows the dash.
    const title = heading.replace(/^ADR-\d{3}\s*[—–-]\s*/, '').trim();

    decisions.push({
      id,
      file,
      title,
      status,
      // Anchored to the start of the status, and this is the whole of the rule. A record
      // is superseded only when its own status says so first. Unanchored, the clause
      // "ruling 2 superseded by [ADR-024]" inside ADR-023's paragraph matched, and the
      // command would then answer "ruling 2" by printing ADR-024's rulings and
      // suppressing the five in ADR-023 that still stand - a partial supersession
      // silently becoming a total one, which is the reverse of what the status says.
      accepted: /^accepted\b/i.test(status),
      supersededBy: firstMatch(status, /^superseded by ADR-(\d{3})/i),
      supersedes: [...status.matchAll(/supersedes ADR-(\d{3})(?!\s+[Ss]?rulings?\b)/g)].map(
        (m) => `ADR-${m[1]}`,
      ),
      partial,
      summary: summarise(text, partial),
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
 * @param {string} text the whole record
 * @param {{ruling: number|null, kind: string, by: string|null}[]} partial the record's
 *   partial supersessions, so a ruling that is no longer in force can say so where it is
 *   printed rather than only in the status line above it
 * @returns {{ruled: string[], rulingNumbers: (number|null)[], rejected: string[], writtenAgainst: string[]}}
 */
function summarise(text, partial = []) {
  // A section ends at the next `## ` — but not at one inside a fenced code block.
// ADR-007's entire ruling is a document skeleton in a fence whose headings are `##`,
// so the old lookahead ended the section at the first line of the ruling itself. It
// went unnoticed because the truncated remnant was still longer than the minimum
// length, and the test that asks whether every record yields a ruling asked only that.
const section = (name) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${name}`));
  if (start === -1) return '';
  const out = [];
  let fence = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('```')) fence = !fence;
    else if (!fence && lines[i].startsWith('## ')) break;
    out.push(lines[i]);
  }
  return out.join('\n');
};

  // The records number their rulings in five ways and this has to read all of them,
  // because a supersession names a ruling by number and a number that cannot be located
  // cannot be reported as no longer in force. Measured across the corpus: `1. **bold**`
  // (17 records), `### 1. Title` (4), `**One.**` (7), `**1. prose**` (8), and plain
  // paragraphs with no number at all (the first twelve). Reading only the first form is
  // what merged the other four into one blob per record, so ADR-045 declared six rulings
  // and printed one, and ADR-013 printed the text "### 2." to an agent as though the
  // record had said it.
  //
  // A blank line does not close a ruling. A record's parenthetical about its own rulings
  // sits between them, and treating the gap as the boundary attributes that aside to
  // whichever ruling happens to precede it.
  // A record's ruling section has one family, decided by its first line, and that
  // family is what opens a ruling for the whole section. Without the decision, a
  // numbered list *inside* a ruling reads as four more rulings - ADR-015 lists four
  // resolution strategies under `### 2.` and the first draft printed them as rulings
  // numbered 1, 2 and 3. With it, a ruling is whatever the section's own shape says it
  // is, and a list inside a ruling stays inside it.
  //
  // The families are the ones the corpus uses, measured rather than imagined: `### 1.`
  // (4 records), `1. **bold**` (17), `**1. prose**` (8), `**One.**` (7), a bare bullet
  // list (1), and plain paragraphs with no numbering at all (the first twelve). Reading
  // only the second is what merged the rest into one blob per record: ADR-045 declared
  // six rulings and printed one, and ADR-013 printed the literal text "### 2." to an
  // agent as though the record had ruled with it.
  //
  // A blank line does not close a ruling. A record's parenthetical about its own rulings
  // sits between them, and treating the gap as the boundary attributes that aside to
  // whichever ruling happens to precede it.
  // The closing `**` is optional in both families, because a record's emphasis runs past
  // the end of the line - ADR-039's first ruling is `**1. A command whose output a CI
  // step consumes…` and the marker does not close until four lines later. The markers
  // are stripped from the text afterwards either way.
  const BULLET = /^[-*]\s+/;
  const FAMILIES = [
    { id: 'heading', open: /^#{2,6}\s+(\d+)\.\s*(.*)$/, number: (m) => Number(m[1]), demark: true },
    { id: 'numbered-bold', open: /^\*\*(\d+)\.\s/, number: (m) => Number(m[1]) },
    { id: 'word-bold', open: /^\*\*([A-Z][a-z]+)\.(?:\*\*|\s)/, number: (m) => ORDINAL_NUMBER.get(m[1]) ?? null },
    { id: 'numbered', open: /^(\d+)\.\s+(.*)$/, number: (m) => Number(m[1]) },
    { id: 'bullet', open: BULLET, number: () => null, demark: true },
  ];

  const units = (body) => {
    // The family is read off the first line that looks like any of them, not off the
    // first line. ADR-032 opens its ruling section with a bold lead paragraph and only
    // then numbers its rulings, and requiring the marker on line one leaves that record
    // a single merged block.
    const family = FAMILIES.find((f) => body.split('\n').some((l) => f.open.test(l.trim())));
    const blocks = [];
    let current = null;
    let fence = false;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      // A fence marker is structure and never part of a ruling. Its contents are: ADR-007's
      // entire ruling is a skeleton in a code block, so dropping the contents left the
      // record with a lead-in and no ruling at all. What a fence does forbid is opening
      // one — a line of YAML or JSON inside a block must not be read as `1. ` and split
      // the ruling around it.
      if (line.startsWith('```')) {
        fence = !fence;
        continue;
      }
      const m = !fence && family ? family.open.exec(line) : null;
      if (m) {
        // A new ruling closes the one it was appended to, whether or not there was a
        // blank line between them.
        if (current) blocks.push(current);
        current = {
          number: family.number(m),
          // The heading marker and the bullet are structure. Leaving `###` or `-` in the
          // text hands an agent a line of markdown as though the record had ruled with
          // it. The numbered families keep their number on purpose: it is what a
          // supersession names, and this text is what the annotation is attached to.
          lines: [family.demark ? line.replace(/^#{2,6}\s+/, '').replace(BULLET, '') : line],
        };
      } else if (current) {
        // A continuation line folds into the ruling it belongs to, except the next
        // heading of any level, which is structure rather than prose.
        if (!/^#{2,6}\s/.test(line)) current.lines.push(line);
      } else {
        current = { number: null, lines: [line] };
      }
    }
    if (current) blocks.push(current);
    return blocks
      .map((b) => ({
        number: b.number,
        text: b.lines.join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((p) => p.text.length > 40 && !p.text.startsWith('|'));
  };

  // A ruling that a later record moved says so where it is printed. Without this the
  // only place the fact existed was the status line, and ADR-023's status line is the
  // one the parser used to truncate - so the reversed ruling and the sentence saying it
  // was reversed were lost by the same line of code.
  const mark = (text2, number) => {
    const hit = partial.find((p) => p.ruling === number);
    if (!hit) return text2;
    const by = hit.by ? ` by ${hit.by}` : ' by a record this status line does not name';
    return `${text2} (${hit.kind}${by})`;
  };

  const rejected = units(section('Rejected'))
    .slice(0, 3)
    .map((p) => sentence(p.text));

  // A lead-in ending in a colon introduces what follows it, so on its own it is a
  // sentence with no predicate. Kept only when nothing follows.
  const ruled = units(section('Ruling') || section('Rulings'));
  const withLead = ruled.filter((p, i) => !p.text.endsWith(':') || i === ruled.length - 1);

  const printed = withLead.slice(0, 2);
  return {
    ruled: printed.map((p) => mark(sentence(p.text), p.number)),
    // The number each printed ruling declares, parallel to `ruled`. It is the join
    // between a supersession and the text it applies to, so it is exported rather than
    // kept inside: a family that stopped numbering its rulings — `**One.**` losing the
    // ordinal is one line of code — would otherwise be invisible, because no record in
    // the estate has both a word-numbered ruling and a partial supersession to catch it.
    rulingNumbers: printed.map((p) => p.number),
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