// The brief packet: one document inside a byte ceiling (plan 0003 R27).
//
// This module is pure. It reads no filesystem, no environment, no clock and no locale —
// a packet built twice from the same items is the same bytes, which is the property the
// accept arm needs and the one a test can check.
//
// The packing rule is the kernel's, not a second one invented here: items go to
// `packToBudget` in the order they should be LOST, and the class marked `hard` is the
// floor. A brief is not a packet silently cut to size; it is a packet that says, in the
// packet, what it did not get.

import { packToBudget } from '../kernel/budget.mjs';

/** The ceiling a brief packs to unless it is told otherwise. */
export const DEFAULT_BRIEF_BYTES = 2048;

/**
 * The most this tool will ever inject into somebody else's prompt (plan 0003 R29).
 *
 * The same number as the default and a different fact: the default is what a packet packs
 * to, and this is the bar the delivery slice was accepted against. A repository may lower
 * its own ceiling; it may not raise it past a number that was measured, because a manifest
 * that could raise it would make an unmeasured figure the promise the tool keeps.
 */
export const PROMPT_CAP_BYTES = 2048;

/**
 * The sections, in the order a reader meets them.
 *
 * The order is fixed and identical in every packet. A reader who has to search for the
 * command is paying the cost the packet exists to remove.
 */
const SECTIONS = ['TASK', 'COMMANDS', 'FILES', 'TESTS', 'DECISIONS', 'FEDERATION', 'SKILLS', 'LESSONS', 'CAUTIONS'];

/**
 * What each section is worth when something has to go.
 *
 * The numbers are a decision, so they are written here where a reader can argue with
 * them, rather than spread through the packing code as conditions. They answer one
 * question: what would a reader rather lose? Cautions they can rediscover, then lessons,
 * then skill pointers (one command answers all three), then decisions, then tests, then
 * files. Commands and the task are why the packet exists.
 *
 * Federation sits with the decisions, and for the same reason: an external server's answer
 * names a source a reader can go back to, so losing it costs a question rather than a fact.
 * A section added later takes a value beside its neighbours rather than renumbering them —
 * the numbers are a standing answer to "what would a reader rather lose", and a new section
 * is not a reason to change what an old one is worth.
 */
const SECTION_VALUE = {
  CAUTIONS: 1,
  LESSONS: 2,
  SKILLS: 3,
  DECISIONS: 4,
  FEDERATION: 4,
  TESTS: 5,
  FILES: 6,
  COMMANDS: 7,
  TASK: 8,
};

/**
 * The floor. An item marked `hard` is never cut, whatever the ceiling.
 *
 * The list is short on purpose: the task itself and the commands that say whether the
 * change worked. Everything else is recoverable with one more command; these are the ones
 * whose absence turns the packet into a quiet lie about what the repository needs.
 */
const HARD = 'hard';
const SOFT = 'soft';

/**
 * A packet under construction.
 *
 * Within a section the insertion order IS the relevance order — the packet loses from the
 * end of a section — so a caller adds the most valuable item first instead of inventing a
 * score. A number per item would be a second thing to keep consistent with the order, and
 * the two would drift.
 */
export function collect() {
  const items = [];
  return {
    items,
    /**
     * Add one line. An empty or non-string line is not added: a blank item is a byte the
     * packet spends saying nothing.
     */
    add(section, text, { hard = false, why = [] } = {}) {
      if (!SECTIONS.includes(section)) throw new Error(`unknown brief section ${section}`);
      if (typeof text !== 'string' || text.length === 0) return this;
      const order = items.length;
      items.push({ id: String(order), section, text, priority: hard ? HARD : SOFT, order, why });
      return this;
    },
  };
}

/**
 * The order items are lost in: least valuable first.
 *
 * Between sections by `SECTION_VALUE`; inside a section the last one added goes first.
 * `hard` items sort to the end, where `packToBudget` refuses to cut them. The order is
 * made total by the insertion index, because a comparator that returns 0 for two
 * different items leaves the result to the sort implementation — a determinism hole in a
 * command whose whole claim is determinism.
 */
function cutOrder(items) {
  const ranked = [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === HARD ? 1 : -1;
    const value = SECTION_VALUE[a.section] - SECTION_VALUE[b.section];
    if (value !== 0) return value;
    return b.order - a.order;
  });
  return ranked.map(({ id, priority }) => ({ id, priority }));
}

/**
 * Render the packet, minus the items that were cut.
 *
 * A section with nothing left prints nothing at all, not an empty heading. The `cut` line
 * is part of the document rather than a footnote, because the reader is the one who has to
 * decide whether to ask for more — and a packet that shrank without saying so is the
 * failure this command was written to avoid.
 */
function renderPacket(items, { cut = new Set(), budget = DEFAULT_BRIEF_BYTES } = {}) {
  const lines = [];
  for (const section of SECTIONS) {
    const kept = items.filter((item) => item.section === section && !cut.has(item.id));
    if (kept.length === 0) continue;
    lines.push(section);
    for (const item of kept) for (const line of item.text.split('\n')) lines.push(`  ${line}`);
  }
  const lost = items.filter((item) => cut.has(item.id));
  if (lost.length > 0) {
    const where = SECTIONS.filter((section) => lost.some((item) => item.section === section)).map(
      (section) => `${section.toLowerCase()} ${lost.filter((item) => item.section === section).length}`,
    );
    lines.push(`cut ${lost.length} of ${items.length} items to fit ${budget}: ${where.join(', ')}`);
  }
  return lines.join('\n');
}

/** The byte length of a rendering. The ceiling is measured in these, not in characters. */
function packetBytes(items, { cut = new Set(), budget = DEFAULT_BRIEF_BYTES } = {}) {
  return Buffer.byteLength(renderPacket(items, { cut, budget }));
}

/**
 * Pack the items into a packet.
 *
 * Returns the text, the byte count before and after, and whether the floor itself is over
 * the line. `floorHeld` is reported to the caller rather than printed: it is the one fact
 * the packet cannot state about itself without the statement changing the thing it
 * describes, so it belongs to `--explain` and the JSON payload.
 *
 * A budget of 0 means no ceiling at all — the reader asked for the whole packet — and the
 * packing step is skipped rather than run against a number that means "unlimited".
 */
export function buildPacket(items, { budget = DEFAULT_BRIEF_BYTES } = {}) {
  const before = packetBytes(items, { budget });
  if (!(budget > 0)) {
    return { cut: [], before, after: before, floorHeld: false, text: renderPacket(items, { budget }) };
  }
  const result = packToBudget({
    candidates: cutOrder(items),
    ceiling: budget,
    costs: (cut) => packetBytes(items, { cut: new Set(cut), budget }),
  });
  const cut = new Set(result.cut);
  return { ...result, text: renderPacket(items, { cut, budget }) };
}

/**
 * One line per item, for `--explain`: what was kept, what was cut, and the two facts that
 * decided it.
 *
 * The explanation is not part of the packet and is never measured against the ceiling —
 * it exists so a reader can tell a packet that is complete from one that was trimmed,
 * which is the question the packet's own byte count cannot answer for them.
 */
export function explainPacket(items, { cut = new Set() } = {}) {
  const counts = new Map();
  for (const item of items) counts.set(item.section, (counts.get(item.section) ?? 0) + 1);
  const seen = new Map();
  const lines = [];
  for (const item of items) {
    const position = (seen.get(item.section) ?? 0) + 1;
    seen.set(item.section, position);
    const verdict = cut.has(item.id) ? 'cut' : 'keep';
    const reason = item.why.length > 0 ? item.why.join('; ') : 'carried by its section';
    lines.push(
      `${verdict} ${item.section} ${position}/${counts.get(item.section)} worth ${SECTION_VALUE[item.section]}: ${item.text.split('\n')[0]}`,
    );
    lines.push(`     ${reason}`);
  }
  return lines;
}
