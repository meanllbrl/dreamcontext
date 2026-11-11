/**
 * A page writes to its own project's Super (the board writing field, 2026-11-11): one hop on the
 * project's bus. Pinned here: the ACK is the write's own result (a socket that reads open but is
 * closing refuses, nothing goes twice), nobody answering reads as off, the presence store, and
 * the "working" rule tied to the message (its turn or its children), never to an unrelated turn.
 * Fictional names throughout.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUPER_PAGE_SEND_EVENT, WORK_GRACE_MS, WORK_MAX_MS, answerPageSend, publishFieldMounted, publishSuperPresence,
  readFieldMounted, readSuperPresence, sendFromPage, startTrack, workGoing, type SuperPageSendDetail, type SuperPresence,
} from '../../dashboard/src/lib/superPageBridge.js';
import { sendToSuper } from '../../dashboard/src/components/sleepy/super/superQuestions.js';
import { msgRef as clientRef } from '../../dashboard/src/lib/superTypes.js';
import { msgRef as serverRef } from '../../src/lib/super/types.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

/** A chat session whose writes say whether the frame went out. */
function session(opts: { status: 'connecting' | 'open' | 'closed'; busy?: boolean; steerOk?: boolean; sendOk?: boolean }) {
  const writes: string[] = [];
  return {
    writes,
    status: opts.status,
    busy: !!opts.busy,
    steer: (text: string) => { if (opts.steerOk) writes.push(`steer:${text}`); return !!opts.steerOk; },
    send: (text: string) => { if (opts.sendOk) writes.push(`send:${text}`); return !!opts.sendOk; },
  };
}

function answering(bus: EventTarget, on: boolean, s: ReturnType<typeof session> | undefined) {
  bus.addEventListener(SUPER_PAGE_SEND_EVENT, (e) => {
    answerPageSend((e as CustomEvent<SuperPageSendDetail>).detail, { on, session: s, write: (text) => sendToSuper(s, text) });
  });
}

describe('the send and its ACK', () => {
  it('is accepted only when the write went out, once', () => {
    const bus = new EventTarget();
    const s = session({ status: 'open', sendOk: true });
    answering(bus, true, s);
    expect(sendFromPage(bus, 'Make it blue')).toEqual({ accepted: true });
    expect(s.writes).toEqual(['send:Make it blue']);
  });

  it('a busy Super is steered; a refused steer falls back to one send', () => {
    const steered = session({ status: 'open', busy: true, steerOk: true, sendOk: true });
    expect(sendToSuper(steered, 'x')).toBe(true);
    expect(steered.writes).toEqual(['steer:x']);
    const fallback = session({ status: 'open', busy: true, steerOk: false, sendOk: true });
    expect(sendToSuper(fallback, 'y')).toBe(true);
    expect(fallback.writes).toEqual(['send:y']);
  });

  it('status open but the socket closing: refused as closed, nothing written, the caller keeps the words', () => {
    const bus = new EventTarget();
    const s = session({ status: 'open', busy: false, sendOk: false });
    answering(bus, true, s);
    expect(sendFromPage(bus, 'Make it blue')).toEqual({ accepted: false, reason: 'closed' });
    expect(s.writes).toEqual([]);
    const busy = session({ status: 'open', busy: true, steerOk: false, sendOk: false });
    expect(sendToSuper(busy, 'z')).toBe(false);
  });

  it('off, connecting, closed, and nobody answering', () => {
    const off = new EventTarget();
    answering(off, false, session({ status: 'open', sendOk: true }));
    expect(sendFromPage(off, 'a')).toEqual({ accepted: false, reason: 'off' });
    const conn = new EventTarget();
    answering(conn, true, session({ status: 'connecting', sendOk: true }));
    expect(sendFromPage(conn, 'a')).toEqual({ accepted: false, reason: 'connecting' });
    const none = new EventTarget();
    answering(none, true, undefined);
    expect(sendFromPage(none, 'a')).toEqual({ accepted: false, reason: 'connecting' });
    const closed = new EventTarget();
    answering(closed, true, session({ status: 'closed', sendOk: true }));
    expect(sendFromPage(closed, 'a')).toEqual({ accepted: false, reason: 'closed' });
    expect(sendFromPage(new EventTarget(), 'a')).toEqual({ accepted: false, reason: 'off' });
  });

  it('a second answerer never writes the same words again', () => {
    const bus = new EventTarget();
    const s = session({ status: 'open', sendOk: true });
    answering(bus, true, s);
    answering(bus, true, s);
    expect(sendFromPage(bus, 'once')).toEqual({ accepted: true });
    expect(s.writes).toEqual(['send:once']);
  });

  it('AgentSurface answers on its bus with sendToSuper, and ChatSession.send says whether it wrote', () => {
    const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    expect(src).toMatch(/useInstanceEvent<SuperPageSendDetail>\(SUPER_PAGE_SEND_EVENT, \(detail\) => \{\s*answerPageSend\(detail, \{ on: dockOn, session: superChatSession, write: \(text\) => sendToSuper\(superChatSession, text\) \}\);/);
    expect(read('dashboard/src/components/sleepy/chatSession.ts')).toMatch(/send: \(text: string\) => boolean;/);
  });

  it('the field\'s ref is the server\'s turn ref for the exact text sent', () => {
    const text = '3 sunuma düşür\n\n[On page whiteboards board=launch-plan sel=9 box=120,-40,860,410 ids=rect-a,txt_b]';
    expect(clientRef(text)).toBe(serverRef(text));
    expect(read('src/server/routes/agent-chat.ts')).toMatch(/noteSuperOwnerMsg\(chatRegistryId, text\.startsWith\('\/'\) \? null : tgRef \?\? msgRef\(text\)\)/);
  });
});

describe('presence', () => {
  it('stamps busySince on the idle→busy edge and keeps it for the same turn', () => {
    const bus = new EventTarget();
    const base = { on: true, connected: true, mark: null, children: [] };
    publishSuperPresence(bus, { ...base, busy: false }, 100);
    expect(readSuperPresence(bus)?.busySince).toBeNull();
    publishSuperPresence(bus, { ...base, busy: true }, 200);
    publishSuperPresence(bus, { ...base, busy: true }, 300);
    expect(readSuperPresence(bus)?.busySince).toBe(200);
    publishSuperPresence(bus, { ...base, busy: false }, 400);
    publishSuperPresence(bus, { ...base, busy: true }, 500);
    expect(readSuperPresence(bus)?.busySince).toBe(500);
    publishSuperPresence(bus, null);
    expect(readSuperPresence(bus)).toBeNull();
  });

  it('the field is mounted per bus', () => {
    const a = new EventTarget();
    const b = new EventTarget();
    publishFieldMounted(a, true);
    expect(readFieldMounted(a)).toBe(true);
    expect(readFieldMounted(b)).toBe(false);
    publishFieldMounted(a, false);
    expect(readFieldMounted(a)).toBe(false);
  });
});

describe('working: tied to the message, not to the Super\'s turn', () => {
  const sentAt = 1_000_000;
  const track = { ref: 'k3f9q0', sentAt };
  const p = (over: Partial<SuperPresence>): SuperPresence => ({ on: true, connected: true, busy: false, busySince: null, mark: null, children: [], ...over });

  it('holds through the grace after the ACK, then needs its turn or its children', () => {
    expect(workGoing(track, null, sentAt + 10)).toBe(true);
    expect(workGoing(track, p({}), sentAt + WORK_GRACE_MS - 1)).toBe(true);
    expect(workGoing(track, p({}), sentAt + WORK_GRACE_MS)).toBe(false);
  });

  it('the turn that took it (first seen running at or after the send) keeps it', () => {
    expect(workGoing(track, p({ busy: true, busySince: sentAt + 5 }), sentAt + 60_000)).toBe(true);
  });

  it('a busy turn that began before the send (an unrelated event turn) does not arm it alone', () => {
    expect(workGoing(track, p({ busy: true, busySince: sentAt - 5 }), sentAt + 60_000)).toBe(false);
  });

  it('written while the Super was busy: the turn it was steered into keeps it until that turn ends', () => {
    const busyAtSend = p({ busy: true, busySince: sentAt - 40_000 });
    const steered = startTrack('k3f9q0', busyAtSend, sentAt);
    expect(steered.turnSince).toBe(sentAt - 40_000);
    expect(workGoing(steered, busyAtSend, sentAt + 60_000)).toBe(true);
    // That turn ends: only its children (or a newer turn) keep it.
    expect(workGoing(steered, p({}), sentAt + 60_000)).toBe(false);
    // A later, different turn that began before the send is still not this message's.
    expect(workGoing(steered, p({ busy: true, busySince: sentAt - 5 }), sentAt + 60_000)).toBe(false);
    // Written while idle: no steered turn.
    expect(startTrack('k3f9q0', p({}), sentAt).turnSince).toBeNull();
    expect(startTrack('k3f9q0', null, sentAt).turnSince).toBeNull();
  });

  it('a live child whose origin is this message keeps it; another message\'s child, or a finished one, does not', () => {
    const now = sentAt + 120_000;
    expect(workGoing(track, p({ children: [{ origin: 'k3f9q0', live: true }] }), now)).toBe(true);
    expect(workGoing(track, p({ children: [{ origin: 'zzzzzz', live: true }] }), now)).toBe(false);
    expect(workGoing(track, p({ children: [{ origin: 'k3f9q0', live: false }] }), now)).toBe(false);
    expect(workGoing(track, p({ children: [{ live: true }] }), now)).toBe(false);
  });

  it('never past 15 minutes, never without a track', () => {
    expect(WORK_MAX_MS).toBe(15 * 60_000);
    expect(workGoing(track, p({ children: [{ origin: 'k3f9q0', live: true }] }), sentAt + WORK_MAX_MS)).toBe(false);
    expect(workGoing(null, p({ busy: true, busySince: sentAt }), sentAt + 1)).toBe(false);
  });
});
