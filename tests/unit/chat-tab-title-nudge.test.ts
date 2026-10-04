import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  chatTabTitleNudge, chatTabTitleStopBlock, tabWantsAgentTitle, transcriptHasAgentTitle,
  CHAT_TAB_TITLE_NUDGE, CHAT_TAB_TITLE_STOP_REASON,
} from '../../src/lib/chat-tab-title-nudge.js';

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

const TAB = '11111111-2222-4333-8444-555555555555';
const tabChat = { DREAMCONTEXT_CHAT_TAB: '1', DREAMCONTEXT_TAB_SESSION: TAB } as NodeJS.ProcessEnv;

/** A scratch context root + home: the roster entry for TAB and, optionally, agent-ui.json. */
function world(entry: Record<string, unknown> | null, ui?: Record<string, unknown>): { root: string; home: string } {
  const d = mkdtempSync(join(tmpdir(), 'dc-title-world-'));
  dirs.push(d);
  const root = join(d, '_dream_context');
  const home = join(d, 'home');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  if (entry) writeFileSync(join(root, 'state', '.agent-sessions.json'), JSON.stringify({ sessions: [{ sessionId: TAB, kind: 'chat', ...entry }] }));
  if (ui) writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), JSON.stringify(ui));
  return { root, home };
}

describe('tabWantsAgentTitle', () => {
  it('wants one for a default-named tab, or one the roster has not saved yet', () => {
    const a = world({ title: 'Chat 7' });
    expect(tabWantsAgentTitle(tabChat, a.root, a.home)).toBe(true);
    const b = world(null);
    expect(tabWantsAgentTitle(tabChat, b.root, b.home)).toBe(true);
  });

  it('not when the user or a purpose named the tab, or the agent already did', () => {
    const user = world({ title: 'Invoice bug' });
    expect(tabWantsAgentTitle(tabChat, user.root, user.home)).toBe(false);
    const agent = world({ title: 'Invoice export', titleByAgent: true });
    expect(tabWantsAgentTitle(tabChat, agent.root, agent.home)).toBe(false);
  });

  it('honours the auto-name switch only past the default-on flip', () => {
    const off = world({ title: 'Chat 2' }, { titleMigrated: true, autoTitle: false });
    expect(tabWantsAgentTitle(tabChat, off.root, off.home)).toBe(false);
    const legacy = world({ title: 'Chat 2' }, { autoTitle: false });
    expect(tabWantsAgentTitle(tabChat, legacy.root, legacy.home)).toBe(true);
  });

  it('silences the prompt nudge the same way', () => {
    const user = world({ title: 'Invoice bug' });
    expect(chatTabTitleNudge(tabChat, undefined, user.root, user.home)).toBeNull();
  });
});

describe('chatTabTitleStopBlock', () => {
  const fresh = () => world({ title: 'Chat 3' });

  it('holds an unnamed chat turn open with the naming reason', () => {
    const w = fresh();
    const p = transcript([{ type: 'user', message: { role: 'user', content: 'fix the export' } }, assistant('Fixed it.')]);
    expect(chatTabTitleStopBlock(tabChat, { transcript_path: p, last_assistant_message: 'Fixed it.' }, w.root, w.home))
      .toEqual({ decision: 'block', reason: CHAT_TAB_TITLE_STOP_REASON });
  });

  it('asks at most once per turn: never when Claude Code says the stop was already blocked', () => {
    const w = fresh();
    expect(chatTabTitleStopBlock(tabChat, { stop_hook_active: true }, w.root, w.home)).toBeNull();
  });

  it('lets the turn end once the title is written, in this message or earlier', () => {
    const w = fresh();
    expect(chatTabTitleStopBlock(tabChat, { last_assistant_message: TITLE }, w.root, w.home)).toBeNull();
    const p = transcript([assistant(`Done.\n\n${TITLE}`), assistant('Anything else?')]);
    expect(chatTabTitleStopBlock(tabChat, { transcript_path: p, last_assistant_message: 'Anything else?' }, w.root, w.home)).toBeNull();
  });

  it('never outside a Chat tab, or for a tab that keeps its own name', () => {
    const w = fresh();
    expect(chatTabTitleStopBlock({}, {}, w.root, w.home)).toBeNull();
    const named = world({ title: 'Release notes' });
    expect(chatTabTitleStopBlock(tabChat, {}, named.root, named.home)).toBeNull();
  });
});
