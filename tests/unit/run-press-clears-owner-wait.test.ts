/**
 * run-bildirim-hemen (owner 2026-11-13: "run'a bastığım an bu bildirim gitmeli"): pressing ▶ Run
 * on a child's run card IS the owner's answer. The moment the run STARTS, the owner item closes
 * (every "needs you" surface reads it: the bar, the Agenda, the child card), its slot line says
 * `running`, and the child's row is not settled `done` while the run goes. At the exit the child
 * still gets the report (`ownerReceipt`) and the slot line becomes `sent`.
 *
 * Through the REAL registry, inbox, card records, receipt store and run registry with its real
 * delivery; a fake PTY and a fake crew handle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/run-press-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetChatRegistry, getChat, registerChat, registerCrewHandle, type ChatHandle, type OwnerReceiptMark,
} from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, attachSuperInbox, deliverHeldOwnerReceipts, lookupOwnerCard, startSuperInbox, writeSuper,
  type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { _resetSuperSends, refusalWait } from '../../src/lib/super/owner-wait.js';
import { _resetCardsForTests, getCard, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import {
  _resetOwnerReceiptsForTests, registerOwnerCardLookup, registerOwnerCardWaker, registerOwnerReceiptDeliverer,
} from '../../src/server/owner-receipts.js';
import { _resetRunsForTests, configureRuns, startRun, type RunPty } from '../../src/server/runs/registry.js';
import { _lastCrewDeliveryForTests, runDelivery } from '../../src/server/runs/delivery.js';
import { resetWindowControl } from '../../src/lib/window-control.js';

const SUPER = 'sup-1';
const C1 = '11111111-1111-4111-8111-111111111111';
const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = { type: 'run', id: 'npm-publish', command: 'npm publish', why: 'only you can publish' };
const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: `conv-${sid.slice(0, 4)}`, vault: 'acme', mode, crew: mode !== 'super' });

class FakePty implements RunPty {
  pid = 4242;
  private data: Array<(d: string) => void> = [];
  private exit: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (d: string) => void) { this.data.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.exit.push(cb); }
  write() { /* ok */ }
  resize() { /* ok */ }
  kill() { this.end(130); }
  emit(d: string) { for (const f of this.data) f(d); }
  end(code: number) { for (const f of this.exit) f({ exitCode: code }); }
}

let dir: string;
let root: string;
let ptys: FakePty[];
let offLookup: () => void;

async function drain(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await _superInboxDrained();
  }
}

async function boot(opts: { failSends?: boolean } = {}) {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { [C1]: { sessionId: C1, brief: 'publish', adopted: false, startedAt: 1, row: 'working' } },
  }));
  const sup = reg(SUPER, 'super');
  sup.userSent('');
  sup.observe({ type: 'result' });
  const h = reg(C1);
  h.userSent('go');
  await startSuperInbox([root]);
  const inbox: SuperInbox = { id: 'inbox-1', sessionId: SUPER, attached: () => true, idle: () => true, deliver: async () => true };
  attachSuperInbox(inbox);
  await drain();
  const got: Array<{ text: string; mark: OwnerReceiptMark }> = [];
  registerCrewHandle(C1, {
    sendServerTurn: (t) => { h.userSent(t, { server: true, closesNothing: true }); return true; },
    sendOwnerReceipt: async (text, mark) => {
      if (opts.failSends) return false;
      got.push({ text, mark }); h.userSent(text, { server: true, ownerReceipt: mark }); return true;
    },
  });
  return { h, got };
}

const item = async (id: string): Promise<SuperQueueItem> => (await readSuperState(root)).queue.find((q) => q.id === id) as SuperQueueItem;

describe('pressing ▶ Run clears the owner wait at the start, not the exit (run-bildirim-hemen)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'run-press-'));
    rmSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true, force: true });
    setCardsHomeForTests(process.env.HOME!);
    _resetChatRegistry();
    _resetSuperSends();
    _resetCardsForTests();
    _resetOwnerReceiptsForTests();
    _resetRunsForTests();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    registerOwnerReceiptDeliverer(deliverHeldOwnerReceipts);
    registerOwnerCardWaker(async () => 'woken');
    offLookup = registerOwnerCardLookup((ps, ref) => {
      const l = lookupOwnerCard(ps, ref);
      return l ? { handle: l.handle, target: l.target, itemId: l.itemId, itemOpen: l.itemOpen, superSession: l.superSession } : null;
    });
    ptys = [];
    configureRuns({
      spawner: () => { const p = new FakePty(); ptys.push(p); return p; },
      projectRootOf: () => dir,
      resolveCwd: (r) => r,
      delivery: runDelivery,
      trackChild: () => () => {},
      capMs: 30 * 60_000,
    });
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    _resetRunsForTests();
    offLookup();
    vi.useRealTimers();
    _resetSuperInbox();
    _resetOwnerReceiptsForTests();
    setCardsHomeForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the item closes as `running` the moment the run starts; the child still gets the report at the exit', async () => {
    const { h, got } = await boot();
    h.observe({ type: 'assistant', uuid: MSG, message: { content: [{ type: 'text', text: `Publish is yours.\n\n${fence(RUN)}` }] } });
    h.observe({ type: 'result' });
    await drain();
    const open = (await readSuperState(root)).queue.find((q) => q.kind === 'owner' && q.card) as SuperQueueItem;
    expect(open.state).not.toBe('done');
    expect(open.delivery).toBeUndefined();
    expect((await readSuperState(root)).children[C1].row).toBe('waiting');

    // He presses ▶ Run: the run is live, nothing has exited.
    const r = startRun(C1, open.card!.cardRef, 'mac');
    expect('refused' in r).toBe(false);
    await drain();
    expect(getCard(C1, open.card!.cardRef)?.run).not.toBeNull();
    expect(getChat(C1)?.ownerWaits ?? []).toEqual([]);
    expect(await item(open.id)).toMatchObject({ state: 'done', delivery: 'running' });
    // No longer his, not done either: the run still goes for the child.
    expect((await readSuperState(root)).children[C1].row).toBe('working');
    // No second item for the same card (the registry no longer holds the wait).
    expect((await readSuperState(root)).queue.filter((q) => q.kind === 'owner' && q.state !== 'done')).toEqual([]);
    // A long quiet run never settles the child as done.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await drain();
    expect((await readSuperState(root)).children[C1].row).toBe('working');
    expect(got).toEqual([]);

    // The exit: the child gets the report, the slot line says where it went.
    ptys[0].emit('+ dreamcontext@0.41.21\n');
    ptys[0].end(0);
    await _lastCrewDeliveryForTests();
    await drain();
    expect(got).toHaveLength(1);
    expect(got[0].mark).toEqual({ kind: 'run', id: 'npm-publish' });
    expect(got[0].text).toMatch(/npm publish/);
    expect(await item(open.id)).toMatchObject({ state: 'done', delivery: 'sent' });
  });

  it('a failed run still reaches the child; a card posted again needs him again', async () => {
    const { h, got } = await boot();
    h.observe({ type: 'assistant', uuid: MSG, message: { content: [{ type: 'text', text: fence(RUN) }] } });
    h.observe({ type: 'result' });
    await drain();
    const first = (await readSuperState(root)).queue.find((q) => q.kind === 'owner' && q.card) as SuperQueueItem;
    startRun(C1, first.card!.cardRef, 'mac');
    await drain();
    ptys[0].end(1);
    await _lastCrewDeliveryForTests();
    await drain();
    expect(got).toHaveLength(1);
    expect(got[0].text).toMatch(/exit 1|exited 1|code 1|1/);
    // The child posts the card again: a new ask, a new open item.
    h.observe({ type: 'assistant', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: { content: [{ type: 'text', text: fence(RUN) }] } });
    h.observe({ type: 'result' });
    await drain();
    const again = (await readSuperState(root)).queue.filter((q) => q.kind === 'owner' && q.state !== 'done');
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(first.id);
  });
  async function posted(h: ChatHandle): Promise<SuperQueueItem> {
    h.observe({ type: 'assistant', uuid: MSG, message: { content: [{ type: 'text', text: fence(RUN) }] } });
    h.observe({ type: 'result' });
    await drain();
    return (await readSuperState(root)).queue.find((q) => q.kind === 'owner' && q.card) as SuperQueueItem;
  }

  it('the press also closes the refusal of the SAME command (one command, two waits); another refusal stays', async () => {
    const { h } = await boot();
    const open = await posted(h);
    const same = refusalWait('Bash', RUN.command, 4000, { source: 'classifier' } as never);
    const other = refusalWait('Bash', 'npm whoami', 4000, { source: 'classifier' } as never);
    await writeSuper(root, (s) => {
      for (const [i, w] of [same, other].entries()) {
        s.queue.push({ id: `rf-item-${i}`, sessionId: C1, kind: 'owner', state: 'escalated', createdAt: Date.now() + 1_000, wait: { kind: 'refusal', id: w.id, key: w.key, refusal: w.refusal }, ownerText: w.line } as SuperQueueItem);
      }
    });
    await drain();
    startRun(C1, open.card!.cardRef, 'mac');
    await drain();
    expect((await item('rf-item-0')).state).toBe('done');
    expect((await item('rf-item-1')).state).not.toBe('done');
    expect(await item(open.id)).toMatchObject({ state: 'done', delivery: 'running' });
  });

  it('a child with no live chat (parked, restarted) stops saying "needs you" at the press too', async () => {
    const { h } = await boot();
    const open = await posted(h);
    h.exited();
    await drain();
    expect((await item(open.id)).state).not.toBe('done');
    startRun(C1, open.card!.cardRef, 'mac');
    await drain();
    expect(await item(open.id)).toMatchObject({ state: 'done', delivery: 'running' });
    expect((await readSuperState(root)).children[C1].row).not.toBe('waiting');
  });

  it('no "running" outlives the run: an exit whose result is held says `finished`', async () => {
    const { h } = await boot({ failSends: true });
    const open = await posted(h);
    startRun(C1, open.card!.cardRef, 'mac');
    await drain();
    expect((await item(open.id)).delivery).toBe('running');
    ptys[0].end(0);
    await _lastCrewDeliveryForTests();
    await drain();
    expect((await item(open.id)).delivery).toBe('finished');
  });
});

