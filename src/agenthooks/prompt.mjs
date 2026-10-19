// The prompt-submit surface: the packet delivered where the agent will read it.
//
// This module must stay off the tool-call path, and the code's shape is what keeps it
// there: `src/commands/agenthook.mjs` reaches it through a dynamic `import()` that only a
// prompt event takes. The pre-tool hook is a latency promise — it answers before every
// shell command an agent runs — so it imports the policy table, the decision and the
// renderer and nothing that walks the repository, and `test/agenthooks.test.mjs` asserts
// exactly that set. A delivery, by contrast, is the one thing here that must read the
// repository, so it lives behind a door the pre-tool path never opens.
//
// Three rules shape what gets delivered:
//
//   * The repository opts in. The opt-in is a `brief` key in the repository's manifest,
//     not the presence of a hook in a harness config: a repository that declared nothing
//     is not spending its owner's context on a packet they did not ask for, and the
//     manifest is the one file a person reviews before they commit the change.
//   * The packet is capped, at PROMPT_CAP_BYTES. A packet is delivered into a prompt that
//     already exists, and the ceiling is the measured bar of this slice rather than a
//     value a repository is free to raise.
//   * A delivery never blocks and never fails loudly. Everything that could go wrong —
//     no index, no prompt in the payload, a registry that will not load — ends in no
//     injection and a line on stderr. A hook that stopped a person's prompt because this
//     tool could not answer would be worse than a hook that said nothing.

import { readManifest } from '../projection/manifest.mjs';
import { DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES } from '../brief/packet.mjs';
import { assembleBrief } from '../brief/assemble.mjs';
import { deliveryJson, factsFrom, promptText } from './render.mjs';

/**
 * Whether this repository asked for a delivered packet, and the ceiling it asked for.
 *
 * Presence is the opt-in and the value is a preference, so `"brief": {}` means "yes, at
 * whatever you measured" and `"brief": { "bytes": 900 }` means "yes, and keep it small".
 * A declared zero is not honoured as a ceiling: zero is this tool's word for "no ceiling"
 * on the command line, and a delivered packet that meant "the whole repository" would be
 * the one thing the cap exists to prevent. It is read from the manifest rather than from
 * the harness config because the manifest is the file the repository reviews.
 */
export async function promptOptIn(root) {
  const { manifest, exists, error } = await readManifest(root);
  if (!exists || error) {
    return { optedIn: false, bytes: DEFAULT_BRIEF_BYTES, why: `${exists ? error : 'no manifest'}` };
  }
  if (manifest?.brief === undefined || manifest.brief === null) {
    return { optedIn: false, bytes: DEFAULT_BRIEF_BYTES, why: 'no `brief` key in the manifest' };
  }
  const declared = manifest.brief?.bytes;
  const asked = Number.isFinite(declared) && declared > 0 ? declared : PROMPT_CAP_BYTES;
  return { optedIn: true, bytes: Math.min(asked, PROMPT_CAP_BYTES) };
}

/**
 * The context one prompt-submit call should deliver, or the reason it delivers nothing.
 *
 * `build: false` is the latency promise in one argument: a delivery reports a cold index
 * rather than building one, so the first prompt in a fresh clone gets nothing and the
 * second gets the packet. The alternative — a person watching their first prompt sit for
 * a minute while a repository is walked — is how the hook gets uninstalled, and the
 * packet is not worth a prompt that cannot be typed.
 */
export async function deliverPrompt(row, payload) {
  const task = promptText(row, payload);
  if (task === null) return { skipped: 'the payload carries no prompt this harness documents' };

  // The root is the same dialect fact for both events, so it is read the same way.
  const root = factsFrom(row, payload).root;
  const optIn = await promptOptIn(root);
  if (!optIn.optedIn) return { skipped: optIn.why };

  // Federation is off on this path and on no other: a delivery has 300 ms to answer, and
  // starting a declared server is a wait a prompt submit must not take. The task is the
  // question a federation would ask, and a person is not made to wait for it here.
  const result = await assembleBrief({ root, task, budget: optIn.bytes, build: false, federate: false });
  if (result.error) return { skipped: 'the packet could not be assembled' };
  if (result.cold) return { skipped: 'the index is empty, and a delivered packet never builds one' };

  const json = deliveryJson(row, result.packed.text);
  if (json === null) return { skipped: `${row.id} has no prompt event that can inject` };
  return { json, root, bytes: result.packed.after };
}
