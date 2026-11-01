/**
 * A Codex rollout read in the Claude transcript shape (Track T W3, plan r5 §4a "sleep sees every
 * tool"). Sleep's scorer (`analyzeTranscript`), the session digest and `transcript distill` read
 * Claude JSONL; a Codex chat's record is `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`.
 * `readTranscriptText` hands every reader the Claude shape for a rollout and the file's own bytes
 * for anything else, so a Claude transcript is read exactly as before.
 *
 * What is kept: what the owner typed, what Codex answered, its tool calls under our canonical
 * names (a patch's files as Write/Edit, a command as Bash, a search as WebSearch) and the novel
 * tokens of each model call. What is dropped: everything injected — developer instructions, the
 * environment context, our own app context (`<external_dreamcontext-*>`: the brain snapshot,
 * recall, the Eco nudge) and the hidden tab-naming turn — so a session's own words are scored and
 * mined, never the brain it was handed.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** A Codex rollout file: `rollout-<timestamp>-<thread uuid>.jsonl`. */
export function isCodexRollout(path: string | null | undefined): boolean {
  if (!path) return false;
  return /^rollout-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(basename(path));
}

/** The file as the transcript readers expect it: a rollout converted, anything else verbatim. */
export function readTranscriptText(path: string): string {
  const raw = readFileSync(path, 'utf-8');
  return isCodexRollout(path) ? codexRolloutToClaudeJsonl(raw) : raw;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The hidden tab-naming turn the bridge runs (tab-title.ts) is ours, never the owner's. */
const HIDDEN_TURN_RE = /^\s*<dreamcontext_tab_title>/;

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => { const o = obj(c); return o ? str(o.text) : ''; })
    .filter(Boolean)
    .join('\n');
}

/** Typed by the owner: a user message whose every item is `user.text` (Codex tags each one). */
function isOwnerText(payload: Json): boolean {
  const meta = obj(payload.internal_chat_message_metadata_passthrough);
  const kinds = Array.isArray(meta?.content_item_kinds) ? meta!.content_item_kinds as unknown[] : null;
  if (kinds) return kinds.length > 0 && kinds.every((k) => k === 'user.text');
  // An older rollout with no kinds: drop the shapes we know are injected.
  const text = contentText(payload.content).trimStart();
  return !/^<(environment_context|external_|user_instructions|permissions instructions)/.test(text);
}

interface ToolUse { name: string; input: Json }

/** Files a `*** Begin Patch` body touches, as Write (added) / Edit (updated, deleted, moved). */
function patchTools(patch: string): ToolUse[] {
  const out: ToolUse[] = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    out.push({ name: m[1] === 'Add' ? 'Write' : 'Edit', input: { file_path: m[2]!.trim() } });
  }
  return out;
}

/** Codex's tool calls → our canonical tool names. The code-mode `exec` tool is read for what it calls. */
function toolUses(payload: Json): ToolUse[] {
  const name = str(payload.name);
  const input = str(payload.input) || str(payload.arguments);
  const type = str(payload.type);
  if (type === 'web_search_call') return [{ name: 'WebSearch', input: {} }];
  if (name === 'apply_patch' || /\*\*\* Begin Patch/.test(input)) {
    const files = patchTools(input.replace(/\\n/g, '\n'));
    if (files.length) return files;
  }
  if (name === 'shell' || name === 'local_shell' || name === 'exec_command' || type === 'local_shell_call') {
    return [{ name: 'Bash', input: { command: input.slice(0, 400) } }];
  }
  if (name === 'exec') {
    const out: ToolUse[] = [];
    const calls = input.match(/tools\.([A-Za-z0-9_]+)\(/g) ?? [];
    for (const c of calls) {
      const tool = c.slice('tools.'.length, -1);
      if (tool === 'exec_command') out.push({ name: 'Bash', input: { command: '' } });
      else if (/^web__/.test(tool)) out.push({ name: 'WebSearch', input: {} });
      else out.push({ name: `mcp__codex__${tool}`, input: {} });
    }
    return out.length ? out : [{ name: 'Bash', input: { command: '' } }];
  }
  if (name.startsWith('mcp__') || type === 'mcp_tool_call') return [{ name: name || 'mcp__codex__tool', input: {} }];
  return name ? [{ name, input: {} }] : [];
}

/**
 * The rollout's lines as Claude transcript JSONL. Unknown records are skipped (never guessed);
 * a malformed line is skipped like the Claude readers skip one.
 */
export function codexRolloutToClaudeJsonl(text: string): string {
  const out: string[] = [];
  let calls = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: Json | null;
    try { rec = obj(JSON.parse(line)); } catch { continue; }
    if (!rec) continue;
    const timestamp = str(rec.timestamp) || undefined;
    const payload = obj(rec.payload);
    if (!payload) continue;
    const emit = (r: Json): void => { out.push(JSON.stringify(timestamp ? { ...r, timestamp } : r)); };
    if (rec.type === 'response_item') {
      const kind = str(payload.type);
      if (kind === 'message') {
        const role = str(payload.role);
        const body = contentText(payload.content);
        if (!body.trim()) continue;
        if (role === 'user' && isOwnerText(payload) && !HIDDEN_TURN_RE.test(body)) {
          emit({ type: 'user', message: { role: 'user', content: body } });
        } else if (role === 'assistant') {
          emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: body }] } });
        }
        continue;
      }
      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call' || kind === 'web_search_call' || kind === 'mcp_tool_call') {
        const uses = toolUses(payload);
        if (!uses.length) continue;
        emit({
          type: 'assistant',
          message: { role: 'assistant', content: uses.map((u) => ({ type: 'tool_use', id: `codex_${++calls}`, name: u.name, input: u.input })) },
        });
      }
      continue;
    }
    if (rec.type === 'token_usage_record') {
      // One model call. OpenAI's input tokens INCLUDE the cached ones; the scorer counts only
      // novel input, the same way it leaves Claude's cache reads out.
      const u = obj(payload.usage);
      if (!u) continue;
      const input = Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens));
      const id = str(payload.response_id) || `codex_usage_${out.length}`;
      emit({ type: 'assistant', message: { id, role: 'assistant', content: [], usage: { input_tokens: input, output_tokens: num(u.output_tokens) } } });
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}
