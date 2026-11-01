// The token split and the two stopword lists, in one place.
//
// The two lists are deliberately NOT merged. The resolver's list is the English
// filler a task string carries ("fix the thing"), hand-authored because a resolver
// nobody can review is not a resolver; the index's list is the vocabulary a task
// about code carries ("file", "test", "line"), sized for a different signal. Merging
// them would change what each one ranks, and a ranking change is a behaviour change
// this deduplication was not asked to make.

/**
 * Split a task string into comparable tokens.
 *
 * Length 2 is kept. The floor used to be 3, and it dropped the most specific words in
 * this domain: `d1`, `r2`, `kv`, `ci` are two-letter vocabulary, not noise, and a task
 * saying "fix d1 migration" lost the one word that identified the change. The cost is
 * that six stopwords of two letters (`in on of or an so`) now reach the summary signal,
 * which is S04's finding and not something this change can resolve on its own - the
 * remedy there is a stopword list, not a longer minimum.
 */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * The English filler a task string carries. Hand-authored rather than derived, for the
 * same reason the capability aliases are: a resolver nobody can review is not a
 * resolver.
 */
export const STOPWORDS = new Set([
  'about', 'after', 'all', 'also', 'and', 'an', 'any', 'are', 'as', 'at', 'be', 'because',
  'been', 'before', 'being', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'each',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'his', 'how', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'like', 'make', 'many', 'may', 'me', 'more', 'most', 'must', 'my',
  'no', 'not', 'now', 'of', 'off', 'on', 'one', 'only', 'onto', 'or', 'other', 'our', 'out',
  'over', 'own', 'per', 'same', 'see', 'set', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too',
  'two', 'under', 'up', 'us', 'use', 'used', 'using', 'very', 'was', 'way', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'within', 'without', 'would',
  'you', 'your',
]);

/** The code vocabulary a task about a tree carries, for the index's term signal. */
export const INDEX_STOP = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'into', 'only', 'when', 'what',
  'which', 'their', 'about', 'after', 'before', 'where', 'there', 'these', 'those',
  'would', 'could', 'should', 'every', 'other', 'than', 'then', 'them', 'they',
  'your', 'will', 'does', 'file', 'files', 'test', 'tests', 'line', 'lines', 'code',
  'also', 'just', 'more', 'some', 'such', 'each', 'same', 'over', 'used', 'using',
]);
