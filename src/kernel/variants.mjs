// Rule text variant parsing, validation, and deterministic projection folding
// (plan 0003 R35).
//
// A rule line or list item may carry `<!-- simt-variants: <slot> <spec> -->`.
// When unlocked, projection uses the baseline variant (`a`, or the line's own
// prose) and strips the marker so `simt-` annotations never reach a reader.
// When `simt-dev.lock.json` records a locked winner for `<ruleId>.<slot>`,
// projection deterministically renders that winning variant.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const VARIANTS_MARKER = 'simt-variants';
const LOCK_FILE_NAME = 'simt-dev.lock.json';

/**
 * Read the locked `variants` map from `simt-dev.lock.json` in `root`, or `{}` when absent.
 */
export async function readLockedVariants(root) {
  if (!root) return {};
  try {
    const raw = await readFile(join(root, LOCK_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.variants &&
      typeof parsed.variants === 'object' &&
      !Array.isArray(parsed.variants)
    ) {
      return parsed.variants;
    }
  } catch {
    // Missing or unreadable lockfile falls back to baseline variants.
  }
  return {};
}

const MARKER = /<!--\s*simt-variants:\s*([\s\S]*?)\s*-->/g;
const MARKER_AT = /\s*<!--\s*simt-variants:\s*[\s\S]*?-->/g;
const HAS_MARKER = /<!--\s*simt-variants:/;
const ITEM_START = /^(\s*)((?:[-*]|\d+\.)\s+)/;
const SLOT_ID_RE = /^[A-Za-z0-9._-]+$/;
const VARIANT_KEY_RE = /^[A-Za-z0-9_-]+$/;

function fenced(unit) {
  return /^\s*(```|~~~)/.test(unit);
}

function markersIn(unit) {
  return [...unit.matchAll(MARKER)].map((m) => m[1]);
}

function stripMarkers(unit) {
  return unit.replace(MARKER_AT, '').replace(/[ \t]+$/gm, '');
}

/** Lines of a body, fences kept whole, list items split from their neighbours. */
function units(body) {
  const lines = String(body ?? '').split('\n');
  const out = [];
  let inFence = false;
  let current = [];
  const flush = () => {
    if (current.length > 0) out.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) flush();
      current.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      out.push(line);
      continue;
    }
    if (ITEM_START.test(line) && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return out;
}

function stripItemPrefix(text) {
  const m = ITEM_START.exec(text);
  if (!m) return { indent: '', bullet: '', content: text.trim() };
  return {
    indent: m[1],
    bullet: m[2],
    content: text.slice(m[0].length).trim(),
  };
}

function qualifySlotId(ruleId, rawSlot) {
  const slot = String(rawSlot ?? '').trim();
  if (!slot) return { slotId: '', shortId: '' };
  const prefix = ruleId ? `${ruleId}.` : '';
  if (prefix && slot.startsWith(prefix)) {
    return { slotId: slot, shortId: slot.slice(prefix.length) };
  }
  if (slot.includes('.')) {
    const dot = slot.indexOf('.');
    return { slotId: slot, shortId: slot.slice(dot + 1) };
  }
  return {
    slotId: prefix ? `${prefix}${slot}` : slot,
    shortId: slot,
  };
}

function parseKvPairs(rawSpec) {
  const map = {};
  const pairRe = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  let matched = 0;
  for (const m of rawSpec.matchAll(pairRe)) {
    const key = m[1];
    const val = (m[2] ?? m[3] ?? '').replace(/\\(["'\\])/g, '$1').trim();
    map[key] = val;
    matched += 1;
  }
  if (matched === 0) return null;
  const leftover = rawSpec.replace(pairRe, '').replace(/[|\s,]+/g, '').trim();
  if (leftover !== '') return null;
  return map;
}

/**
 * Parse one `simt-variants` marker expression together with the stripped unit text.
 */
export function parseVariantSpec(expr, ruleId = '', strippedUnit = '') {
  const raw = String(expr ?? '').trim();
  if (!raw) {
    return { error: `${VARIANTS_MARKER} is empty; name a slot and its variants` };
  }

  let rawSlot = '';
  let rawMap = null;

  if (raw.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { error: `${VARIANTS_MARKER} JSON is invalid (${error.message})` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `${VARIANTS_MARKER} must be a JSON object` };
    }
    const keys = Object.keys(parsed);
    if (
      keys.length === 1 &&
      parsed[keys[0]] &&
      typeof parsed[keys[0]] === 'object' &&
      !Array.isArray(parsed[keys[0]])
    ) {
      rawSlot = keys[0];
      rawMap = parsed[keys[0]];
    } else if (typeof parsed.id === 'string' || typeof parsed.slot === 'string') {
      rawSlot = String(parsed.id ?? parsed.slot);
      rawMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k === 'id' || k === 'slot') continue;
        rawMap[k] = v;
      }
    } else {
      return { error: `${VARIANTS_MARKER} JSON object must name a slot id` };
    }
  } else {
    const firstSpace = raw.search(/\s/);
    if (firstSpace === -1) {
      return { error: `${VARIANTS_MARKER} "${raw}" names a slot but no variants` };
    }
    rawSlot = raw.slice(0, firstSpace).trim();
    const rest = raw.slice(firstSpace + 1).trim();
    if (rest.startsWith('{')) {
      try {
        rawMap = JSON.parse(rest);
      } catch (error) {
        return { error: `${VARIANTS_MARKER} "${rawSlot}" has invalid JSON (${error.message})` };
      }
      if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return { error: `${VARIANTS_MARKER} "${rawSlot}" must map variant keys to strings` };
      }
    } else {
      rawMap = parseKvPairs(rest);
      if (!rawMap) {
        return {
          error: `${VARIANTS_MARKER} "${rawSlot}" must specify variants as JSON or key="text" pairs`,
        };
      }
    }
  }

  const { slotId, shortId } = qualifySlotId(ruleId, rawSlot);
  if (!slotId || !shortId || !SLOT_ID_RE.test(slotId) || !SLOT_ID_RE.test(shortId)) {
    return { error: `${VARIANTS_MARKER} has invalid slot id "${rawSlot}"` };
  }

  const { indent, bullet, content: baseProse } = stripItemPrefix(strippedUnit);
  const variants = {};

  if (baseProse !== '' && rawMap.a === undefined) {
    variants.a = baseProse;
  }

  for (const [k, v] of Object.entries(rawMap)) {
    if (!VARIANT_KEY_RE.test(k)) {
      return { error: `${VARIANTS_MARKER} "${slotId}" has invalid variant key "${k}"` };
    }
    if (typeof v !== 'string' || v.trim() === '') {
      return { error: `${VARIANTS_MARKER} "${slotId}" variant "${k}" must be a non-empty string` };
    }
    const { content } = stripItemPrefix(v.trim());
    variants[k] = content;
  }

  const variantKeys = Object.keys(variants);
  if (variantKeys.length < 2) {
    return {
      error: `${VARIANTS_MARKER} "${slotId}" needs at least 2 variants (found ${variantKeys.length})`,
    };
  }

  const baseline = variants.a !== undefined ? 'a' : variantKeys[0];
  return {
    slotId,
    shortId,
    ruleId: ruleId || (slotId.includes('.') ? slotId.slice(0, slotId.indexOf('.')) : ''),
    baseline,
    variants,
    indent,
    bullet,
    error: null,
  };
}

/**
 * Report the first defect in a rule body's `simt-variants` markers, or null.
 */
export function variantsDefect(body, ruleId = '') {
  const seenSlots = new Set();
  for (const unit of units(body)) {
    if (fenced(unit)) continue;
    const found = markersIn(unit);
    if (found.length === 0) continue;
    if (found.length > 1) {
      return `carries more than one ${VARIANTS_MARKER} marker on one item; one item is one variant slot`;
    }
    const stripped = stripMarkers(unit);
    const parsed = parseVariantSpec(found[0], ruleId, stripped);
    if (parsed.error) return parsed.error;
    if (seenSlots.has(parsed.slotId)) {
      return `declares duplicate ${VARIANTS_MARKER} slot "${parsed.slotId}"`;
    }
    seenSlots.add(parsed.slotId);
  }
  return null;
}

/**
 * Extract all declared variant slots from a rule (`{id, source, body}`).
 */
export function extractVariantsFromRule(rule) {
  const body = String(rule?.body ?? '');
  const ruleId = String(rule?.id ?? '');
  if (!HAS_MARKER.test(body) || variantsDefect(body, ruleId) !== null) return [];
  const slots = [];
  for (const unit of units(body)) {
    if (fenced(unit)) continue;
    const found = markersIn(unit);
    if (found.length !== 1) continue;
    const stripped = stripMarkers(unit);
    const parsed = parseVariantSpec(found[0], ruleId, stripped);
    if (parsed.error) continue;
    slots.push({
      slotId: parsed.slotId,
      shortId: parsed.shortId,
      ruleId: parsed.ruleId,
      source: rule?.source ?? null,
      baseline: parsed.baseline,
      variants: parsed.variants,
    });
  }
  return slots;
}

function lookupLockedWinner(lockedVariants, slotId, shortId) {
  if (!lockedVariants || typeof lockedVariants !== 'object') return null;
  const entry = lockedVariants[slotId] ?? (shortId ? lockedVariants[shortId] : undefined);
  if (typeof entry === 'string') return { winner: entry, entry: { winner: entry } };
  if (entry && typeof entry === 'object') {
    const w = entry.winner ?? entry.variant;
    if (typeof w === 'string' && w !== '') return { winner: w, entry };
  }
  return null;
}

/**
 * Resolve every `simt-variants` slot in `body` using `lockedVariants` (or the baseline
 * variant when unlocked) and strip the marker comments.
 *
 * When `body` carries no `simt-variants` marker, returns `body` by identity so
 * untouched rules do not move a byte.
 *
 * @returns {{body: string, selected: {slotId: string, winner: string, baseline: string, locked: boolean, entry: object|null}[], changed: boolean}}
 */
export function foldVariants(body, ruleId = '', lockedVariants = null) {
  if (!HAS_MARKER.test(body) || variantsDefect(body, ruleId) !== null) {
    return { body, selected: [], changed: false };
  }

  const selected = [];
  const kept = [];

  for (const unit of units(body)) {
    const found = fenced(unit) ? [] : markersIn(unit);
    if (found.length === 0) {
      kept.push(unit);
      continue;
    }
    const stripped = stripMarkers(unit);
    const parsed = parseVariantSpec(found[0], ruleId, stripped);
    if (parsed.error) {
      kept.push(stripped);
      continue;
    }

    const locked = lookupLockedWinner(lockedVariants, parsed.slotId, parsed.shortId);
    const hasLockedKey = locked !== null && Object.hasOwn(parsed.variants, locked.winner);
    const chosenKey = hasLockedKey ? locked.winner : parsed.baseline;
    const chosenText = parsed.variants[chosenKey];

    kept.push(`${parsed.indent}${parsed.bullet}${chosenText}`);
    selected.push({
      slotId: parsed.slotId,
      winner: chosenKey,
      baseline: parsed.baseline,
      locked: hasLockedKey,
      entry: hasLockedKey ? locked.entry : null,
    });
  }

  const next = kept.join('\n');
  return { body: next, selected, changed: next !== body };
}
