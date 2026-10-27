// One ignore list, four readers' dialects (plan 0003 R52).
//
// Cursor, Aider, Gemini and Claude each want the same fact — "the agent must
// not load these paths" — in a different place: three gitignore-style files and
// one array inside a JSON settings object. Hand-maintaining four copies is four
// chances to forget one, and a forget is silent: the agent reads the file that
// did get updated and confidently loads the path the other three excluded. So
// the list lives in exactly one file (`.simtignore`, at the repository root,
// where a gitignore-syntax list already belongs) and everything else is
// rendered from it.
//
// Two ownership rules, because the four targets are not equally ours:
//
//   - The three ignore files are GENERATED: whatever they held is what the list
//     says after `simt ignore --yes`. A line that is in one and not in the list
//     is drift between four files that claim to agree, and the plan prints it
//     as a removal before anything is written.
//   - `.claude/settings.json` is the READER'S file that merely contains our
//     entries. We merge: every key, every permission and every deny entry that
//     was already there survives byte-for-byte, and we only add `Read(...)`
//     lines. In particular we never REMOVE a deny entry, because deleting a
//     permission is a security decision that belongs to whoever wrote it — an
//     entry dropped from `.simtignore` leaves a stale deny in Claude (safe
//     direction) while the three generated files converge immediately.

/** The one list. gitignore syntax: one path or glob per line, `#` comments. */
export const IGNORE_FILE = '.simtignore';

/** The three readers that take the list verbatim. */
const TEXT_TARGETS = ['.cursorignore', '.aiderignore', '.geminiignore'];

/** The reader that takes it as `permissions.deny` `Read(...)` entries. */
export const CLAUDE_SETTINGS = '.claude/settings.json';

/**
 * Parse the list: trim, drop blanks and `#` comments, keep entries verbatim.
 *
 * Verbatim matters — `.env.local` and `secrets/` and `*.pem` are the reader's
 * globs, and normalising them would be this tool guessing at another tool's
 * pattern language.
 */
export function parseIgnoreList(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The bytes of one of the three generated ignore files. */
export function renderTextIgnore(entries) {
  return entries.length === 0 ? '' : `${entries.join('\n')}\n`;
}

/** The list as Claude deny entries: `Read(.env)`, `Read(secrets/**)`, … */
export function denyEntries(entries) {
  return entries.map((entry) => `Read(${entry})`);
}

/**
 * Merge the list into `.claude/settings.json`, preserving everything else.
 *
 * @param {string|null} existingText current bytes, or null when absent
 * @param {string[]} entries the parsed list
 * @returns {{ok: true, text: string} | {ok: false, error: string}} — a settings
 *   file that is not valid JSON OBJECT is refused rather than replaced: the one
 *   failure that loses a reader's whole Claude configuration is a renderer that
 *   "repairs" what it could not parse.
 */
export function renderClaudeSettings(existingText, entries) {
  let settings = {};
  if (existingText !== null) {
    try {
      settings = JSON.parse(existingText);
    } catch (error) {
      return { ok: false, error: `${CLAUDE_SETTINGS} is not valid JSON: ${error.message}` };
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      return { ok: false, error: `${CLAUDE_SETTINGS} is not a JSON object; it cannot hold permissions` };
    }
  }

  const current =
    settings.permissions !== null &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions)
      ? { ...settings.permissions }
      : {};
  const existing = Array.isArray(current.deny)
    ? current.deny.filter((entry) => typeof entry === 'string')
    : [];
  const wanted = denyEntries(entries);
  // Existing entries keep their order and their bytes; ours append in list
  // order, deduplicated so a re-run is byte-idempotent.
  current.deny = [...existing, ...wanted.filter((entry) => !existing.includes(entry))];
  settings.permissions = current;

  return { ok: true, text: `${JSON.stringify(settings, null, 2)}\n` };
}

/**
 * The four targets with their desired bytes, from the current bytes of each.
 *
 * @param {string[]} entries the parsed list
 * @param {(path: string) => Promise<string|null>} read current bytes or null
 * @returns {Promise<{ok: true, targets: {path: string, action: 'create'|'update'|'unchanged',
 *   before: string|null, after: string}[]} | {ok: false, error: string}>}
 */
export async function planIgnore(entries, read) {
  const text = renderTextIgnore(entries);
  const targets = [];

  for (const path of TEXT_TARGETS) {
    const before = await read(path);
    targets.push({
      path,
      action: before === null ? 'create' : before === text ? 'unchanged' : 'update',
      before,
      after: text,
    });
  }

  const claudeBefore = await read(CLAUDE_SETTINGS);
  const merged = renderClaudeSettings(claudeBefore, entries);
  if (!merged.ok) return { ok: false, error: merged.error };
  targets.push({
    path: CLAUDE_SETTINGS,
    action: claudeBefore === null ? 'create' : claudeBefore === merged.text ? 'unchanged' : 'update',
    before: claudeBefore,
    after: merged.text,
  });

  return { ok: true, targets };
}