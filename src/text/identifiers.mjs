const NON_ASCII = /[^\x00-\x7f]/u;
const MARKS_EXCEPT_VOICING = /(?=[^\u3099\u309a])\p{M}/gu;
const ASCII_IDENTIFIERS = /[a-zA-Z0-9]+(?:[_.\/-]+[a-zA-Z0-9]+)*/g;
const UNICODE_IDENTIFIERS = /[\p{L}\p{N}]+(?:[_.\/-]+[\p{L}\p{N}]+)*/gu;
const ASCII_BOUNDARY = /[_.\/-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]{2,})/g;
const UNICODE_BOUNDARY = /[_.\/-]+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll}{2,})/gu;
const CJK_SEGMENTS = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u;
const PROTECTED_ENDING = /(?:ss|us|is|alias)$/;
const PLURAL_ES = /(?:ches|shes|sses|xes|zzes|uses)$/;

/** Case-preserving Unicode fold. The original case is needed for identifier boundaries. */
export function foldIdentifierText(value) {
  const text = String(value ?? '');
  if (!NON_ASCII.test(text)) return text;
  return text.normalize('NFKC').normalize('NFKD').replace(MARKS_EXCEPT_VOICING, '').normalize('NFKC');
}

function singular(word) {
  if (word.length <= 4 || !word.endsWith('s') || PROTECTED_ENDING.test(word)) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  return word.slice(0, PLURAL_ES.test(word) ? -2 : -1);
}

function appendWord(out, word, role) {
  out.push({ token: word, role });
  const variant = singular(word);
  if (word !== variant) out.push({ token: variant, role: 'part' });
}

function appendIdentifier(out, identifier, boundary) {
  const parts = identifier.split(boundary);
  if (parts.length === 1) {
    if (identifier.length >= 2) appendWord(out, identifier.toLowerCase(), 'exact');
    return;
  }
  out.push({ token: parts.join('').toLowerCase(), role: 'exact' });
  for (const part of parts) {
    if (part.length >= 2) appendWord(out, part.toLowerCase(), 'part');
  }
}

function appendCjk(out, run) {
  const points = [...run];
  if (points.length === 1) out.push({ token: run, role: 'part' });
  for (let index = 1; index < points.length; index += 1) {
    out.push({ token: points[index - 1] + points[index], role: 'part' });
  }
}

/** Ordered token stream shared by experimental indexing and query processing. */
export function tokenizeIdentifiers(value) {
  const text = foldIdentifierText(value);
  const out = [];
  if (!NON_ASCII.test(text)) {
    for (const match of text.match(ASCII_IDENTIFIERS) ?? []) appendIdentifier(out, match, ASCII_BOUNDARY);
    return out;
  }
  const segments = text.split(CJK_SEGMENTS);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index % 2 === 1) appendCjk(out, segment);
    else for (const match of segment.match(UNICODE_IDENTIFIERS) ?? []) appendIdentifier(out, match, UNICODE_BOUNDARY);
  }
  return out;
}
