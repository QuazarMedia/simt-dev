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
//
// R42 added the MCP registration files to the same answer. They are reported from the
// loader table (one source of paths, with `verified` naming the vendor page) because a
// detection question deserves the same provenance rule the loader table set: a row with
// no source is a guess in a report.

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { SURFACES, CANDIDATE_DIRS } from '../projection/surfaces.mjs';
import { LOADERS, LOADER_IDS, caps, loader } from '../projection/loaders.mjs';
import { viewAll } from '../measure/loaderView.mjs';

/**
 * `simt harness detect`. The subcommand is validated by dispatch, which rejects a
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

  // MCP evidence is project-scope by construction: the loader table carries repo-root
  // paths (.mcp.json, .codex/config.toml, …), and the same path means different scopes
  // per harness in $HOME - Codex registers user servers in its user config, Claude Code
  // does not keep .mcp.json there - so a home scan reports directories only, and stays
  // right by saying less rather than by carrying a second per-harness user-scope table.
  const repo = await scan(root, { mcp: true });
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
 *
 * `{ mcp: true }` (repo scans only) adds the MCP registration files the loader table
 * records - single-sourced from `loaders.mjs` because that is the whole point of R42:
 * the evidence is data the tool already verified once, not a second list of paths to
 * keep in step by hand. It is file stat and nothing else: present, labelled, cited.
 */
async function scan(root, { mcp = false } = {}) {
  const rows = [];
  for (const s of SURFACES) {
    for (const dir of s.configDirs ?? []) {
      if (await present(root, dir)) {
        rows.push(row(dir, s.label, { id: s.id, verified: s.verified ?? null, readsAgentsMd: s.readsAgentsMd, rule: s.rule }));
      }
    }
  }
  for (const c of CANDIDATE_DIRS) {
    if (await present(root, c.dir)) {
      rows.push(row(c.dir, c.harness, { readsAgentsMd: c.readsAgentsMd ?? null, readsAgentsMdNote: c.readsAgentsMdNote ?? null, verified: c.verified ?? null }));
    }
  }
  if (mcp) rows.push(...(await scanMcpFiles(root)));
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

/**
 * The MCP registration files the loader table says a project can carry.
 *
 * A row requires the path to be a FILE the loader table names, and it is skipped when
 * the loader carries none (opencode registers servers in a profile key, DeepSeek as a
 * profile plugin). Nothing reads the file: whether the JSON parses or names servers is
 * the harness's problem at session time, and a service that promised to validate that
 * would be a service somebody had to keep current.
 *
 * This is evidence, not a channel: no rule file is projected into an MCP config, so
 * `channel` stays false and `readsAgentsMd` stays null - the fields say what they mean
 * instead of borrowing the meaning the directory rows give them.
 */
async function scanMcpFiles(root) {
  const rows = [];
  for (const loader of LOADERS) {
    const mcp = loader.mcp;
    if (mcp?.path == null) continue;
    const file = join(root, mcp.path);
    try {
      if (!(await stat(file)).isFile()) continue;
    } catch {
      continue;
    }
    rows.push({
      dir: mcp.path,
      kind: 'mcp',
      label: loader.label,
      surface: loader.id,
      channel: false,
      readsAgentsMd: null,
      verified: mcp.verified ?? loader.verified ?? null,
    });
  }
  return rows;
}

/** One present directory, and what - if anything - this tool can project into it. */
function row(dir, label, surface) {
  const id = surface.id ?? null;
  return {
    dir,
    kind: 'rules',
    label,
    surface: id,
    // `channel: false` is the honest half of the answer: the directory exists and this
    // release has no rule file to write there. Reported as its own field rather than
    // left implicit, because "we found it and did nothing" and "we found nothing" look
    // identical in a list of names.
    channel: id !== null && surface.rule != null,
    readsAgentsMd: surface.readsAgentsMd ?? null,
    // Which reader ("some") or which configuration ("some, under this setting") - the
    // bare three-valued column started life on rows with many readers, where "which" is
    // a per-row note. A row that lacks one renders without it.
    readsAgentsMdNote: surface.readsAgentsMdNote ?? null,
    verified: surface.verified ?? null,
  };
}

function countUnclaimed(scan) {
  // A candidate that cites a document and reads AGENTS.md is covered by the standard
  // region. One that cites nothing is the case the note exists for (ADR-067). An MCP
  // config row is not "unclaimed" - it never claimed a rule channel, so it must not
  // count toward the note, or mcp.json presence would read as a rule gap it is not.
  return scan.rows.filter((r) => r.kind === 'rules' && r.surface === null && r.readsAgentsMd == null).length;
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
    // An MCP row is judged by presence alone, so it is named first: routed last, its
    // non-null `surface` (the loader it belongs to) would collide with the directory
    // rows' meaning and print "AGENTS.md" under a file that carries no rules at all.
    const through =
      r.kind === 'mcp'
        ? 'MCP config present'
        : r.surface === null
          ? r.readsAgentsMd === 'all'
            ? 'AGENTS.md'
            : 'no rule channel in this release'
          : r.channel
            ? 'projected rule file'
            : 'AGENTS.md';
    // "some" never renders bare when the row knows which: a reader who needs the
    // detail already had it only in the JSON, and the detail is the answer to "is my
    // AGENTS.md read" - the question this text is here to answer.
    const agents =
      r.readsAgentsMd === 'all'
        ? ' (reads AGENTS.md)'
        : r.readsAgentsMd === 'some'
          ? ` (some readers read AGENTS.md${r.readsAgentsMdNote ? `: ${r.readsAgentsMdNote}` : ''})`
          : '';
    return `${pad}${r.dir.padEnd(12)} ${r.label.padEnd(38)} ${through}${agents}`;
  });
}

// `simt harness loaders` - what each reader loads at session start, and the vendor
// document every claim in that answer came from.
//
// It exists because `simt tokens` answers a question about files and this one answers a
// question about a reader, and the two disagree in ways that matter: Antigravity scans
// `.agents/rules/` flat and ignores nested files, and Codex stops merging at 32 KiB
// across the chain rather than per file. A byte count that ignores those is not
// pessimistic, it is wrong, and it was wrong in the meter this slice unblocked.
//
// It exits 0 whatever it finds, for the same reason `harness detect` does: a reader that
// loads nothing here is a fact about this repository, not a defect in it.

/**
 * `simt harness loaders [--root <path>] [--reader <id>] [--table]`.
 *
 * With no flags it prints one block per reader: what it loads, what the cap leaves out,
 * and the sentence it was read from. `--reader` narrows it. `--table` prints the
 * vendor facts without measuring anything, which is the answer to "what does this reader
 * do" in a repository where the answer is not about bytes.
 */
export async function harnessLoadersCommand(positional, flags) {
  const root = flags.root ?? process.cwd();
  const wanted = typeof flags.reader === 'string' ? flags.reader : null;
  const rows = wanted === null ? LOADERS : [loader(wanted)].filter(Boolean);

  if (rows.length === 0) {
    return fail(
      `unknown reader "${wanted}"`,
      EXIT.USAGE,
      `known readers: ${LOADER_IDS.join(', ')}`,
    );
  }

  if (flags.table === true) {
    const payload = rows.map((row) => ({
      id: row.id,
      label: row.label,
      readers: row.readers,
      order: row.order,
      nested: row.nested,
      start: row.start,
      alsoReads: row.alsoReads ?? [],
      imports: row.imports,
      caps: caps(row),
      skills: row.skills ?? [],
      hooks: row.hooks,
      hooksNote: row.hooksNote ?? null,
      mcp: row.mcp,
      verified: row.verified,
      note: row.note ?? null,
    }));
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'harness loaders', rows: payload });
      return EXIT.OK;
    }
    emit(rows.map((row) => loaderTable(row)).join('\n'));
    return EXIT.OK;
  }

  // `--at` asks what a reader loading from a subdirectory would get, which is the only
  // way the chain rows mean anything: Codex merges the project root down to the working
  // directory, so the same repository costs a different reader a different total
  // depending on where that reader is standing.
  const views = await viewAll(root, rows, flags.at ? { cwd: isAbsolute(flags.at) ? flags.at : join(root, flags.at) } : {});
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'harness loaders', root, rows: views });
    return EXIT.OK;
  }
  emit(`${views.map((view) => renderView(view)).join('\n')}`);
  return EXIT.OK;
}

/**
 * One reader's measured view of the repository.
 *
 * The dropped rows come first under a heading of their own. A total that quietly
 * excludes a file past the cap reads as a total, and the reader who is about to lose the
 * tail of their deepest instruction file to a merge is exactly the person who needs to
 * see it named.
 */
function renderView(view) {
  const lines = [`${view.reader.padEnd(11)} ${view.label}  ${view.files.length} file(s) at start, ${view.totalBytes} B`];
  lines.push(`            order     ${view.order}`);
  for (const file of view.files) {
    const state = file.beyondCap
      ? '  BEYOND CAP - not read'
      : file.truncated
        ? `  TRUNCATED to ${file.keptBytes} B`
        : file.overCap
          ? `  OVER CAP (${file.countedBytes} B)`
          : '';
    lines.push(`            ${file.file.padEnd(44)} ${String(file.countedBytes).padStart(7)} B${state}`);
  }
  if (view.cap) {
    lines.push(`            cap       ${view.cap.bytes} B over ${view.cap.appliesTo} (${view.cap.config ?? 'fixed'})`);
  } else if (!view.perFileCap && !view.budget) {
    lines.push('            cap       none published');
  }
  if (view.perFileCap) {
    lines.push(`            file cap  ${view.perFileCap.bytes} B per rule file (${view.perFileCap.config ?? 'fixed'})`);
  }
  if (view.budget) {
    lines.push(`            budget    ${view.budget.tokens} tokens (${view.budget.bytes} B approx) over ${view.budget.appliesTo}`);
  }
  if (view.imports?.syntax) {
    lines.push(`            imports   ${view.imports.syntax}, ${view.imports.depth} hop(s)`);
  }
  if (view.userScope.length > 0) {
    lines.push(`            user      ${view.userScope.join(', ')} (not measured: your bytes, not the repo's)`);
  }
  return `${lines.join('\n')}\n`;
}

/** The vendor facts, without a repository — the part of the answer that is not a measurement. */
function loaderTable(row) {
  const lines = [`${row.id}  ${row.label}  (${row.readers})`];
  lines.push(`  order     ${row.order}`);
  lines.push(`  nested    ${row.nested}`);
  for (const entry of row.start) {
    const where = entry.scope === 'user' ? 'user' : 'project';
    lines.push(`  start     ${where} ${entry.path}${entry.atStart ? '' : ' (on demand)'}`);
  }
  for (const extra of row.alsoReads ?? []) {
    lines.push(`  also      ${extra.what}${extra.atStart ? '' : ' (on demand)'}`);
  }
  for (const c of caps(row)) {
    lines.push(`  cap       ${c.bytes} ${c.scope === 'tokens' ? 'tokens' : 'B'} over ${c.appliesTo ?? c.scope}`);
  }
  if (row.cap === null) lines.push(`  cap       none published — ${row.capNote ?? 'checked'}`);
  lines.push(`  skills    ${(row.skills ?? []).join(', ') || 'none documented'}`);
  lines.push(`  hooks     ${row.hooks?.path ?? 'none documented'}${row.hooksNote ? ` — ${row.hooksNote}` : ''}`);
  lines.push(
    `  mcp       ${row.mcp?.path ?? (row.mcp?.key ? `profile ${row.mcp.key}` : 'none documented')}`,
  );
  lines.push(`  source    ${row.verified}`);
  return lines.join('\n');
}
