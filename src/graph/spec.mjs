// Agent Skills conformance, checked against the specification.
//
// Every rule here was read from agentskills.io rather than recalled, for the reason
// ADR-067 records: a lint that checks the wrong rule is worse than no lint, because it
// reports a clean file that a client will reject.
//
// The distinction the file draws is the one the specification draws. A "must" is an error
// and stops the exit code; a "should" or a recommendation is a warning and does not. An
// error the reader cannot act on is a papercut that trains people to skip the gate, so
// every message names the rule it broke and the fix.

/** The one specification this knows, and the name `--spec` accepts. */
export const SPEC = 'agentskills';

export const SPEC_SOURCE = 'agentskills.io/specification';

/** Fields the specification defines. Anything else in the frontmatter is unknown. */
const SPEC_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];

/** Tokens, not bytes, because the specification counts tokens and every number here is
 *  the same four-bytes-per-token estimate the context meter uses. */
const BODY_TOKEN_BUDGET = 5000;
const BODY_LINE_BUDGET = 500;
const BYTES_PER_TOKEN = 4;

/** The `name` rules, as one predicate with the rule it enforces. */
const NAME_RULES = {
  max: 64,
  // Lowercase alphanumerics and hyphens only. Unicode lowercase is deliberately NOT
  // allowed even though the specification says "unicode lowercase alphanumeric": a
  // skill directory travels between machines and shells, and the subset every client
  // accepts is the ASCII one. Reported as the ASCII rule because that is the one a
  // reader can fix without reading a Unicode table.
  pattern: /^[a-z0-9-]+$/,
};

/**
 * The first naming rule `name` breaks, or null when it breaks none.
 *
 * Exported because two commands need the same answer: the lint, which reports it, and
 * `skills install`, which refuses to create a directory a client could never address by
 * the name inside it. Two copies of these rules would be two sets, and the one nobody
 * linted would be the one that let an unaddressable skill through.
 *
 * @param {string} name
 * @returns {string|null} the rule, phrased as a defect
 */
export function nameProblems(name) {
  if (name.length === 0) return 'is empty; the specification requires 1 to 64 characters';
  if (name.length > NAME_RULES.max) {
    return `is ${name.length} characters; the specification allows at most ${NAME_RULES.max}`;
  }
  if (!NAME_RULES.pattern.test(name)) return `is not lowercase letters, digits and hyphens`;
  if (name.startsWith('-') || name.endsWith('-')) return `starts or ends with a hyphen`;
  if (name.includes('--')) return `contains consecutive hyphens`;
  return null;
}

/**
 * Check one skill against the specification.
 *
 * @param {object} input
 * @param {string} input.directoryName the directory the skill lives in
 * @param {string} [input.fileName] the file the frontmatter came from
 * @param {string} input.text the whole SKILL.md
 * @param {string} input.at how the reader names this skill in a finding
 * @returns {{errors: string[], warnings: string[]}}
 */
export function checkSkill({ directoryName, fileName = 'SKILL.md', text, at }) {
  const errors = [];
  const warnings = [];
  const fail = (detail) => errors.push(`${at}: ${detail}`);
  const warn = (detail) => warnings.push(`${at}: ${detail}`);

  if (fileName !== 'SKILL.md') {
    // The layout is part of the specification, not a naming preference: a client looks
    // for that file by name. ADR-009's flat `skills/<name>.md` form is the case here,
    // and it is reported rather than accepted.
    fail(`the specification requires the file to be named SKILL.md; this skill is a single ${fileName}`);
  }

  const { meta, body, present } = readFrontmatter(text);

  // --- name -------------------------------------------------------------------
  const name = meta.name ?? '';
  if (name.length === 0) {
    fail('frontmatter has no `name`, which the specification requires');
  } else {
    const broken = nameProblems(name);
    if (broken !== null) fail(`name "${name}" ${broken}`);
    // The rule the review did not list and the one that breaks installs: a directory
    // and a name that disagree cannot both be addressed, and the client that resolves
    // by name never finds the directory it was given.
    if (directoryName !== undefined && name !== directoryName) {
      fail(`name "${name}" does not match its directory "${directoryName}"; the specification requires them to be equal`);
    }
  }

  // --- description ------------------------------------------------------------
  const description = meta.description ?? '';
  if (description.length === 0) {
    fail('frontmatter has no `description`, which the specification requires');
  } else if (description.length > 1024) {
    fail(`description is ${description.length} characters; the specification allows at most 1024`);
  } else if (description.length < 30) {
    // A recommendation, not a rule: the specification asks for what the skill does and
    // when to use it, and a client matching on keywords finds nothing in three words.
    warn(`description is ${description.length} characters; it should say what the skill does AND when to use it`);
  }

  // --- compatibility ----------------------------------------------------------
  const compatibility = meta.compatibility;
  if (compatibility !== undefined && String(compatibility).length > 500) {
    fail(`compatibility is ${String(compatibility).length} characters; the specification allows at most 500`);
  }

  // --- metadata ---------------------------------------------------------------
  // Stated as a map from string keys to string values, but not as a hard requirement,
  // so a value of another type is a warning. A client that reads it strictly will drop
  // the field, and the reader deserves to know before a client does.
  for (const [key, value] of Object.entries(meta.metadata ?? {})) {
    if (typeof value !== 'string') {
      warn(`metadata.${key} is ${typeof value}, not a string; the specification describes a map of string keys to string values`);
    }
  }

  // --- unknown fields ---------------------------------------------------------
  for (const key of present) {
    if (!SPEC_FIELDS.includes(key)) {
      warn(`frontmatter carries "${key}", which the specification does not define`);
    }
  }

  // --- body -------------------------------------------------------------------
  const bytes = Buffer.byteLength(text);
  const tokens = Math.ceil(bytes / BYTES_PER_TOKEN);
  if (tokens > BODY_TOKEN_BUDGET) {
    warn(`body is ~${tokens} tokens (${bytes} bytes); the specification recommends under ${BODY_TOKEN_BUDGET}, with detail in reference files`);
  }
  const lines = body.split('\n').length;
  if (lines > BODY_LINE_BUDGET) {
    warn(`body is ${lines} lines; the specification recommends keeping SKILL.md under ${BODY_LINE_BUDGET}`);
  }
  // The three progressive-disclosure numbers, reported as one line so a reader sees
  // the cost before the fix rather than one warning at a time.
  if (tokens > BODY_TOKEN_BUDGET) {
    const perHundred = Math.round(tokens / (lines / 100));
    warn(`~${perHundred} tokens per 100 lines: the agent loads all of this once the skill activates, and reference files load only when asked`);
  }

  return { errors, warnings };
}

/**
 * Frontmatter as flat scalars, folded block scalars, plus a nested `metadata` map.
 *
 * Deliberately its own reader rather than the two that live in the projection: those
 * strip the block and keep the values this file never looks at, and one of them would
 * have to grow a block-scalar branch for a second caller.
 *
 * The block scalar is here because it is not optional: `description: >-` followed by
 * indented lines is the spelling most real skills use for a long description, and a
 * reader that took `>-` as the value reported a 200-character description as two
 * characters. That is the whole failure this file exists to prevent, one level down - a
 * lint that is confidently wrong about a conforming file.
 */
function readFrontmatter(text) {
  const meta = {};
  const present = [];
  const body = text.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (!match) return { meta, present, body };
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s/.test(line)) continue; // Consumed by the block it belongs to, or metadata.
    const field = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, raw] = field;
    present.push(key);

    const block = /^([|>])([-+]?)\s*$/.exec(raw.trim());
    if (block !== null) {
      const folded = block[1] === '>';
      const collected = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        const next = lines[i + 1];
        if (next.trim() === '' && !/^\s/.test(next)) break;
        collected.push(next.trim());
        i += 1;
        if (i + 1 >= lines.length) break;
        if (!/^\s/.test(lines[i + 1]) && lines[i + 1].trim() !== '') break;
      }
      // A folded scalar joins its lines with spaces; a literal one keeps the newlines.
      // Either way the blank lines a paragraph break introduced become a single space,
      // because the count that matters here is characters, not layout.
      meta[key] = collected.join(folded ? ' ' : '\n').replace(/\s+/g, folded ? ' ' : '\n').trim();
      if (key === 'metadata') meta.metadata = {};
      continue;
    }

    if (raw.trim() === '') {
      meta[key] = '';
      if (key === 'metadata') {
        meta.metadata = {};
        // An indented `key: value` block belongs to it.
        while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
          const nested = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(lines[i + 1]);
          if (nested && key === 'metadata') meta.metadata[nested[1]] = scalar(nested[2]);
          i += 1;
        }
      }
      continue;
    }
    meta[key] = scalar(raw);
  }
  return { meta, present, body: body.slice(match[0].length) };
}

/** Strip the quoting and the trailing comment a scalar may carry. */
function scalar(raw) {
  const value = raw.trim().replace(/\s+#.*$/, '').trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}
