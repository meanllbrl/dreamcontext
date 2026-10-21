/**
 * A briefing change reaches a running Super Agent (jarvis plan r9, K9): `--resume` restores the
 * system prompt the session was born with, so the transcript decides whether this revision still
 * has to ride on the next owner message.
 */
import { describe, it, expect } from 'vitest';
import { superBriefState } from '../../src/server/chat-mode-drift.js';
import { superBriefing } from '../../src/server/chat-modes.js';
import { OWNER_VOICE_TEXT, SUPER_BRIEF_MARKER, SUPER_BRIEF_REV, SUPER_BRIEF_TEXT } from '../../src/lib/super/types.js';

const j = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const snapshot = (text: string) => ({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: [text] } });
const owner = (...blocks: string[]) => ({ type: 'user', message: { role: 'user', content: blocks.map((text) => ({ type: 'text', text })) } });
const compact = { type: 'system', subtype: 'compact_boundary' };

describe('the briefing carries the jarvis sections and its revision', () => {
  it('Show, don\'t tell and Voice are in the briefing and in the update block, both marked', () => {
    const b = superBriefing();
    for (const t of [b, SUPER_BRIEF_TEXT]) {
      expect(t).toContain("## Show, don't tell");
      expect(t).toContain('## Voice');
      expect(t).toContain(SUPER_BRIEF_MARKER);
      expect(t).toContain('--group');
      // Owner, 2026-10-21 (eval): never name the items, and a full stage is still two sentences.
      expect(t).toContain('never name them in a sentence either, not even\n  three');
      expect(t).toContain('do not tell what you\n  moved to make room');
      // 2026-10-21 (eval re-run): the one real full-stage miss named Others and said "nothing closed".
      expect(t).toContain('never name or count what went to Others, never say that nothing was\n  closed');
    }
    expect(SUPER_BRIEF_TEXT.startsWith('<')).toBe(true);
    expect(OWNER_VOICE_TEXT.startsWith('<')).toBe(true);
  });
});

describe('superBriefState', () => {
  it('born with this revision: nothing owed, ever (a compaction keeps the system prompt)', () => {
    expect(superBriefState(j(snapshot(superBriefing()), owner('hi'), compact), SUPER_BRIEF_REV)).toEqual({ inPrompt: true, due: false });
  });

  it('born before it: owed once, delivered by a message, owed again after a compaction', () => {
    const old = snapshot('# Mode: Super Agent\n<super-brief rev=0>');
    expect(superBriefState(j(old, owner('hi')), SUPER_BRIEF_REV).due).toBe(true);
    expect(superBriefState(j(old, owner('hi', SUPER_BRIEF_TEXT)), SUPER_BRIEF_REV).due).toBe(false);
    expect(superBriefState(j(old, owner('hi', SUPER_BRIEF_TEXT), compact), SUPER_BRIEF_REV).due).toBe(true);
    expect(superBriefState(j(old, owner('hi', SUPER_BRIEF_TEXT), compact, owner('again', SUPER_BRIEF_TEXT)), SUPER_BRIEF_REV).due).toBe(false);
  });

  it('a tool result quoting the marker (the agent grepping this source) is not a delivery', () => {
    const old = snapshot('# Mode: Super Agent');
    const quoted = { type: 'user', message: { content: [{ type: 'tool_result', content: `src/lib/super/types.ts: ${SUPER_BRIEF_MARKER}` }] } };
    expect(superBriefState(j(old, quoted), SUPER_BRIEF_REV).due).toBe(true);
  });

  it('a compaction summary quoting the marker is not a delivery', () => {
    const old = snapshot('# Mode: Super Agent');
    const summary = { type: 'user', isCompactSummary: true, message: { content: [{ type: 'text', text: `summary ${SUPER_BRIEF_MARKER}` }] } };
    expect(superBriefState(j(old, owner('x', SUPER_BRIEF_TEXT), compact, summary), SUPER_BRIEF_REV).due).toBe(true);
  });
});
