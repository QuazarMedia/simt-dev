import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { STATE_DIR } from '../name.mjs';
import { gitText } from '../sys/git.mjs';

export const SEEN_MULTIPLIER = 0.20;
const LEDGER_FILE = 'session-brief.json';
const MAX_HASH_BYTES = 512 * 1024;

export function textDigest(text) {
  return `sha256-${createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 24)}`;
}

export async function fileRevision(root, relPath) {
  if (!relPath) return null;
  const full = isAbsolute(relPath) ? relPath : join(root, relPath);
  try {
    const info = await stat(full);
    if (!info.isFile()) return null;
    if (info.size > MAX_HASH_BYTES) return `size-${info.size}-${Math.trunc(info.mtimeMs)}`;
    const buf = await readFile(full);
    return textDigest(buf);
  } catch {
    return 'missing';
  }
}

async function gitHeadInfo(root) {
  const [branch, headSha] = await Promise.all([
    gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    gitText(root, ['rev-parse', 'HEAD']).catch(() => null),
  ]);
  return {
    branch: branch?.trim() || 'HEAD',
    headSha: headSha?.trim() || 'worktree',
  };
}

function parseExplicitKeys(raw) {
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/u);
  return new Set(list.map((value) => String(value).trim()).filter(Boolean));
}

async function isLedgerTarget(root, value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /[\s,]/u.test(trimmed)) return false;
  if (trimmed.endsWith('.json')) return true;
  const full = isAbsolute(trimmed) ? trimmed : resolve(root, trimmed);
  try {
    const info = await stat(full);
    if (!info.isFile() || info.size > MAX_HASH_BYTES) return false;
    const parsed = JSON.parse(await readFile(full, 'utf8'));
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('entries' in parsed || 'version' in parsed));
  } catch {
    return false;
  }
}

export async function loadSeenState(root, seenInput, { record = true } = {}) {
  if (seenInput === undefined || seenInput === null || seenInput === false) return null;

  let ledgerPath = null;
  let keys = new Set();
  let entries = new Map();
  let ledgerBranch = null;
  let ledgerHeadSha = null;

  if (seenInput === true) {
    ledgerPath = join(root, STATE_DIR, LEDGER_FILE);
  } else if (typeof seenInput === 'string' && await isLedgerTarget(root, seenInput)) {
    const trimmed = seenInput.trim();
    ledgerPath = isAbsolute(trimmed) ? trimmed : resolve(root, trimmed);
  } else if (typeof seenInput === 'object' && !Array.isArray(seenInput)) {
    ledgerBranch = seenInput.branch ?? null;
    ledgerHeadSha = seenInput.headSha ?? null;
    for (const [k, v] of Object.entries(seenInput.entries ?? {})) entries.set(k, v);
  } else {
    keys = parseExplicitKeys(seenInput);
  }

  if (ledgerPath) {
    try {
      const parsed = JSON.parse(await readFile(ledgerPath, 'utf8'));
      ledgerBranch = parsed?.branch ?? null;
      ledgerHeadSha = parsed?.headSha ?? null;
      for (const [k, v] of Object.entries(parsed?.entries ?? {})) entries.set(k, v);
    } catch {
      // First turn: no ledger exists yet; start empty and record kept items at the end.
    }
  }

  const head = await gitHeadInfo(root);
  return {
    root,
    ledgerPath,
    write: Boolean(ledgerPath) && record,
    branch: head.branch,
    headSha: head.headSha,
    ledgerBranch,
    ledgerHeadSha,
    keys,
    entries,
    fileRevisions: new Map(),
  };
}

function itemLookupKeys(item) {
  const out = [];
  if (item.key) out.push(item.key);
  if (item.path) out.push(item.path);
  if (item.key && item.key.includes(':')) out.push(item.key.slice(item.key.indexOf(':') + 1));
  if (item.id) out.push(item.id);
  return out;
}

export async function applySeenWeights(items, seenState) {
  if (!seenState) return { items, summary: null };

  const uniquePaths = [...new Set(items.map((item) => item.path).filter(Boolean))];
  await Promise.all(uniquePaths.map(async (path) => {
    seenState.fileRevisions.set(path, await fileRevision(seenState.root, path));
  }));

  const penalized = [];
  const reset = [];
  const nextItems = items.map((item) => {
    if (item.priority === 'hard') return item;
    const lookup = itemLookupKeys(item);
    let matchedEntry = null;
    for (const k of lookup) {
      if (seenState.entries.has(k)) {
        matchedEntry = seenState.entries.get(k);
        break;
      }
    }
    const matchedKey = !matchedEntry && lookup.some((k) => seenState.keys.has(k));
    if (!matchedEntry && !matchedKey) return item;

    let changed = false;
    if (matchedEntry) {
      if (matchedEntry.path) {
        const currentRev = seenState.fileRevisions.get(matchedEntry.path) ?? 'missing';
        changed = currentRev !== matchedEntry.revision;
      } else {
        const currentDigest = textDigest(item.text);
        changed = currentDigest !== matchedEntry.textDigest
          || (seenState.ledgerBranch !== null && seenState.ledgerBranch !== seenState.branch);
      }
    }

    const id = item.key ?? item.path ?? item.id;
    if (changed) {
      reset.push(id);
      const why = [...(item.why ?? []), 'seen modified (reset to 1.00x)'];
      return { ...item, utilityWeight: 1, why };
    }

    penalized.push(id);
    const why = [...(item.why ?? []), `seen unchanged (${SEEN_MULTIPLIER.toFixed(2)}x)`];
    return { ...item, utilityWeight: SEEN_MULTIPLIER, why };
  });

  return {
    items: nextItems,
    summary: {
      active: true,
      multiplier: SEEN_MULTIPLIER,
      branch: seenState.branch,
      headSha: seenState.headSha,
      penalized: [...new Set(penalized)],
      reset: [...new Set(reset)],
    },
  };
}

export async function saveSeenLedger(seenState, keptItems) {
  if (!seenState?.write || !seenState.ledgerPath) return;
  const entries = {};
  for (const [k, v] of seenState.entries) entries[k] = v;
  for (const item of keptItems) {
    if (item.priority === 'hard') continue;
    const key = item.key ?? item.path;
    if (!key) continue;
    const revision = item.path
      ? (seenState.fileRevisions.get(item.path) ?? await fileRevision(seenState.root, item.path))
      : null;
    entries[key] = {
      key,
      ...(item.path ? { path: item.path } : {}),
      ...(revision ? { revision } : {}),
      textDigest: textDigest(item.text),
    };
  }
  const payload = {
    version: 1,
    branch: seenState.branch,
    headSha: seenState.headSha,
    entries,
  };
  await mkdir(dirname(seenState.ledgerPath), { recursive: true });
  await writeFile(seenState.ledgerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}
