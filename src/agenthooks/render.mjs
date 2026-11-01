// One renderer per harness: the payload in, the decision out, and the config written.
//
// Six harnesses read a hook and no two agree on anything. The config path, the event
// name, the shape of the document, the tool name for a shell command, the key holding
// the command, and the JSON a hook answers with are all different, and none of them is
// the same fact. So this module owns the differences and `policy.mjs` owns none of
// them:
//
//   claude       .claude/settings.json   PreToolUse      {"hooks":{E:[{matcher,hooks:[h]}]}}
//   codex        .codex/hooks.json       PreToolUse      {"hooks":{E:[{matcher,hooks:[h]}]}}
//   cursor       .cursor/hooks.json      preToolUse      {"version":1,"hooks":{E:[h]}}
//   antigravity  .agents/hooks.json      PreToolUse      {"<name>":{E:[{matcher,hooks:[h]}]}}
//   gemini       .gemini/settings.json   BeforeTool      {"hooks":{E:[{matcher,hooks:[h]}]}}
//   opencode     .opencode/plugins/      execute.before  a JS plugin the tool owns whole
//
// The prompt-submit event (R29) is a second table, and it is shorter because the vendors
// are: four of the six document a prompt event that can put text into the model's context,
// and a delivery is the only thing this tool does there. None takes a matcher — all
// document that field for tool events, and a matcher a harness ignores is a matcher the
// next person believes is filtering something.
//
//   claude       .claude/settings.json   UserPromptSubmit   hookSpecificOutput.additionalContext
//   codex        .codex/hooks.json       UserPromptSubmit   hookSpecificOutput.additionalContext
//   gemini       .gemini/settings.json   BeforeAgent        hookSpecificOutput.additionalContext
//   opencode     .opencode/plugins/      prompt             event.prompt.text, prepended
//   cursor       .cursor/hooks.json      beforeSubmitPrompt CANNOT INJECT: block-only
//   antigravity  .agents/hooks.json      (no prompt event documented)
//
// Cursor is the one that would be a mistake to write anyway. Its `beforeSubmitPrompt` hook
// can only continue or block, so the entry would carry no packet and a broken one would
// stop a person from typing — and its only injection point, `sessionStart.additional_context`,
// fires once when the session is created, which is a different lifetime from the brief a
// task needs. Gemini CLI was replaced by Antigravity CLI on 2026-06-18, which is the row
// that covers the successor; the gemini row stays because the extension is still documented
// and installable and R43 ships a package for it, and its hooks file is in the reader table
// this module takes its paths from — a harness this tool did not verify is a harness it
// does not write to.
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
import { harnessHooks, harnessPayloads } from '../harness/records.mjs';
import { renderOpencodePlugin } from './opencode.mjs';
import { EVENTS } from './policy.mjs';
import { AGENT_HOOK_SHIM } from './shim.mjs';

/** The seconds a hook is allowed before the harness gives up on it. */
const TIMEOUT_SECONDS = 10;

/**
 * The hook's own entry point, as it appears inside every harness's config.
 *
 * The shim, never the bare binary: a harness does not share the shell's PATH,
 * so a config naming `simt` runs nothing on Claude and blocks everything on
 * Cursor (review 0003 Q21). `--harness` stays explicit rather than detected
 * from the payload: a hook that guessed would answer in the wrong harness's
 * dialect when a payload arrived in an unexpected shape, and the harness would
 * read a decision it does not understand as no decision at all.
 */
export function hookCommand(id, event = EVENTS[0]) {
  return `${AGENT_HOOK_SHIM} ${event} --harness ${id}`;
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

/**
 * The files an apply_patch body writes, one per header line.
 *
 * `Update`/`Add`/`Delete` name their file on the header itself. A move is the
 * one header whose target is not on its own line: `*** Move File: <old>` is
 * followed by the destination on the `+++` line, and a body that spells the
 * destination as `*** Move to: <new>` says it outright. A move with neither
 * spelling still writes its source out of the way, so the source is the floor
 * a move guards.
 */
function asString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function editFields(input = {}) {
  const edit = {};
  const oldString = asString(input.old_string ?? input.oldString ?? input.OldText ?? input.old_text);
  const newString = asString(input.new_string ?? input.newString ?? input.NewText ?? input.new_text);
  const content = asString(input.content ?? input.CodeContent ?? input.file_content ?? input.new_source ?? input.newSource);
  if (oldString !== null) edit.old_string = oldString;
  if (newString !== null) edit.new_string = newString;
  if (content !== null) edit.content = content;
  if (Array.isArray(input.edits)) {
    const edits = input.edits
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        old_string: asString(e.old_string ?? e.oldString),
        new_string: asString(e.new_string ?? e.newString),
      }))
      .filter((e) => e.old_string !== null || e.new_string !== null);
    if (edits.length > 0) edit.edits = edits;
  }
  return edit;
}

function writeOf(path, input) {
  if (!path) return null;
  return { path, ...editFields(input ?? {}) };
}

/**
 * The files an apply_patch body writes, one per header line.
 *
 * `Update`/`Add`/`Delete` name their file on the header itself. A move is the
 * one header whose target is not on its own line: `*** Move File: <old>` is
 * followed by the destination on the `+++` line, and a body that spells the
 * destination as `*** Move to: <new>` says it outright. A move with neither
 * spelling still writes its source out of the way, so the source is the floor
 * a move guards.
 *
 * Each entry keeps its hunk text: without it the generated-region check cannot
 * tell an edit outside the region from one inside it (review 0003 Q17), and
 * every patch would deny as though it touched the region.
 */
function patchWrites(text) {
  return patchFiles(text).map((f) => ({ path: f.path, patch: f.hunks }));
}

function patchFiles(text) {
  const lines = String(text ?? '').split('\n');
  const files = [];
  let current = null;
  const push = () => {
    if (current !== null) files.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const direct = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    if (direct !== null) {
      push();
      current = { path: direct[1].trim(), hunks: '' };
      continue;
    }
    const moveTo = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moveTo !== null) {
      push();
      current = { path: moveTo[1].trim(), hunks: '' };
      continue;
    }
    const moveFile = /^\*\*\* Move File: (.+)$/.exec(line);
    if (moveFile !== null) {
      push();
      const next = lines[i + 1]?.trim();
      const dest = next !== undefined && next.startsWith('+++ ') ? next.slice(4).trim() : moveFile[1].trim();
      current = { path: dest, hunks: '' };
      continue;
    }
    if (/^\*\*\* (Begin Patch|End Patch)/.test(line)) {
      if (line.includes('End Patch')) push();
      continue;
    }
    if (current !== null) current.hunks += `${lines[i]}\n`;
  }
  push();
  return files.filter((f) => f.path !== '');
}

// The payload a hook reads: where the tool name and its input sit, and the keys that
// name a command and a file. A record cannot carry a function, so the engine reads the
// record's keys and applies them: a harness that puts a field somewhere new is a new
// record, not a new branch here (Q71).
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function extractOf(spec) {
  return (p) => {
    const payload = p ?? {};
    // antigravity nests the call under `toolCall`; the rest name the tool at the top
    // level. `toolNameKey` is present only on the nested shape, so its presence is
    // the detector.
    const nested = spec.toolNameKey !== undefined;
    const call = nested ? (payload[spec.toolKey] ?? {}) : null;
    const toolName = nested ? call[spec.toolNameKey] : payload[spec.toolKey];
    const input = nested ? (call[spec.inputSubKey] ?? {}) : (payload[spec.inputKey] ?? {});
    return {
      command: (spec.shellTools ?? []).includes(toolName) ? (input[spec.commandKey] ?? null) : null,
      // apply_patch carries its targets inside the patch text (writesFrom: "patch");
      // every other write tool names its file through the path keys.
      writes: (spec.writeTools ?? []).includes(toolName)
        ? spec.writesFrom === 'patch'
          ? patchWrites(String(input[spec.commandKey] ?? ''))
          : [writeOf(pick(input, spec.pathOverrides?.[toolName] ?? spec.pathKeys), input)].filter(Boolean)
        : [],
    };
  };
}

// The record's `rootKeys`: a list of accessor paths, first non-null wins. The caller
// applies its `?? process.cwd()` floor (factsFrom).
function rootOf(spec) {
  return (p) => {
    for (const path of spec.rootKeys ?? []) {
      let v = p;
      for (const seg of path) v = v?.[seg];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };
}

// The `__SIMT_TEXT__` sentinel in a record's deny and delivery templates: the text a
// decision or a delivery carries is substituted for it, and JSON.stringify downstream
// escapes whatever it carries.
const TEXT = '__SIMT_TEXT__';

function applyText(value, text) {
  if (typeof value === 'string') return value === TEXT ? text : value;
  if (Array.isArray(value)) return value.map((v) => applyText(v, text));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyText(v, text);
    return out;
  }
  return value;
}

// The hooks dialect per harness, as records (Q71): the data a config document and a
// decision are shaped by, with the page each shape was read from. What a record cannot
// carry is attached here — `root` and `extract` read the record's payload keys, and
// `deny`, `prompt.context` and `post.context` apply its templates. Module-internal on
// purpose: `adapters()` and `adapter()` are the only doors in, and both check the
// reader table, so an id with no hooks file is no adapter.
const HOOKS = harnessHooks();
const PAYLOADS = harnessPayloads();

const ADAPTERS = Object.fromEntries(
  Object.entries(HOOKS).map(([id, h]) => [
    id,
    {
      ...h,
      root: rootOf(PAYLOADS[id]),
      extract: extractOf(PAYLOADS[id]),
      deny: (message) => applyText(h.deny, message),
      ...(h.prompt ? { prompt: { ...h.prompt, context: (text) => applyText(h.prompt.delivery, text) } } : {}),
      ...(h.post ? { post: { ...h.post, context: (text) => applyText(h.post.delivery, text) } } : {}),
    },
  ]),
);

/** The six adapters, in the order the reader table lists them. */
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

/**
 * The session a payload claims, when it names one. Harness hook processes rarely
 * carry `SIMT_SESSION`, so an agent is session `''` and is blocked by its own
 * lease — the payload's own session id is the fallback (review 0003 Q20).
 */
export function payloadSession(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload.session_id ?? payload.sessionId ?? payload.session?.id ?? payload.tool_input?.session_id ?? null;
  return typeof direct === 'string' && direct.trim() !== '' ? direct : null;
}

/**
 * The facts a payload carries, and the root it names. An unknown shape yields none.
 *
 * `root` is a caller-supplied override that outranks the payload: a packaged hook runs
 * from the plugin directory and the harness's environment variable names the project, so
 * `--root` (from `$CLAUDE_PROJECT_DIR` and friends) must win over a payload cwd that is
 * the plugin's own working directory. An empty override is treated as absent rather than
 * trusted: an env var the harness did not set expands to `""` in the shell, and a root of
 * the empty string would resolve every fact against the filesystem root.
 */
export function factsFrom(row, payload, { root } = {}) {
  const override = typeof root === 'string' && root.trim() !== '' ? root : null;
  return {
    root: override ?? row.root(payload) ?? process.cwd(),
    session: payloadSession(payload),
    ...row.extract(payload ?? {}),
  };
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

/** The document to print for a post-tool lesson recall delivery, or null when the harness takes none. */
export function postDeliveryJson(row, text) {
  return row.post ? row.post.context(text) : null;
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
  if (event === 'post-tool-use') return row.post?.event ?? null;
  return null;
}

/** The events a row answers, and the name each one goes under in its config file. */
function eventsOf(row, { prompt = false, post = false } = {}) {
  const pairs = [[EVENTS[0], row.event]];
  if (prompt && row.prompt) pairs.push(['prompt-submit', row.prompt.event]);
  if (post && row.post) pairs.push(['post-tool-use', row.post.event]);
  return pairs;
}

/**
 * The group this tool owns for one event, in that harness's shape.
 *
 * `command` overrides the entry point for one build: a package ships a self-contained
 * runtime and its config names that copy rather than the binary on PATH, so the shape
 * comes from this table and only the path differs.
 */
function group(row, event = EVENTS[0], command = hookCommand(row.id, event)) {
  const timeout = row.timeout ?? TIMEOUT_SECONDS;
  if (event === 'prompt-submit') {
    // No matcher: both vendors document that field for tool events, and a matcher a
    // harness ignores is a matcher the next reader believes is filtering something.
    return { hooks: [{ type: 'command', command, timeout }] };
  }
  if (event === 'post-tool-use') {
    const matcher = row.post?.matcher;
    return matcher
      ? { matcher, hooks: [{ type: 'command', command, timeout }] }
      : { hooks: [{ type: 'command', command, timeout }] };
  }
  if (row.id === 'cursor') {
    // failClosed is set because a hooks file this tool wrote should not silently
    // degrade to fail-open on its own crash: the vendor's default turns a broken hook
    // into an absent one, and the whole point of writing it is that it runs.
    // It is set only because the command is the repo shim (review 0003 Q21):
    // failClosed on a bare-PATH binary would block every tool call on the machines
    // where the binary is not installed, which is exactly the machines the shim exists for.
    return { command, timeout, matcher: row.matcher, failClosed: true };
  }
  return { matcher: row.matcher, hooks: [{ type: 'command', command, timeout }] };
}

/** Whether a group is this tool's, judged by the command it runs and not by position. */
function ours(entry) {
  const text = JSON.stringify(entry);
  // The shim spelling first; the bare-binary spelling is the pre-shim install,
  // still recognised (and migrated on the next install) for one release.
  return text.includes(AGENT_HOOK_SHIM) || text.includes(`${CLI} agent-hook`);
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
function withHook(row, config, { prompt = false, post = false, command } = {}) {
  const box = container(row, config, { create: true });
  for (const [event, name] of eventsOf(row, { prompt, post })) {
    const kept = entries(row, config, event).filter((e) => !ours(e));
    box[name] = [...kept, group(row, event, event === EVENTS[0] ? command : undefined)];
  }
  return config;
}

/** The text `install` would write, or the reason the existing file cannot be read. */
export function rendered(row, existing, options = {}) {
  if (row.file) {
    // The tool owns this file whole, so there is nothing to merge: the text is
    // the plugin source and `updated` means only that the bytes differ.
    const text = renderOpencodePlugin({ command: options.command ?? hookCommand(row.id), prompt: options.prompt });
    return { text, action: existing === null ? 'created' : text === existing ? 'unchanged' : 'updated' };
  }
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

/**
 * A fresh config document carrying only this tool's hooks, for a package that ships its
 * own runtime: the shape comes from the same table `install` merges into a repository,
 * and only the entry point differs — the package's copy of the binary, named by `command`.
 * Returns null for a harness this tool has no adapter for or that documents no hooks file.
 */
export function hookDocument(id, { command, prompt = false, post = false } = {}) {
  const row = adapter(id);
  if (!row) return null;
  if (row.file) return renderOpencodePlugin({ command: command ?? hookCommand(id), prompt });
  const config = withHook(row, {}, { prompt, post, command });
  return `${JSON.stringify(config, null, 2)}\n`;
}
