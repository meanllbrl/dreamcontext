/**
 * A mode switch on an open chat reaches the model (chat-mode-drift.ts).
 *
 * A resume restores the system prompt from the transcript's `prompt_snapshot`, so the new
 * append file is ignored. These pin the two decisions that fix rests on: which mode the model
 * is ACTUALLY holding (read from the transcript, not the registry), and when a note must be
 * injected — on resume when that differs, on compact when the snapshot differs.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_SURFACE_BRIEFING } from '../../src/server/chat-surface.js';
import { modeBriefing, type ChatMode } from '../../src/server/chat-modes.js';
import {
  heldModeFromTranscript, modeFromSystemPrompt, modeNoteHookOutput, modeNoteSettings,
  modeNoteSources, modeSwitchNote,
} from '../../src/server/chat-mode-drift.js';

const briefed = (mode: ChatMode) =>
  `You are Claude Code.\n${CHAT_SURFACE_BRIEFING}\n${modeBriefing(mode, { worktreeAllowed: false })}`;
const snapshot = (mode: ChatMode) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['intro', briefed(mode)] } });
const note = (to: ChatMode, from: ChatMode = 'basic') =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'SessionStart', content: [modeSwitchNote(from, to, modeBriefing(to, { worktreeAllowed: false }))] } });
const compact = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
const said = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const jsonl = (...lines: string[]) => lines.join('\n');

describe('modeFromSystemPrompt', () => {
  it('reads every chat mode off the brief it was born with', () => {
    for (const m of ['basic', 'plan', 'develop', 'train'] as const) expect(modeFromSystemPrompt(briefed(m))).toBe(m);
  });
  it('a prompt without the chat surface was born outside the Chat view', () => {
    expect(modeFromSystemPrompt('You are Claude Code.')).toBe('none');
  });
  it('a mode NAMED mid-line is not a brief', () => {
    expect(modeFromSystemPrompt(`${CHAT_SURFACE_BRIEFING}\nsee "# Mode: Plan" in the docs\n`)).toBe('basic');
  });
});

describe('heldModeFromTranscript', () => {
  it('no snapshot → null: that CLI honours the append file on resume', () => {
    expect(heldModeFromTranscript(jsonl(said('hi')))).toBeNull();
  });
  it('the snapshot alone decides — the owner report: born Basic, badge says Plan', () => {
    expect(heldModeFromTranscript(jsonl(snapshot('basic'), said('hi'), snapshot('basic')))).toEqual({ snapshot: 'basic', held: 'basic' });
  });
  it('a note of ours after the snapshot is what the model holds; the latest one wins', () => {
    expect(heldModeFromTranscript(jsonl(snapshot('basic'), note('plan'), said('ok'), note('develop', 'plan'))))
      .toEqual({ snapshot: 'basic', held: 'develop' });
  });
  it('a compaction drops our notes and falls back to the snapshot', () => {
    expect(heldModeFromTranscript(jsonl(snapshot('basic'), note('plan'), compact))).toEqual({ snapshot: 'basic', held: 'basic' });
  });
  it('the marker in ordinary conversation text is not a note (this repo talks about it)', () => {
    expect(heldModeFromTranscript(jsonl(snapshot('basic'), said('<!-- dreamcontext-chat-mode:plan -->'))))
      .toEqual({ snapshot: 'basic', held: 'basic' });
  });
  it('a torn last line does not throw', () => {
    expect(heldModeFromTranscript(`${snapshot('plan')}\n{"attachment":{"type":"prompt_snap`)).toEqual({ snapshot: 'plan', held: 'plan' });
  });
});

describe('modeNoteSources', () => {
  it('nothing to do when the model already holds the mode', () => {
    expect(modeNoteSources({ snapshot: 'plan', held: 'plan' }, 'plan')).toEqual([]);
  });
  it('switched away from the birth mode: inject now AND after every compaction', () => {
    expect(modeNoteSources({ snapshot: 'basic', held: 'basic' }, 'plan')).toEqual(['resume', 'compact']);
  });
  it('already told, resumed again: only compaction needs it', () => {
    expect(modeNoteSources({ snapshot: 'basic', held: 'plan' }, 'plan')).toEqual(['compact']);
  });
  it('switched BACK to the birth mode: the earlier note must be overridden, compaction restores it anyway', () => {
    expect(modeNoteSources({ snapshot: 'basic', held: 'plan' }, 'basic')).toEqual(['resume']);
  });
  it('no snapshot, or the Assistant: never', () => {
    expect(modeNoteSources(null, 'plan')).toEqual([]);
    expect(modeNoteSources({ snapshot: 'basic', held: 'basic' }, 'assistant')).toEqual([]);
  });
});

describe('the note and its hook', () => {
  it('says it REPLACES the system prompt mode and carries the new brief', () => {
    const text = modeSwitchNote('basic', 'plan', modeBriefing('plan', { worktreeAllowed: false }));
    expect(text).toMatch(/REPLACE/);
    expect(text).toContain('# Mode: Plan');
    expect(heldModeFromTranscript(jsonl(snapshot('basic'), note('plan')))?.held).toBe('plan');
  });
  it('switching to Basic lifts the earlier procedure explicitly', () => {
    expect(modeSwitchNote('plan', 'basic', modeBriefing('basic', { worktreeAllowed: false }))).toMatch(/no Plan, Develop or Train Me procedure applies/);
  });
  it('hook output and settings are the shapes Claude Code reads', () => {
    expect(JSON.parse(modeNoteHookOutput('x'))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'x' } });
    expect(JSON.parse(modeNoteSettings('cat "/tmp/a.json"', ['resume', 'compact']))).toEqual({
      hooks: { SessionStart: [{ matcher: 'resume|compact', hooks: [{ type: 'command', command: 'cat "/tmp/a.json"' }] }] },
    });
  });
});
