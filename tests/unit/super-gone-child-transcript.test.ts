/**
 * A finished child's card shows its conversation (owner, 2026-10-25: "biten sessionlara ben
 * tıkladığımda beyaz alan olarak açılıyor erişemiyorum").
 *
 * What happened: a child that did its job and exited (`gone`) comes back after a relaunch as a
 * DORMANT tab, no process. Its card, shown side by side, drew the empty `shown` slot, and
 * AgentSurface homes only a LIVE session into it (`superShownSid` skips dormant entries), so the
 * pane stayed blank: the head said "Read only." and nothing was under it.
 *
 * Pinned: with no live session the card reads the child's transcript into the same ChatPane
 * (a transcript-only ChatSession: no socket, no `claude`, every verb a no-op), its turns in
 * `items` (no "resumed" divider), read only with the finished line; with a live session the card
 * keeps the slot AgentSurface fills.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTranscriptSession } from '../../dashboard/src/components/sleepy/transcriptSession';
import type { HistoryEntry } from '../../dashboard/src/components/sleepy/chatSession';

const fakeContainer = () => ({ className: 'agent-pane-chat', parentElement: null }) as unknown as HTMLDivElement;
const CHILD = '4bbd2150-622a-40f1-b185-a0bb1512a771';
const TRANSCRIPT: HistoryEntry[] = [
  { kind: 'user', text: 'Write the export plan', uuid: 'u-1', at: 1000 },
  { kind: 'tool', toolUseId: 'toolu_1', name: 'Bash', input: { command: 'ls src/export' }, status: 'done', result: 'csv.ts', at: 1100, endAt: 1200 },
  { kind: 'text', text: 'PLAN-DONE: the export plan is written', at: 1300 },
];

describe('a transcript-only session: a finished child read from disk', () => {
  it('starts empty and shows the transcript once loaded, as items (no resumed divider)', () => {
    const s = createTranscriptSession(CHILD, fakeContainer);
    expect(s.getModel().items).toEqual([]);
    let fired = 0;
    const off = s.subscribe(() => { fired++; });
    s.load(TRANSCRIPT);
    const m = s.getModel();
    expect(fired).toBe(1);
    expect(m.history).toEqual([]);
    expect(m.items.map((it) => it.kind)).toEqual(['user', 'tool', 'text']);
    expect(m.items[0]).toMatchObject({ kind: 'user', text: 'Write the export plan', uuid: 'u-1' });
    expect(m.items[1]).toMatchObject({ kind: 'tool', name: 'Bash', status: 'done', toolUseId: 'toolu_1' });
    expect(m.items[2]).toMatchObject({ kind: 'text', text: 'PLAN-DONE: the export plan is written', done: true });
    off();
    s.load(TRANSCRIPT);
    expect(fired).toBe(1);
  });

  it('a reload replaces what it shows, never appends twice', () => {
    const s = createTranscriptSession(CHILD, fakeContainer);
    s.load(TRANSCRIPT);
    s.load(TRANSCRIPT);
    expect(s.getModel().items).toHaveLength(3);
  });

  it('reads as an idle, open conversation with nothing to resume and acts on nothing', async () => {
    const s = createTranscriptSession(CHILD, fakeContainer);
    s.load(TRANSCRIPT);
    // 'open', never 'closed': closed would draw "Session ended · Resume" over a read-only card.
    expect(s).toMatchObject({ kind: 'chat', claudeId: CHILD, status: 'open', busy: false, asking: false, takenOver: false });
    expect(s.hasLiveWork()).toBe(false);
    expect(s.canSteer()).toBe(false);
    expect(s.steer('x')).toBe(false);
    expect(s.answer('r', { behavior: 'allow' })).toBe(false);
    s.send('hello');
    s.enqueue('later');
    s.interrupt();
    await s.rewind('tr-1');
    expect(s.getModel().items).toHaveLength(3);
    expect(s.getModel().queued).toEqual([]);
  });

  it('two finished children are two sessions', () => {
    const a = createTranscriptSession(CHILD, fakeContainer);
    const b = createTranscriptSession('7a1c0de5-0000-4000-8000-00000000a11d', fakeContainer);
    expect(a.id).not.toBe(b.id);
  });
});

describe('the shown card: the slot for a live child, the transcript for a finished one', () => {
  const src = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperContainer.tsx', import.meta.url), 'utf-8');
  const pane = readFileSync(new URL('../../dashboard/src/components/sleepy/super/ChildTranscript.tsx', import.meta.url), 'utf-8');

  it('draws the homed slot only when the child has a live session, else its transcript', () => {
    expect(src).toMatch(/p\.session \|\| !p\.childTranscript \? <div className="super-slot" data-super-slot="shown" \/> : p\.childTranscript\(c\.ref\)/);
    // The stage never imports the chat pane (it would pull the terminal into every stage import).
    expect(src).not.toMatch(/from '\.\/ChildTranscript'/);
    const surface = readFileSync(new URL('../../dashboard/src/components/sleepy/AgentSurface.tsx', import.meta.url), 'utf-8');
    expect(surface).toMatch(/childTranscript=\{renderChildTranscript\}/);
  });

  it('reads the transcript from chat-history into the existing ChatPane, read only as finished', () => {
    expect(pane).toMatch(/\/agent\/chat-history\?claudeId=/);
    expect(pane).toMatch(/<ChatPaneHost[\s\S]*readOnly="finished"/);
    expect(pane).not.toMatch(/createChatSession/);
  });
});
