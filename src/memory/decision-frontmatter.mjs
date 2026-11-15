// Reading an ADR frontmatter: `simt-affects` and `simt-supersedes` parsed into the
// shape `rules why` and the linter consume. Extracted from the decision assistant so
// the parser can be tested without scaffolding a record.

import { parseFrontmatter } from '../text/frontmatter.mjs';

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
  const { front } = parseFrontmatter(text);
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

const VALID_KINDS = new Set(['superseded', 'narrowed', 'withdrawn']);

export { VALID_KINDS, normaliseKind, normaliseSupersedesEntry };
