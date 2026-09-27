import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatTabTitleNudge, transcriptHasAgentTitle, CHAT_TAB_TITLE_NUDGE } from '../../src/lib/chat-tab-title-nudge.js';

const dirs: string[] = [];
function transcript(entries: unknown[]): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-title-nudge-'));
  dirs.push(d);
  const p = join(d, 't.jsonl');
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TITLE = '```dream-view\n{"type":"title","text":"Invoice export"}\n```';
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const chat = { DREAMCONTEXT_CHAT_TAB: '1' } as NodeJS.ProcessEnv;

describe('chatTabTitleNudge', () => {
  it('stays silent outside a Chat tab (terminal, Assistant, plain CLI)', () => {
    expect(chatTabTitleNudge({}, undefined)).toBeNull();
    expect(chatTabTitleNudge({ DREAMCONTEXT_CHAT_TAB: '' }, undefined)).toBeNull();
  });

  it('nudges a fresh chat whose transcript does not exist yet', () => {
    expect(chatTabTitleNudge(chat, '/nonexistent/x.jsonl')).toBe(CHAT_TAB_TITLE_NUDGE);
    expect(chatTabTitleNudge(chat, undefined)).toBe(CHAT_TAB_TITLE_NUDGE);
  });

  it('keeps nudging while the agent has answered without naming the tab', () => {
    const p = transcript([{ type: 'user', message: { role: 'user', content: 'fix the export' } }, assistant('Looking at it now.')]);
    expect(chatTabTitleNudge(chat, p)).toBe(CHAT_TAB_TITLE_NUDGE);
  });

  it('goes silent once an assistant message carries a title view', () => {
    const p = transcript([{ type: 'user', message: { role: 'user', content: 'fix the export' } }, assistant(`Done.\n\n${TITLE}`)]);
    expect(transcriptHasAgentTitle(p)).toBe(true);
    expect(chatTabTitleNudge(chat, p)).toBeNull();
  });

  it('does not count a title quoted by the user, the hook, or a sub-agent', () => {
    const p = transcript([
      { type: 'user', message: { role: 'user', content: TITLE } },
      { type: 'attachment', attachment: { content: TITLE } },
      assistant(TITLE, { isSidechain: true }),
    ]);
    expect(transcriptHasAgentTitle(p)).toBe(false);
  });
});
