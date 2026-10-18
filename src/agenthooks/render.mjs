// One renderer per harness: the payload in, the decision out, and the config written.
//
// Four harnesses read a hook and no two agree on anything. The config path, the event
// name, the shape of the document, the tool name for a shell command, the key holding
// the command, and the JSON a hook answers with are all different, and none of them is
// the same fact. So this module owns the differences and `policy.mjs` owns none of
// them:
//
//   claude       .claude/settings.json   PreToolUse      {"hooks":{E:[{matcher,hooks:[h]}]}}
//   codex        .codex/hooks.json       PreToolUse      {"hooks":{E:[{matcher,hooks:[h]}]}}
//   cursor       .cursor/hooks.json      preToolUse      {"version":1,"hooks":{E:[h]}}
//   antigravity  .agents/hooks.json      PreToolUse      {"<name>":{E:[{matcher,hooks:[h]}]}}
//
// The prompt-submit event (R29) is a second table, and it is shorter because the vendors
// are: two of the four document a prompt event that can put text into the model's context,
// and a delivery is the only thing this tool does there. Neither takes a matcher — both
// document that field for tool events, and a matcher a harness ignores is a matcher the
// next person believes is filtering something.
//
//   claude       .claude/settings.json   UserPromptSubmit   hookSpecificOutput.additionalContext
//   codex        .codex/hooks.json       UserPromptSubmit   hookSpecificOutput.additionalContext
//   cursor       .cursor/hooks.json      beforeSubmitPrompt CANNOT INJECT: block-only
//   antigravity  .agents/hooks.json      (no prompt event documented)
//
// Cursor is the one that would be a mistake to write anyway. Its `beforeSubmitPrompt` hook
// can only continue or block, so the entry would carry no packet and a broken one would
// stop a person from typing — and its only injection point, `sessionStart.additional_context`,
// fires once when the session is created, which is a different lifetime from the brief a
// task needs. Gemini CLI documents `BeforeAgent`, which does inject, but the product was
// replaced by Antigravity CLI on 2026-06-18 and its config is not in the reader table this
// module takes its paths from; a harness this tool did not verify is a harness it does not
// write to.
//
// The paths are not written here. They come from the reader table (R14) because that is
// where each one was verified against its vendor page, and a second copy of a verified
// fact is a copy that drifts the first time a vendor moves the file.
//
// Two things are recorded per row that a reader of the code cannot get from the code:
// the page the shape was read from, and whether anything about the row is inferred.
// An inferred key is marked as inferred rather than presented as documented, because
// the failure that matters is not a missing policy — it is a policy that silently never
// fires in a harness whose payload we guessed wrong.

import { CLI } from '../name.mjs';
import { LOADERS } from '../projection/loaders.mjs';
import { EVENTS } from './policy.mjs';

/** The seconds a hook is allowed before the harness gives up on it. */
const TIMEOUT_SECONDS = 10;

/**
 * The hook's own entry point, as it appears inside every harness's config.
 *
 * A repository that has this tool has its binary on PATH, and `--harness` is explicit
 * rather than detected from the payload: a hook that guessed would answer in the wrong
 * harness's dialect when a payload arrived in an unexpected shape, and the harness would
 * read a decision it does not understand as no decision at all.
 */
export function hookCommand(id, event = EVENTS[0]) {
  return `${CLI} agent-hook ${event} --harness ${id}`;
}

/** The path a config file lives at, from the reader table rather than a second list. */
export function hookPath(id) {
  const row = LOADERS.find((l) => l.id === id);
  return row?.hooks?.path ?? null;
}

/** The reader rows that document a hooks file, and the ones that document none. */
export function hookRows() {
  return LOADERS.map((l) => ({
    id: l.id,
    label: l.label,
    path: l.hooks?.path ?? null,
    note: l.hooks ? l.hooks.verified : (l.hooksNote ?? 'no hooks file is documented'),
  }));
}

const ADAPTERS = {
  claude: {
    id: 'claude',
    event: 'PreToolUse',
    matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit',
    denyExit: 2,
    verified: 'docs.claude.com/en/docs/claude-code/hooks, read 2026-10-16',
    root: (p) => p.cwd,
    extract: (p) => ({
      command: p.tool_name === 'Bash' ? (p.tool_input?.command ?? null) : null,
      writes: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(p.tool_name)
        ? [p.tool_input?.file_path].filter(Boolean)
        : [],
    }),
    deny: (message) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
    }),
    // The delivery door. `additionalContext` is documented for this event and is
    // wrapped into the conversation at the point the hook fired, which is why the
    // packet goes here rather than into a system prompt: the cached prefix survives.
    prompt: {
      event: 'UserPromptSubmit',
      verified: 'code.claude.com/docs/en/hooks, read 2026-10-19',
      context: (text) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }),
    },
  },
  codex: {
    id: 'codex',
    event: 'PreToolUse',
    matcher: 'Bash|apply_patch',
    denyExit: 2,
    verified: 'developers.openai.com/codex/hooks, read 2026-10-16',
    // Codex is the one harness that will not run a hook until a person has approved the
    // exact definition, keyed by its hash — so an install that does not say this leaves
    // the repository with a hook that never fires and no way to tell why.
    trust: 'Codex skips a hook nobody has trusted: review it with /hooks, or the entry stays inert.',
    root: (p) => p.cwd,
    extract: (p) => ({
      command: p.tool_name === 'Bash' ? (p.tool_input?.command ?? null) : null,
      // apply_patch carries its targets inside the patch text, one header line per file.
      writes:
        p.tool_name === 'apply_patch'
          ? [...String(p.tool_input?.command ?? '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
          : [],
    }),
    deny: (message) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
    }),
    prompt: {
      event: 'UserPromptSubmit',
      verified: 'developers.openai.com/codex/hooks, read 2026-10-19',
      context: (text) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }),
    },
  },
  cursor: {
    id: 'cursor',
    event: 'preToolUse',
    matcher: 'Shell|Write|Edit',
    denyExit: 2,
    verified: 'cursor.com/docs/agent/hooks, read 2026-10-16',
    root: (p) => p.working_directory ?? p.cwd,
    extract: (p) => ({
      command: p.tool_name === 'Shell' ? (p.tool_input?.command ?? null) : null,
      writes: ['Write', 'Edit'].includes(p.tool_name)
        ? [p.tool_input?.file_path ?? p.tool_input?.path].filter(Boolean)
        : [],
    }),
    deny: (message) => ({ permission: 'deny', user_message: message, agent_message: message }),
    // beforeSubmitPrompt is documented as continue/block and nothing else, so there is no
    // key to deliver a packet in. Writing the entry anyway would put a command that reads
    // a repository on the path of every prompt a person types, to say nothing.
    prompt: null,
  },
  antigravity: {
    id: 'antigravity',
    event: 'PreToolUse',
    matcher: 'run_command|write_to_file|replace_file_content|multi_replace_file_content',
    // The page documents the decision JSON and not an exit code, so the denial travels
    // in the JSON only: a non-zero exit whose meaning the vendor has not stated is not
    // a block, it is a guess that happens to be loud.
    denyExit: 0,
    verified: 'antigravity.google/docs/hooks, read 2026-10-16',
    root: (p) => p.workspacePaths?.[0] ?? p.cwd,
    extract: (p) => {
      const call = p.toolCall ?? {};
      const args = call.args ?? {};
      return {
        command: call.name === 'run_command' ? (args.CommandLine ?? null) : null,
        writes: ['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(call.name)
          ? [args.TargetFile].filter(Boolean)
          : [],
      };
    },
    deny: (message) => ({ decision: 'deny', reason: message }),
    // No prompt event is documented for this harness's hooks file, and a guessed event
    // name is a hook that never fires while its config says it does.
    prompt: null,
  },
};

/** The four adapters, in the order the reader table lists them. */
export function adapters() {
  return hookRows()
    .filter((r) => r.path !== null)
    .map((r) => ADAPTERS[r.id])
    .filter(Boolean);
}

export function adapter(id) {
  const row = ADAPTERS[id];
  return row && hookPath(id) !== null ? row : null;
}

/** The facts a payload carries, and the root it names. An unknown shape yields none. */
export function factsFrom(row, payload) {
  return { root: row.root(payload) ?? process.cwd(), ...row.extract(payload ?? {}) };
}

/** The document to print for a decision, or null when there is nothing to say. */
export function decisionJson(row, decision) {
  if (decision.decision !== 'deny') return null;
  return row.deny(decision.messages.join('\n'));
}

/**
 * The document to print for a delivery, or null when the harness takes none.
 *
 * A delivery is never a decision: nothing here can deny, and the caller exits 0 whatever
 * this returns. That is the whole difference between the two events, and it is why the
 * prompt event has no `denyExit` — there is no exit code that means "here is some context".
 */
export function deliveryJson(row, text) {
  return row.prompt ? row.prompt.context(text) : null;
}

/**
 * The submitted text a prompt payload carries, or null when it carries none we recognise.
 *
 * Marked inferred rather than documented: both harnesses that take this event place the
 * prompt at the top level, but only in the example on each page, not as a stated contract.
 * An unrecognised payload therefore delivers nothing and says so on stderr. The failure
 * this must not have is the opposite one — a packet delivered as though it answered a task
 * it never saw, which reads as a confident answer about the wrong question.
 */
export function promptText(row, payload) {
  if (!row.prompt) return null;
  const text = payload?.prompt ?? payload?.user_prompt ?? payload?.message;
  return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

// ---------------------------------------------------------------------------
// The config file: reading ours out of somebody else's JSON, and putting it back.
// ---------------------------------------------------------------------------

/** The name antigravity's document keys its hooks by; its events live under a name. */
const NAMED_HOOK = 'simt-dev-policies';

/** Where a document keeps its event keys. Antigravity is the odd one: by name. */
function container(row, config, { create = false } = {}) {
  if (row.id === 'antigravity') {
    if (config[NAMED_HOOK] === undefined && create) config[NAMED_HOOK] = {};
    return config[NAMED_HOOK] ?? null;
  }
  // Before `hooks`, so a file this tool creates reads the way the vendor's own example
  // does rather than with the version key appended wherever it happened to land.
  if (row.id === 'cursor' && config.version === undefined && create) config.version = 1;
  if (config.hooks === undefined && create) config.hooks = {};
  return config.hooks ?? null;
}

/** The vendor's name for one of our events on this row, or null when it has none. */
function vendorEvent(row, event) {
  if (event === EVENTS[0]) return row.event;
  if (event === 'prompt-submit') return row.prompt?.event ?? null;
  return null;
}

/** The events a row answers, and the name each one goes under in its config file. */
function eventsOf(row, { prompt = false } = {}) {
  const pairs = [[EVENTS[0], row.event]];
  if (prompt && row.prompt) pairs.push(['prompt-submit', row.prompt.event]);
  return pairs;
}

/** The group this tool owns for one event, in that harness's shape. */
function group(row, event = EVENTS[0]) {
  const command = hookCommand(row.id, event);
  if (event !== EVENTS[0]) {
    // No matcher: both vendors document that field for tool events, and a matcher a
    // harness ignores is a matcher the next reader believes is filtering something.
    return { hooks: [{ type: 'command', command, timeout: TIMEOUT_SECONDS }] };
  }
  if (row.id === 'cursor') {
    // failClosed is set because a hooks file this tool wrote should not silently
    // degrade to fail-open on its own crash: the vendor's default turns a broken hook
    // into an absent one, and the whole point of writing it is that it runs.
    return { command, timeout: TIMEOUT_SECONDS, matcher: row.matcher, failClosed: true };
  }
  return { matcher: row.matcher, hooks: [{ type: 'command', command, timeout: TIMEOUT_SECONDS }] };
}

/** Whether a group is this tool's, judged by the command it runs and not by position. */
function ours(entry) {
  return JSON.stringify(entry).includes(`${CLI} agent-hook`);
}

function entries(row, config, event = EVENTS[0]) {
  const name = vendorEvent(row, event);
  if (name === null) return [];
  const list = container(row, config)?.[name];
  return Array.isArray(list) ? list : [];
}

/** Our entries in this document for one event, for `status`; the document is not modified. */
export function installedIn(row, config, event = EVENTS[0]) {
  return entries(row, config, event).filter(ours);
}

/**
 * The document with this tool's hooks added, everything else left alone.
 *
 * Written as JSON with two spaces and a trailing newline because that is what a file in
 * a repository reads like; a config that is rewritten with different indentation on
 * every run is a diff nobody can review. Keys this tool does not own are preserved
 * exactly, including their order, because the file belongs to the repository.
 *
 * One file can carry both events — Claude and Codex each hold a tool hook and a prompt
 * hook in the same document — so this writes one group per event the row answers rather
 * than one group per file. `prompt` is the caller's opt-in: a repository that has not
 * asked for a delivered packet gets the tool hook and nothing extra, and the file it never
 * asked to change is a file this tool does not touch.
 */
function withHook(row, config, { prompt = false } = {}) {
  const box = container(row, config, { create: true });
  for (const [event, name] of eventsOf(row, { prompt })) {
    const kept = entries(row, config, event).filter((e) => !ours(e));
    box[name] = [...kept, group(row, event)];
  }
  return config;
}

/** The text `install` would write, or the reason the existing file cannot be read. */
export function rendered(row, existing, options = {}) {
  if (existing === null) return { text: `${JSON.stringify(withHook(row, {}, options), null, 2)}\n`, action: 'created' };
  let config;
  try {
    config = JSON.parse(existing);
  } catch (e) {
    return { error: `not valid JSON (${e.message}); left alone` };
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { error: 'not a JSON object; left alone' };
  }
  const text = `${JSON.stringify(withHook(row, config, options), null, 2)}\n`;
  return { text, action: text === existing ? 'unchanged' : 'updated' };
}
