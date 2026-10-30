// One renderer per harness for the agent file, and the plan the install writes.
//
// Six harnesses read a subagent and no two agree on the file. Five write a
// markdown file with YAML frontmatter and a body that becomes the system prompt;
// Codex writes a TOML file whose `developer_instructions` holds the same body.
// The path, the extension, the frontmatter keys and the document shape are all
// different, and none of them is the same fact. So this module owns the
// differences and the command owns none of them:
//
//   opencode     .opencode/agents/simt-agent.md   markdown   description
//   claude       .claude/agents/simt-agent.md     markdown   name, description
//   cursor       .cursor/agents/simt-agent.md     markdown   name, description
//   gemini       .gemini/agents/simt-agent.md     markdown   name, description
//   codex        .codex/agents/simt-agent.toml    TOML       name, description, developer_instructions
//   antigravity  .agents/agents/simt-agent.md     markdown   name, description
//
// The source of truth is ONE file in this repository, `agents/simt-agent.md`:
// neutral frontmatter plus a harness-agnostic body. The renderer strips that
// frontmatter and re-emits the keys each harness documents, so the body — the
// part that says how to act — is written once and cannot drift between
// harnesses. An agent is a file the tool owns whole, not a config entry to
// merge, so `rendered` compares bytes and reports created, unchanged or updated.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PACKAGE_ROOT } from '../workspace.mjs';
import { splitFrontmatter } from '../memory/decide.mjs';
import { LOADERS } from '../projection/loaders.mjs';
import { journaledWriteFile } from '../journal.mjs';

/** The one agent this tool ships, and the filename stem every harness shares. */
const AGENT_FILE = 'simt-agent.md';
export const AGENT_STEM = 'simt-agent';

/**
 * The per-harness differences. `frontmatter` returns the ordered [key, value]
 * pairs a markdown harness documents; Codex has none because its shape is TOML,
 * not frontmatter. The body is identical everywhere and is not a difference.
 */
const ADAPTERS = {
  opencode: {
    id: 'opencode',
    format: 'md',
    frontmatter: (agent) => [
      ['description', agent.description],
    ],
  },
  claude: {
    id: 'claude',
    format: 'md',
    frontmatter: (agent) => [
      ['name', agent.name],
      ['description', agent.description],
    ],
  },
  cursor: {
    id: 'cursor',
    format: 'md',
    frontmatter: (agent) => [
      ['name', agent.name],
      ['description', agent.description],
    ],
  },
  gemini: {
    id: 'gemini',
    format: 'md',
    frontmatter: (agent) => [
      ['name', agent.name],
      ['description', agent.description],
    ],
  },
  codex: {
    id: 'codex',
    format: 'toml',
  },
  antigravity: {
    id: 'antigravity',
    format: 'md',
    frontmatter: (agent) => [
      ['name', agent.name],
      ['description', agent.description],
    ],
  },
};

/** The reader-table row for a harness's agents directory, or null when none is documented. */
function agentInfo(id) {
  const row = LOADERS.find((l) => l.id === id);
  return row?.agents ?? null;
}

/**
 * The path a harness reads the agent from, sourced from the reader table rather
 * than spelled here. Null for a harness that documents no agents directory.
 */
export function agentPath(id) {
  const info = agentInfo(id);
  return info ? join(info.dir, `${AGENT_STEM}${info.ext}`) : null;
}

/**
 * Every reader, with the agents path it documents and the note for the ones that
 * do not. The command reports these so a harness this tool does not write is
 * named rather than silent.
 */
export function agentRows() {
  return LOADERS.map((l) => ({
    id: l.id,
    label: l.label,
    path: l.agents ? join(l.agents.dir, `${AGENT_STEM}${l.agents.ext}`) : null,
    note: l.agents ? l.agents.verified : (l.agentsNote ?? 'no agents file is documented'),
  }));
}

/** The adapters that both have a reader-table path and a renderer, in reader order. */
export function adapters() {
  return agentRows()
    .filter((r) => r.path !== null)
    .map((r) => ADAPTERS[r.id])
    .filter(Boolean);
}

/** One adapter by id, or null when the harness has no path or no renderer. */
export function adapter(id) {
  return ADAPTERS[id] && agentInfo(id) !== null ? ADAPTERS[id] : null;
}

/** Parse the neutral frontmatter of the source file: `key: value` lines. */
function parseSimpleFront(front) {
  const out = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

/**
 * The one agent, read from this repository's `agents/` directory. The body is
 * the system prompt; `name` and `description` are re-emitted per harness.
 */
export async function loadAgent() {
  const raw = await readFile(join(PACKAGE_ROOT, 'agents', AGENT_FILE), 'utf8');
  const { front, body } = splitFrontmatter(raw);
  const meta = parseSimpleFront(front ?? '');
  if (!meta.name || !meta.description) {
    throw new Error(`${AGENT_FILE} must declare a name and a description in its frontmatter`);
  }
  return { name: meta.name, description: meta.description, body: body.trim() };
}

/** A basic TOML string: double-quoted, with backslashes and quotes escaped. */
function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** The markdown form: frontmatter the harness documents, a blank line, the body. */
function renderMarkdown(adapterRow, agent) {
  const fm = adapterRow.frontmatter(agent).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${fm}\n---\n\n${agent.body}\n`;
}

/**
 * The Codex form: a TOML file. The body goes in `developer_instructions` as a
 * multi-line basic string; a literal `"""` in the body would end the string, so
 * one of its quotes is escaped.
 */
function renderToml(agent) {
  const body = agent.body.replace(/"""/g, '\\"""');
  return `name = ${tomlString(agent.name)}\ndescription = ${tomlString(agent.description)}\ndeveloper_instructions = """\n${body}\n"""\n`;
}

/**
 * Render the agent for a harness and compare it to what is on disk. The tool
 * owns the file whole, so the comparison is by bytes and the action is one of
 * created, unchanged, updated.
 */
export function rendered(adapterRow, agent, existing) {
  const text = adapterRow.format === 'toml' ? renderToml(agent) : renderMarkdown(adapterRow, agent);
  if (existing === null) return { text, action: 'created' };
  if (existing === text) return { text, action: 'unchanged' };
  return { text, action: 'updated' };
}

/** Read a file as UTF-8, or null when it is not there. */
async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The agent files a repository should carry, one per harness that documents an
 * agents directory. Reads each existing file and renders what install would
 * write, so a dry run and a run describe the same set of files. `harness`
 * narrows to one.
 */
export async function planAgents(root, { harness } = {}) {
  const agent = await loadAgent();
  const rows = harness === undefined ? adapters() : adapters().filter((a) => a.id === harness);
  const plan = [];
  for (const row of rows) {
    const path = agentPath(row.id);
    const existing = await readIfExists(join(root, path));
    const result = rendered(row, agent, existing);
    plan.push({ id: row.id, path, action: result.action, text: result.text });
  }
  return plan;
}

/**
 * Write the agent files a plan names, journaled so `undo` restores the run.
 * Skips files that are already unchanged. Returns the paths written.
 */
export async function writeAgentPlan(root, journal, plan) {
  const written = [];
  for (const p of plan.filter((x) => x.action !== 'unchanged')) {
    await mkdir(join(root, dirname(p.path)), { recursive: true });
    await journaledWriteFile(root, journal, join(root, p.path), p.text);
    written.push(p.path);
  }
  return written;
}
