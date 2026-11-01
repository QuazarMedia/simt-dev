// The one string comparison for every sort that orders paths, names and ids.
//
// Seven copies of the same three-line comparator grew up under src/, spelled two
// different ways, and a divergence in any one of them would quietly reorder a list
// a reader has memorized. One definition, one order.

/** Deterministic string order: -1, 0 or 1. */
export function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
