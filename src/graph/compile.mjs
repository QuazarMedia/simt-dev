// Skill compiler, progressive-disclosure splitter, and trigger report (plan 0003 R30).
//
// 1. Compiles a skill into the Agent Skills layout (`<name>/SKILL.md` + `references/*.md`)
//    with frontmatter that passes `checkSkill` (review 0002 S44, ADR-069).
// 2. Flags every skill body over 5,000 tokens (20,000 bytes at 4 B/token) with a
//    deterministic split plan, and splits markdown bodies by section into `references/`
//    so `SKILL.md` stays within the 5,000-token and 500-line budget.
// 3. Reads R02 transcripts and run records to determine whether the agent opened a skill
//    when the task's gold patch touched its declared `paths`, reporting trigger recall
//    and precision per skill.
// 4. Builds offline, proposal-only description improvements with provenance (`model`,
//    `promptHash`, `digest`) so model output never lands directly in committed text (P2).

import { createHash } from 'node:crypto';
import { checkSkill, nameProblems, readFrontmatter } from './spec.mjs';
import { matchesGlob } from '../resolve/resolve.mjs';

export const BODY_TOKEN_BUDGET = 5000;
export const BYTES_PER_TOKEN = 4;
export const BODY_BYTE_BUDGET = BODY_TOKEN_BUDGET * BYTES_PER_TOKEN;
export const BODY_LINE_BUDGET = 500;

const TARGET_MAIN_BYTES = 12_000;
const TARGET_MAIN_LINES = 350;
const TARGET_REF_BYTES = 16_000;
const SPEC_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

function sha256Tag(text) {
  return `sha256-${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)}`;
}

function slugify(title, index) {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/`+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
  const num = String(index + 1).padStart(2, '0');
  return base ? `${num}-${base}` : `${num}-section`;
}

/** Build a conforming Agent Skills description (30..1024 chars, stating what + when). */
export function buildConformingDescription(skill = {}, rawDescription = '') {
  const clean = String(rawDescription ?? '').replace(/\s+/g, ' ').trim();
  const summary = String(skill.summary ?? '').replace(/\s+/g, ' ').trim();
  const paths = Array.isArray(skill.paths) && skill.paths.length > 0 ? skill.paths.slice(0, 4).join(', ') : '';
  const keywords = Array.isArray(skill.keywords) && skill.keywords.length > 0 ? skill.keywords.slice(0, 5).join(', ') : '';

  const whenClause = paths
    ? `Use when touching ${paths}${keywords ? ` or working with ${keywords}` : ''}.`
    : keywords
      ? `Use when working with ${keywords}.`
      : 'Use when a task matches this capability.';

  let desc = clean || summary || `Instructions for ${skill.name ?? 'this skill'}.`;
  if (!desc.endsWith('.')) desc += '.';
  if (desc.length < 30 || !/\buse when\b/i.test(desc)) {
    const combined = `${desc} ${whenClause}`.replace(/\s+/g, ' ').trim();
    if (combined.length <= 1024) desc = combined;
  }
  if (desc.length < 30) desc = `${desc} ${whenClause}`.trim();
  if (desc.length > 1024) desc = `${desc.slice(0, 1021).trimEnd()}...`;
  return desc;
}

function splitMarkdownSections(bodyText) {
  const lines = String(bodyText ?? '').split(/\r?\n/);
  const preamble = [];
  const sections = [];
  let current = null;
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) inFence = !inFence;
    const h2 = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (h2) {
      if (current) sections.push(current);
      current = { title: h2[1].trim(), lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current);

  if (sections.length <= 1 && lines.length > BODY_LINE_BUDGET) {
    const chunkSize = 200;
    const bodyLines = sections.length === 1 ? [...preamble, ...sections[0].lines] : preamble;
    const intro = bodyLines.slice(0, 80);
    const rest = bodyLines.slice(80);
    const chunked = [];
    for (let i = 0; i < rest.length; i += chunkSize) {
      const partNum = Math.floor(i / chunkSize) + 1;
      chunked.push({
        title: `Reference Part ${partNum}`,
        lines: [`## Reference Part ${partNum}`, '', ...rest.slice(i, i + chunkSize)],
      });
    }
    return { preamble: intro.join('\n').trim(), sections: chunked };
  }
  return { preamble: preamble.join('\n').trim(), sections };
}

/**
 * Compute a deterministic progressive-disclosure split plan for a skill.
 * Every skill over 5,000 tokens (20,000 bytes) or 500 lines is flagged with a split plan.
 */
export function planSkillSplit(skill = {}, bodyText = null) {
  const hasBody = typeof bodyText === 'string' && bodyText.length > 0;
  const bodyBytes = hasBody ? Buffer.byteLength(bodyText, 'utf8') : 0;
  const totalBytes = Math.max(Number(skill.bytes ?? 0), bodyBytes);
  const totalTokens = Math.ceil(totalBytes / BYTES_PER_TOKEN);
  const totalLines = hasBody ? bodyText.split(/\r?\n/).length : Math.ceil(totalBytes / 60);
  const overTokens = totalTokens > BODY_TOKEN_BUDGET;
  const flagged = overTokens;

  if (!flagged) {
    return {
      flagged: false,
      source: hasBody ? 'body' : 'registry',
      reason: null,
      totalBytes,
      totalTokens,
      totalLines,
      mainBytes: bodyBytes || totalBytes,
      mainTokens: Math.ceil((bodyBytes || totalBytes) / BYTES_PER_TOKEN),
      references: [],
    };
  }

  const reason = `${totalTokens} tokens > ${BODY_TOKEN_BUDGET} token budget`;

  if (!hasBody || bodyBytes <= BODY_BYTE_BUDGET) {
    const mainBytes = hasBody ? bodyBytes : Math.min(totalBytes, TARGET_MAIN_BYTES);
    const mainTokens = Math.ceil(mainBytes / BYTES_PER_TOKEN);
    const remainingBytes = Math.max(1024, totalBytes - mainBytes);
    const topics = [...(skill.capabilities ?? []), ...(skill.keywords ?? []).slice(0, 4)];
    const refCount = Math.max(1, Math.ceil(remainingBytes / TARGET_REF_BYTES));
    const references = [];
    let left = remainingBytes;
    for (let i = 0; i < refCount; i += 1) {
      const share = i === refCount - 1 ? left : Math.min(left, Math.ceil(remainingBytes / refCount));
      left -= share;
      const topic = topics[i] ?? `reference-${i + 1}`;
      references.push({
        path: `references/${slugify(topic, i)}.md`,
        title: `Reference: ${topic}`,
        bytes: share,
        tokens: Math.ceil(share / BYTES_PER_TOKEN),
        lines: Math.max(1, Math.ceil(share / 60)),
      });
    }
    return {
      flagged: true,
      source: hasBody ? 'body' : 'registry',
      reason,
      totalBytes,
      totalTokens,
      totalLines,
      mainBytes,
      mainTokens,
      references,
    };
  }

  const parsed = readFrontmatter(bodyText);
  const { preamble, sections } = splitMarkdownSections(parsed.body);
  const keptSections = [];
  const movedSections = [];
  let runningBytes = Buffer.byteLength(preamble, 'utf8') + 512;
  let runningLines = preamble.split(/\r?\n/).length + 25;

  for (const section of sections) {
    const secBytes = Buffer.byteLength(section.lines.join('\n').trim(), 'utf8');
    const secLines = section.lines.length;
    if (
      movedSections.length === 0 &&
      runningBytes + secBytes <= TARGET_MAIN_BYTES &&
      runningLines + secLines <= TARGET_MAIN_LINES &&
      sections.length > 1
    ) {
      keptSections.push(section);
      runningBytes += secBytes;
      runningLines += secLines;
    } else {
      movedSections.push(section);
    }
  }
  if (movedSections.length === 0 && sections.length > 0) movedSections.push(keptSections.pop());

  const references = movedSections.map((sec, idx) => {
    const content = `# ${sec.title}\n\n${sec.lines.slice(1).join('\n').trim()}\n`;
    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      path: `references/${slugify(sec.title, idx)}.md`,
      title: sec.title,
      bytes,
      tokens: Math.ceil(bytes / BYTES_PER_TOKEN),
      lines: content.split('\n').length,
      content,
    };
  });

  const keptBody = [preamble, ...keptSections.map((s) => s.lines.join('\n').trim())].filter(Boolean).join('\n\n');
  const refIndexLines = [
    '## References',
    '',
    'Progressive-disclosure reference files (load on demand when needed):',
    ...references.map((r) => `- [${r.title}](${r.path}) (~${r.tokens} tokens, ${r.bytes} bytes)`),
  ];
  const compiledBody = `${keptBody}\n\n${refIndexLines.join('\n')}\n`;
  const mainBytes = Buffer.byteLength(compiledBody, 'utf8');

  return {
    flagged: true,
    source: 'body',
    reason,
    totalBytes,
    totalTokens,
    totalLines,
    mainBytes,
    mainTokens: Math.ceil(mainBytes / BYTES_PER_TOKEN),
    compiledBody,
    references,
  };
}

function serializeFrontmatter({ name, description, license, compatibility, allowedTools, metadata }) {
  const lines = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`];
  if (license) lines.push(`license: ${JSON.stringify(String(license))}`);
  if (compatibility) lines.push(`compatibility: ${JSON.stringify(String(compatibility).slice(0, 500))}`);
  if (allowedTools) lines.push(`allowed-tools: ${JSON.stringify(String(allowedTools))}`);
  const metaEntries = Object.entries(metadata ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (metaEntries.length > 0) {
    lines.push('metadata:');
    for (const [k, v] of metaEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/** Compile a skill into Agent Skills conforming `SKILL.md` + optional `references/*.md`. */
export function compileSkill(skill = {}, rawText = null) {
  const name = String(skill.name ?? '').trim();
  const brokenName = nameProblems(name);
  if (brokenName) throw new Error(`skill "${name}" cannot be compiled: name ${brokenName}`);

  const parsed = rawText ? readFrontmatter(rawText) : { meta: {}, present: [], body: '' };
  const description = buildConformingDescription(skill, parsed.meta.description);
  const metadata = {};
  for (const [k, v] of Object.entries(parsed.meta.metadata ?? {})) metadata[k] = String(v);
  for (const key of parsed.present) {
    if (!SPEC_KEYS.has(key) && parsed.meta[key] !== undefined) metadata[key] = String(parsed.meta[key]);
  }

  const fmBlock = serializeFrontmatter({
    name,
    description,
    license: parsed.meta.license,
    compatibility: parsed.meta.compatibility,
    allowedTools: parsed.meta['allowed-tools'],
    metadata,
  });

  const defaultBody = parsed.body.trim() || `# ${name}\n\n${skill.summary ?? description}`;
  const fullCandidate = `${fmBlock}\n\n${defaultBody}\n`;
  const splitPlan = planSkillSplit(skill, rawText ? fullCandidate : null);
  const finalBody = splitPlan.compiledBody ? splitPlan.compiledBody.trim() : defaultBody;
  const mainText = `${fmBlock}\n\n${finalBody}\n`;
  const mainBytes = Buffer.byteLength(mainText, 'utf8');
  const mainTokens = Math.ceil(mainBytes / BYTES_PER_TOKEN);
  const conformance = checkSkill({ directoryName: name, fileName: 'SKILL.md', text: mainText, at: name });

  return {
    name,
    description,
    mainPath: `${name}/SKILL.md`,
    mainText,
    mainBytes,
    mainTokens,
    references: (splitPlan.references ?? []).map((r) => ({
      path: r.path,
      title: r.title,
      bytes: r.bytes,
      tokens: r.tokens,
      lines: r.lines,
      ...(r.content ? { content: r.content } : {}),
    })),
    splitPlan: {
      flagged: splitPlan.flagged,
      source: splitPlan.source,
      reason: splitPlan.reason,
      totalBytes: splitPlan.totalBytes,
      totalTokens: splitPlan.totalTokens,
      mainBytes: rawText ? mainBytes : splitPlan.mainBytes,
      mainTokens: rawText ? mainTokens : splitPlan.mainTokens,
      references: (splitPlan.references ?? []).map(({ path, title, bytes, tokens, lines }) => ({
        path,
        title,
        bytes,
        tokens,
        lines,
      })),
    },
    conformance,
  };
}

/** Return the sorted names of skills whose declared `paths` globs match any file in `touchedPaths`. */
export function matchSkillsForPaths(skills = [], touchedPaths = []) {
  const cleanPaths = (touchedPaths ?? []).map((p) => String(p ?? '').replace(/^\/+/, '').trim()).filter(Boolean);
  if (cleanPaths.length === 0) return [];
  const matched = [];
  for (const skill of skills) {
    if (!skill?.name || skill.aliasOf) continue;
    const globs = Array.isArray(skill.paths) ? skill.paths : [];
    if (globs.length > 0 && cleanPaths.some((file) => globs.some((glob) => matchesGlob(file, glob)))) {
      matched.push(skill.name);
    }
  }
  return [...new Set(matched)].sort();
}

/** Extract the sorted list of skill names opened by an agent from an R02 transcript. */
export function extractOpenedSkills(transcriptInput, knownSkillNames = null) {
  const known = knownSkillNames ? new Set(knownSkillNames) : null;
  const opened = new Set();
  const recordIfKnown = (candidate) => {
    const name = String(candidate ?? '').trim().toLowerCase();
    if (!name || nameProblems(name) !== null) return;
    if (!known || known.has(name)) opened.add(name);
  };

  if (Array.isArray(transcriptInput)) {
    for (const item of transcriptInput) {
      if (typeof item === 'string') recordIfKnown(item);
      else if (item && typeof item === 'object') {
        for (const s of extractOpenedSkills(JSON.stringify(item), known)) opened.add(s);
      }
    }
    return [...opened].sort();
  }

  const text = typeof transcriptInput === 'string' ? transcriptInput : JSON.stringify(transcriptInput ?? '');
  for (const m of text.matchAll(/(?:^|[\s"'`:=(/])skills\/([a-z0-9-]+)(?:\/SKILL\.md|\.md|\/|[\s"'`),]|$)/gi)) {
    recordIfKnown(m[1]);
  }
  for (const m of text.matchAll(/(?:^|[\s"'`:=(/])([a-z0-9-]+)\/SKILL\.md\b/g)) recordIfKnown(m[1]);
  for (const m of text.matchAll(/\bsimt(?:-dev)?\s+skills\s+show\s+([a-z0-9-]+)\b/gi)) recordIfKnown(m[1]);
  for (const m of text.matchAll(/"(?:skill|skill_name|skillName)"\s*:\s*"([a-z0-9-]+)"/gi)) recordIfKnown(m[1]);
  for (const m of text.matchAll(/"name"\s*:\s*"skills_show"[\s\S]{0,200}?"name"\s*:\s*"([a-z0-9-]+)"/gi)) {
    recordIfKnown(m[1]);
  }
  return [...opened].sort();
}

/** Compute per-skill trigger recall/precision across R02 runs and attach split plans. */
export function evaluateSkillTriggers(registry, runs = [], { bodiesBySkill = new Map(), goldPathsByTask = new Map() } = {}) {
  const skills = [...(registry?.skills ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const knownNames = new Set(skills.map((s) => s.name));

  const normalizedRuns = (runs ?? []).map((run) => {
    const taskId = String(run?.task ?? '');
    const expectedFromRun = Array.isArray(run?.skills?.expected)
      ? run.skills.expected
      : Array.isArray(run?.expectedSkills) ? run.expectedSkills : null;
    const goldPaths = run?.goldFiles ?? goldPathsByTask.get(taskId) ?? [];
    const expected = expectedFromRun
      ? expectedFromRun.filter((n) => knownNames.has(n))
      : matchSkillsForPaths(skills, goldPaths);
    const openedFromRun = Array.isArray(run?.skills?.opened)
      ? run.skills.opened
      : Array.isArray(run?.openedSkills) ? run.openedSkills : null;
    const opened = openedFromRun
      ? openedFromRun.filter((n) => knownNames.has(n))
      : extractOpenedSkills(run?.transcript ?? '', knownNames);
    return { task: taskId, arm: String(run?.arm ?? 'default'), expected: new Set(expected), opened: new Set(opened) };
  });

  const rows = skills.map((skill) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const run of normalizedRuns) {
      const exp = run.expected.has(skill.name);
      const opn = run.opened.has(skill.name);
      if (exp && opn) tp += 1;
      else if (!exp && opn) fp += 1;
      else if (exp && !opn) fn += 1;
    }
    const expected = tp + fn;
    const opened = tp + fp;
    const splitPlan = planSkillSplit(skill, bodiesBySkill.get(skill.name) ?? null);
    return {
      name: skill.name,
      bytes: skill.bytes ?? 0,
      tokens: splitPlan.totalTokens,
      paths: skill.paths ?? [],
      expected,
      opened,
      tp,
      fp,
      fn,
      recall: expected > 0 ? tp / expected : null,
      precision: opened > 0 ? tp / opened : null,
      flagged: splitPlan.flagged,
      splitPlan: {
        flagged: splitPlan.flagged,
        source: splitPlan.source,
        reason: splitPlan.reason,
        totalBytes: splitPlan.totalBytes,
        totalTokens: splitPlan.totalTokens,
        mainBytes: splitPlan.mainBytes,
        mainTokens: splitPlan.mainTokens,
        references: (splitPlan.references ?? []).map(({ path, title, bytes, tokens, lines }) => ({
          path,
          title,
          bytes,
          tokens,
          lines,
        })),
      },
    };
  });

  return {
    runCount: normalizedRuns.length,
    skillCount: rows.length,
    flaggedCount: rows.filter((r) => r.flagged).length,
    skills: rows,
  };
}

/** Create a proposal-only description improvement with provenance (Principle P2). */
export async function proposeSkillDescription(
  skill,
  { currentDescription = '', triggerStats = null, proposer = null, model = 'deterministic-template' } = {},
) {
  const prompt = [
    `Skill: ${skill.name}`,
    `Summary: ${skill.summary ?? ''}`,
    `Paths: ${(skill.paths ?? []).join(', ') || '(none)'}`,
    `Keywords: ${(skill.keywords ?? []).join(', ') || '(none)'}`,
    `Capabilities: ${(skill.capabilities ?? []).join(', ') || '(none)'}`,
    `Current description: ${currentDescription || skill.summary || ''}`,
    triggerStats
      ? `Trigger stats: expected=${triggerStats.expected}, opened=${triggerStats.opened}, recall=${triggerStats.recall ?? 'n/a'}, precision=${triggerStats.precision ?? 'n/a'}`
      : 'Trigger stats: unmeasured',
  ].join('\n');

  const promptHash = sha256Tag(prompt);
  let candidate = '';
  let usedModel = model;
  if (typeof proposer === 'function') {
    const raw = await proposer({ skill, prompt, triggerStats });
    if (typeof raw === 'string' && raw.trim()) candidate = raw.trim();
    else if (raw && typeof raw.description === 'string') {
      candidate = raw.description.trim();
      if (raw.model) usedModel = String(raw.model);
    }
  }
  const proposedDescription = buildConformingDescription(skill, candidate);
  return {
    schemaVersion: 1,
    skill: skill.name,
    status: 'proposal',
    currentDescription: currentDescription || skill.summary || '',
    proposedDescription,
    provenance: { model: usedModel, promptHash, digest: sha256Tag(proposedDescription) },
  };
}
