// AC16 + AC18 decisions as plain functions: what a chat open does with a live child (adopt,
// supersede, refuse), what the drawer calls a live chat's state, and how the drawer lists each
// conversation once.
import { describe, it, expect } from 'vitest';
import { chatOpenDecision, liveChatState } from '../../src/server/routes/agent-chat.js';
import { drawerRows, liveStateKey, activeStateKey, pastTap } from '../../dashboard/src/components/sleepy/drawerRows.js';
import type { LiveChatWire } from '../../dashboard/src/components/handsfree/macContract.js';

const live = (root: string) => ({ projectRoot: root, id: 'x' });

describe('chatOpenDecision (AC16)', () => {
  it('a phone reattach in the chosen project adopts its live, unflushed chat', () => {
    const l = live('/p/foo');
    expect(chatOpenDecision({ phone: true, live: l, projectRoot: '/p/foo', reattach: true, foreignTranscript: false })).toEqual({ refuse: false, adopt: l, supersede: null });
  });

  it('a phone naming a conversation that runs under another project is refused; nothing is adopted or superseded', () => {
    expect(chatOpenDecision({ phone: true, live: live('/p/other'), projectRoot: '/p/foo', reattach: true, foreignTranscript: false })).toEqual({ refuse: true });
    expect(chatOpenDecision({ phone: true, live: live('/p/other'), projectRoot: '/p/foo', reattach: false, foreignTranscript: false })).toEqual({ refuse: true });
  });

  it('a phone naming a conversation whose transcript belongs to an unchosen project is refused', () => {
    expect(chatOpenDecision({ phone: true, live: null, projectRoot: '/p/foo', reattach: false, foreignTranscript: true })).toEqual({ refuse: true });
  });

  it('a new tab (no live child, no transcript) opens', () => {
    expect(chatOpenDecision({ phone: true, live: null, projectRoot: '/p/foo', reattach: false, foreignTranscript: false })).toEqual({ refuse: false, adopt: null, supersede: null });
  });

  it('behaviour change (laptop): a tab of another project naming a live conversation no longer supersedes it', () => {
    const l = live('/p/other');
    expect(chatOpenDecision({ phone: false, live: l, projectRoot: '/p/foo', reattach: false, foreignTranscript: false })).toEqual({ refuse: false, adopt: null, supersede: null });
    expect(chatOpenDecision({ phone: false, live: l, projectRoot: '/p/other', reattach: false, foreignTranscript: false })).toEqual({ refuse: false, adopt: null, supersede: l });
  });
});

describe('live chat state (AC18)', () => {
  it('a waiting question wins; then a running turn; else idle; a gone entry says nothing', () => {
    expect(liveChatState(true, ['asking'])).toBe('asking');
    expect(liveChatState(false, ['working', 'asking'])).toBe('asking');
    expect(liveChatState(true, [])).toBe('working');
    expect(liveChatState(false, ['starting'])).toBe('working');
    expect(liveChatState(false, ['idle'])).toBe('idle');
    expect(liveChatState(false, ['gone'])).toBe('idle');
  });

  it('the drawer reads Working / Waiting for you / Idle for live rows and for the phone\'s own sessions', () => {
    expect(liveStateKey('working')).toBe('handsfree.mac.state.working');
    expect(liveStateKey('asking')).toBe('handsfree.mac.state.asking');
    expect(liveStateKey('idle')).toBe('handsfree.mac.state.idle');
    expect(activeStateKey({ kind: 'asking' })).toBe('handsfree.mac.state.asking');
    expect(activeStateKey({ kind: 'working' })).toBe('handsfree.mac.state.working');
    expect(activeStateKey({ kind: 'ready' })).toBe('handsfree.mac.state.idle');
    expect(activeStateKey({ kind: 'ended' })).toBeNull();
  });
});

describe('drawer rows (AC18)', () => {
  const chat = (id: string, vault: string | null = 'proj'): LiveChatWire => ({ conversationId: id, vault, title: null, busy: false, state: 'idle' });
  const past = (id: string) => ({ id, title: id });

  it('a conversation running on the Mac is listed only under "Open on Mac", never also under past chats', () => {
    const r = drawerRows({ live: [chat('a')], draining: [], past: [past('a'), past('b')], openClaudeIds: [] });
    expect(r.liveRows.map((c) => c.conversationId)).toEqual(['a']);
    expect(r.pastRows.map((s) => s.id)).toEqual(['b']);
  });

  it('a draining conversation is not a past chat either; the phone\'s own tabs are in neither list', () => {
    const r = drawerRows({ live: [chat('a')], draining: ['d'], past: [past('a'), past('d'), past('mine'), past('old')], openClaudeIds: ['a', 'mine'] });
    expect(r.liveRows).toEqual([]);
    expect(r.pastRows.map((s) => s.id)).toEqual(['old']);
  });

  it('a tap on a stale past row whose id is live adopts it, never resumes it', () => {
    const c = chat('a');
    expect(pastTap('a', [c])).toEqual({ adopt: c });
    expect(pastTap('b', [c])).toEqual({ resume: true });
    expect(pastTap('a', [chat('a', null)])).toEqual({ resume: true });
  });
});
