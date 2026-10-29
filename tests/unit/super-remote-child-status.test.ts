/**
 * A remote stage's child cards (owner 2026-10-29, hands-free on another computer): the remote has
 * no live session for a Super child, so every card read "saved" and was named "Child chat 53"
 * while the Mac showed the job working under its name. The status now comes from the child's row
 * (the server reconciles it from the Mac's registry and pushes it in every `super_stage` frame),
 * and the card's name from the remote view, the digest's name on the same socket.
 */
import { describe, it, expect } from 'vitest';
import { chatStatus, remoteChildStatus } from '../../dashboard/src/components/sleepy/super/SuperContainer.js';
import { remoteStageState } from '../../dashboard/src/components/sleepy/super/remoteStage.js';
import { superRemoteView } from '../../src/lib/super/remote-view.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import type { ChatSession } from '../../dashboard/src/components/sleepy/chatSession.js';

describe('remoteChildStatus', () => {
  it('reads the row: working, asking (and waiting on the owner), done (and stuck), ended; no row or gone is saved', () => {
    expect(remoteChildStatus({ row: 'working' }).kind).toBe('working');
    expect(remoteChildStatus({ row: 'asking' }).kind).toBe('asking');
    expect(remoteChildStatus({ row: 'waiting' }).kind).toBe('asking');
    expect(remoteChildStatus({ row: 'done' }).kind).toBe('ready');
    expect(remoteChildStatus({ row: 'stuck' }).kind).toBe('ready');
    expect(remoteChildStatus({ row: 'gone' }).kind).toBe('saved');
    expect(remoteChildStatus({}).kind).toBe('saved');
    // `super end` wins over any row.
    expect(remoteChildStatus({ row: 'working', endedAt: 5 }).kind).toBe('ended');
  });

  it('chatStatus: a live session always wins; with none, the remote row speaks; on the Mac (no row) it stays saved', () => {
    const session = { status: 'open', busy: false, asking: false, agentsWorking: false, getModel: () => null } as unknown as ChatSession;
    expect(chatStatus(session, { row: 'working' }).kind).toBe('ready');
    expect(chatStatus(undefined, { row: 'working' }).kind).toBe('working');
    expect(chatStatus(undefined, null).kind).toBe('saved');
    expect(chatStatus(undefined).kind).toBe('saved');
  });
});

describe('the remote stage carries what a child card draws', () => {
  it('three children in three states arrive with their row and their name, not "saved" and "Child chat N"', () => {
    const kids = { a: 'working', b: 'asking', c: 'done' } as const;
    const rec: SuperState = {
      ...emptySuperState(),
      session: 'sess-1', enabled: true,
      containers: Object.keys(kids).map((sid) => ({ id: `chat-${sid}`, kind: 'chat', ref: sid, shape: 'tall', place: 'float' })) as SuperState['containers'],
      children: Object.fromEntries(Object.entries(kids).map(([sid, row], i) => [sid, {
        sessionId: sid, brief: `Job ${sid.toUpperCase()}: fix the thing`, adopted: false, startedAt: i + 1, row,
      }])) as SuperState['children'],
    };
    const st = remoteStageState(JSON.parse(JSON.stringify(superRemoteView(rec, 'acme', null))));
    expect(st).not.toBeNull();
    for (const [sid, row] of Object.entries(kids)) {
      const card = st!.containers.find((c) => c.ref === sid);
      expect(card?.title).toBe(`Job ${sid.toUpperCase()}: fix the thing`);
      expect(st!.children[sid].row).toBe(row);
      expect(st!.children[sid].brief).toBe('');
    }
    expect(chatStatus(undefined, st!.children.a).kind).toBe('working');
    expect(chatStatus(undefined, st!.children.b).kind).toBe('asking');
    expect(chatStatus(undefined, st!.children.c).kind).toBe('ready');
  });
});
