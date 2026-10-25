// The distiller's orchestrator (plan 0003 R38): one target in, one proposal out.
//
// R37 gave this repository a local model client, and R38 is the first consumer of
// it: distillation is the cheapest thing a local model can do that the
// deterministic engine cannot — abstractive compression — and the one that most
// needs the guardrails here, because its output is the kind a reader would paste
// into a pack and forget to check.
//
// Nothing here writes outside `.simt-dev/distilled/`, and nothing here edits a
// source file (ADR-090, ADR-075). A proposal that a human did not merge is a dead
// file, which is the intended failure mode: proposals expire, projections do not.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { EXIT, fail } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { loadRegistry } from '../graph/load.mjs';
import { nearMatches } from '../resolve/near.mjs';
import { bodyFile, sourcePath } from '../resolve/body.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { readLocalConfig, chatEndpoint } from '../local/config.mjs';
import { localChat } from '../local/client.mjs';
import {
  ENGINE_LOCAL,
  ENGINE_OUTLINE,
  buildLocalPrompt,
  digestOf,
  outlineSummary,
  proposalFrontmatter,
  promptHash,
  sourceDigest,
  verifyCitations,
} from './engine.mjs';

export const DEFAULT_BUDGET = 2048;
const DISTILL_DIR = '.simt-dev/distilled';

/**
 * The row's acceptance metric, stated where a caller reads results (ADR-076):
 * "bench shows distilled body plus references match the full body on R at lower
 * C, or the feature stays experimental." It is the second of the two until the
 * bench measures it, so every report says so rather than implying parity.
 */
const METRIC_NOTE = 'parity at lower C unmeasured on R; experimental (plan 0003 R38)';

/**
 * Resolve `<skill|doc>` to an absolute source path.
 *
 * A name first: `distill core-rule` is read as the skill that `skills show` would
 * read, so both commands answering differently is the defect. A path second:
 * everything else is a file under the root, and one that escapes the root is
 * refused — a proposal whose provenance names `../../etc` is provenance nobody
 * should trust.
 */
async function resolveTarget(target, root, flags) {
  const { registry, errors, ok } = await loadRegistry(null, flags);
  if (!ok) return { exit: fail(errors[0], EXIT.REGISTRY) };

  const skill = registry.skills.find((s) => s.name === target);
  if (skill) {
    const ws = await resolveWorkspace(flags);
    const full = await sourcePath(skill, ws.root ?? null, root);
    const readable = full !== null && (full === root || bodyFile(full).startsWith(root + sep));
    if (!readable) {
      const near = nearMatches(target, registry.skills.map((s) => s.name));
      return {
        exit: fail(
          `skill "${target}" resolved to ${full ?? 'no body'} and that body is not under ${root}`,
          EXIT.FAIL,
          `run ${CLI} skills show ${target} to see how the body resolves, or distill a doc path`,
        ),
      };
    }
    const canonical = skill.sources?.find((s) => s.role === 'canonical') ?? skill.sources?.[0];
    return {
      path: bodyFile(full),
      name: canonical ? `${canonical.repo}/${canonical.path}` : skill.name,
      how: 'skill',
    };
  }

  const candidate = isAbsolute(target) ? target : resolve(root, target);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return {
      exit: fail(`${target} is outside ${root}`, EXIT.FAIL, 'distill reads docs under the repository root only'),
    };
  }
  try {
    const text = await readFile(bodyFile(candidate), 'utf8');
    return {
      path: candidate,
      name: relative(root, candidate) || target,
      how: 'doc',
      text,
    };
  } catch {
    const near = nearMatches(target, registry.skills.map((s) => s.name));
    return {
      exit: fail(
        `no skill named "${target}" and no file ${relative(root, candidate) ?? target}`,
        EXIT.FAIL,
        near.length ? `did you mean the skill ${near.join(', ')}?` : `run ${CLI} skills index`,
      ),
    };
  }
}

/**
 * The engine dispatch, including the model path's guardrails.
 *
 * `--local` without a usable `local.chat` is a configuration error, not a silent
 * fallback to the deterministic engine: a caller who asked for the model and got
 * the outline would read the outline's confidence as the model's — and the
 * reverse, reading model output as deterministic, is worse.
 */
async function runEngine(kind, text, budget, context) {
  if (kind === ENGINE_OUTLINE) return outlineSummary(text, budget);

  const { root, allowRemote, name } = context;
  const config = await readLocalConfig(root, { allowRemote });
  // The shared guard arrived from `local/config.mjs` when the critic became the
  // second real user of the same rules (plan 0003 R39, ADR-002).
  const endpoint = chatEndpoint(config);
  if (endpoint.exit !== undefined) return endpoint;

  const prompt = buildLocalPrompt(name, text, budget);
  const chat = await localChat(config.chat, {
    system: 'You compress documents for software agents. Follow the rules the user message states exactly.',
    prompt,
    temperature: 0,
    maxTokens: budget === 0 ? 2048 : Math.min(2048, Math.max(256, Math.ceil(budget / 4))),
    allowRemote,
  });
  if (!chat.ok) {
    return {
      exit: fail(
        `local chat failed: ${chat.error}`,
        EXIT.FAIL,
        'fix the endpoint, or run without --local for the deterministic engine',
      ),
    };
  }
  return { engine: ENGINE_LOCAL, model: chat.model, body: String(chat.content).trim(), prompt };
}

function parseExistingFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const head = text.split('\n---', 1)[0];
  const fields = {};
  for (const line of head.split('\n').slice(1)) {
    const m = /^([a-z]+):\s?(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

function countCitations(text) {
  return (text.match(/\[L\d+(-L\d+)?\]/g) ?? []).length;
}

/**
 * Returns either the report object (ok) or an exit code (fail) — the same shape
 * the command layer returns, so a failure passes through unchanged.
 */
export async function distillTarget(args, flags) {
  const target = args[0];
  if (!target) {
    return fail(
      'distill needs a skill name or a doc path',
      EXIT.USAGE,
      `usage: ${CLI} distill <skill|doc> [--budget <bytes>]`,
    );
  }

  const root = resolve(flags.root ?? process.cwd());
  const source = await resolveTarget(target, root, flags);
  if (source.exit !== undefined) return source.exit;

  const text = source.text ?? (await readFile(bodyFile(source.path), 'utf8'));
  const bytes = Buffer.byteLength(text, 'utf8');
  const budget = Number.isInteger(flags.budget) ? flags.budget : DEFAULT_BUDGET;
  const allowRemote = flags.allowRemote === true;
  const engineKind = flags.local === true ? ENGINE_LOCAL : ENGINE_OUTLINE;
  const digest = digestOf(text, engineKind, budget);
  const relProposal = `${DISTILL_DIR}/${digest}.md`;
  const absProposal = join(root, relProposal);
  const lineCount = text.split('\n').length;

  const cached = flags.refresh === true ? null : await readFile(absProposal, 'utf8').catch(() => null);
  if (cached !== null) {
    const fields = parseExistingFrontmatter(cached);
    return {
      ok: true,
      command: 'distill',
      target: { kind: source.how, source: source.name, bytes, lines: lineCount },
      digest: sourceDigest(text),
      engine: fields.engine ?? ENGINE_OUTLINE,
      budget: Number(fields.budget ?? budget),
      citations: countCitations(cached),
      verified: fields.verified !== 'false',
      metric: { note: METRIC_NOTE },
      proposal: { path: relProposal, state: 'cached', bytes: Buffer.byteLength(cached, 'utf8') },
    };
  }

  const outcome = await runEngine(engineKind, text, budget, { root, allowRemote, name: source.name });
  if (outcome.exit !== undefined) return outcome.exit;

  const check = verifyCitations(outcome.body, lineCount);
  const faults = [...check.faults];
  const bodyBytes = Buffer.byteLength(outcome.body, 'utf8');
  if (budget > 0 && bodyBytes > budget) {
    faults.push(`summary is ${bodyBytes} bytes against a ${budget}-byte budget`);
  }

  const provenance =
    outcome.engine === ENGINE_LOCAL
      ? `${ENGINE_LOCAL}:${outcome.model} (prompt ${promptHash(outcome.prompt)})`
      : ENGINE_OUTLINE;
  const proposal =
    proposalFrontmatter({
      source: source.name,
      digest,
      engine: provenance,
      budget,
      verified: faults.length === 0,
    }) + `\n${outcome.body}\n`;

  await mkdir(join(root, DISTILL_DIR), { recursive: true });
  await writeFile(absProposal, proposal);

  return {
    ok: true,
    command: 'distill',
    target: { kind: source.how, source: source.name, bytes, lines: lineCount },
    digest: sourceDigest(text),
    engine: provenance,
    budget,
    citations: check.ranges.length,
    verified: faults.length === 0,
    ...(faults.length > 0 ? { faults } : {}),
    metric: { note: METRIC_NOTE },
    proposal: { path: relProposal, state: 'fresh', bytes: Buffer.byteLength(proposal, 'utf8') },
  };
}
