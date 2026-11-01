/**
 * Owner 2026-10-31: every tab can be minimized, the chat window cannot. The strip's left corner
 * has no "–" button in either shell, and nothing reserves room for one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), 'dashboard/src/components/sleepy', p), 'utf-8');

describe('the chat head has no window minimize', () => {
  it('the button, its styles and its clearance are gone', () => {
    for (const f of ['AgentSurface.tsx', 'AgentTerminal.css', 'MobileChat.css', 'super/SuperSurface.css']) {
      expect(read(f)).not.toContain('agent-overlay-collapse');
      expect(read(f)).not.toContain('--head-clear-start');
    }
  });

  it('a phone\'s head is the chat\'s name and its ＋, nothing else: no ‹, no ☰, no Mac chip', () => {
    const src = read('AgentSurface.tsx');
    const head = src.slice(src.indexOf('{/* The phone header:'), src.indexOf('{!isMobile && ('));
    expect(head).toContain('className="mchat-head-title"');
    expect(head).toContain('data-testid="chat-head-new"');
    // The ＋ is always there: every project on a phone starts chats.
    expect(head).toMatch(/<button\s+className="mchat-head-btn"/);
    expect(head).not.toContain('chat-back');
    expect(head).not.toContain('setDrawerOpen');
    expect(head).not.toContain('<PhoneChip');
    expect(head.match(/<button/g)).toHaveLength(1);
  });

  it('each tab keeps its own minimize', () => {
    expect(read('AgentSurface.tsx')).toContain('onMinimize={minimizeSession}');
  });
});
