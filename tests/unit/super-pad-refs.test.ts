/**
 * An agenda line carries the arrivals of the owner messages that moved its work (task
 * ajanda-gunluk, plan ajanda-filtre C1, criterion 10). The dashboard filters the Super chat to
 * them, so:
 *  - `note add` (a new line, and the same line again), `delegate --note` and `send` in his turn
 *    (or with `--origin`) append `{ ref, at }`, `at` = when his message ARRIVED;
 *  - never the schedule banner's line, his own `pad/add`, or an event turn without `--origin`;
 *  - two turns with the same words are two pairs; a retry of the same pair is one;
 *  - malformed pairs drop on load; a Done day file and the phone digest (newest 20) keep valid
 *    ones; the digest carries the owed `child` and the waiting rows' thread-key fields.
 * Fictional words throughout; HOME is a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-pad-refs-home-`);
});

/** The window opening a delegated child: answered here, with a fixed session id. */
vi.mock('../../src/lib/window-control.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/window-control.js')>();
  return {
    ...real,
    sendSuperCommand: async (...a: Parameters<typeof real.sendSuperCommand>) => (a[1] === 'delegate'
      ? { ok: true, result: { sessionId: 'child-orbit' } }
      : real.sendSuperCommand(...a)),
  };
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizePad } from '../../src/lib/super/store.js';
import { MAX_DIGEST_PAD_REFS, emptySuperState, msgRef, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, markSuperEventTurn, noteSuperOwnerMsg, superOwnerMsgAt } from '../../src/lib/super/inbox.js';
import { addPadNote, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { cleanPadRefs, linkLineRef } from '../../src/lib/super/pad.js';
import { superDigest } from '../../src/lib/super/phone-mirror.js';
import { agendaDoneOn, archiveDoneLines } from '../../src/lib/super/pad-archive.js';
import { readSuperDigest } from '../../dashboard/src/lib/superTypes.js';

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-1';
const CHILD = 'child-orbit';
const ASK = 'Go through the Orbit inbox and answer what is left unanswered';

function makeVault(extra: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...extra }));
  token = mintWindowToken({
    send: (frame) => {
      if (typeof frame.id === 'string' && frame.subtype === 'window_command') setImmediate(() => deliverWindowResult(token, frame.id as string, { ok: true, result: { delivered: 'sent' } }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
  }).token;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-pad-refs-')));
  _resetChatRegistry(); resetSuperIndex(); _resetSuperInbox(); resetWindowControl();
  makeVault();
});
afterEach(() => { markSuperEventTurn(SUPER, false); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
async function verb(name: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const out = { status: 0, json: {} as Record<string, unknown> };
  const r = out as unknown as ServerResponse;
  (r as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (r as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  await handleSuperVerb(req(body), r, { verb: name });
  return out;
}
const stored = () => readSuperState(root);
/** What agent-chat.ts writeOwnerTurn does for an owner message to the Super. */
const ownerWrites = (text: string) => { markSuperEventTurn(SUPER, false); noteSuperOwnerMsg(SUPER, msgRef(text)); return superOwnerMsgAt(SUPER)!; };
const lineByText = async (text: string) => (await stored()).pad?.find((p) => p.text === text);

describe('the arrival of his message is kept beside its ref', () => {
  it('set when his message arrives, dropped with the ref', () => {
    const at = ownerWrites(ASK);
    expect(typeof at).toBe('number');
    noteSuperOwnerMsg(SUPER, null);
    expect(superOwnerMsgAt(SUPER)).toBeUndefined();
  });
});

describe('note add links his message', () => {
  it('a new line in his turn carries { ref, at }; the same line in a later turn with the same words gets a second pair', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    const at1 = ownerWrites('evet');
    expect((await verb('note-add', { section: 'now', text: 'Orbit inbox is being answered' })).status).toBe(200);
    expect((await lineByText('Orbit inbox is being answered'))?.refs).toEqual([{ ref: msgRef('evet'), at: at1 }]);
    // The same command retried: no second pair.
    await verb('note-add', { section: 'now', text: 'Orbit inbox is being answered' });
    expect((await lineByText('Orbit inbox is being answered'))?.refs).toHaveLength(1);
    // A later turn with the very same words: a second pair (two "evet" are two messages).
    vi.setSystemTime(1_060_000);
    const at2 = ownerWrites('evet');
    await verb('note-add', { section: 'now', text: 'Orbit inbox is being answered' });
    expect((await lineByText('Orbit inbox is being answered'))?.refs).toEqual([{ ref: msgRef('evet'), at: at1 }, { ref: msgRef('evet'), at: at2 }]);
  });

  it('an event turn links nothing; --origin names his message (the open debt\'s time), a malformed one is refused', async () => {
    makeVault({ owed: [{ id: 'o1', kind: 'msg', ref: msgRef(ASK), seq: 1, at: 4242, gist: 'x', nudges: 0 }] });
    ownerWrites(ASK);
    markSuperEventTurn(SUPER, true);
    await verb('note-add', { section: 'now', text: 'From an event turn' });
    expect((await lineByText('From an event turn'))?.refs).toBeUndefined();
    await verb('note-add', { section: 'now', text: 'Named by origin', origin: msgRef(ASK) });
    expect((await lineByText('Named by origin'))?.refs).toEqual([{ ref: msgRef(ASK), at: 4242 }]);
    expect((await verb('note-add', { section: 'now', text: 'Bad', origin: 'NOT A REF' })).status).toBe(400);
    expect(await lineByText('Bad')).toBeUndefined();
  });

  it('the server\'s own line (the schedule banner path) and his own pad/add never link', async () => {
    ownerWrites(ASK);
    await addPadNote(root, 'waiting', 'Scheduled for 09:00');
    expect((await lineByText('Scheduled for 09:00'))?.refs).toBeUndefined();
  });
});

describe('delegate --note and send link his message', () => {
  it('delegate in his turn starts the line\'s thread; a later send to that job adds the new message', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 2_000_000 });
    const at1 = ownerWrites(ASK);
    expect((await verb('delegate', { model: 'sonnet', prompt: 'Answer the Orbit inbox', brief: 'Orbit inbox', mode: 'basic', note: 'Orbit inbox job' })).status).toBe(200);
    expect((await lineByText('Orbit inbox job'))).toMatchObject({ for: CHILD, refs: [{ ref: msgRef(ASK), at: at1 }] });

    registerChat({ sessionId: CHILD, conversationId: null, vault: 'acme', mode: 'basic' });
    vi.setSystemTime(2_120_000);
    const at2 = ownerWrites('devam');
    const sent = await verb('send', { child: CHILD, text: 'go on' });
    expect(sent.status).toBe(200);
    expect((await lineByText('Orbit inbox job'))?.refs).toEqual([{ ref: msgRef(ASK), at: at1 }, { ref: msgRef('devam'), at: at2 }]);

    // A send from an event turn without --origin moves nothing.
    markSuperEventTurn(SUPER, true);
    await verb('send', { child: CHILD, text: 'and the rest' });
    expect((await lineByText('Orbit inbox job'))?.refs).toHaveLength(2);
  });
});

describe('stored pairs are checked', () => {
  it('malformed pairs drop on load, the rest stay oldest first', () => {
    const [line] = sanitizePad([{ id: 'n1', section: 'now', text: 'x', at: 5, refs: [
      { ref: 'abc123', at: 30 }, { ref: 'NOPE', at: 1 }, { ref: 'abc124', at: -1 }, { ref: 'abc125', at: Number.NaN }, 'junk', { ref: 'abc126', at: 10 },
    ] }]);
    expect(line.refs).toEqual([{ ref: 'abc126', at: 10 }, { ref: 'abc123', at: 30 }]);
    expect(sanitizePad([{ id: 'n2', section: 'now', text: 'y', at: 5, refs: 'nope' }])[0].refs).toBeUndefined();
  });

  it('linkLineRef skips an identical pair and reaches every line of a job', () => {
    const s = { pad: [
      { id: 'n1', section: 'now' as const, text: 'a', at: 1, for: CHILD },
      { id: 'n2', section: 'done' as const, text: 'b', at: 1, for: CHILD },
      { id: 'n3', section: 'now' as const, text: 'c', at: 1 },
    ] };
    linkLineRef(s, { child: CHILD }, { ref: 'abc123', at: 7 });
    linkLineRef(s, { child: CHILD }, { ref: 'abc123', at: 7 });
    expect(s.pad.map((p) => p.refs)).toEqual([[{ ref: 'abc123', at: 7 }], [{ ref: 'abc123', at: 7 }], undefined]);
    expect(cleanPadRefs(Array.from({ length: 250 }, (_, i) => ({ ref: 'abc123', at: i })))).toHaveLength(200);
  });

  it('a Done day file keeps valid pairs', async () => {
    const day = new Date(2026, 10, 10, 12).getTime();
    await archiveDoneLines(root, 'main', [{ id: 'n9', section: 'done', text: 'Shipped', at: day, refs: [{ ref: 'abc123', at: day - 5 }, { ref: 'BAD', at: 1 }] } as never]);
    const lines = await agendaDoneOn(root, 'main', '2026-11-10', []);
    expect(lines.find((l) => l.id === 'n9')?.refs).toEqual([{ ref: 'abc123', at: day - 5 }]);
  });
});

describe('the phone digest carries what the thread key reads', () => {
  it('a line\'s newest 20 pairs, the owed child, and direct / hasCard / team on waiting rows', () => {
    const refs = Array.from({ length: 30 }, (_, i) => ({ ref: 'abc123', at: i }));
    const state = {
      ...emptySuperState(), session: SUPER,
      pad: [{ id: 'n1', section: 'now', text: 'Orbit', at: 1, for: CHILD, refs }],
      queue: [
        { id: 'q1', sessionId: CHILD, kind: 'question', state: 'pending', createdAt: 1, direct: true },
        { id: 'q2', sessionId: CHILD, kind: 'owner', state: 'pending', createdAt: 2, card: { kind: 'run', id: 'r1' } },
        { id: 'q3', sessionId: SUPER, kind: 'question', state: 'escalated', createdAt: 3, team: 'tj-1' },
      ],
      owed: [{ id: 'o1', kind: 'result', ref: 'abc123', seq: 1, at: 9, gist: 'Orbit done', nudges: 0, child: CHILD }],
    } as unknown as SuperState;
    const d = superDigest(state);
    expect(d.pad[0].refs).toHaveLength(MAX_DIGEST_PAD_REFS);
    expect(d.pad[0].refs?.[0]).toEqual({ ref: 'abc123', at: 10 });
    expect(d.owed[0].child).toBe(CHILD);
    const by = (id: string) => d.waiting.find((w) => w.id === id);
    expect(by('q1')).toMatchObject({ direct: true });
    expect(by('q2')).toMatchObject({ hasCard: true });
    expect(by('q3')).toMatchObject({ team: true });
    // The window reads them back with the same checks.
    const back = readSuperDigest(JSON.parse(JSON.stringify(d)))!;
    expect(back.pad[0].refs).toEqual(d.pad[0].refs);
    expect(back.owed?.[0].child).toBe(CHILD);
    expect(back.waiting.find((w) => w.id === 'q2')?.hasCard).toBe(true);
  });
});
