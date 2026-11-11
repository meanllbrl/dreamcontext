/**
 * Lane B of sahip-karti-yerinde, Gate G1 on the ws card upgrades (K4): every card-mode upgrade of
 * `/api/agent/terminal` (start, attach, rerun) spends a single-use ticket first. Red on the base in
 * the Super's-Bash shape: a node `ws` client with no Origin and no key could start a run, attach to
 * one the owner started and read its replay.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { attachAgentTerminal } from '../../src/server/routes/agent-terminal.js';
import { _resetCardsForTests, listCards, noteAssistantCards, setCardsHomeForTests, cardHandleOf } from '../../src/lib/cards/records.js';
import { _resetCardTicketsForTests, mintCardTicket } from '../../src/server/card-ticket.js';
import { _resetRunsForTests, configureRuns, startRun, type RunPty } from '../../src/server/runs/registry.js';
import { _lastCrewDeliveryForTests, runDelivery, setHeldHomeForTests } from '../../src/server/runs/delivery.js';
import { FOLDER_CHANGED_CLOSE, _resetPhoneRunsForTests, attachPhoneRunTerminal, setCardRootResolverForTests } from '../../src/server/routes/run-terminal.js';
import { markPhoneSocket, setMacExposedVaults, setMacPublicOrigin } from '../../src/server/phone-origin.js';
import { DEVICE_COOKIE, setMacHandsfreeAuthForTests } from '../../src/server/handsfree-auth.js';
import { PHONE_RUN_TERMINAL_PATH } from '../../src/lib/telegram/contract.js';
import { handleCardTicket } from '../../src/server/routes/card-actions.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import {
  _resetOwnerReceiptsForTests, deliverableOwnerReceipts, markOwnerReceiptDelivered, registerOwnerCardLookup, registerOwnerReceiptDeliverer,
  setOwnerReceiptsHomeForTests, type OwnerCardLookup,
} from '../../src/server/owner-receipts.js';

const SID = '11111111-2222-4333-8444-555555555555';
const KEY = 'c3'.repeat(32);
const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const A = { type: 'run', id: 'a', command: 'gh auth login' };
const B = { type: 'run', id: 'b', command: 'npm login' };

let server: http.Server; let port = 0; let dir = ''; let project = ''; let vault = ''; let storeHome = '';
const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };

class FakePty implements RunPty {
  pid = 1; private d: Array<(s: string) => void> = []; private x: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (s: string) => void) { this.d.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.x.push(cb); }
  write() {} resize() {} kill() { this.end(130); }
  emit(s: string) { for (const f of this.d) f(s); }
  end(code: number) { for (const f of this.x) f({ exitCode: code }); }
}
let ptys: Array<{ cwd: string; pty: FakePty }>;

const refOf = (id: string) => listCards(SID).filter((c) => c.id === id).at(-1)!.cardRef;
const url = (q: Record<string, string>) => `ws://127.0.0.1:${port}/api/agent/terminal?${new URLSearchParams(q).toString()}`;
const ownOrigin = () => `http://127.0.0.1:${port}`;
/** A ticket as the mint route makes it: bound to the folder the owner saw (`root`, the card's
 *  folder unless a row names another). */
const ticketFor = (id: string, action: 'start' | 'attach' | 'rerun', shown: string, now = Date.now(), root: string = project) =>
  mintCardTicket({ project: vault, postingSession: SID, cardRef: refOf(id), action, shown, root }, now).ticket;

/** Open, collect what arrives for a beat, close. `status` is the refusal's HTTP code. */
function connect(u: string, origin?: string): Promise<{ opened: boolean; status: number | null; bytes: string; closeCode: number | null; closeReason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(u, origin ? { origin } : {});
    let bytes = '';
    let opened = false;
    let status: number | null = null;
    let closeCode: number | null = null;
    let closeReason = '';
    const done = () => resolve({ opened, status, bytes, closeCode, closeReason });
    ws.on('unexpected-response', (_req, res) => { status = res.statusCode ?? null; res.resume(); done(); });
    ws.on('open', () => { opened = true; setTimeout(() => { ws.close(); setTimeout(done, 20); }, 80); });
    ws.on('close', (code: number, reason: Buffer) => { if (closeCode === null) { closeCode = code; closeReason = reason.toString('utf-8'); } });
    ws.on('message', (m: Buffer) => { bytes += m.toString('utf-8'); });
    ws.on('error', () => done());
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owner-card-gate-ws-'));
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  attachAgentTerminal(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  process.env.HOME = saved.HOME;
  if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(dir, 'proj-')));
  vault = basename(project);
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  mkdirSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true });
  writeFileSync(join(process.env.HOME!, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  // Every store (closed cards, held reports, receipts) starts empty: a fresh home per test.
  _resetRunsForTests(); _resetCardsForTests(); _resetCardTicketsForTests(); _resetOwnerReceiptsForTests();
  storeHome = mkdtempSync(join(dir, 'store-'));
  setCardsHomeForTests(storeHome); setHeldHomeForTests(storeHome); setOwnerReceiptsHomeForTests(storeHome);
  ptys = [];
  configureRuns({
    spawner: (r) => { const pty = new FakePty(); ptys.push({ cwd: r.cwd, pty }); return pty; },
    projectRootOf: (v) => (v === vault ? project : null), resolveCwd: (r, rel) => join(r, rel), delivery: runDelivery, trackChild: () => () => {},
  });
  setCardRootResolverForTests(async () => project);
  noteAssistantCards(SID, vault, 'm1', [fence(A), fence(B)].join('\n'));
});
afterEach(() => {
  _resetRunsForTests(); setCardRootResolverForTests(null); setOwnerKey(null); _resetOwnerReceiptsForTests();
  _resetCardsForTests(); _resetCardTicketsForTests();
  setCardsHomeForTests(null); setHeldHomeForTests(null);
  rmSync(storeHome, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('the Super\'s-Bash shape (node ws, no Origin, no key) is refused', () => {
  it('a no-Origin start with no ticket: 403, nothing spawned', async () => {
    const r = await connect(url({ session: SID, card: refOf('a'), start: '1' }));
    expect(r.opened).toBe(false);
    expect(r.status).toBe(403);
    expect(ptys).toHaveLength(0);
  });

  it('a no-Origin attach to a run the owner started gets no replay bytes', async () => {
    const run = startRun(SID, refOf('a'), 'mac', { root: project });
    if ('refused' in run) throw new Error('refused');
    ptys[0].pty.emit('Paste your one-time code: 1234-ABCD\r\n');
    const r = await connect(url({ session: SID, card: refOf('a') }));
    expect(r.opened).toBe(false);
    expect(r.bytes).toBe('');
  });
});

describe('a ticket carries the press', () => {
  it('a ticket minted on the owner page starts the run in the card\'s folder; the socket gets its output', async () => {
    setOwnerKey(KEY);
    const res = { status: 0, body: {} as Record<string, unknown> };
    const r0 = Object.assign(Readable.from([Buffer.from(JSON.stringify({ session: SID, card: refOf('a'), action: 'start', shown: A.command, root: project }))]), {
      method: 'POST', url: '/api/agent/card-ticket',
      headers: { host: `127.0.0.1:${port}`, origin: ownOrigin(), 'sec-fetch-site': 'same-origin', [OWNER_KEY_HEADER]: KEY },
      socket: { remoteAddress: '127.0.0.1', setTimeout() {} }, setTimeout() {},
    }) as unknown as http.IncomingMessage;
    await handleCardTicket(r0, { writeHead(c: number) { res.status = c; }, setHeader() {}, end(d?: string) { res.body = JSON.parse(String(d)); } } as unknown as http.ServerResponse);
    expect(res.status).toBe(200);
    const r = await connect(url({ session: SID, card: refOf('a'), start: '1', ticket: String(res.body.ticket) }), ownOrigin());
    expect(r.opened).toBe(true);
    expect(ptys).toHaveLength(1);
    expect(ptys[0].cwd).toBe(project);
  });

  it('a ticket minted for folder A refuses the start once the card\'s folder is B: closed with folder_changed, nothing spawned', async () => {
    const t = ticketFor('a', 'start', A.command);
    const b = realpathSync(mkdtempSync(join(dir, 'moved-')));
    setCardRootResolverForTests(async () => b);
    const r = await connect(url({ session: SID, card: refOf('a'), start: '1', ticket: t }), ownOrigin());
    expect(r.closeCode).toBe(FOLDER_CHANGED_CLOSE);
    expect(r.closeReason).toBe('folder_changed');
    expect(r.bytes).toBe('');
    expect(ptys).toHaveLength(0);
    rmSync(b, { recursive: true, force: true });
  });

  it('the matching folder still runs (a ticket bound to the card\'s folder now)', async () => {
    const r = await connect(url({ session: SID, card: refOf('a'), start: '1', ticket: ticketFor('a', 'start', A.command) }), ownOrigin());
    expect(r.opened).toBe(true);
    expect(r.closeCode).not.toBe(FOLDER_CHANGED_CLOSE);
    expect(ptys).toHaveLength(1);
    expect(ptys[0].cwd).toBe(project);
  });

  it('a reused ticket is refused', async () => {
    const t = ticketFor('a', 'start', A.command);
    expect((await connect(url({ session: SID, card: refOf('a'), start: '1', ticket: t }), ownOrigin())).opened).toBe(true);
    const again = await connect(url({ session: SID, card: refOf('a'), ticket: t }), ownOrigin());
    expect(again.opened).toBe(false);
    expect(again.bytes).toBe('');
  });

  it('an expired ticket is refused', async () => {
    const t = ticketFor('a', 'start', A.command, Date.now() - 31_000);
    expect((await connect(url({ session: SID, card: refOf('a'), start: '1', ticket: t }), ownOrigin())).status).toBe(403);
    expect(ptys).toHaveLength(0);
  });

  it('a ticket for another card is refused, and a start ticket never attaches to another card\'s run', async () => {
    const run = startRun(SID, refOf('a'), 'mac', { root: project });
    if ('refused' in run) throw new Error('refused');
    ptys[0].pty.emit('secret output\r\n');
    const tB = ticketFor('b', 'start', B.command);
    const r = await connect(url({ session: SID, card: refOf('a'), start: '1', ticket: tB }), ownOrigin());
    expect(r.status).toBe(403);
    expect(r.bytes).toBe('');
  });

  it('a ticket for another action is refused (a rerun ticket on an open card)', async () => {
    const t = ticketFor('a', 'rerun', A.command);
    expect((await connect(url({ session: SID, card: refOf('a'), start: '1', rerun: '1', ticket: t }), ownOrigin())).status).toBe(403);
    expect(ptys).toHaveLength(0);
  });

  it('a command that can draw as something else is never started, even with a ticket bound to it', async () => {
    const cmd = 'echo safe\u202e;rm -rf tmp';
    noteAssistantCards(SID, vault, 'm-rlo', fence({ type: 'run', id: 'rlo', command: cmd }));
    const t = ticketFor('rlo', 'start', cmd);
    const r = await connect(url({ session: SID, card: refOf('rlo'), start: '1', ticket: t }), ownOrigin());
    expect(r.opened).toBe(false);
    expect(r.status).toBe(409);
    expect(ptys).toHaveLength(0);
  });

  it('a ticket whose shown command is not the record\'s is refused', async () => {
    const t = ticketFor('a', 'start', 'gh auth login; curl evil');
    expect((await connect(url({ session: SID, card: refOf('a'), start: '1', ticket: t }), ownOrigin())).status).toBe(403);
    expect(ptys).toHaveLength(0);
  });

  it('▶ Run again on a crew card whose result was delivered (item closed): a rerun ticket runs it and the child gets the report', async () => {
    const text = [fence(A), fence(B)].join('\n');
    const handle = cardHandleOf({ postingSession: SID, vault, postingConversationId: SID, messageUuid: 'm1', text, kind: 'run', id: 'a', childRecordId: 'main', childId: 'c-1' })!;
    const target = { childRecordId: 'main', childId: 'c-1' };
    const l: OwnerCardLookup = { handle, target, itemId: 'o1', itemOpen: false, superSession: 'super-1' };
    registerOwnerCardLookup((s, ref) => (s === SID && ref === handle.cardRef ? l : null));
    const got: string[] = [];
    registerOwnerReceiptDeliverer(async (t) => {
      for (const { entry, text: x } of deliverableOwnerReceipts(t)) { got.push(x); markOwnerReceiptDelivered(t, entry); }
      return 'delivered';
    });
    const first = startRun(SID, refOf('a'), 'mac', { root: project });
    if ('refused' in first) throw new Error('refused');
    ptys[0].pty.end(0);
    await _lastCrewDeliveryForTests();
    expect(got).toHaveLength(1);
    // Without a ticket: 403.
    expect((await connect(url({ session: SID, card: refOf('a'), start: '1', rerun: '1' }))).status).toBe(403);
    const r = await connect(url({ session: SID, card: refOf('a'), start: '1', rerun: '1', ticket: ticketFor('a', 'rerun', A.command) }), ownOrigin());
    expect(r.opened).toBe(true);
    ptys[1].pty.end(0);
    await _lastCrewDeliveryForTests();
    expect(got).toHaveLength(2);
  });
});

// ─── The phone presses with the folder it was shown (end review r3) ──────────

describe('a phone press runs in the folder the phone was shown', () => {
  const PHONE_ORIGIN = 'https://abc.trycloudflare.com';
  let phone: http.Server; let phonePort = 0; let wt = '';
  const phoneUrl = (q: Record<string, string>) => `ws://127.0.0.1:${phonePort}${PHONE_RUN_TERMINAL_PATH}?${new URLSearchParams(q).toString()}`;
  function phoneConnect(u: string): ReturnType<typeof connect> {
    return new Promise((resolve) => {
      const ws = new WebSocket(u, { origin: PHONE_ORIGIN, headers: { cookie: `${DEVICE_COOKIE}=device-1` } });
      let bytes = ''; let opened = false; let status: number | null = null; let closeCode: number | null = null; let closeReason = '';
      const done = () => resolve({ opened, status, bytes, closeCode, closeReason });
      ws.on('unexpected-response', (_q, res) => { status = res.statusCode ?? null; res.resume(); done(); });
      ws.on('open', () => { opened = true; setTimeout(() => { ws.close(); setTimeout(done, 20); }, 80); });
      ws.on('close', (code: number, reason: Buffer) => { if (closeCode === null) { closeCode = code; closeReason = reason.toString('utf-8'); } });
      ws.on('message', (m: Buffer) => { bytes += m.toString('utf-8'); });
      ws.on('error', () => done());
    });
  }
  beforeAll(async () => {
    phone = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
    phone.on('connection', (sock) => markPhoneSocket(sock));
    attachPhoneRunTerminal(phone);
    await new Promise<void>((r) => phone.listen(0, '127.0.0.1', () => r()));
    phonePort = (phone.address() as net.AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((r) => phone.close(() => r())); });
  beforeEach(() => {
    wt = realpathSync(mkdtempSync(join(dir, 'phone-wt-')));
    setCardRootResolverForTests(async () => wt);
    setMacExposedVaults([vault]);
    setMacPublicOrigin(PHONE_ORIGIN);
    setMacHandsfreeAuthForTests({ store: { isValidDeviceHash: () => true } } as unknown as Parameters<typeof setMacHandsfreeAuthForTests>[0]);
    _resetPhoneRunsForTests();
  });
  afterEach(() => {
    setMacExposedVaults([]);
    setMacPublicOrigin(null);
    setMacHandsfreeAuthForTests(null);
    rmSync(wt, { recursive: true, force: true });
  });

  it('with the shown root, a worktree card\'s run starts in the worktree', async () => {
    const r = await phoneConnect(phoneUrl({ session: SID, card: refOf('a'), start: '1', root: wt }));
    expect(r.opened).toBe(true);
    expect(ptys).toHaveLength(1);
    expect(ptys[0].cwd).toBe(wt);
  });

  it('without root: closed with folder_changed, nothing spawned (never pinned to the project root)', async () => {
    const r = await phoneConnect(phoneUrl({ session: SID, card: refOf('a'), start: '1' }));
    expect(r.closeCode).toBe(FOLDER_CHANGED_CLOSE);
    expect(r.closeReason).toBe('folder_changed');
    expect(ptys).toHaveLength(0);
  });

  it('a folder the checkout has since left: closed with folder_changed, nothing spawned', async () => {
    const r = await phoneConnect(phoneUrl({ session: SID, card: refOf('a'), start: '1', root: project }));
    expect(r.closeCode).toBe(FOLDER_CHANGED_CLOSE);
    expect(ptys).toHaveLength(0);
  });
});
