// The shell command a hook is about to run, read the way a shell reads it.
//
// A policy that greps the payload's command string for `git push` is a policy an agent
// can route around: the review that found it (0003, Q01) counted twenty-five spellings
// the regex let through - `git -C . push`, `sh -c 'git push'`, `$(git push)`, `(git push)`,
// the alias `git p`, `git send-pack`, `--amen`, `+main`. Every one of them is the same
// act, and a reader of this file should be able to see that the act is what is matched.
//
// So the command is tokenised the way POSIX sh tokenises it - quotes, escapes, `; && ||
// | &`, newlines, subshells, `$()` and backticks - each resulting command is unwrapped
// through the wrappers a shell will execute for you, and every git invocation is reduced
// to the fact a policy can read: which subcommand, with which options, in which
// repository. The match is made against that fact, not against the text.
//
// This module is pure: no filesystem, no git. The one lookup that needs the outside
// world - what the author's `alias.p` expands to - is done by the caller, because it
// reads a configuration this module does not own.

import { basename } from 'node:path';

/**
 * A POSIX shell command list: commands separated by `;`, `&&`, `||`, `|`, `&` or a
 * newline, each a list of words.
 *
 * @param {string} text the command string a payload carried
 * @returns {{ok: true, commands: string[][]} | {ok: false}} `ok` is false when the text
 *   cannot be read - unbalanced quotes, an unclosed `$()`, a dangling `(`. A caller that
 *   gets false must fall back to something weaker, never to "nothing to see here": a
 *   command we cannot parse is not a command we are allowed.
 */
function tokenize(text) {
  if (typeof text !== 'string') return { ok: false };
  const commands = [];
  try {
    parseList(text, 0, text.length, commands);
  } catch {
    return { ok: false };
  }
  return { ok: true, commands };
}

/** Read one list of commands from `text[start..end)` into `out`. Throws on unbalance. */
function parseList(text, start, end, out) {
  let i = start;
  let current = null; // the words of the command being read
  const flush = () => {
    if (current !== null && current.length > 0) out.push(current);
    current = null;
  };
  while (i < end) {
    const c = text[i];
    if (c === ';' || c === '&' || c === '|') {
      flush();
      i += 1;
      if ((c === '&' && text[i] === '&') || (c === '|' && text[i] === '|')) i += 1; // && and ||
      continue;
    }
    if (c === '\n' || c === '\r') {
      flush();
      i += 1;
      continue;
    }
    if (c === '(' || c === '{') {
      flush();
      const close = match(text, i, c, c === '(' ? ')' : '}');
      parseList(text, i + 1, close, out); // a subshell is a list in its own right
      i = close + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }
    const word = readWord(text, i, end, out);
    if (word.word !== null) (current ??= []).push(word.word);
    i = word.next;
  }
  flush();
}

/** The index of the `close` char that balances the `open` at `from`, through nesting. */
function match(text, from, open, close) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced');
}

/**
 * Read one word from `text` at `i`, stopping at the next separator. A `$()` or a
 * backtick span inside the word is a command of its own: it is tokenised on its own and
 * added to `out`, because the shell will run it, and a policy that reads only the outer
 * word would see `echo` and let `$(git push)` through.
 *
 * @returns {{word: string|null, next: number}} `word` is null when the span produced no
 *   word of its own (a bare substitution).
 */
function readWord(text, i, end, out) {
  let buf = '';
  while (i < end) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === '{' || c === ')' || c === '}') break;
    if (c === '\\') {
      buf += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1 || close > end) throw new Error('unbalanced quote');
      buf += text.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < end) {
        const q = text[i];
        if (q === '"') {
          i += 1;
          closed = true;
          break;
        }
        if (q === '\\') {
          buf += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (q === '$' && text[i + 1] === '(') {
          const close = match(text, i + 1, '(', ')');
          const inner = [];
          parseList(text, i + 2, close, inner);
          out.push(...inner);
          i = close + 1;
          continue;
        }
        if (q === '`') {
          const close = text.indexOf('`', i + 1);
          if (close === -1 || close > end) throw new Error('unbalanced backtick');
          const inner = [];
          parseList(text, i + 1, close, inner);
          out.push(...inner);
          i = close + 1;
          continue;
        }
        buf += q;
        i += 1;
      }
      if (!closed) throw new Error('unbalanced quote');
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const close = match(text, i + 1, '(', ')');
      const inner = [];
      parseList(text, i + 2, close, inner);
      out.push(...inner);
      i = close + 1;
      continue;
    }
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1 || close > end) throw new Error('unbalanced backtick');
      const inner = [];
      parseList(text, i + 1, close, inner);
      out.push(...inner);
      i = close + 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  return { word: buf === '' ? null : buf, next: i };
}

/**
 * The words a wrapper will execute for you, with the wrapper gone.
 *
 * `sh -c 'git push'` runs `git push`; `sudo -u ci git push` runs `git push`. A policy
 * that unwraps none of these sees the wrapper and lets the wrapped command through, so
 * each one is descended into. The loop is bounded because `env env sh -c …` is legal and
 * a command that wraps forever is not a command, it is an attack on this function.
 *
 * @param {string[]} words one tokenised command
 * @returns {string[][]} the commands it will run: the unwrapped one, plus any command
 *   string a `-c`/`eval` argument carries, tokenised on its own
 */
function unwrap(words) {
  const out = [];
  let w = words;
  for (let depth = 0; depth < 16 && w.length > 0; depth += 1) {
    const name = basename(w[0]);
    if (['sh', 'bash', 'zsh', 'dash'].includes(name)) {
      for (let k = 1; k < w.length; k += 1) {
        const opt = w[k];
        if (!opt.startsWith('-') || opt === '-') break; // the first cluster that is not -c: not this form
        if (opt.includes('c')) { // -c, -lc, -xc: the next word is a command string
          const rest = w.slice(k + 1).join(' ');
          if (rest.trim() !== '') {
            const inner = tokenize(rest);
            if (inner.ok) out.push(...inner.commands);
          }
          return out.length > 0 ? out : [w];
        }
      }
      return [w]; // `bash script.sh` runs a file this policy cannot see; nothing to descend into
    }
    if (name === 'eval') {
      const rest = w.slice(1).join(' ');
      if (rest.trim() !== '') {
        const inner = tokenize(rest);
        if (inner.ok) out.push(...inner.commands);
      }
      return out.length > 0 ? out : [w];
    }
    if (name === 'env') {
      let i = 1;
      while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || w[i] === '-i' || w[i].startsWith('-u'))) {
        i += 1;
      }
      w = w.slice(i);
      continue;
    }
    if (name === 'command' || name === 'exec' || name === 'time') {
      w = w.slice(1);
      continue;
    }
    if (name === 'xargs') {
      let i = 1;
      while (i < w.length && w[i].startsWith('-')) i += 1; // xargs' own options
      w = w.slice(i);
      continue; // the first remaining word is the command xargs runs
    }
    if (name === 'nice') {
      let i = 1;
      while (i < w.length) {
        if (w[i] === '-n') i += 2; // -n takes a value
        else if (w[i].startsWith('-')) i += 1;
        else break;
      }
      w = w.slice(i);
      continue;
    }
    if (name === 'sudo') {
      let i = 1;
      while (i < w.length) {
        if (w[i] === '-u' || w[i] === '-g' || w[i] === '-D' || w[i] === '-C') i += 2; // take a value
        else if (w[i].startsWith('-')) i += 1;
        else break;
      }
      w = w.slice(i);
      continue;
    }
    break;
  }
  out.push(w);
  return out;
}

/** The long options git accepts before the subcommand, so a global flag is not mistaken for one. */
const GLOBAL_FLAGS = new Set([
  'no-pager',
  'paginate',
  'git-dir',
  'work-tree',
  'namespace',
  'super-prefix',
  'exec-path',
  'html-path',
  'no-replace-objects',
  'implied-gitdir',
  'bare',
]);

/**
 * The subcommands a policy can name, so an alias that is not one of them needs no
 * lookup: `git foobar` runs something this table does not police, and spending a git
 * spawn on it would buy nothing.
 */
export const GIT_BUILTINS = new Set([
  'add', 'am', 'apply', 'archimport', 'bisect', 'blame', 'branch', 'bundle', 'checkout',
  'cherry', 'cherry-pick', 'citool', 'clean', 'clone', 'commit', 'commit-graph',
  'count-objects', 'dap', 'diff', 'diff-tree', 'fast-export', 'fast-import',
  'fetch-pack', 'filter-branch', 'format-patch', 'for-each-ref', 'gc', 'get-tar-commit-id',
  'grep', 'hash-object', 'help', 'init', 'interpret-trailers', 'log',
  'ls-files', 'ls-remote', 'ls-tree', 'mailinfo', 'imap-send', 'merge', 'merge-base',
  'mergetool', 'merge-tree', 'mv', 'name-rev', 'notes', 'pack-objects', 'pack-refs',
  'prune', 'prune-packed', 'pull', 'push', 'read-tree', 'rebase', 'remote', 'repack',
  'replace', 'reset', 'restore', 'revert', 'rm', 'run-help', 'send-pack', 'shortlog',
  'show-branch', 'show-index', 'show-ref', 'sparse-checkout', 'stage', 'stash',
  'status', 'strip-stage', 'svn', 'svn-fetch', 'symlink', 'tag', 'teardown-repo',
  'update-index', 'update-ref', 'update-server-info', 'upload-archive', 'upload-pack',
  'verify-commit', 'verify-pack', 'web--browse', 'whatchanged', 'worktree',
]);

/**
 * Per-subcommand short options that take a value, so the value is not mistaken for an
 * option of its own. The table is kept small on purpose: a short option it does not know
 * is treated as flag-like, which can only over-report a policy, never under.
 */
const SHORT_VALUE = {
  commit: new Set(['m', 'C', 'c', 'F', 'S']),
  reset: new Set(['p', 'W', 'C']),
  push: new Set(['r', 'F']),
  pull: new Set(['s', 'o']),
  add: new Set(['f', 'i', 'p', 'u', 'm']),
  rm: new Set(['f', 'n', 'q', 'r']),
  clean: new Set(['d', 'e', 'i', 'n', 'q', 'x', 'f']),
  checkout: new Set(['b', 'B', 'm', 'o', 'p', 't', 'u', 'w']),
};

/** Long options that take a value, per subcommand: `--opt value` consumes the next word. */
const VALUE_LONG = {
  commit: new Set(['message', 'file', 'author', 'date', 'parent', 'gpg-sign']),
  push: new Set(['user', 'receive-pack', 'depth']),
  reset: new Set(['patch', 'combined', 'mode']),
  pull: new Set(['rebase', 'strategy', 'depth']),
};

/** Git's unique-prefix rule: `--amen` is `--amend` because nothing else starts with it. */
const LONG_OPTIONS = {
  commit: ['amend', 'all', 'allow-empty', 'allow-empty-message', 'author', 'date', 'file',
    'force', 'message', 'no-verify', 'only', 'patch', 'signoff', 'verbose'],
  reset: ['hard', 'mixed', 'soft', 'keep', 'merge', 'cache', 'quiet', 'patch'],
  push: ['all', 'atomic', 'delete', 'dry-run', 'force', 'force-with-lease', 'mirror',
    'no-verify', 'prune', 'set-upstream', 'tags', 'verbose'],
  rebase: ['abort', 'apply', 'continue', 'interactive', 'merge', 'onto', 'skip', 'verbose'],
  pull: ['rebase', 'ff', 'no-ff', 'ff-only', 'no-edit', 'verbose'],
  add: ['all', 'force', 'interactive', 'patch', 'update', 'verbose'],
  rm: ['cached', 'dry-run', 'force', 'ignore-unmatch', 'quiet', 'recursive'],
  clean: ['dry-run', 'force', 'ignore', 'interactive', 'quiet', 'recursive'],
  checkout: ['branch', 'force', 'merge', 'orphan', 'overlay', 'progress', 'quiet',
    'track', 'verbose'],
};

/** The unique full option a prefix names, or null when the prefix is ambiguous. */
function resolveLong(sub, name) {
  const table = LONG_OPTIONS[sub] ?? [];
  if (table.includes(name)) return name; // an exact spelling is never ambiguous
  const hits = table.filter((o) => o.startsWith(name));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The git fact one invocation reduces to, or null when the command is not a git call.
 *
 * @param {string[]} words one tokenised, unwrapped command
 * @returns {{kind: 'git', globals: {C: string|null, c: string[], gitDir: string|null},
 *   sub: string, opts: Set<string>, refspecs: string[]}|null}
 *   `opts` holds long options in full (a unique prefix resolved) and short options as
 *   single letters, a cluster expanded. `refspecs` are the positional arguments; a
 *   leading `+` is force and stays on the string, because it is the act.
 */
function parseGit(words) {
  if (words.length === 0 || basename(words[0]) !== 'git') return null;
  const globals = { C: null, c: [], gitDir: null };
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === '-C') {
      globals.C = words[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (w === '-c') {
      globals.c.push(words[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (w === '--git-dir' || w.startsWith('--git-dir=')) {
      globals.gitDir = w === '--git-dir' ? words[i + 1] ?? null : w.slice('--git-dir='.length);
      i += w === '--git-dir' ? 2 : 1;
      continue;
    }
    if (w.startsWith('--')) {
      const name = w.slice(2).split('=')[0];
      if (!GLOBAL_FLAGS.has(name) && !name.startsWith('no-')) break; // an unknown global flag ends the prefix
      i += 1;
      continue;
    }
    if (w.startsWith('-')) {
      i += 1; // a global short flag (-p, -P …): git takes it, so skip it
      continue;
    }
    break; // the subcommand
  }
  if (i >= words.length) return null; // `git` alone runs the help; nothing to police
  const sub = words[i];
  i += 1;

  const opts = new Set();
  const refspecs = [];
  const valueShorts = SHORT_VALUE[sub] ?? new Set();
  let pendingLong = false; // a long option that will take its value from the next word
  while (i < words.length) {
    const w = words[i];
    if (pendingLong && !w.startsWith('-')) {
      i += 1; // the value of --opt: consumed, not an option
      pendingLong = false;
      continue;
    }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq === -1 ? w.slice(2) : w.slice(2, eq);
      if (name !== '') {
        const full = resolveLong(sub, name);
        const spelling = full !== null ? `--${full}` : `--${name}`;
        opts.add(spelling); // unknown to this table: keep it, it can only over-report
        pendingLong = full !== null && (VALUE_LONG[sub] ?? new Set()).has(full);
      }
      i += 1;
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      for (const ch of w.slice(1)) {
        opts.add(ch);
        if (valueShorts.has(ch)) break; // the rest of the cluster is that option's value
      }
      i += 1;
      continue;
    }
    if (w === '--') {
      pendingLong = false;
      i += 1;
      continue; // everything after is a path or a refspec, never an option
    }
    pendingLong = false;
    refspecs.push(w);
    i += 1;
  }
  return { kind: 'git', globals, sub, opts, refspecs };
}

/**
 * The rm fact one invocation reduces to, or null when the command is not an rm call.
 *
 * `rm` is the second command a policy can name: deleting the hooks directory is how a
 * repository's gates go away, and the `hooks-disable` policy reads this fact.
 */
function parseRm(words) {
  if (words.length === 0 || basename(words[0]) !== 'rm') return null;
  const opts = new Set();
  const args = [];
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (w === '--') {
      args.push(...words.slice(i + 1)); // everything after is a path, never an option
      break;
    }
    if (w.startsWith('--')) {
      opts.add(w.slice(2).split('=')[0]);
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      for (const ch of w.slice(1)) opts.add(ch); // a cluster: every letter is an option
      continue;
    }
    args.push(w);
  }
  return { kind: 'rm', opts, args };
}

/**
 * Every fact a policy can name that a command string carries, or null when it is not a
 * string.
 *
 * @param {string} text the command a payload carried
 * @returns {{parsed: true, facts: Array<ReturnType<typeof parseGit>|ReturnType<typeof parseRm>>}|{parsed: false}}
 *   one fact per git or rm invocation, including the ones a wrapper or a substitution
 *   hides; an invocation whose subcommand is not a builtin (an alias, or nothing) is
 *   left as-is - the caller resolves aliases against the author's own configuration,
 *   which this module does not read. `parsed` is false when the text cannot be
 *   tokenised at all, and a caller that gets it must fall back to something weaker,
 *   never to "nothing to see here".
 */
export function commandFacts(text) {
  if (typeof text !== 'string') return null;
  const tokens = tokenize(text);
  if (!tokens.ok) return { parsed: false };
  const facts = [];
  for (const words of tokens.commands) {
    for (const unwrapped of unwrap(words)) {
      const fact = parseGit(unwrapped) ?? parseRm(unwrapped);
      if (fact !== null) facts.push(fact);
    }
  }
  return { parsed: true, facts };
}

/**
 * The facts with each alias subcommand resolved to what the author's git expands it to.
 *
 * `git p` with `alias.p = push` is a push, and the fact has to say so. A value that
 * starts with `!` is a shell command git runs, so it is read the way any other command
 * string is; anything else is a subcommand line. An alias that resolves to nothing this
 * table can read is left as-is: it runs something the policies do not name, which is
 * the same position as before the lookup.
 *
 * @param {Array<ReturnType<typeof parseGit>|ReturnType<typeof parseRm>>} facts
 * @param {Map<string, string>} aliases name to value, as `git config` spells them
 * @returns the facts, with git facts whose sub is an alias replaced by what it runs
 */
export function applyAliases(facts, aliases) {
  return facts.flatMap((f) => {
    if (f.kind !== 'git' || !aliases.has(f.sub)) return [f];
    const value = aliases.get(f.sub);
    if (value.startsWith('!')) {
      const inner = commandFacts(value.slice(1));
      return inner !== null && inner.parsed ? inner.facts : [f];
    }
    const tokens = tokenize(value);
    if (!tokens.ok || tokens.commands.length === 0) return [f];
    const resolved = parseGit(['git', ...tokens.commands[0]]);
    return resolved !== null ? [resolved] : [f];
  });
}
