// Decision assistant (plan 0003 R34): scaffold ADRs with structured frontmatter
// (`simt-affects` from the diff and `simt-supersedes: [{adr, ruling}]`), parse
// frontmatter first for `rules why` and `why`, and fail lint on partial
// supersessions stated only in prose.

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const DECISION_KEYS = ['simt-affects', 'simt-supersedes'];

const VALID_KINDS = new Set(['superseded', 'narrowed', 'withdrawn']);

export const PARTIAL_CLAUSE =
  /\b(?:one ruling|rulings?\s+(\d+(?:\s*(?:,|and)\s*\d+)*))\s+(superseded|narrowed|withdrawn)\s+by\s+(ADR-\d{3,}|the same record)\b/gi;

const ACTIVE_PARTIAL_AFTER_RE =
  /\b(supersedes?|narrowed|narrows|withdrawn|withdraws|amends?|refines?)\s+(?:\[?(ADR-\d{3,})\]?(?:\([^)]*\))?)\s+rulings?\s+(\d+(?:\s*(?:,|and)\s*\d+)*)\b/gi;

const ACTIVE_PARTIAL_BEFORE_RE =
  /\b(supersedes?|narrowed|narrows|withdrawn|withdraws|amends?|refines?)\s+rulings?\s+(\d+(?:\s*(?:,|and)\s*\d+)*)\s+of\s+(?:\[?(ADR-\d{3,})\]?(?:\([^)]*\))?)\b/gi;

function normaliseKind(verb) {
  const v = String(verb ?? 'superseded').toLowerCase();
  if (v.startsWith('narrow')) return 'narrowed';
  if (v.startsWith('withdraw')) return 'withdrawn';
  return 'superseded';
}

function unquote(value) {
  const t = String(value ?? '').trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

/** Strip leading YAML frontmatter (`---\n...\n---`) from a markdown document. */
export function splitFrontmatter(text) {
  const raw = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  return match ? { front: match[1], body: raw.slice(match[0].length) } : { front: null, body: raw };
}

function parseInlineStringList(inner) {
  return inner.trim() ? inner.split(',').map(unquote).filter(Boolean) : [];
}

function parseObjectLiteral(rawObj) {
  const inner = rawObj.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!inner) return {};
  const out = {};
  for (const pair of inner.split(',')) {
    const colon = pair.indexOf(':');
    if (colon < 0) continue;
    const key = unquote(pair.slice(0, colon));
    const valRaw = pair.slice(colon + 1).trim();
    out[key] = /^null$/i.test(valRaw) ? null : /^-?\d+$/.test(valRaw) ? Number(valRaw) : unquote(valRaw);
  }
  return out;
}

function normaliseSupersedesEntry(obj, errors) {
  if (!obj || typeof obj !== 'object') {
    errors.push('simt-supersedes entry must be an object {adr, ruling}');
    return null;
  }
  const rawAdr = obj.adr !== undefined && obj.adr !== null ? String(obj.adr).trim().toUpperCase() : '';
  if (!/^ADR-\d{3,}$/.test(rawAdr)) {
    errors.push(`simt-supersedes entry has invalid adr "${obj.adr ?? ''}" (expected ADR-NNN)`);
    return null;
  }
  let ruling = null;
  if (obj.ruling !== undefined && obj.ruling !== null && obj.ruling !== '') {
    const num = Number(obj.ruling);
    if (!Number.isInteger(num) || num < 1) {
      errors.push(`simt-supersedes entry for ${rawAdr} has invalid ruling "${obj.ruling}"`);
      return null;
    }
    ruling = num;
  }
  const rawKind = obj.kind !== undefined && obj.kind !== null ? String(obj.kind).trim().toLowerCase() : 'superseded';
  if (!VALID_KINDS.has(rawKind)) {
    errors.push(`simt-supersedes entry for ${rawAdr} has unknown kind "${obj.kind}"`);
    return null;
  }
  return { adr: rawAdr, ruling, kind: rawKind };
}

/** Parse `simt-affects` and `simt-supersedes` from an ADR's YAML frontmatter. */
export function parseDecisionFrontmatter(text) {
  const { front } = splitFrontmatter(text);
  if (front === null) {
    return { hasFrontmatter: false, hasAffects: false, hasSupersedes: false, affects: [], supersedes: [], errors: [] };
  }
  const errors = [];
  let hasAffects = false;
  let hasSupersedes = false;
  const affects = [];
  const supersedes = [];
  const lines = front.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const affectsMatch = /^simt-affects:\s*(.*)$/.exec(line);
    if (affectsMatch) {
      hasAffects = true;
      const rest = affectsMatch[1].trim();
      if (rest.startsWith('[')) {
        const close = rest.lastIndexOf(']');
        affects.push(...parseInlineStringList(close >= 0 ? rest.slice(1, close) : rest.slice(1)));
      } else if (rest === '') {
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          i += 1;
          const val = unquote(lines[i].replace(/^\s*-\s+/, ''));
          if (val) affects.push(val);
        }
      } else if (unquote(rest)) {
        affects.push(unquote(rest));
      }
      continue;
    }

    const supMatch = /^simt-supersedes:\s*(.*)$/.exec(line);
    if (supMatch) {
      hasSupersedes = true;
      const rest = supMatch[1].trim();
      if (rest.startsWith('[')) {
        let combined = rest;
        while (!combined.includes(']') && i + 1 < lines.length) {
          i += 1;
          combined += ` ${lines[i].trim()}`;
        }
        const close = combined.lastIndexOf(']');
        const inner = (close >= 0 ? combined.slice(1, close) : combined.slice(1)).trim();
        if (inner) {
          const objMatches = [...inner.matchAll(/\{[^{}]*\}/g)];
          if (objMatches.length === 0) errors.push('simt-supersedes list must contain {adr, ruling} objects');
          for (const m of objMatches) {
            const parsed = normaliseSupersedesEntry(parseObjectLiteral(m[0]), errors);
            if (parsed) supersedes.push(parsed);
          }
        }
      } else if (rest === '') {
        let currentObj = null;
        const flush = () => {
          if (!currentObj) return;
          const parsed = normaliseSupersedesEntry(currentObj, errors);
          if (parsed) supersedes.push(parsed);
          currentObj = null;
        };
        while (i + 1 < lines.length && /^\s+(?:-\s+|[a-z]+:)/i.test(lines[i + 1])) {
          i += 1;
          const sub = lines[i].trim();
          if (sub.startsWith('-')) {
            flush();
            const afterDash = sub.replace(/^-\s*/, '').trim();
            if (afterDash.startsWith('{')) {
              const parsed = normaliseSupersedesEntry(parseObjectLiteral(afterDash), errors);
              if (parsed) supersedes.push(parsed);
            } else if (afterDash.includes(':')) {
              const [k, ...vParts] = afterDash.split(':');
              currentObj = { [unquote(k)]: unquote(vParts.join(':')) };
            }
          } else if (currentObj && sub.includes(':')) {
            const [k, ...vParts] = sub.split(':');
            currentObj[unquote(k)] = unquote(vParts.join(':'));
          }
        }
        flush();
      } else if (rest.startsWith('{')) {
        const parsed = normaliseSupersedesEntry(parseObjectLiteral(rest), errors);
        if (parsed) supersedes.push(parsed);
      }
    }
  }

  return { hasFrontmatter: true, hasAffects, hasSupersedes, affects, supersedes, errors };
}

/** Parse CLI or API `--supersedes` values into structured `[{adr, ruling, kind}]` entries. */
export function parseSupersedesSpec(input) {
  if (input === undefined || input === null) return { entries: [], errors: [] };
  const rawList = Array.isArray(input) ? input : [input];
  const entries = [];
  const errors = [];

  for (const item of rawList) {
    if (item && typeof item === 'object') {
      const norm = normaliseSupersedesEntry(item, errors);
      if (norm) entries.push(norm);
      continue;
    }
    for (const part of String(item).split(',')) {
      const token = part.trim();
      if (!token) continue;
      const colonMatch = /^(ADR-\d{3,})(?:[:#](\d+))?(?::(superseded|narrowed|withdrawn))?$/i.exec(token);
      if (colonMatch) {
        entries.push({
          adr: colonMatch[1].toUpperCase(),
          ruling: colonMatch[2] ? Number(colonMatch[2]) : null,
          kind: colonMatch[3] ? colonMatch[3].toLowerCase() : 'superseded',
        });
        continue;
      }
      const proseMatch = /^(ADR-\d{3,})\s+ruling\s+(\d+)(?:\s+\(?(superseded|narrowed|withdrawn)\)?)?$/i.exec(token);
      if (proseMatch) {
        entries.push({
          adr: proseMatch[1].toUpperCase(),
          ruling: Number(proseMatch[2]),
          kind: proseMatch[3] ? proseMatch[3].toLowerCase() : 'superseded',
        });
        continue;
      }
      errors.push(`invalid --supersedes spec "${token}" (expected ADR-NNN or ADR-NNN:<ruling>[:<kind>])`);
    }
  }
  return { entries, errors };
}

/** Slugify an ADR title into a filename suffix. */
function slugifyTitle(title) {
  const slug = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
  return slug || 'decision';
}

/** Determine the next free ADR number in a decisions directory. */
export async function nextDecisionNumber(decisionsDir) {
  const names = await readdir(decisionsDir).catch(() => []);
  let max = 0;
  for (const name of names) {
    const m = /^ADR-(\d+)-.*\.md$/i.exec(name);
    if (m && Number(m[1]) > max) max = Number(m[1]);
  }
  const next = max + 1;
  return { number: next, id: `ADR-${String(next).padStart(3, '0')}` };
}

/** Collect affected repository paths from the working tree / staged diff (R25, R34). */
export async function diffAffectedPaths(root) {
  const paths = new Set();
  const addLines = (stdout) => {
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('.simt-dev/')) paths.add(trimmed);
    }
  };
  for (const args of [
    ['diff', '--name-only', '--cached'],
    ['diff', '--name-only', 'HEAD'],
    ['diff', '--name-only'],
  ]) {
    try {
      const { stdout } = await exec('git', args, { cwd: root });
      addLines(stdout);
    } catch {
      // Ignore if not a git repo or HEAD absent.
    }
  }
  if (paths.size === 0) {
    try {
      const { stdout } = await exec('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: root });
      addLines(stdout);
    } catch {
      // Ignore.
    }
  }
  return [...paths].sort();
}

function formatSupersedesFrontmatter(supersedes) {
  if (!Array.isArray(supersedes) || supersedes.length === 0) return '[]';
  const items = supersedes.map((entry) => {
    const parts = [`adr: "${entry.adr}"`, `ruling: ${entry.ruling === null ? 'null' : entry.ruling}`];
    if (entry.kind && entry.kind !== 'superseded') parts.push(`kind: "${entry.kind}"`);
    return `{ ${parts.join(', ')} }`;
  });
  return `[${items.join(', ')}]`;
}

function formatAffectsFrontmatter(affects) {
  return Array.isArray(affects) && affects.length > 0
    ? `[${affects.map((p) => JSON.stringify(String(p))).join(', ')}]`
    : '[]';
}

/** Render an ADR markdown document with structured frontmatter, a Status line, and a rulings skeleton. */
function renderDecisionScaffold({
  id,
  title,
  date = new Date().toISOString().slice(0, 10),
  status = 'accepted',
  affects = [],
  supersedes = [],
}) {
  const cleanTitle = String(title ?? 'Untitled decision').trim() || 'Untitled decision';
  const wholeSupersedes = supersedes.filter((s) => s.ruling === null).map((s) => s.adr);
  const partialSupersedes = supersedes.filter((s) => s.ruling !== null);
  const statusClauses = [`${status} · ${date}`];
  if (wholeSupersedes.length > 0) statusClauses.push(`supersedes ${wholeSupersedes.join(', ')}`);
  for (const p of partialSupersedes) {
    const verb = p.kind === 'narrowed' ? 'narrows' : p.kind === 'withdrawn' ? 'withdraws' : 'supersedes';
    statusClauses.push(`${verb} ${p.adr} ruling ${p.ruling}`);
  }

  return [
    '---',
    `simt-affects: ${formatAffectsFrontmatter(affects)}`,
    `simt-supersedes: ${formatSupersedesFrontmatter(supersedes)}`,
    '---',
    `# ${id} — ${cleanTitle}`,
    '',
    `Status: ${statusClauses.join(' · ')}`,
    '',
    '## Context',
    '',
    'State the context and the measurement that prompted this decision.',
    '',
    '## Rulings',
    '',
    '1. **First ruling.** State the first constraint or invariant clearly so it can be cited by number.',
    '',
    '2. **Second ruling.** State the second constraint or invariant clearly so it can be cited by number.',
    '',
    '## Consequences',
    '',
    '- State what changes in the repository or projection as a result of these rulings.',
    '',
    '## Rejected',
    '',
    '- **Alternative considered.** Rejected: state why this option was refused.',
    '',
  ].join('\n');
}

/** Scaffold a new ADR in `<root>/docs/decisions` with structured frontmatter. */
export async function scaffoldDecision(root, options = {}) {
  const decisionsDir = options.decisionsDir ?? join(root, 'docs', 'decisions');
  const { number, id } = await nextDecisionNumber(decisionsDir);
  const title = String(options.title ?? 'Untitled decision').trim() || 'Untitled decision';
  const slug = slugifyTitle(title);
  const file = `${id}-${slug}.md`;
  const relPath = ['docs', 'decisions', file].join('/');
  const fullPath = join(decisionsDir, file);
  const affects = Array.isArray(options.affects)
    ? options.affects.map((p) => String(p).trim()).filter(Boolean)
    : await diffAffectedPaths(root);

  const { entries: supersedes, errors } = parseSupersedesSpec(options.supersedes);
  if (errors.length > 0) return { ok: false, errors };

  const text = renderDecisionScaffold({
    id,
    title,
    date: options.date,
    status: options.status,
    affects,
    supersedes,
  });

  if (options.write) {
    await mkdir(decisionsDir, { recursive: true });
    await writeFile(fullPath, text, 'utf8');
  }

  return {
    ok: true,
    id,
    number,
    title,
    slug,
    file,
    relPath,
    path: fullPath,
    affects,
    supersedes,
    text,
    written: Boolean(options.write),
  };
}

/** Extract partial supersession claims stated in prose (`Status:` and header paragraphs). */
function prosePartialSupersessions(body) {
  const claims = [];
  const headSection = String(body ?? '').split(/^##\s+/m)[0] ?? '';
  const clean = headSection.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ');

  let lastNamed = null;
  for (const m of clean.matchAll(PARTIAL_CLAUSE)) {
    const [raw, list, kind, ref] = m;
    const adr = /^ADR-/i.test(ref) ? ref.toUpperCase() : lastNamed;
    if (/^ADR-/i.test(ref)) lastNamed = ref.toUpperCase();
    const rulings = list ? list.split(/\D+/).filter(Boolean).map(Number) : [null];
    for (const ruling of rulings) claims.push({ adr, ruling, kind: normaliseKind(kind), raw });
  }
  for (const m of clean.matchAll(ACTIVE_PARTIAL_AFTER_RE)) {
    const [raw, verb, adrRaw, list] = m;
    for (const ruling of list.split(/\D+/).filter(Boolean).map(Number)) {
      claims.push({ adr: adrRaw.toUpperCase(), ruling, kind: normaliseKind(verb), raw });
    }
  }
  for (const m of clean.matchAll(ACTIVE_PARTIAL_BEFORE_RE)) {
    const [raw, verb, list, adrRaw] = m;
    for (const ruling of list.split(/\D+/).filter(Boolean).map(Number)) {
      claims.push({ adr: adrRaw.toUpperCase(), ruling, kind: normaliseKind(verb), raw });
    }
  }
  return claims;
}

/** Lint a single ADR document for structured supersession conformance (plan 0003 R34). */
export function lintDecision(text, { file = 'ADR-000.md', allowHistorical = false } = {}) {
  const fileMatch = file !== 'ADR-000.md' ? /^(ADR-\d{3,})/i.exec(file) : null;
  const headMatch = /^#\s+(ADR-\d{3,})\b/m.exec(String(text ?? ''));
  const id = (fileMatch?.[1] ?? headMatch?.[1] ?? /^(ADR-\d{3,})/i.exec(file)?.[1] ?? '').toUpperCase() || null;
  const num = id ? Number(id.replace(/^ADR-/, '')) : null;

  const fm = parseDecisionFrontmatter(text);
  const { body } = splitFrontmatter(text);
  const findings = fm.errors.map((err) => ({
    file,
    id,
    status: 'invalid-decision-frontmatter',
    detail: err,
    remedy: 'fix simt-supersedes frontmatter to use [{ adr: "ADR-NNN", ruling: N }]',
  }));

  if (allowHistorical && !fm.hasFrontmatter && num !== null && num > 0 && num <= 96) {
    return { ok: findings.length === 0, findings };
  }

  for (const claim of prosePartialSupersessions(body)) {
    const covered = fm.supersedes.some(
      (e) => e.ruling === claim.ruling && (claim.adr === null || e.adr === claim.adr || (id !== null && e.adr === id)),
    );
    if (!covered) {
      const targetAdr = claim.adr ?? id ?? 'ADR-NNN';
      const rulingLabel = claim.ruling !== null ? `ruling ${claim.ruling}` : 'unnumbered ruling';
      findings.push({
        file,
        id,
        status: 'prose-partial-supersession',
        detail: `partial supersession (${targetAdr} ${rulingLabel}) is stated only in prose ("${claim.raw}")`,
        remedy: `declare simt-supersedes: [{ adr: "${targetAdr}", ruling: ${claim.ruling ?? 1} }] in the ADR frontmatter`,
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Lint all ADR records in a decisions directory. */
export async function lintDecisions(decisionsDir, { allowHistorical = false } = {}) {
  const names = (await readdir(decisionsDir).catch(() => [])).filter((n) => /^ADR-\d{3,}-.*\.md$/i.test(n)).sort();
  const findings = [];
  for (const file of names) {
    const text = await readFile(join(decisionsDir, file), 'utf8');
    findings.push(...lintDecision(text, { file, allowHistorical }).findings);
  }
  return { ok: findings.length === 0, findings };
}
