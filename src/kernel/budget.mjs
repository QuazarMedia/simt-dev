// Budgeted compilation: which kernel lines may be cut so a repository's declared budget
// is met (plan 0003 R08).
//
// A budget nobody enforces is a number in a JSON file. ADR-072 shipped the number and
// reported it; what it could not do is meet it, because meeting a budget means something
// gives. Kernel mode is what gives (ADR-073), and this module is the half of it that
// measures first and cuts second — the half that turns "your projection is over the line"
// from a finding a reader has to act on alone into a projection that was already under it.
//
// Two rulings live here and nowhere else, because both are the kind of decision that
// looks like arithmetic until it is written down:
//
//   1. Nothing is cut in `full` mode. ADR-072's finding already words the consequence —
//      "nothing was cut: the projection is still in full mode" — and a full projection
//      that quietly lost a rule would turn that sentence into a lie told by the tool
//      about itself. A repository that has not asked for a kernel gets its rules.
//   2. `hard` is the floor. A priority class exists to say what a reader loses by not
//      having the line (ADR-073), and a byte count is not a reader. Cutting a hard
//      constraint to reach a ceiling would remove the one class whose whole claim is that
//      its absence produces a defect, and it would report itself as compliance.
//
// Everything here is a pure function of its arguments: no clock, no network, no PATH. Two
// machines given the same repository and the same budget cut the same rules in the same
// order, which is R08's second accept criterion and the only reason a pull request can
// diff the result.

import { CLI, MANIFEST_FILE } from '../name.mjs';

/** The class a budget may not cut. Ruling 2 above. */
const BUDGET_FLOOR = 'hard';

/**
 * Cut candidates, least valuable first, until the region fits `ceiling`.
 *
 * The candidate order is the caller's, not this module's. Which class a reader loses least
 * is a judgement about the rules, and the rules declare their own class in their own
 * frontmatter (ADR-073); this module is handed a list already in the order it should lose
 * them and does the one thing that is arithmetic.
 *
 * `costs` is called with the ids cut so far and returns what the document then weighs. It
 * is re-rendered per attempt rather than subtracting each rule's own size, because the
 * three things that change the total when a rule leaves are not the rule's length: the
 * provenance header lists every source, the deferred section gains a line naming what left,
 * and both shrink as the cut list grows. Arithmetic that ignored them would be a budget
 * that is either never quite met or overshot by the width of a comment.
 *
 * @param {{candidates: {id: string, priority: string}[], ceiling: number,
 *          costs: (cut: Set<string>) => number}} input
 * @returns {{cut: string[], before: number, after: number, floorHeld: boolean}}
 */
export function packToBudget({ candidates, ceiling, costs }) {
  const cut = new Set();
  const before = costs(cut);
  let after = before;
  for (const candidate of candidates) {
    if (after <= ceiling) break;
    if (candidate.priority === BUDGET_FLOOR) continue;
    cut.add(candidate.id);
    after = costs(cut);
  }
  // `floorHeld` is not a cut count. It says the kernel is over the line with everything
  // cuttable already cut, which is a different fact from "we cut some rules" and is
  // reported differently: nothing else can shrink it, so the reader is told to move a rule
  // out of the two classes kernel mode packs, exactly as ADR-072's kernel wording says.
  return { cut: [...cut], before, after, floorHeld: after > ceiling };
}

/**
 * Report that the kernel was cut to fit the budget this repository declared.
 *
 * Non-blocking, and for the same reason `budget` is (ADR-072): the cut is the tool doing
 * what the repository asked, and the remedy is a decision about the number, not a missing
 * file. A gate that failed here would fail a repository for shipping a smaller projection.
 *
 * The detail carries the three numbers a reader needs to judge the cut and names every
 * rule that left, because a cut line that is not named is indistinguishable from a rule
 * that was never written (ADR-073 ruling 6). `before` is the size the reader would have
 * had, so the remedy can quote a number rather than sending them to go and measure one.
 *
 * The remedy's number is the one that ends the cut, and it is `before + reserve`, because
 * the ceiling the region was cut against is the budget less what was held back for the
 * files loading beside it.
 *
 * @param {{file: string, bytes: number, reserve: number, before: number, after: number,
 *          cuts: {id: string, priority: string}[]}} input
 * @returns {{file: string, status: string, detail: string, remedy: string}}
 */
export function budgetCutFinding({ file, bytes, reserve, before, after, cuts }) {
  const named = cuts.map((c) => `${c.id} (${c.priority})`).join(', ');
  return {
    file,
    status: 'budget-cut',
    detail: `BUDGET-CUT: the kernel projection was cut from ${before} to ${after} bytes against a declared budget of ${bytes}${reserve > 0 ? `, with ${reserve} bytes reserved for the generated files that load beside the region` : ''}; cut: ${named}`,
    // The number has to be `before + reserve`, not `before`. The region is cut against a
    // ceiling that already holds the rule files back, so a budget of `before` leaves the
    // cut standing and the reader has followed the remedy to no effect — which is worse
    // than naming no number at all, because they will believe they were told what to do.
    remedy: `raise budget.bytes to ${before + reserve} in ${MANIFEST_FILE}, or move a cut rule out of the hard and command classes so kernel mode leaves it out; ${CLI} rules show <id> reads any of them`,
  };
}