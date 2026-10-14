// Local session transcript attribution for `simt tokens --session <path>` (R06, ADR-075).
//
// Splits a recorded Claude Code or Codex JSONL/JSON session transcript into `rules`,
// `fileReads` and `toolOutput` using only the local file on disk. Remote URLs are
// refused before any socket or filesystem call so session contents never leave the
// machine.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { tokens } from './context.mjs';

const RULE_PATH_RE =
  /(?:^|\/)(?:AGENTS(?:\.override)?\.md|CLAUDE(?:\.local)?\.md|GEMINI\.md|SKILL\.md|\.cursor\/rules\/|\.claude\/rules\/|\.agents\/rules\/|\.github\/(?:copilot-instructions\.md|instructions\/)|\.simt-dev\/profiles\/)/;

const FILE_READ_TOOLS = new Set(['Read', 'read_file', 'NotebookRead', 'view_file', 'read']);

function bytes(text) {
  return Buffer.byteLength(text);
}

function isRulePath(path) {
  return typeof path === 'string' && RULE_PATH_RE.test(path.replace(/\\/g, '/'));
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.output === 'string') return content.output;
    if (typeof content.content === 'string') return textOfContent(content.content);
  }
  return '';
}

/**
 * Split a local Claude Code or Codex session transcript into `rules`, `fileReads` and
 * `toolOutput` (R06, ADR-075).
 */
export async function measureSession(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
    return {
      ok: false,
      error: '--session requires a local transcript path',
      remedy: 'pass a local JSONL or JSON transcript path: simt tokens --session <path>',
    };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(transcriptPath.trim())) {
    return {
      ok: false,
      error: `${transcriptPath}: remote URLs are refused; session transcripts are read locally only (ADR-075)`,
      remedy: 'pass a local file path on this machine: simt tokens --session ./session.jsonl',
    };
  }

  const resolvedPath = resolve(transcriptPath);
  let raw;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: `${resolvedPath}: cannot read session transcript (${err.code ?? err.message})`,
      remedy: 'pass a readable local JSONL or JSON transcript file to --session <path>',
    };
  }

  let records = [];
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    try {
      if (trimmed.startsWith('[')) {
        records = JSON.parse(trimmed);
      } else {
        records = trimmed
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }
    } catch (err) {
      return {
        ok: false,
        error: `${resolvedPath}: invalid JSON/JSONL session transcript (${err.message})`,
        remedy: 'pass a valid Claude Code or Codex JSONL transcript file to --session <path>',
      };
    }
  }

  const callsById = new Map();
  for (const rec of records) {
    const msg = rec?.message ?? rec?.payload ?? rec;
    const content = msg?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.id) {
          const input = block.input ?? {};
          const path = input.file_path ?? input.path ?? input.notebook_path ?? null;
          callsById.set(block.id, { name: block.name, path });
        }
      }
    }
    if ((rec?.type === 'function_call' || msg?.type === 'function_call') && (rec.call_id ?? msg.call_id)) {
      const id = rec.call_id ?? msg.call_id;
      const name = rec.name ?? msg.name ?? '';
      let args = {};
      try {
        args =
          typeof (rec.arguments ?? msg.arguments) === 'string'
            ? JSON.parse(rec.arguments ?? msg.arguments)
            : (rec.arguments ?? msg.arguments ?? {});
      } catch {
        args = {};
      }
      const path = args.file_path ?? args.path ?? args.file ?? null;
      callsById.set(id, { name, path });
    }
  }

  const buckets = {
    rules: { bytes: 0, items: 0 },
    fileReads: { bytes: 0, items: 0 },
    toolOutput: { bytes: 0, items: 0 },
  };

  const credit = (bucket, text) => {
    const n = bytes(text);
    if (n <= 0) return;
    buckets[bucket].bytes += n;
    buckets[bucket].items += 1;
  };

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;

    const explicitKind = rec.category ?? rec.kind;
    if (explicitKind === 'rules' || explicitKind === 'rule') {
      credit('rules', textOfContent(rec.text ?? rec.content ?? rec.output ?? ''));
      continue;
    }
    if (explicitKind === 'file_read' || explicitKind === 'fileRead') {
      const target = rec.path ?? rec.file ?? null;
      credit(isRulePath(target) ? 'rules' : 'fileReads', textOfContent(rec.text ?? rec.content ?? rec.output ?? ''));
      continue;
    }
    if (explicitKind === 'tool_output' || explicitKind === 'toolOutput') {
      credit('toolOutput', textOfContent(rec.text ?? rec.content ?? rec.output ?? ''));
      continue;
    }

    const msg = rec.message ?? rec.payload ?? rec;
    const role = msg.role ?? rec.role;
    const type = msg.type ?? rec.type;

    if (
      role === 'system' ||
      role === 'developer' ||
      type === 'system' ||
      type === 'user_instructions' ||
      type === 'instructions'
    ) {
      credit('rules', textOfContent(msg.content ?? msg.text ?? msg.instructions ?? ''));
      continue;
    }

    if (type === 'session_meta' && (msg.instructions || msg.base_instructions)) {
      credit('rules', textOfContent(msg.instructions ?? msg.base_instructions));
      continue;
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      const call = callsById.get(msg.call_id ?? rec.call_id);
      const outText = textOfContent(msg.output ?? rec.output ?? '');
      if (call && isRulePath(call.path)) credit('rules', outText);
      else if (call && FILE_READ_TOOLS.has(call.name)) credit('fileReads', outText);
      else credit('toolOutput', outText);
      continue;
    }

    if (role === 'tool' || type === 'tool_result') {
      const call = callsById.get(msg.tool_use_id ?? rec.tool_use_id ?? msg.call_id);
      const target = msg.path ?? rec.path ?? call?.path ?? null;
      const outText = textOfContent(msg.content ?? msg.output ?? '');
      if (isRulePath(target)) credit('rules', outText);
      else if ((call && FILE_READ_TOOLS.has(call.name)) || FILE_READ_TOOLS.has(msg.name ?? rec.name)) {
        credit('fileReads', outText);
      } else {
        credit('toolOutput', outText);
      }
      continue;
    }

    const content = msg.content;
    if (typeof content === 'string') {
      for (const m of content.matchAll(
        /<(?:user_instructions|instructions|system-reminder)>([\s\S]*?)<\/(?:user_instructions|instructions|system-reminder)>/g,
      )) {
        credit('rules', m[1]);
      }
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          const call = callsById.get(block.tool_use_id);
          const target = block.path ?? call?.path ?? null;
          const outText = textOfContent(block.content ?? block.output ?? '');
          if (isRulePath(target)) credit('rules', outText);
          else if ((call && FILE_READ_TOOLS.has(call.name)) || FILE_READ_TOOLS.has(block.name)) {
            credit('fileReads', outText);
          } else {
            credit('toolOutput', outText);
          }
        } else if (typeof block.text === 'string') {
          for (const m of block.text.matchAll(
            /<(?:user_instructions|instructions|system-reminder)>([\s\S]*?)<\/(?:user_instructions|instructions|system-reminder)>/g,
          )) {
            credit('rules', m[1]);
          }
        }
      }
    }
  }

  const totalBytes = buckets.rules.bytes + buckets.fileReads.bytes + buckets.toolOutput.bytes;
  const share = (n) => (totalBytes === 0 ? 0 : Math.round((n / totalBytes) * 100));

  return {
    ok: true,
    path: resolvedPath,
    rules: {
      bytes: buckets.rules.bytes,
      tokens: tokens(buckets.rules.bytes),
      share: share(buckets.rules.bytes),
      items: buckets.rules.items,
    },
    fileReads: {
      bytes: buckets.fileReads.bytes,
      tokens: tokens(buckets.fileReads.bytes),
      share: share(buckets.fileReads.bytes),
      items: buckets.fileReads.items,
    },
    toolOutput: {
      bytes: buckets.toolOutput.bytes,
      tokens: tokens(buckets.toolOutput.bytes),
      share: share(buckets.toolOutput.bytes),
      items: buckets.toolOutput.items,
    },
    total: {
      bytes: totalBytes,
      tokens: tokens(totalBytes),
    },
  };
}
