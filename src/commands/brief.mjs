// `simt brief "<task>"` — print the packet.
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
// `--only <section>` renders one section of the packet as a view; MCP's `skills_brief`
// is its SKILLS instance. The tier-1 command had its own 20 KB default and its own
// budget arithmetic; both now go through this assembly, so one packer and one budget
// answer the question (ADR-226).

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { SECTIONS, DEFAULT_BRIEF_BYTES, explainPacket } from '../brief/packet.mjs';
import { explainComposite, parseSubtaskId } from '../brief/drilldown.mjs';
import { assembleBrief } from '../brief/assemble.mjs';
import { retrievalMode } from '../index/retrieval-mode.mjs';
import { commandRoot } from '../repo-root.mjs';

export async function briefCommand(args, flags, commands = []) {
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
  const only = flags.only === undefined ? null : String(flags.only).toLowerCase();
  if (only !== null && !SECTIONS.includes(only.toUpperCase())) {
    return fail(
      `unknown brief section ${flags.only}`,
      EXIT.USAGE,
      `run: ${CLI} brief --only <section> — one of ${SECTIONS.join(', ').toLowerCase()}`,
    );
  }
  if (only !== null && flags.scope !== undefined) {
    return fail('a scoped brief is not filtered', EXIT.USAGE, `run: ${CLI} brief "<task>" --only <section>`);
  }

  if (flags.scope !== undefined && (typeof flags.scope !== 'string' || flags.scope === '' || flags.paths !== undefined)) {
    return fail('a scoped brief needs a scope id without --paths', EXIT.USAGE, `run: ${CLI} brief "<task>" --scope <id>`);
  }
  const subtask = parseSubtaskId(flags.subtask);
  if (Number.isNaN(subtask)) return fail('subtask must be a positive integer', EXIT.USAGE, 'use --subtask <n>');
  const retrieval = retrievalMode(flags.retrieval);
  if (subtask !== null && (flags.scope !== undefined || retrieval === 'v1')) {
    return fail('subtask selection requires a composite brief', EXIT.USAGE, 'use --retrieval v2 or v3 without --scope');
  }
  if (retrieval === null) return fail('unknown retrieval mode', EXIT.USAGE, 'pass --retrieval v1, v2 or v3');
  const result = await assembleBrief({
    root: commandRoot(flags),
    task: String(args[0] ?? flags.task ?? ''),
    paths: flags.paths === undefined ? null : flags.paths,
    budget,
    retrieval,
    subtask,
    flags,
    commands,
    proof: flags.proof === true,
    workScope: flags.scope ?? null,
    only: only === null ? null : only.toUpperCase(),
    scopeSpans: flags.scopes === true,
    nash: flags.nash === true,
    seen: flags.seen ?? null,
  });
  if (result.error) return typeof result.error === 'number' ? result.error
    : fail(result.error.message, result.error.exitCode, result.error.remedy);
  // Unreachable from here — only a delivered brief asks for a cold index to be reported
  // rather than built — but a silent empty packet would be the worst way to find out.
  if (result.cold) {
    const detail = result.indexError?.message;
    return fail(
      result.broken
        ? `could not read the index${detail ? ` (${detail})` : ''}`
        : 'the index is empty, and this command will not assemble a packet from it',
      EXIT.UNSUPPORTED,
      result.indexError?.code === 'INDEX_BUSY' ? 'wait for the other index run, then retry' : `run: ${CLI} index`,
    );
  }
  const { root, kind, basis, task, scope, budget: ceiling, items, packed, sections } = result;
  const cut = new Set(packed.cut);
  const explanation = flags.explain === true
    ? (result.composite ? explainComposite(result) : explainPacket(items, { cut })) : undefined;

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
        ...(result.workScope === undefined ? {} : { workScope: result.workScope }),
        ...(result.retrieval === undefined ? {} : { retrieval: result.retrieval }),
        budget: ceiling,
        bytes: packed.after,
        before: packed.before,
        floorHeld: packed.floorHeld,
        cut: packed.cut,
        sections,
        explain: explanation,
        proof: result.proof,
        ...(result.scopes ? { scopes: result.scopes } : {}),
        ...(result.seen ? { seen: result.seen } : {}),
        ...result.composite,
        text: packed.text,
      },
    );
    return EXIT.OK;
  }

  const body = explanation ? [packed.text, '', 'EXPLAIN', ...explanation] : [packed.text];
  emit(body.join('\n'));
  return EXIT.OK;
}
