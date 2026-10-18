// `simt brief "<task>"` — print the packet (plan 0003 R27).
//
// What this is for: an agent that has to explore a repository to find out how to run its
// tests, which files the task will touch and what governs them spends turns discovering
// what the repository already knows. The packet is that answer, assembled from the index
// the repository already has, in the bytes a prompt can carry.
//
// The assembly itself is in `../brief/assemble.mjs`, because three doors open onto it —
// this command, MCP's `brief` tool and the prompt-submit hook — and one implementation
// behind three doors is the only way the three cannot disagree. This file owns the
// command line: what a task may be, what the ceiling may be, and how the packet is
// rendered for a terminal or for `--json`.
//
// One thing is deliberately missing: `skills brief` keeps its own behaviour, and MCP's
// `skills_brief` keeps its own shape. Superseding them changes two accepted decisions
// (ADR-035, ADR-052) and the MCP contract, and this slice carries no ADR to do it.

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { DEFAULT_BRIEF_BYTES, explainPacket } from '../brief/packet.mjs';
import { assembleBrief } from '../brief/assemble.mjs';

export async function briefCommand(args, flags) {
  if (args.length > 1) {
    return fail(`brief takes one task, not ${args.length}`, EXIT.USAGE, `run: ${CLI} brief "<task>"`);
  }
  if (args.length === 1 && flags.task !== undefined) {
    return fail('the task was passed twice, as an argument and as --task', EXIT.USAGE, `run: ${CLI} brief "<task>"`);
  }
  const budget = flags.budget === undefined ? DEFAULT_BRIEF_BYTES : Number(flags.budget);
  if (!Number.isInteger(budget) || budget < 0) {
    return fail(`--budget must be a byte count, not ${flags.budget}`, EXIT.USAGE, `run: ${CLI} brief --budget ${DEFAULT_BRIEF_BYTES}`);
  }

  const result = await assembleBrief({
    root: flags.root ?? process.cwd(),
    task: String(args[0] ?? flags.task ?? ''),
    paths: flags.paths === undefined ? null : flags.paths,
    budget,
    flags,
  });
  if (result.error) return result.error;
  // Unreachable from here — only a delivered brief asks for a cold index to be reported
  // rather than built — but a silent empty packet would be the worst way to find out.
  if (result.cold) {
    return fail('the index is empty, and this command will not assemble a packet from it', EXIT.UNSUPPORTED, `run ${CLI} index`);
  }
  const { root, kind, basis, task, scope, budget: ceiling, items, packed, sections } = result;
  const cut = new Set(packed.cut);

  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: 'brief',
        root,
        kind,
        basis,
        task,
        scope,
        budget: ceiling,
        bytes: packed.after,
        before: packed.before,
        floorHeld: packed.floorHeld,
        cut: packed.cut,
        sections,
        explain: flags.explain === true ? explainPacket(items, { cut }) : undefined,
        text: packed.text,
      },
      { pretty: flags.pretty === true, maxBytes: Number(flags.maxBytes ?? 0) || 0 },
    );
    return EXIT.OK;
  }

  const body = flags.explain === true ? [packed.text, '', 'EXPLAIN', ...explainPacket(items, { cut })] : [packed.text];
  emit(body.join('\n'), { maxBytes: Number(flags.maxBytes ?? 0) || 0 });
  return EXIT.OK;
}
