import { maskPrompt } from './decompose.mjs';

const NEGATION = /\b(?:(?:do\s+not|don['’]t|never)\s+(touch|edit|modify|change|break|use)|without\s+(touching|editing|modifying|changing|breaking|using)|except(?:\s+for)?|leave|keep)\b/giu;
const LEADING_GUARD = /^(?:please\s+)?(if|unless|only\s+when)\s+/iu;
const ONLY_WHEN = /\bonly\s+when\s+/iu;
const PROSE_BOUNDARY = /[;.!?](?=\s|$)|\r?\n|,\s*(?=(?:and\s+)?(?:then|also|but|please|add|fix|update|verify|test|document)\b)|\s+(?=but\b|(?:and\s+)?(?:then|also)\b|and\s+(?:add|fix|update|keep|verify|test|document)\b)/iu;
const QUOTED = /^(?:\x60+(.+?)\x60+|"(.+)"|'(.+)'|“(.+)”|‘(.+)’)$/u;

function unwrap(text) {
  const match = QUOTED.exec(text.trim());
  return match ? match.slice(1).find((value) => value !== undefined) : text.trim();
}

function conditionSpan(source, masked) {
  const leading = LEADING_GUARD.exec(masked);
  if (leading) {
    const end = masked.indexOf(',', leading[0].length);
    if (end > leading[0].length && source.slice(end + 1).trim()) {
      return {
        guard: leading[1].toLowerCase().replace(/\s+/gu, ' '),
        condition: source.slice(leading[0].length, end).trim(),
        start: 0, end: end + 1,
      };
    }
  }
  const trailing = ONLY_WHEN.exec(masked);
  if (!trailing || trailing.index === 0) return null;
  const condition = source.slice(trailing.index + trailing[0].length).trim().replace(/[.;!?]+$/u, '');
  return condition ? { guard: 'only when', condition, start: trailing.index, end: source.length } : null;
}

function targetsIn(source, view) {
  const bits = [];
  let start = 0;
  for (const divider of view.matchAll(/\s*,\s*|\s+and\s+/giu)) {
    const text = source.slice(start, divider.index).trim();
    if (text) bits.push(unwrap(text));
    start = divider.index + divider[0].length;
  }
  const tail = source.slice(start).trim();
  if (tail) bits.push(unwrap(tail));
  return bits;
}

function negativeSpans(source, masked, guard) {
  const spells = [...masked.matchAll(NEGATION)].filter(({ index }) => !guard || index < guard.start || index >= guard.end);
  const spans = [];
  for (const [index, match] of spells.entries()) {
    const form = match[0].toLowerCase();
    const targetStart = match.index + match[0].length;
    const limit = Math.min(spells[index + 1]?.index ?? source.length,
      guard && guard.start > targetStart ? guard.start : source.length);
    const remaining = masked.slice(targetStart, limit);
    const boundary = PROSE_BOUNDARY.exec(remaining)?.index ?? remaining.length;
    const fragment = remaining.slice(0, boundary);
    let kind = 'exclude';
    let targetEnd = fragment.length;
    let end = targetEnd;
    if (form === 'leave' || form === 'keep') {
      const qualifier = form === 'leave' ? /\s+alone\b/iu : /\s+(compatible|intact|unchanged|stable)\b/iu;
      const flag = qualifier.exec(fragment);
      if (!flag) continue;
      targetEnd = flag.index;
      end = flag.index + flag[0].length;
      if (form === 'keep' && flag[1]?.toLowerCase() !== 'unchanged') kind = 'preserve';
    }
    const targets = targetsIn(source.slice(targetStart, targetStart + targetEnd), remaining.slice(0, targetEnd));
    if (!targets.length) continue;
    spans.push({
      kind,
      action: match[1]?.toLowerCase() === 'use' || match[2]?.toLowerCase() === 'using' ? 'use' : kind === 'preserve' ? 'preserve' : 'edit',
      targets,
      start: match.index,
      end: targetStart + end,
    });
  }
  return spans;
}

function withoutSpans(source, spans) {
  if (!spans.length) return source;
  let cursor = 0;
  const kept = [];
  for (const { start, end } of spans) {
    const piece = source.slice(cursor, start).trim().replace(/^[,;:]+\s*/u, '')
      .replace(/(?:\s+|[,;]\s*)(?:and|but)$/iu, '').replace(/[,;:]+$/u, '');
    if (piece) kept.push(piece);
    cursor = end;
  }
  const tail = source.slice(cursor).trim().replace(/^[,;:]+\s*/u, '');
  if (tail && !/^[.!?]+$/u.test(tail)) kept.push(tail);
  return kept.join(' ');
}

export function constraintCaution(constraint) {
  if (constraint.kind === 'condition') return constraint.guard + ' ' + constraint.condition + ', ' + constraint.action;
  const targets = constraint.targets.join(', ');
  if (constraint.kind === 'preserve') return 'Keep ' + targets + ' compatible with the requested change.';
  return (constraint.action === 'use' ? 'Do not use ' : 'Do not edit ') + targets + '.';
}

/** Conditions and exclusions retain exact source spans and stay out of the positive query. */
export function extractConstraints(text) {
  const source = String(text ?? '').trim();
  const { masked } = maskPrompt(source);
  const guard = conditionSpan(source, masked);
  const negatives = negativeSpans(source, masked, guard);
  const spans = (guard ? [...negatives, guard] : negatives).sort((a, b) => a.start - b.start);
  const query = withoutSpans(source, spans);
  const constraints = spans.map((span) => span === guard ? { kind: 'condition', ...guard, action: query } : span);
  return { query, constraints, cautions: constraints.map(constraintCaution) };
}

/** Resolve explicit excluded paths and directory prefixes without guessing a basename. */
export function excludedPaths(constraints, files) {
  const paths = [...files];
  const excluded = new Set();
  for (const { kind, targets } of constraints) {
    if (kind !== 'exclude') continue;
    for (const target of targets) {
      const name = target.replace(/^\.\//u, '').replace(/\/+$/u, '');
      const qualified = paths.filter((path) => path === name || path.startsWith(name + '/'));
      if (qualified.length) {
        for (const path of qualified) excluded.add(path);
      } else {
        const suffix = paths.filter((path) => path.endsWith('/' + name));
        if (suffix.length === 1) excluded.add(suffix[0]);
      }
    }
  }
  return excluded;
}
