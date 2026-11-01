// Pure helpers for a lesson record: its slug, its capped fix diff, and evidence equality.
//
// They touch no file and no clock, which is why they are separable from the store
// (review 0003 Q80).


export function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/^not ok\s+\d+\s*-?\s*/i, '')
    .replace(/^(?:error|assertionerror|fail|revert|blocked)[:\s-]*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'lesson';
}

/**
 * Read all candidate records from `.simt/lessons.jsonl`.
 *
 * @param {string} root
 * @returns {Promise<{candidates: Array<object>, errors: string[]}>}
 */


/**
 * Truncate an unbounded diff to the evidence budget, keeping the head: the hunk
 * headers that name the files are the part a reader acts on.
 *
 * @param {string} diff
 * @returns {string}
 */
export function capFixDiff(diff) {
  const text = String(diff ?? '');
  if (text.length <= FIX_DIFF_BUDGET) return text;
  return `${text.slice(0, FIX_DIFF_BUDGET)}\n… (truncated to ${FIX_DIFF_BUDGET} chars)`;
}


export function sameEvidence(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Append one deterministic candidate to the lessons ledger, deduplicating by
 * `(kind, signature, evidence)`.
 *
 * The stored text is redacted before anything else: candidates keep the raw
 * commands that failed, and a command can carry a token. Redaction runs before
 * the signature is hashed so the same failure redacts to the same signature
 * (review 0003 Q36).
 *
 * @param {string} root
 * @param {object} candidate
 * @returns {Promise<object>}
 */

/** The cap on a stored fix diff, so one large commit cannot bloat a lesson. */
export const FIX_DIFF_BUDGET = 20000;
