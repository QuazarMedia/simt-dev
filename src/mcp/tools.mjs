// The MCP tool surface: a second front door onto the same logic the CLI uses.
//
// Deliberately a subset. Every tool here is READ-ONLY, because the commands that write
// (`init`, `sync`, `hooks install`, `skills install`, `upgrade`) each exist to be read as
// a diff by a human before they touch anything (ADR-001, ADR-004). A model can call a
// tool; a model cannot review a diff it never showed you.
//
// The tools return the same facts the commands render, by calling the command
// modules' core functions rather than rebuilding the answers. The commands render
// for terminals, these return JSON for a model, and the two copies had already
// drifted: MCP `check` reported 3 findings where the command reports 77, the MCP
// `doctor` was a fingerprint with none of the findings, `rules_list` missed the
// per-surface rules, and the skills payloads disagreed on field names (Q15). The
// CLI keeps its field names; the tools adopt them. What is shared is the whole
// answer, because two answers to one question is what ADR-035 rules out.
//
// Bodies are never inlined by `skills_brief`. Tier 1 is a set of pointers and reasons;
// the body is a separate call. A 384 KB reference inlined into a tool result is the exact
// failure progressive disclosure exists to prevent, and a transport makes it easier to
// cause by accident because the caller cannot see the size until it has paid for it.

import { TOOLS_READ } from './tools-read.mjs';
import { TOOLS_FACTS } from './tools-facts.mjs';

export const TOOLS = [...TOOLS_READ, ...TOOLS_FACTS];

export { ERROR_SHAPE } from './schemas.mjs';

export function toolNames() {
  return TOOLS.map((t) => t.name);
}
