import { foldIdentifierText, tokenizeIdentifiers } from '../text/identifiers.mjs';
import { STOPWORDS } from '../text/tokens.mjs';
import { cmp } from '../util/sort.mjs';
import { extractReferences } from './references.mjs';
import { scanSource } from './syntax.mjs';

const CODE_LANGS = new Set([
  'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'swift', 'dart', 'ruby',
]);
const SKIP_STRINGS = /^(?:[./~][\w./-]+|https?:\/\/\S+|[A-Za-z0-9+/=_-]{24,}|[0-9a-f]{16,})$/i;
const ORDERED_FIELDS = Object.freeze(['path_tokens', 'symbol_names', 'string_literals', 'body']);
const WINDOW_FIELDS = Object.freeze(['body', 'headings']);
const ORDERED_WINDOW = 2;
const UNORDERED_WINDOW = 8;

const round = (value) => Math.round(value * 1e6) / 1e6;

function constructTokens(text) {
  return tokenizeIdentifiers(text).map(({ token }) => token.replaceAll('ς', 'σ')).join(' ');
}

export function isMeaningfulLiteral(raw) {
  const value = String(raw ?? '').trim();
  if (value.length < 6 || value.length > 120) return false;
  if (SKIP_STRINGS.test(value)) return false;
  if (!/[a-zA-Z\p{L}]{2}/u.test(value)) return false;
  return /\s|[_:.-]/.test(value);
}

export function extractCodeConstructs(text, lang, { tokens = null, chunk = null } = {}) {
  if (!text || !CODE_LANGS.has(lang)) return { invocations: '', string_literals: '' };
  const scanned = tokens ?? scanSource(text, lang);
  const refs = chunk ?? extractReferences('', text, lang, { tokens: scanned });

  const calls = new Set();
  for (const ref of refs?.references ?? []) {
    if (ref?.calleeName) calls.add(ref.calleeName);
    if (ref?.memberName) calls.add(ref.memberName);
    if (ref?.localName && ref.kind === 'call') calls.add(ref.localName);
  }
  if (!calls.size) {
    for (let i = 1; i < scanned.length; i += 1) {
      if (scanned[i].kind === 'punct' && scanned[i].value === '(' && scanned[i - 1].kind === 'word') {
        calls.add(scanned[i - 1].value);
      }
    }
  }

  const literals = new Set();
  for (const tok of scanned) {
    if (tok.kind !== 'string') continue;
    if (isMeaningfulLiteral(tok.value)) literals.add(tok.value.trim());
  }

  return {
    invocations: calls.size ? constructTokens([...calls].sort(cmp).join(' ')) : '',
    string_literals: literals.size ? constructTokens([...literals].sort(cmp).join(' ')) : '',
  };
}

export function sdmQueryTerms(task) {
  const words = [];
  const raw = foldIdentifierText(task);
  for (const part of raw.split(/[^a-zA-Z0-9\p{L}\p{N}]+/u)) {
    const token = part.toLowerCase().replaceAll('ς', 'σ');
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    if (words[words.length - 1] !== token) words.push(token);
    if (words.length >= 24) break;
  }
  return words;
}

export function sdmQueryBigrams(task) {
  const terms = sdmQueryTerms(task);
  const pairs = [];
  const seen = new Set();
  for (let i = 1; i < terms.length && pairs.length < 12; i += 1) {
    const key = `${terms[i - 1]}\0${terms[i]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([terms[i - 1], terms[i]]);
  }
  return pairs;
}

function hasOrderedPair(words, left, right) {
  let lastLeft = -100;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === right && i - lastLeft >= 1 && i - lastLeft <= ORDERED_WINDOW) return true;
    if (w === left) lastLeft = i;
  }
  return false;
}

function hasUnorderedPair(words, left, right) {
  let lastLeft = -100;
  let lastRight = -100;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === left) {
      if (i - lastRight <= UNORDERED_WINDOW && i !== lastRight) return true;
      lastLeft = i;
    } else if (w === right) {
      if (i - lastLeft <= UNORDERED_WINDOW && i !== lastLeft) return true;
      lastRight = i;
    }
  }
  return false;
}

export function rerankWithSdm(ranking, rows, task, { topK = 32 } = {}) {
  if (!Array.isArray(ranking) || !ranking.length || !Array.isArray(rows) || !rows.length) return ranking;
  const bigrams = sdmQueryBigrams(task);
  if (!bigrams.length) return ranking;

  const head = ranking.slice(0, topK);
  const tail = ranking.slice(topK);
  const maxBm25 = head.reduce((best, row) => Math.max(best, row.score ?? 0), 0);
  if (!(maxBm25 > 0)) return ranking;

  const headPaths = new Set(head.map(({ path }) => path));
  const fieldWordsByPath = new Map();
  for (const row of rows) {
    const path = row.ref ?? row.path;
    if (!headPaths.has(path)) continue;
    let map = fieldWordsByPath.get(path);
    if (!map) {
      map = new Map();
      fieldWordsByPath.set(path, map);
    }
    for (const field of new Set([...ORDERED_FIELDS, ...WINDOW_FIELDS])) {
      if (!row[field]) continue;
      const list = map.get(field) ?? [];
      list.push(row[field].split(' ').filter(Boolean));
      map.set(field, list);
    }
  }

  const rerankedHead = head.map((entry) => {
    const fieldMap = fieldWordsByPath.get(entry.path);
    if (!fieldMap) return { ...entry, score: round(0.78 * entry.score) };
    let orderedHits = 0;
    let windowHits = 0;
    for (const [left, right] of bigrams) {
      if (ORDERED_FIELDS.some((f) => (fieldMap.get(f) ?? []).some((words) => hasOrderedPair(words, left, right)))) {
        orderedHits += 1;
      }
      if (WINDOW_FIELDS.some((f) => (fieldMap.get(f) ?? []).some((words) => hasUnorderedPair(words, left, right)))) {
        windowHits += 1;
      }
    }
    const orderedScore = (orderedHits / bigrams.length) * maxBm25;
    const windowScore = (windowHits / bigrams.length) * maxBm25;
    const score = round(0.78 * entry.score + 0.14 * orderedScore + 0.08 * windowScore);
    return {
      ...entry,
      score,
      sdm: { orderedHits, windowHits, totalBigrams: bigrams.length },
    };
  }).sort((a, b) => b.score - a.score || cmp(a.path, b.path));

  const minHead = rerankedHead.reduce((low, row) => Math.min(low, row.score), Infinity);
  const adjustedTail = tail.map((row) => ({
    ...row,
    score: round(Math.min(row.score * 0.78, minHead)),
  }));
  return [...rerankedHead, ...adjustedTail];
}
