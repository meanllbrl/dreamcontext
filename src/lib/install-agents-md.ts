/**
 * The dreamcontext block in a project's `AGENTS.md` (Codex reads it as project instructions),
 * written by `dreamcontext install --tool codex` (Track T W3). Marker-delimited: only the text
 * between the markers is ours; everything else in the file is the owner's and is never touched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENTS_MD_START = '<!-- dreamcontext:start (managed by `dreamcontext install --tool codex`; edits inside are replaced) -->';
export const AGENTS_MD_END = '<!-- dreamcontext:end -->';

export const AGENTS_MD_BODY = [
  '## dreamcontext',
  '',
  'This project keeps its memory in `_dream_context/` (dreamcontext). The session snapshot and per-prompt recall arrive as context from hooks (`.codex/hooks.json`).',
  '',
  '- Before answering a question about the project, look it up: `dreamcontext recall "<question>"`.',
  '- Log progress and decisions to the task you are working on: `dreamcontext tasks log <task> "<what changed and why>"`.',
  '- Never write `_dream_context/marketing/.env`; never hand-edit files under `_dream_context/` that the CLI manages (tasks, knowledge index, sleep state).',
].join('\n');

export type AgentsMdResult = 'created' | 'appended' | 'updated' | 'unchanged';

/** Write or refresh the block; idempotent. Text outside the markers is kept byte for byte. */
export function ensureAgentsMdBlock(projectRoot: string): AgentsMdResult {
  const file = join(projectRoot, 'AGENTS.md');
  const block = `${AGENTS_MD_START}\n${AGENTS_MD_BODY}\n${AGENTS_MD_END}`;
  if (!existsSync(file)) {
    writeFileSync(file, block + '\n', 'utf-8');
    return 'created';
  }
  const text = readFileSync(file, 'utf-8');
  const start = text.indexOf(AGENTS_MD_START);
  const end = start >= 0 ? text.indexOf(AGENTS_MD_END, start) : -1;
  if (start >= 0 && end >= 0) {
    const next = text.slice(0, start) + block + text.slice(end + AGENTS_MD_END.length);
    if (next === text) return 'unchanged';
    writeFileSync(file, next, 'utf-8');
    return 'updated';
  }
  const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(file, text + sep + block + '\n', 'utf-8');
  return 'appended';
}
