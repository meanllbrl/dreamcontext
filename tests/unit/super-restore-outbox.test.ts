/**
 * A relaunch brings back only the live super children (ended ones are dropped, card-closed,
 * parked and gone ones come back dormant), and a `super send` the window had queued survives it:
 * kept on disk, sent at the child's first idle, never twice (task uygulama-yeniden-acilinca-…).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-outbox-home-`);
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superRestoreHold } from '../../src/lib/super/restore.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { superRestorePlan } from '../../dashboard/src/components/sleepy/superRestore';
import { OUTBOX_BOOT, _resetSuperOutbox, addToOutbox, dropFromOutbox, arrivedInTranscript, pumpOutbox, readOutbox, type OutboxDeps } from '../../src/lib/super/outbox.js';
import { _resetChatParkForTests, parkChat, parkedSince, registerParkable } from '../../src/server/chat-park.js';

const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: sid, adopted: false, startedAt: 1, ...extra });
const card = (sid: string) => ({ id: `chat-${sid}`, kind: 'chat' as const, ref: sid, shape: 'tall' as const, place: 'float' as const });

describe('superRestoreHold: who a relaunch resumes', () => {
  const s = {
    ...emptySuperState(), session: 'sup',
    children: {
      live: child('live'), ended: child('ended', { endedAt: 5 }), closed: child('closed'),
      parked: child('parked'), gone: child('gone'), own: child('own', { adopted: true }),
    },
    containers: [card('live'), card('ended'), card('parked'), card('gone')],
    queue: [
      { id: 'q1', sessionId: 'gone', kind: 'gone', state: 'done', createdAt: 9 },
      { id: 'q2', sessionId: 'live', kind: 'gone', state: 'done', createdAt: 1 },
      { id: 'q3', sessionId: 'live', kind: 'idle', state: 'done', createdAt: 2 },
    ],
  } as unknown as SuperState;

  it.each([
    ['live', false, null], ['ended', false, 'ended'], ['closed', false, 'closed'],
    ['parked', true, 'parked'], ['gone', false, 'gone'], ['own', false, null],
    ['sup', false, null], ['stranger', false, null],
  ] as const)('%s (parked %s) -> %s', (sid, parked, want) => {
    expect(superRestoreHold(s, sid, parked)).toBe(want);
  });

  it('the window drops ended, keeps the others dormant, resumes the rest', () => {
    expect(superRestorePlan('ended')).toBe('drop');
    for (const h of ['closed', 'parked', 'gone']) expect(superRestorePlan(h)).toBe('dormant');
    expect(superRestorePlan(undefined)).toBe('resume');
    expect(superRestorePlan('nonsense')).toBe('resume');
  });
});

describe('parked tabs survive a restart', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'super-parked-')); });
  afterEach(() => { _resetChatParkForTests(); rmSync(dir, { recursive: true, force: true }); });

  it('a park is written to disk, read back after a restart, and cleared when the tab runs again', async () => {
    const file = join(dir, 'parked-tabs.json');
    _resetChatParkForTests(null, { parkedFile: file });
    const reg = () => registerParkable({
      id: 'c1', kind: 'chat', projectRoot: dir, exempt: () => null, busy: () => false, asking: () => false,
      backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0, park: async () => 'parked',
    });
    const off = reg();
    expect(await parkChat('c1', 'machine')).toBe('parked');
    off();
    _resetChatParkForTests(null, { parkedFile: file }); // the restart
    expect(parkedSince('c1')).not.toBeNull();
    reg();
    expect(parkedSince('c1')).toBeNull();
  });

  it('super end (end: true) is not a park', async () => {
    _resetChatParkForTests(null, { parkedFile: join(dir, 'p.json') });
    registerParkable({
      id: 'c2', kind: 'chat', projectRoot: dir, exempt: () => null, busy: () => false, asking: () => false,
      backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0, park: async () => 'parked',
    });
    await parkChat('c2', 'super-end', { end: true });
    expect(parkedSince('c2')).toBeNull();
  });
});

describe('the super send outbox', () => {
  let root: string;
  let transcript: string;
  beforeEach(() => {
    _resetSuperOutbox();
    root = mkdtempSync(join(tmpdir(), 'outbox-vault-'));
    transcript = join(root, 't.jsonl');
    writeFileSync(transcript, '');
  });
  afterEach(() => { _resetSuperOutbox(); rmSync(root, { recursive: true, force: true }); });

  const deps = (o: Partial<OutboxDeps> & { idle?: Set<string> } = {}) => {
    const sent: Array<[string, string]> = [];
    const d: OutboxDeps = {
      // The run after a relaunch: what the earlier run queued is the outbox's to send.
      boot: 'later-run',
      isIdle: (sid) => o.idle?.has(sid) ?? true,
      isChild: () => true,
      superToken: () => 'tok',
      transcript: () => transcript,
      send: async (_t, child, text) => { sent.push([child, text]); return 'sent'; },
      ...o,
    };
    return { d, sent };
  };

  it('keeps a queued message on disk and sends it at the child\'s first idle, once', async () => {
    await addToOutbox(root, 'c1', 'stop: a successor has this');
    expect(await readOutbox(root)).toHaveLength(1);
    const busy = deps({ idle: new Set() });
    expect((await pumpOutbox(root, undefined, busy.d)).delivered).toEqual([]);
    expect(busy.sent).toEqual([]);
    const idle = deps();
    expect((await pumpOutbox(root, undefined, idle.d)).delivered).toHaveLength(1);
    expect(idle.sent).toEqual([['c1', 'stop: a successor has this']]);
    expect(await readOutbox(root)).toEqual([]);
    await pumpOutbox(root, undefined, idle.d);
    expect(idle.sent).toHaveLength(1);
  });

  it('while the run that queued it lives, the window owns it: never sent from here (no double delivery)', async () => {
    const item = await addToOutbox(root, 'c1', 'merge it');
    expect(item.boot).toBe(OUTBOX_BOOT);
    const { d, sent } = deps({ boot: OUTBOX_BOOT });
    await pumpOutbox(root, undefined, d);
    expect(sent).toEqual([]);
    expect(await readOutbox(root)).toHaveLength(1);
  });

  it('queued again after a relaunch: this run\'s window owns it, it is not sent a second time', async () => {
    await addToOutbox(root, 'c1', 'merge it');
    const { d, sent } = deps({ send: async (_t, child, text) => { sent.push([child, text]); return 'queued'; } });
    await pumpOutbox(root, undefined, d);
    await pumpOutbox(root, undefined, d);
    expect(sent).toHaveLength(1);
    expect((await readOutbox(root))[0].boot).toBe('later-run');
  });

  it('a row the owner took back (deleted, edited, Stop) never comes back after a relaunch', async () => {
    await addToOutbox(root, 'c1', 'merge it');
    await addToOutbox(root, 'c1', 'then push');
    await addToOutbox(root, 'c2', 'other child');
    expect(await dropFromOutbox(root, 'c1', ['merge it '])).toBe(1);
    expect((await readOutbox(root)).map((i) => i.text)).toEqual(['then push', 'other child']);
    // Stop holds the whole queue of that child.
    expect(await dropFromOutbox(root, 'c1')).toBe(1);
    const { d, sent } = deps();
    await pumpOutbox(root, undefined, d);
    expect(sent).toEqual([['c2', 'other child']]);
  });

  it('two equal rows, one deleted: one stays', async () => {
    await addToOutbox(root, 'c1', 'yes');
    await addToOutbox(root, 'c1', 'yes');
    expect(await dropFromOutbox(root, 'c1', ['yes'])).toBe(1);
    expect(await readOutbox(root)).toHaveLength(1);
  });

  it('Stop after a relaunch never drops what an earlier run left (the owner never saw it)', async () => {
    await addToOutbox(root, 'c1', 'from before the relaunch');
    expect(await dropFromOutbox(root, 'c1', undefined, 'later-run')).toBe(0);
    expect(await dropFromOutbox(root, 'c1', ['from before the relaunch'], 'later-run')).toBe(0);
    expect(await readOutbox(root)).toHaveLength(1);
  });

  it('the window reports taken-back rows and the server drops them (checked against the source)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const session = fs.readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/chatSession.ts'), 'utf-8');
    for (const fn of ['function pauseQueue', 'function editQueued', 'function removeQueued']) {
      const body = session.slice(session.indexOf(fn), session.indexOf('\n  }\n', session.indexOf(fn)));
      expect(body, fn).toContain('noteQueueDropped(');
    }
    const chat = fs.readFileSync(join(__dirname, '../../src/server/routes/agent-chat.ts'), 'utf-8');
    expect(chat).toContain("if (msg.type === 'queue_dropped')");
    expect(chat).toMatch(/if \(root && texts\.length\) void dropFromOutbox\(root, pinId, texts\)/);
    expect(chat).toMatch(/if \(stopRoot\) void dropFromOutbox\(stopRoot, pinId\)/);
  });

  it('a short message does not read as arrived inside a longer owner line', async () => {
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date(2000).toISOString(), message: { content: 'devam etme, bekle' } })}\n`);
    expect(await arrivedInTranscript(transcript, 'devam', 1000)).toBe(false);
  });

  it('a message the transcript already shows (the window delivered it) is dropped, not resent', async () => {
    const item = await addToOutbox(root, 'c1', 'check the logs', 1000);
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date(item.at + 5).toISOString(), message: { content: 'check the logs' } })}\n`);
    const { d, sent } = deps();
    expect((await pumpOutbox(root, undefined, d)).dropped).toEqual([item.id]);
    expect(sent).toEqual([]);
  });

  it('one message per child per pump, in order; no super window yet = nothing sent, nothing lost', async () => {
    await addToOutbox(root, 'c1', 'first', 1);
    await addToOutbox(root, 'c1', 'second', 2);
    const none = deps({ superToken: () => null });
    await pumpOutbox(root, undefined, none.d);
    expect(none.sent).toEqual([]);
    expect(await readOutbox(root)).toHaveLength(2);
    const { d, sent } = deps();
    await pumpOutbox(root, undefined, d);
    expect(sent).toEqual([['c1', 'first']]);
    expect((await readOutbox(root)).map((i) => i.text)).toEqual(['second']);
  });

  it('a message for a child that was ended or replaced is dropped, never delivered', async () => {
    const item = await addToOutbox(root, 'gone-child', 'carry on');
    const { d, sent } = deps({ isChild: (_r, sid) => sid !== 'gone-child' });
    expect((await pumpOutbox(root, undefined, d)).dropped).toEqual([item.id]);
    expect(sent).toEqual([]);
    expect(await readOutbox(root)).toEqual([]);
  });

  it('arrivedInTranscript ignores what was written before the message was queued', async () => {
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date(10).toISOString(), message: { content: 'hello' } })}\n`);
    expect(await arrivedInTranscript(transcript, 'hello', 1000)).toBe(false);
    expect(await arrivedInTranscript(transcript, 'hello', 5)).toBe(true);
    expect(await arrivedInTranscript(null, 'hello', 5)).toBe(false);
  });
});

describe('Resume on a dormant super child (AgentSurface.tsx, checked against the source)', () => {
  // AgentSurface is a React module root vitest cannot load; the rule is held by the source.
  const src = require('node:fs').readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8') as string;
  it('a dormant chat with a saved mode comes back as that chat, its agent bound, under its own bypass', () => {
    expect(src).toContain("const asChat = parked ? parked.transport === 'chat' : meta.kind === 'chat' && !!meta.mode;");
    expect(src).toMatch(/if \(asChat\) bindChatAgent\(meta\.claudeId, meta\.agent \?\? ''\);/);
    expect(src).toMatch(/: asChat\s*\n\s*\? spawn\(meta\.bypass, meta\.claudeId, true, 'chat', '', parked\?\.model \?\? '', true, '', false, parked\?\.effort \?\? '', true, meta\.mode \?\? DEFAULT_CHAT_MODE/);
  });
});
