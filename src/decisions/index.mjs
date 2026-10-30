// The decision index: what `simt rules why` traces back to.
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

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILE } from '../name.mjs';
import { CLI } from '../name.mjs';
import { PREFIX_ARGUING, TOOL_WORDS } from '../toolwords.mjs';
import { LOCAL_DIR } from '../state.mjs';
import { packageVersion } from '../package-version.mjs';
// Q55: read lazily (see commandVerbs). The registry imports the `decide`
// command, which imports this module, so touching COMMANDS during module
// evaluation would read an initialising binding on one of the two load
// orders. Every use below happens at runtime, when both sides are loaded.
import { COMMANDS } from '../commands/index.mjs';
import { PARTIAL_CLAUSE, parseDecisionFrontmatter, splitFrontmatter } from '../memory/decide.mjs';
import { affectsTokens } from '../index/govern.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DECISIONS_DIR = resolve(HERE, '..', '..', 'docs', 'decisions');
const PACKAGE_ROOT = resolve(HERE, '..', '..');

/**
 * Top-level files this tool writes into a repository that adopts it.
 *
 * Read one at a time, because each is somebody else's decision and none of them is
 * derivable here: `AGENTS.md` is the primary target, `simt-dev.json` the manifest,
 * `package.json` belongs to the adopting repository rather than to us. Anything at the
 * top level NOT on this list is this package's own tree and does not exist at the root
 * of a repository that ran `simt-dev init`.
 *
 * The list is asserted against a real `init` in `rules.test.mjs`, because a name that
 * drifts onto this list stops being redacted and a name that drifts off it starts
 * redacting a file the reader does have.
 */
const INHERITED = ['AGENTS.md', 'package.json', `${MANIFEST_FILE}`];

/**
 * Matches a location that resolves inside this package and nowhere a reader stands.
 *
 * Derived from the package root rather than written out, so a directory added tomorrow is
 * covered by the same rule. Dot-entries are excluded because the tool writes into a
 * consumer's `.github/` and `.cursor/` and those paths do travel; `INHERITED` is excluded
 * because those files are the reader's own.
 */
let internalPath = null;
function internalPathPattern() {
  if (internalPath !== null) return internalPath;
  const names = readdirSync(PACKAGE_ROOT, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !INHERITED.includes(e.name))
    .map((e) => e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // A name with nothing after the slash is not a location, so the separator is required:
  // that is what keeps `graph lint` — a command the reader can run — from being redacted
  // by a directory that happens to share its name.
  internalPath = new RegExp(`\\b(?:${names.join('|')})\\/[\\w./-]+`, 'g');
  return internalPath;
}

/**
 * Name the thing rather than the path, in text that travels.
 *
 * `rules why` output is read inside a repository that owns none of this package's files,
 * and a path that resolves here resolves nowhere there. The judgement this function
 * refuses to make is the one about PROSE: `docs/plans/` means this package's plan in one
 * record and the adopting repository's own plans in another, and no amount of reading the
 * string separates them. So this is not applied to a record's argument — it is applied to
 * the `Status:` line, where every clause is a statement about THIS package by
 * construction and there is no benign reading to confuse it with (S54).
 *
 * @param {string} text
 * @returns {string}
 */
export function redactInternalPaths(text) {
  return String(text ?? '').replace(internalPathPattern(), 'a file in this tool');
}

// Q55: four digits and more are real record numbers, not a typo. The old `\d{3}`
// silently dropped every citation past ADR-999, and lexical sorting put ADR-1000
// before ADR-999 in every listing that trusted string order.
const ADR_IN_TEXT = /\bADR-(\d{3,})\b/g;

/** Numeric sort for record ids: ADR-1000 follows ADR-999, not ADR-100. */
function compareAdrIds(a, b) {
  const num = (id) => Number(id.replace(/^ADR-/i, ''));
  return num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0);
}

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
  return [...found].sort(compareAdrIds);
}

/**
 * Parse one ADR markdown document, reading structured `simt-affects` and
 * `simt-supersedes` frontmatter first (plan 0003 R34).
 *
 * @param {string} file filename (e.g. `ADR-097-example.md`)
 * @param {string} text raw markdown content
 * @param {{all?: boolean}} [options]
 * @returns {{ok: boolean, decision?: object, error?: string, rawBody?: string}}
 */
export function parseDecision(file, text, { all = false } = {}) {
  const fm = parseDecisionFrontmatter(text);
  const { body } = splitFrontmatter(text);
  const fileId = /^ADR-(\d{3,})/i.exec(file)?.[0]?.toUpperCase();
  const heading = /^#\s+(.*)$/m.exec(body)?.[1] ?? null;
  const headId = heading ? /^(ADR-\d{3,})/i.exec(heading)?.[1]?.toUpperCase() : null;
  const id = fileId ?? headId ?? null;
  if (!id) {
    return { ok: false, error: `${file}: filename does not start with ADR-NNN` };
  }
  if (!heading) {
    return { ok: false, error: `${file}: no level-1 heading` };
  }
  const rawStatus = statusParagraph(body);
  if (rawStatus === null) {
    return { ok: false, error: `${file}: no Status: line, so currency cannot be reported` };
  }
  const status = stripMarkdown(rawStatus);
  const selfNum = Number(id.replace(/^ADR-/i, ''));

  const fmPartial = [];
  const fmWholeSupersedes = [];
  for (const entry of fm.supersedes) {
    const otherNum = Number(entry.adr.replace(/^ADR-/i, ''));
    if (entry.ruling === null) {
      if (otherNum < selfNum) fmWholeSupersedes.push(entry.adr);
    } else if (otherNum > selfNum || entry.adr === id) {
      fmPartial.push({
        ruling: entry.ruling,
        kind: entry.kind ?? 'superseded',
        by: entry.adr === id ? null : entry.adr,
      });
    }
  }

  const prosePartial = partialSupersessions(status);
  const partial = [...fmPartial];
  for (const p of prosePartial) {
    if (!partial.some((x) => x.ruling === p.ruling && x.by === p.by)) {
      partial.push(p);
    }
  }

  const proseSupersedes = [...status.matchAll(/supersedes ADR-(\d{3,})(?!\s+[Ss]?rulings?\b)/g)].map(
    (m) => `ADR-${m[1]}`,
  );
  const supersedes = [...new Set([...fmWholeSupersedes, ...proseSupersedes])];
  const title = heading.replace(/^ADR-\d{3,}\s*[—–-]\s*/i, '').trim();

  return {
    ok: true,
    rawBody: body,
    decision: {
      id,
      file,
      title,
      status: redactInternalPaths(redactCommand(status)),
      accepted: /^accepted\b/i.test(status),
      supersededBy: firstMatch(status, /^superseded by ADR-(\d{3,})/i),
      supersedes,
      supersedesRulings: fm.supersedes,
      affects: affectsTokens(text),
      frontmatter: fm.hasFrontmatter ? { affects: fm.affects, supersedes: fm.supersedes } : null,
      partial,
      summary: summarise(body, partial, { all, file }),
      bytes: Buffer.byteLength(text),
    },
  };
}

/**
 * Load every ADR record once.
 *
 * An unreadable or unparseable record is an error rather than a skipped file: a
 * missing decision is the one thing `rules why` must never report silently.
 *
 * @returns {Promise<{ok: boolean, decisions: object[], errors: string[]}>}
 */
export async function loadDecisions({ all = false, dir = DECISIONS_DIR } = {}) {
  let names;
  try {
    // Numeric, so the first record `byId` keeps under a duplicate is deterministic
    // (lint flags the collision; the load does not guess between two files).
    names = (await readdir(dir))
      .filter((n) => /^ADR-\d{3,}-.*\.md$/i.test(n))
      .sort((a, b) => compareAdrIds(adrIdOf(a) ?? a, adrIdOf(b) ?? b));
  } catch (error) {
    return { ok: false, decisions: [], errors: [`${dir}: unreadable (${error.message})`] };
  }

  const decisions = [];
  const rawBodies = new Map();
  const errors = [];

  for (const file of names) {
    const text = await readFile(join(dir, file), 'utf8');
    const parsed = parseDecision(file, text, { all });
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    rawBodies.set(parsed.decision.id, parsed.rawBody);
    decisions.push(parsed.decision);
  }

  const index = byId(decisions);
  for (const d of decisions) {
    const selfNum = Number(d.id.replace(/^ADR-/i, ''));
    for (const entry of d.supersedesRulings ?? []) {
      const otherNum = Number(entry.adr.replace(/^ADR-/i, ''));
      if (otherNum >= selfNum) continue;
      const target = index.get(entry.adr);
      if (!target) continue;
      if (entry.ruling === null) {
        target.supersededBy = d.id;
        target.accepted = false;
      } else if (!target.partial.some((p) => p.ruling === entry.ruling && p.by === d.id)) {
        target.partial.unshift({
          ruling: entry.ruling,
          kind: entry.kind ?? 'superseded',
          by: d.id,
        });
        target.summary = summarise(rawBodies.get(target.id) ?? '', target.partial, {
          all,
          file: target.file,
        });
      }
    }
  }

  return { ok: errors.length === 0, decisions, errors };
}

/** The record id a filename claims, or null when it claims none. */
function adrIdOf(file) {
  return /^ADR-(\d{3,})/i.exec(file)?.[0]?.toUpperCase() ?? null;
}

/** Index by id, for a lookup per cited ADR. */
export function byId(decisions) {
  return new Map(decisions.map((d) => [d.id, d]));
}

/** The command verbs a record may quote, derived from the dispatch registry. */
export function decisionVerbs() {
  return commandVerbs();
}

/** One file's cache identity: name, size and mtime. Any write changes one of them. */
async function fileSignature(dir, name) {
  const st = await stat(join(dir, name));
  return { name, size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Load the records, reusing a machine-local cache when the tree is unchanged.
 *
 * Every call used to re-parse every record (`rules why` 44 ms; part of
 * `resources/list` 771 ms). The cache lives under `.simt/local/` — machine
 * state, never committed — and is keyed on the directory, the `all` flag, the
 * running version and one signature per file, so an edit, an add or an upgrade
 * all miss honestly. Best-effort throughout: any cache failure loads fresh.
 *
 * @param {{root: string, dir: string, all?: boolean}} input `dir` is absolute;
 *   callers resolve it with `decisionsDir(root)` (or the package directory for
 *   shipped records) so this loader never guesses whose records these are.
 */
export async function loadDecisionsCached({ root, dir, all = false } = {}) {
  const cachePath = root ? join(root, LOCAL_DIR, 'decisions.index.json') : null;
  let files = null;
  try {
    const names = (await readdir(dir)).filter((n) => /^ADR-\d{3,}-.*\.md$/i.test(n));
    files = [];
    for (const name of names) files.push(await fileSignature(dir, name));
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return loadDecisions({ all, dir });
  }
  const key = { v: 1, tool: packageVersion(), dir, all, files };
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      if (JSON.stringify(cached.key) === JSON.stringify(key)) return cached.result;
    } catch {
      // A missing or corrupt cache is a miss, never an error.
    }
  }
  const fresh = await loadDecisions({ all, dir });
  if (cachePath) {
    try {
      await mkdir(join(root, LOCAL_DIR), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ key, result: fresh }), 'utf8');
    } catch {
      // A read-only checkout keeps working uncached.
    }
  }
  return fresh;
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
 * The `ruled` and `rejected` halves are the record's own argument and are printed as
 * written. This comment used to claim they could "never contain a path", which was never
 * true: measured over the corpus, five records name a location that resolves only inside
 * this package. The claim was left in place because it is the right aspiration and an
 * unverifiable one, and an unverifiable promise in a docstring is the same defect ADR-049
 * is about — a sentence that reads like evidence and carries none. S54 fixed the field
 * where the promise can be kept (`Status:`, scrubbed at load) and narrowed this one to
 * the truth: prose is the record's argument, and redaction here would have to guess
 * whether `docs/plans/` means this package's plan or the reader's.
 *
 * @param {string} text the whole record
 * @param {{ruling: number|null, kind: string, by: string|null}[]} partial the record's
 *   partial supersessions, so a ruling that is no longer in force can say so where it is
 *   printed rather than only in the status line above it
 * @param {{all?: boolean}} [options] `all` keeps every ruling instead of the first two.
 *   The cap exists for the common case, where a rule cites one record and two rulings
 *   answer "why is this here"; the reader who needs the rest asks.
 * @returns {{ruled: string[], rulingNumbers: (number|null)[], rulingCount: number, rejected: string[], writtenAgainst: string[]}}
 */
function summarise(text, partial = [], { all = false, file = null } = {}) {
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
    .map((p) => sentence(redactCommand(p.text)));

  // A lead-in ending in a colon introduces what follows it, so on its own it is a
  // sentence with no predicate. Kept only when nothing follows.
  const ruled = units(section('Ruling') || section('Rulings'));
  const withLead = ruled.filter((p, i) => !p.text.endsWith(':') || i === ruled.length - 1);

  // Two by default, and every one of them on request. Fifty-five of the sixty records
  // carry more than two rulings, so the default is an excerpt for almost every record —
  // which is fine as a budget and wrong as a silence, and the count below says so.
  //
  // The full set is kept rather than discarded, because the command that names where the
  // rest of it is has to be able to produce it. A remedy that cannot be followed is the
  // defect this whole command exists to prevent, and the first version of this fix
  // printed "the rest: simt rules show ADR-019", which exits 2: `rules show` takes a rule
  // id. So `--all` is the command the excerpt points at, and this is what it reads.
  const printed = all ? withLead : withLead.slice(0, 2);
  return {
    ruled: printed.map((p) => mark(sentence(redactCommand(p.text)), p.number)),
    // How many rulings the record carries. Parallel to `ruled`: "two of eight" and "two"
    // are different answers to the same question and only one of them is true.
    rulingCount: withLead.length,
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
    //
    // What is named is a repository, and the shape was wrong about that: every
    // `simt-<word>` that was not `simt-dev` was reported as one, so the tool's own
    // `simt-priority` was listed as a surveyed repository and the record that settled the
    // kernel read as if it had been decided by looking at some other repository (ADR-080).
    // A record whose subject is the prefix is arguing rather than citing, so it names none.
    writtenAgainst: PREFIX_ARGUING.has(file)
      ? []
      : [...new Set((text.match(ESTATE) ?? []).filter((name) => !TOOL_WORDS.has(name)))].sort(),
  };
}

/**
 * A repository name from the estate this tool was written in.
 *
 * `simt-dev` is the tool, so a reader needs that word. Every other `simt-*` name is a
 * repository, matched by prefix so a new one cannot pass by being absent from a list.
 * The skill registry's `source.repo` values are asserted to match this (S14); a name
 * the registry adds that is not `simt-*` has to be added here or that assertion fails.
 *
 * The shape is not the whole answer, and treating it as one is what ADR-080 settles: a
 * `simt-` name this tool owns is not a repository, and neither reader can tell that from
 * the shape. `src/toolwords.mjs` is the list both of them share.
 *
 * Not global: callers reuse it with `exec`, and a `/g` flag would remember `lastIndex`.
 */
/**
 * Identifiers that belong to the repositories this tool was built against, rather than
 * to anything a reader has.
 *
 * This used to be a list of names, and that was the defect: the guard that exists to
 * keep those names out of shipped text was itself shipped, carrying them. Every
 * adopting repository could read the portfolio out of `src/`.
 *
 * So it matches shapes instead:
 *
 *   - `simt-<something>` that is not `simt-dev`, which is most of the estate
 *   - `repo-NN`, the pseudonyms the decision records now use in place of a name. These
 *     must not leak either: a label that identifies nothing publicly is still a label
 *     that joins one record to another, and shipping it into a consumer's repository
 *     would carry that join with it.
 *
 * What this no longer catches, stated plainly: three estate repositories whose names
 * do not begin `simt-`, which a shape-based rule cannot recognise without enumerating
 * them - which is what this file used to do. Detection of those now depends on a name
 * never being written into shipped text, rather than on a check.
 */
// Q55: one shape, two flags. The estate-name pattern used to be written out twice
// (`ESTATE_NAME` and `ESTATE`), so a shape fixed in one kept matching in the other.
const ESTATE_SOURCE = '\\b(?:simt-(?!dev\\b)[\\w-]+|repo-\\d{2})\\b';

export const ESTATE_NAME = new RegExp(ESTATE_SOURCE);

/** Replace estate repository names with a phrase a reader who does not have them can use. */
export function redactEstate(text) {
  return String(text ?? '').replace(new RegExp(ESTATE_NAME.source, 'g'), (name) =>
    // The tool's own names are left where they are. Redacting them turned a ruling about
    // `simt-priority` into a sentence about `a repository`, which is how a reader learned
    // that the record had surveyed something and not what it said (ADR-080).
    TOOL_WORDS.has(name) ? name : 'a repository',
  );
}

/**
 * Commands that existed when a record was written and that this package no longer installs.
 *
 * The binary was `simt-dev` for the whole of this corpus and is `simt` now. The records
 * quote it verbatim, often quoting the output of the version they were written against:
 * ADR-036 instructs the reader to `run simt-dev sync --yes`, and a reader who types that
 * today gets a shell error. Fifty-odd records ship in the package and are opened with
 * `rules why` from inside an adopting repository.
 *
 * The alternative was to rewrite the records, and this repository's rule is that a record
 * is never edited in place - the quoted command is evidence of what happened, so it stays
 * in the file and is converted on the way out. Same shape as redactEstate above, for the
 * same reason: what travels must be actionable, and what lives here must stay true.
 *
 * Only a real verb follows, which is what keeps `simt-dev.json`, `simt-dev-check.yml` and
 * `simt-dev's` untouched - those are the project's artefacts and the project keeps its name.
 */
// Q55: the verbs a record may quote are the commands this binary dispatches,
// not a hand list. The list used to miss `pack`, `plugin` and `lease`, so a record
// quoting one read as prose instead of a runnable command.
let verbAlternation = null;
function commandVerbs() {
  if (verbAlternation === null) {
    const words = new Set();
    for (const path of COMMANDS) {
      const first = path.split(' ')[0];
      if (first) words.add(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    verbAlternation = `(?:${[...words].sort().join('|')}|--[a-z-]+)`;
  }
  return verbAlternation;
}

function redactCommand(text) {
  return String(text ?? '').replace(new RegExp(`\\bsimt-dev (?=${commandVerbs()})\\b`, 'g'), `${CLI} `);
}

/**
 * Repositories the records were written about, so a maintainer can see which decisions
 * cite which. `rules why` redacts them before printing: the names are not actionable in
 * a repository that does not contain those files.
 *
 * Same shape rule as {@link ESTATE_NAME} and for the same reason - this shipped too, so
 * enumerating the names here put the portfolio in every adopting repository. The records
 * themselves now carry `repo-NN` labels, so that is what this matches in practice.
 */
const ESTATE = new RegExp(ESTATE_SOURCE, 'gi');

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