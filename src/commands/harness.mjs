// `simt harness detect` - which harnesses this repository (and this user) is set up
// for, and which of them simt-dev has a channel for.
//
// Why this is a command and not a sentence in the docs: the question "which harness
// reads my rules" has two halves that used to be answered in different places, and the
// second half was answered by a reader's guess. What is present on disk is observable
// and belongs to the tool; what a given harness actually loads is a vendor fact, and a
// vendor fact is only trustworthy when it names its source. So the table that says "we
// have a channel for this" and the table that says "we have not verified one" are kept
// apart, and this command reports both without collapsing them into a verdict.
//
// It exits 0 whatever it finds. A harness with no channel is a fact about coverage, not
// a defect in the repository: the rules in AGENTS.md still reach whichever harnesses
// read that file, and a reader who wanted a failing command could not tell the
// difference between "no channel" and "broken".

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EXIT, emit, emitJson, isJson, note } from '../output/index.mjs';
import { SURFACES, CANDIDATE_DIRS } from '../projection/surfaces.mjs';

/**
 * `simt-dev harness detect`. The subcommand is validated by dispatch, which rejects a
 * second token that is not in the group registry rather than silently routing to the
 * default; this function therefore has exactly one thing to do and no second spelling
 * to keep in step with it.
 *
 * @param {string[]} positional arguments after the command path
 * @param {object} flags
 * @returns {Promise<number>} process exit code
 */
export async function harnessCommand(positional, flags) {
  const root = flags.root ?? process.cwd();

  const repo = await scan(root);
  // Only on request. The home directory is the reader's, not the repository's, and a
  // command that reports both by default is a command whose output changes because
  // somebody installed something elsewhere.
  const user = flags.user === true ? await scan(homedir()) : null;

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'harness detect',
      root,
      repo,
      ...(user === null ? {} : { user }),
    });
    return EXIT.OK;
  }

  emit(render(root, repo, user));
  if (repo.rows.length === 0) {
    note(
      `note     no harness configuration directory found in ${root}. That is a repository ` +
        'nobody has set an agent up in - not a finding.',
    );
  }
  const unclaimed = countUnclaimed(repo);
  if (unclaimed > 0) {
    note(
      `note     ${unclaimed} present configur${unclaimed === 1 ? 'ation has' : 'ations have'} ` +
        'no rule channel in this release. Each one is reported as present, not as ' +
        'unsupported: whether it reads AGENTS.md is a vendor question this tool does not ' +
        'answer without a source, and a guess here would be the reader\'s problem later.',
    );
  }
  return EXIT.OK;
}

/**
 * Every harness directory present under one root, sorted by directory name.
 *
 * A directory whose stat fails for any reason other than absence is treated as absent
 * rather than raised: a permissions error on one candidate must not make the whole
 * command fail, and the difference between "could not look" and "not there" is one
 * note in the output rather than a second failure mode nobody asked for.
 */
async function scan(root) {
  const rows = [];
  for (const s of SURFACES) {
    for (const dir of s.configDirs ?? []) {
      if (await present(root, dir)) {
        rows.push(row(dir, s.label, { id: s.id, verified: s.verified ?? null, readsAgentsMd: s.readsAgentsMd, rule: s.rule }));
      }
    }
  }
  for (const c of CANDIDATE_DIRS) {
    if (await present(root, c.dir)) rows.push(row(c.dir, c.harness, {}));
  }
  rows.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { root, rows };
}

async function present(root, dir) {
  try {
    return (await stat(join(root, dir))).isDirectory();
  } catch {
    return false;
  }
}

/** One present directory, and what - if anything - this tool can project into it. */
function row(dir, label, surface) {
  const id = surface.id ?? null;
  return {
    dir,
    label,
    surface: id,
    // `channel: false` is the honest half of the answer: the directory exists and this
    // release has no rule file to write there. Reported as its own field rather than
    // left implicit, because "we found it and did nothing" and "we found nothing" look
    // identical in a list of names.
    channel: id !== null && surface.rule != null,
    readsAgentsMd: surface.readsAgentsMd ?? null,
    verified: surface.verified ?? null,
  };
}

function countUnclaimed(scan) {
  return scan.rows.filter((r) => r.surface === null).length;
}

/**
 * One line per present directory, in the order the scanner found them.
 *
 * `surface` is printed when there is one, and `AGENTS.md` is named when the surface
 * loads it - because the answer a reader actually wants is "do my rules reach this",
 * and the channel column alone does not answer it.
 */
function render(root, repo, user) {
  const lines = [`repo     ${root}`];
  lines.push(...block(repo, '        '));
  if (user !== null) {
    lines.push(`user     ${user.root}`);
    lines.push(...block(user, '        '));
  }
  return `${lines.join('\n')}\n`;
}

function block(scan, pad) {
  if (scan.rows.length === 0) return [`${pad}(none present)`];
  return scan.rows.map((r) => {
    const through = r.surface === null ? 'no rule channel in this release' : r.channel ? 'projected rule file' : 'AGENTS.md';
    const agents = r.readsAgentsMd === 'all' ? ' (reads AGENTS.md)' : r.readsAgentsMd === 'some' ? ' (some readers read AGENTS.md)' : '';
    return `${pad}${r.dir.padEnd(12)} ${r.label.padEnd(38)} ${through}${agents}`;
  });
}
