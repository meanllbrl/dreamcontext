/**
 * The Super Agent's question reads as a question, like any chat's AskUserQuestion (owner,
 * 2026-10-22, Tilki: two `super ask`s at 12:04 and 12:21 — "benim haberim yok ve loading duruyor.
 * Zıplamıyor da, 'soru sordu' durumuna da gelmiyor").
 *
 * What the record showed: the server posted both banners (notifications.jsonl, "Super Agent asks ·
 * Tilki"), and both replies said reached:true. What the window drew: the project chip's colour
 * turned, but its `asking` count stayed 0 — so no magenta bubble and no repeating nudge, only the
 * green ring of the working children — and the Super stage's centre read its chat alone, idle or
 * "agents working" (a spinner), never asking. The folded dock had no chip for it at all.
 *
 * Pinned: the queue head counts as one asking chat (the asking child's row when it is a child's,
 * else the Super Agent's own conversation), the chip's three counts still partition `live`, and
 * it clears with the head; the centre asks while a question it put to the owner waits; the
 * folded dock draws the Super Agent's question as a chip with no close button.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveSessionStatus, rollupProject, type SessionRow } from '../../dashboard/src/components/sleepy/agentStatus';
import { superCentreStatus } from '../../dashboard/src/components/sleepy/super/SuperContainer';
import type { ChatSession } from '../../dashboard/src/components/sleepy/chatSession';

const row = (id: string, o: { asking?: boolean; busy?: boolean; superChild?: boolean; claudeId?: string } = {}): SessionRow => ({
  id, title: id, kind: 'chat', claudeId: o.claudeId ?? id, attention: false, ...(o.superChild ? { superChild: true } : {}),
  info: deriveSessionStatus({ status: 'open', asking: o.asking, busy: o.busy }),
});
const partitions = (r: ReturnType<typeof rollupProject>) => r.asking + r.working + r.idle === r.live;

describe('the project chip: the Super Agent\'s question is an asking chat', () => {
  const children = [row('a', { busy: true, superChild: true }), row('b', { busy: true, superChild: true })];

  it('its own ask (no row of its own): one more live chat, asking — the bubble and the nudge', () => {
    const r = rollupProject(children, { superQueueHead: { asker: 'super-1' } });
    expect(r).toMatchObject({ worst: 'asking', asking: 1, working: 2, live: 3, waiting: 1 });
    expect(partitions(r)).toBe(true);
  });

  it('answered (no head): back to the working children, nothing asks', () => {
    const r = rollupProject(children, { superQueueHead: false });
    expect(r).toMatchObject({ worst: 'working', asking: 0, working: 2, live: 2, waiting: 0 });
  });

  it('a child\'s permission or escalated question at the head: THAT child\'s row asks, counted once', () => {
    const rows = [row('a', { asking: true, superChild: true }), row('b', { busy: true, superChild: true })];
    const r = rollupProject(rows, { superQueueHead: { asker: 'a' } });
    expect(r).toMatchObject({ worst: 'asking', asking: 1, working: 1, live: 2, waiting: 1 });
    expect(partitions(r)).toBe(true);
    // Another child asking off the head stays quiet (D16).
    const quiet = rollupProject([row('a', { asking: true, superChild: true }), row('b', { asking: true, superChild: true })], { superQueueHead: { asker: 'a' } });
    expect(quiet).toMatchObject({ asking: 1, working: 1, waiting: 1 });
  });

  it('the old boolean form still reads as one asking chat', () => {
    expect(rollupProject(children, { superQueueHead: true })).toMatchObject({ asking: 1, live: 3, waiting: 1, worst: 'asking' });
  });
});

describe('the Super stage\'s centre asks while its question waits', () => {
  const session = (o: Partial<Pick<ChatSession, 'status' | 'busy' | 'asking' | 'agentsWorking'>>) => ({ status: 'open', busy: false, asking: false, agentsWorking: false, ...o }) as unknown as ChatSession;

  it('idle, busy or with agents working: asking wins', () => {
    expect(superCentreStatus(session({}), true).kind).toBe('asking');
    expect(superCentreStatus(session({ busy: true }), true).kind).toBe('asking');
    expect(superCentreStatus(session({ agentsWorking: true }), true).kind).toBe('asking');
    expect(superCentreStatus(session({ agentsWorking: true }), true).mood).toBe('asking');
  });

  it('nothing waiting: its own status, as before', () => {
    expect(superCentreStatus(session({ agentsWorking: true }), false).kind).toBe('working');
    expect(superCentreStatus(session({}), false).kind).toBe('ready');
    expect(superCentreStatus(session({ status: 'closed' }), true).kind).toBe('ended');
  });
});

describe('the wiring', () => {
  const read = (p: string) => readFileSync(new URL(`../../dashboard/src/components/sleepy/${p}`, import.meta.url), 'utf-8');

  it('the centre counts every question the Super Agent put to the owner, never a child\'s permission', () => {
    const src = read('super/SuperSurface.tsx');
    expect(src).toMatch(/const ownerAsk = state\.queue\.some\(\(q\) => needsOwner\(q\) && q\.kind !== 'permission'\);\s*const status = superCentreStatus\(superSession, ownerAsk\);/);
  });

  it('the folded dock draws the Super Agent\'s question as its own chip, opening the stage, never closable', () => {
    const src = read('AgentSurface.tsx');
    expect(src).toMatch(/const superAskRow: SessionRow \| null = superHead && !dockRows\.some\(\(r\) => r\.claudeId === superHead\.sessionId\)/);
    expect(src).toMatch(/rows=\{dockShown\}/);
    expect(src).toMatch(/if \(id === SUPER_ASK_ROW\) \{ setSuperView\('super'\); setExpanded\(true\); return; \}/);
    expect(src).toMatch(/onClose=\{\(id\) => \{ if \(id !== SUPER_ASK_ROW\) closeSessionById\(id\); \}\}/);
    expect(read('AgentDock.tsx')).toMatch(/\{!row\.pinned && <button/);
  });
});
