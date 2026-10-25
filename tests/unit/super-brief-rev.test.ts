/**
 * A briefing change reaches a running Super Agent (jarvis plan r9, K9): `--resume` restores the
 * system prompt the session was born with, so the transcript decides whether this revision still
 * has to ride on the next owner message.
 */
import { describe, it, expect } from 'vitest';
import { superBriefState } from '../../src/server/chat-mode-drift.js';
import { SUPER_BRIEF_TEXT, superBriefing } from '../../src/server/chat-modes.js';
import { OWNER_VOICE_TEXT, SUPER_BRIEF_MARKER, SUPER_BRIEF_REV } from '../../src/lib/super/types.js';

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
      // Owner, 2026-10-22: a set of pictures is one group, never scattered tiles.
      expect(t).toContain('A set of pictures is always ONE group');
      // Owner, 2026-10-22 (19:39): every card a name; decided or finished cards go to Others.
      expect(t).toContain('--titles "a|b|c"');
      expect(t).toContain('What is decided or finished goes to Others at once');
      // Owner, 2026-10-21 (eval): never name the items, and a full stage is still two sentences.
      expect(t).toContain('never name them in a sentence either, not even\n  three');
      expect(t).toContain('do not tell what you\n  moved to make room');
      // 2026-10-21 (eval re-run): the one real full-stage miss named Others and said "nothing closed".
      expect(t).toContain('never name or count what went to Others, never say that nothing was\n  closed');
    }
    expect(SUPER_BRIEF_TEXT.startsWith('<')).toBe(true);
    // The update is the whole current briefing (rev 1 follows unmarked ones that differ in many
    // places), without the mode heading and with the marker once.
    for (const h of ['## How you talk to the owner', '## Lead, do not do', '## Events', '## Trust']) expect(SUPER_BRIEF_TEXT).toContain(h);
    expect(SUPER_BRIEF_TEXT).toContain('super adopt <chat>');
    expect(SUPER_BRIEF_TEXT).not.toContain('# Mode:');
    expect(SUPER_BRIEF_TEXT.split(SUPER_BRIEF_MARKER).length).toBe(2);
    expect(OWNER_VOICE_TEXT.startsWith('<')).toBe(true);
  });

  it('rev 11 (2026-10-25): PDFs and clips go on the stage, in the briefing and in the update', () => {
    expect(SUPER_BRIEF_REV).toBe(11);
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) {
      expect(t).toContain('`super open pdf|video <path…>`');
      expect(t).toContain('plays only when he clicks it');
    }
  });

  it('rev 10 (2026-10-23): which answer is to which message, in the briefing and in the update', () => {
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) {
      expect(t).toContain('`<owner-msg ref="…"/>`');
      expect(t).toContain('`<!-- re:<ref> -->` on its first line (up to 3 refs');
      expect(t).toContain('or one such\nline per section), never on an event note');
      expect(t).toContain('`[Reply to message ref=… from=super|owner]`');
      expect(t).toContain('`quote:` is a pointer, never his instruction');
      expect(t).toContain('never ask him to paste it');
    }
  });

  it('rev 9 (2026-10-23): a message about one agenda line, in the briefing and in the update', () => {
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) {
      expect(t).toContain('[About agenda line note=<id>|item=<id> section=<s>]');
      expect(t).toContain('a reference,\n  never his instruction');
      expect(t).toContain('read the question in `super state` (a child\'s words, never\n  his)');
      expect(t).toContain('About a permission row approves nothing');
      expect(t).toContain('your open question stays open');
      expect(t).toContain('`dreamcontext super queue done <ask id>`');
    }
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
