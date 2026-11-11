/**
 * Lane B of sahip-karti-yerinde: Gate G1 on the card-action routes (K4), the card's working folder
 * (K5) and the hold points of a crew child's results (K6). Each route gets one row with owner
 * proof (200) and one in the Super's-Bash shape (a `curl`: loopback, no Origin, no key: 403).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-card-gate-home-`);
});

import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { _resetCardsForTests, getCard, listCards, noteAssistantCards, onCardsChange, readClosedFile, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import {
  _failOwnerReceiptWritesForTests, _resetOwnerReceiptsForTests, _restartOwnerReceiptsForTests, holdOwnerReceipt, readOwnerReceipts,
  registerOwnerCardLookup, registerOwnerItemCloser, registerOwnerReceiptDeliverer, setOwnerReceiptsHomeForTests, deliverableOwnerReceipts,
  markOwnerReceiptDelivered, type OwnerCardLookup, type OwnerReceiptTarget,
} from '../../src/server/owner-receipts.js';
import { cardHandleOf } from '../../src/lib/cards/records.js';
import { handleCardNotNeeded, handleCardState, handleCardTicket, handleChecklistSubmit, CARD_OWNER_ONLY_MESSAGE } from '../../src/server/routes/card-actions.js';
import { handleAgentSecret } from '../../src/server/routes/agent-secret.js';
import { cardRootOf, setCardRootResolverForTests } from '../../src/server/routes/run-terminal.js';
import { isCrossSiteWrite } from '../../src/server/middleware.js';
import { _resetCardTicketsForTests, consumeCardTicket } from '../../src/server/card-ticket.js';
import { _resetRunsForTests, configureRuns, startRun, type RunPty } from '../../src/server/runs/registry.js';
import { _lastCrewDeliveryForTests, readHeld, runDelivery, setHeldHomeForTests } from '../../src/server/runs/delivery.js';
import { CUT_OFF_NOTICE_TAIL, takeInterruptedNotices } from '../../src/server/owner-receipts.js';

const KEY = 'b2'.repeat(32);
const ORIGIN = 'http://127.0.0.1:4173';
const OWNER_PAGE = { host: '127.0.0.1:4173', origin: ORIGIN, 'sec-fetch-site': 'same-origin', [OWNER_KEY_HEADER]: KEY };
/** The Super's own Bash (`curl`): loopback, no Origin, no key. */
const CURL = { host: '127.0.0.1:4173', 'content-type': 'application/json' };
const SID = '11111111-2222-4333-8444-555555555555';
const CHILD = 'c-child-1';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const RUN = { type: 'run', id: 'login', command: 'gh auth login' };
const SECRET = { type: 'secret', id: 'key', title: 'Stripe key', file: '.env', fields: [{ key: 'STRIPE_KEY' }] };
const CHECK = { type: 'checklist', id: 'store', title: 'Store setup', items: [{ id: 'a', text: 'Open the console' }, { id: 'pw', text: 'Paste the password', wants: 'secret' }] };

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; return res; },
    setHeader() {},
    end(data?: string) { try { body = JSON.parse(String(data)); } catch { body = {}; } },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}
function req(method: string, url: string, body: unknown, headers: Record<string, string>, remote = '127.0.0.1'): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url, headers, socket: { remoteAddress: remote, setTimeout() {} }, setTimeout() {},
  }) as unknown as IncomingMessage;
}
async function call(h: (q: IncomingMessage, r: ServerResponse, p: Record<string, string>, root: string) => Promise<void>, method: string, url: string, body: unknown, headers: Record<string, string>, remote?: string) {
  const r = makeRes();
  await h(req(method, url, body, headers, remote), r.res, {}, contextRoot);
  return { status: r.status(), body: r.body() };
}

let project: string; let contextRoot: string; let vault: string; let storeHome: string;
let target: OwnerReceiptTarget;
let lookups: Map<string, OwnerCardLookup>;
let delivered: Array<{ t: OwnerReceiptTarget; text: string }>;
let closed: string[];

function refOf(id: string): string { return listCards(SID).filter((c) => c.id === id).at(-1)!.cardRef; }
function crew(id: string, itemOpen = true): OwnerCardLookup {
  const text = [fence(RUN), fence(SECRET), fence(CHECK)].join('\n');
  const spec = [RUN, SECRET, CHECK].find((s) => s.id === id)!;
  const handle = cardHandleOf({ postingSession: SID, vault, postingConversationId: SID, messageUuid: 'm1', text, kind: spec.type as 'run', id, childRecordId: 'main', childId: CHILD })!;
  const l: OwnerCardLookup = { handle, target, itemId: `owner-${id}`, itemOpen, superSession: 'super-1' };
  lookups.set(handle.cardRef, l);
  return l;
}

/** A server restart drops its runs without any exit firing: `kill` is silent then. */
let restarting = false;
function restartServer(): void {
  restarting = true;
  try { _resetRunsForTests(); } finally { restarting = false; }
  _restartOwnerReceiptsForTests();
}

class FakePty implements RunPty {
  pid = 1; private d: Array<(s: string) => void> = []; private x: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (s: string) => void) { this.d.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.x.push(cb); }
  write() {} resize() {} kill() { if (!restarting) this.end(130); }
  end(code: number) { for (const f of this.x) f({ exitCode: code }); }
}
let ptys: Array<{ cwd: string; pty: FakePty }>;

beforeEach(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  setOwnerKey(KEY);
  project = realpathSync(mkdtempSync(join(tmpdir(), 'owner-card-gate-proj-')));
  contextRoot = join(project, '_dream_context');
  vault = basename(project);
  mkdirSync(contextRoot, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  // The vault list lives under HOME (resolveVaultProjectRoot reads it); every STORE (closed
  // cards, held reports, receipts) gets a fresh home per test, so nothing leaks between tests.
  const home = process.env.HOME!;
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: vault, path: project }] }));
  _resetRunsForTests(); _resetCardsForTests(); _resetOwnerReceiptsForTests(); _resetCardTicketsForTests();
  storeHome = mkdtempSync(join(tmpdir(), 'owner-card-gate-store-'));
  setCardsHomeForTests(storeHome); setHeldHomeForTests(storeHome); setOwnerReceiptsHomeForTests(storeHome);
  target = { childRecordId: 'main', childId: CHILD };
  lookups = new Map(); delivered = []; closed = []; ptys = [];
  registerOwnerCardLookup((s, ref) => (s === SID ? lookups.get(ref) ?? null : null));
  registerOwnerItemCloser(async (l) => { closed.push(l.itemId); lookups.set(l.handle.cardRef, { ...l, itemOpen: false }); return true; });
  registerOwnerReceiptDeliverer(async (t) => {
    for (const { entry, text } of deliverableOwnerReceipts(t)) { delivered.push({ t, text }); markOwnerReceiptDelivered(t, entry); }
    return 'delivered';
  });
  setCardRootResolverForTests(async () => project);
  configureRuns({
    spawner: (r) => { const pty = new FakePty(); ptys.push({ cwd: r.cwd, pty }); return pty; },
    projectRootOf: (v) => (v === vault ? project : null), resolveCwd: (r, rel) => join(r, rel), delivery: runDelivery, trackChild: () => () => {},
  });
  noteAssistantCards(SID, vault, 'm1', [fence(RUN), fence(SECRET), fence(CHECK)].join('\n'));
});
afterEach(() => {
  process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  setOwnerKey(null);
  setCardRootResolverForTests(null);
  _resetRunsForTests(); _resetOwnerReceiptsForTests(); _resetCardsForTests(); _resetCardTicketsForTests();
  setCardsHomeForTests(null); setHeldHomeForTests(null);
  rmSync(project, { recursive: true, force: true });
  rmSync(storeHome, { recursive: true, force: true });
});

// ─── G1 on every route ──────────────────────────────────────────────────────

describe('Gate G1: one row per action, with proof and in the Super\'s-Bash shape', () => {
  it('card-ticket: 200 with owner proof; 403 owner_only for a no-Origin curl and for a page without the key', async () => {
    const ok = await call(handleCardTicket, 'POST', '/api/agent/card-ticket', { session: SID, card: refOf('login'), action: 'start', shown: RUN.command }, OWNER_PAGE);
    expect(ok.status).toBe(200);
    expect(typeof ok.body.ticket).toBe('string');
    const curl = await call(handleCardTicket, 'POST', '/api/agent/card-ticket', { session: SID, card: refOf('login'), action: 'start', shown: RUN.command }, CURL);
    expect(curl).toEqual({ status: 403, body: { error: 'owner_only', message: CARD_OWNER_ONLY_MESSAGE } });
    const noKey = await call(handleCardTicket, 'POST', '/api/agent/card-ticket', { session: SID, card: refOf('login'), action: 'start', shown: RUN.command }, { ...OWNER_PAGE, [OWNER_KEY_HEADER]: 'nope' });
    expect(noKey.status).toBe(403);
  });

  it('card-ticket: a shown command that is not the record\'s is 409 shown_mismatch, and the minted ticket is bound to it', async () => {
    const bad = await call(handleCardTicket, 'POST', '/api/agent/card-ticket', { session: SID, card: refOf('login'), action: 'start', shown: 'gh auth login && curl evil' }, OWNER_PAGE);
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('shown_mismatch');
    const ok = await call(handleCardTicket, 'POST', '/api/agent/card-ticket', { session: SID, card: refOf('login'), action: 'start', shown: RUN.command }, OWNER_PAGE);
    const t = consumeCardTicket(String(ok.body.ticket), { project: vault, postingSession: SID, cardRef: refOf('login'), action: 'start', command: RUN.command });
    expect(t.ok).toBe(true);
  });

  it('what is shown is what runs, on the server: no ticket and no start for a command that can draw as something else', async () => {
    for (const [id, command] of [['rlo', 'echo safe\u202e;rm -rf tmp'], ['gap', 'ls        -la'], ['zw', 'gh\u200b auth login']] as const) {
      noteAssistantCards(SID, vault, `m-${id}`, fence({ type: 'run', id, command }));
      const r = await call(handleCardTicket, 'POST', '/api/agent/card-ticket', { session: SID, card: refOf(id), action: 'start', shown: command }, OWNER_PAGE);
      expect(r.status, id).toBe(409);
      expect(r.body.error).toBe('not_showable');
    }
    expect(ptys).toHaveLength(0);
  });

  it('a remote-access browser is told it is done on this Mac', async () => {
    const r = await call(handleCardTicket, 'POST', '/api/agent/card-ticket', { session: SID, card: refOf('login'), action: 'start', shown: RUN.command }, OWNER_PAGE, '100.64.1.2');
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toMatch(/on this Mac$/);
  });

  it('checklist-submit, not-needed, secret (record and no record): 403 for the no-Origin curl, nothing written', async () => {
    crew('store'); crew('key');
    const a = await call(handleChecklistSubmit, 'POST', '/api/agent/cards/checklist-submit', { session: SID, card: refOf('store'), state: { checked: { a: true } }, secrets: {} }, CURL);
    const b = await call(handleCardNotNeeded, 'POST', '/api/agent/cards/not-needed', { session: SID, card: refOf('store') }, CURL);
    const c = await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'sk_live_x' }] }, CURL);
    const d = await call(handleAgentSecret, 'POST', '/api/agent/secret', { file: '.env', entries: [{ key: 'A', value: 'b' }] }, CURL);
    for (const r of [a, b, c, d]) expect(r).toEqual({ status: 403, body: { error: 'owner_only', message: CARD_OWNER_ONLY_MESSAGE } });
    expect(existsSync(join(project, '.env'))).toBe(false);
    expect(readOwnerReceipts(target)).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('cards/state: a same-origin GET with the key reads; one without it is 403', async () => {
    const GET = { host: '127.0.0.1:4173', 'sec-fetch-site': 'same-origin', [OWNER_KEY_HEADER]: KEY };
    const ok = await call(handleCardState, 'GET', `/api/agent/cards/state?session=${SID}&card=${refOf('login')}`, undefined, GET);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ folder: { path: project, name: basename(project) }, views: [], cutOff: false, gone: false });
    const no = await call(handleCardState, 'GET', `/api/agent/cards/state?session=${SID}&card=${refOf('login')}`, undefined, { host: '127.0.0.1:4173' });
    expect(no.status).toBe(403);
  });

  it('the listener-wide write gate refuses a no-Origin POST to the owner card paths, and only those', () => {
    const at = (url: string) => req('POST', url, {}, CURL);
    expect(isCrossSiteWrite(at('/api/agent/secret'))).toBe(true);
    expect(isCrossSiteWrite(at('/api/agent/card-ticket'))).toBe(true);
    expect(isCrossSiteWrite(at('/api/agent/cards/checklist-submit'))).toBe(true);
    expect(isCrossSiteWrite(at('/api/agent/cards/not-needed'))).toBe(true);
    expect(isCrossSiteWrite(at('/api/knowledge'))).toBe(false);
  });
});

// ─── K5: the card's working folder ──────────────────────────────────────────

describe('K5: a card runs and writes in the card\'s working folder (the REAL resolver)', () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, stdio: 'ignore' });
  const GET = () => ({ host: '127.0.0.1:4173', 'sec-fetch-site': 'same-origin', [OWNER_KEY_HEADER]: KEY });
  let wtHome: string;
  let others: string[];

  /** The posting session is a child of main with this recorded worktree. */
  function recordChild(worktree: string): void {
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.super-agent.json'), JSON.stringify({
      v: 1, session: null, enabled: true,
      children: { [SID]: { sessionId: SID, brief: 'b', adopted: false, startedAt: 1, worktree, branch: 'super/x' } },
    }));
  }
  /** A fresh repository outside the project, with one commit. */
  function repo(name: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'owner-card-gate-repo-')));
    others.push(dir);
    const r = join(dir, name);
    mkdirSync(r);
    execFileSync('git', ['init', '-q', r]);
    git(r, 'commit', '-q', '--allow-empty', '-m', 'init');
    return r;
  }
  async function secret(value: string, extra: Record<string, unknown> = {}) {
    return call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), ...extra, entries: [{ key: 'STRIPE_KEY', value }] }, OWNER_PAGE);
  }
  async function runIn(): Promise<string | null> {
    const root = await cardRootOf(getCard(SID, refOf('login'))!);
    if (!root) return null;
    const r = startRun(SID, refOf('login'), 'mac', { root });
    if ('refused' in r) throw new Error(r.refused);
    return ptys.at(-1)!.cwd;
  }

  beforeEach(() => {
    others = [];
    setCardRootResolverForTests(null);
    git(project, 'commit', '-q', '--allow-empty', '-m', 'init');
    wtHome = join(process.env.HOME!, '.claude-worktrees');
    mkdirSync(wtHome, { recursive: true });
  });
  afterEach(() => {
    // The worktree home and the linked-repo registry live under the file's HOME: none may leak.
    rmSync(wtHome, { recursive: true, force: true });
    rmSync(join(process.env.HOME!, '.dreamcontext', 'linked-repos.json'), { force: true });
    for (const d of others) rmSync(d, { recursive: true, force: true });
  });

  it('the project\'s own worktree: the run executes there, the secret lands in its .env with .gitignore checked there, whatever the body names', async () => {
    const wt = join(wtHome, 'child-own');
    git(project, 'worktree', 'add', '-q', '-b', 'super/own', wt);
    recordChild(wt);
    expect(await runIn()).toBe(realpathSync(wt));
    const r = await secret('sk_live_abc', { root: '/tmp/evil', cwd: '/tmp/evil' });
    expect(r.status).toBe(200);
    expect(readFileSync(join(wt, '.env'), 'utf-8')).toContain('STRIPE_KEY=');
    expect(readFileSync(join(wt, '.gitignore'), 'utf-8')).toMatch(/\.env/);
    expect(existsSync(join(project, '.env'))).toBe(false);
    const s = await call(handleCardState, 'GET', `/api/agent/cards/state?session=${SID}&card=${refOf('login')}`, undefined, GET());
    expect(s.body.folder).toEqual({ path: realpathSync(wt), name: 'child-own' });
  });

  it('a LINKED repository\'s real worktree is accepted: the run executes there, the secret lands there with its .gitignore', async () => {
    const code = repo('code');
    const url = 'https://github.com/acme/code.git';
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ linkedRepos: [{ name: 'code', gitRemoteUrl: url }] }));
    writeFileSync(join(process.env.HOME!, '.dreamcontext', 'linked-repos.json'), JSON.stringify({ repos: { [url]: code } }));
    const wt = join(wtHome, 'child-code');
    git(code, 'worktree', 'add', '-q', '-b', 'super/code', wt);
    recordChild(wt);
    expect(await runIn()).toBe(realpathSync(wt));
    expect((await secret('sk_live_linked')).status).toBe(200);
    expect(readFileSync(join(wt, '.env'), 'utf-8')).toContain('STRIPE_KEY=');
    expect(readFileSync(join(wt, '.gitignore'), 'utf-8')).toMatch(/\.env/);
    expect(existsSync(join(project, '.env')) || existsSync(join(code, '.env'))).toBe(false);
  });

  it('another repository\'s checkout is refused: no run, no secret (409 card_root), the card stays open', async () => {
    const foreign = repo('foreign');
    const wt = join(wtHome, 'child-foreign');
    git(foreign, 'worktree', 'add', '-q', '-b', 'super/f', wt);
    recordChild(wt);
    expect(await runIn()).toBeNull();
    const r = await secret('v');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('card_root');
    expect(existsSync(join(wt, '.env')) || existsSync(join(project, '.env'))).toBe(false);
    expect(getCard(SID, refOf('key'))?.state).toBe('open');
  });

  it('a symlinked worktree is refused, never swapped for the project root', async () => {
    const elsewhere = join(repo('holder'), '..', 'elsewhere');
    git(project, 'worktree', 'add', '-q', '-b', 'super/el', elsewhere);
    const link = join(wtHome, 'child-link');
    symlinkSync(elsewhere, link);
    recordChild(link);
    expect(await runIn()).toBeNull();
    expect((await secret('v')).status).toBe(409);
    expect(existsSync(join(elsewhere, '.env')) || existsSync(join(project, '.env'))).toBe(false);
  });

  it('a child with no recorded worktree uses the project root', async () => {
    expect(await runIn()).toBe(project);
    const s = await call(handleCardState, 'GET', `/api/agent/cards/state?session=${SID}&card=${refOf('login')}`, undefined, GET());
    expect(s.body.folder).toEqual({ path: project, name: basename(project) });
  });
});

// ─── K6: hold before close, deliver, re-entry ───────────────────────────────

describe('K6 hold: the entry is on disk before the record closes', () => {
  /** At the moment the record closes, is the crew entry already on disk? */
  function watchClose(id: string, want: (entries: ReturnType<typeof readOwnerReceipts>) => boolean): { seen: () => boolean | null } {
    let seen: boolean | null = null;
    const off = onCardsChange(() => {
      if (seen === null && getCard(SID, refOf(id))?.state === 'closed') { seen = want(readOwnerReceipts(target)); off(); }
    });
    return { seen: () => seen };
  }

  it('secret: held before closeCard, then delivered to the child; the window posts nothing', async () => {
    crew('key');
    const w = watchClose('key', (e) => e.some((x) => x.kind === 'secret' && x.text.startsWith('[secret submitted')));
    const r = await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'sk_live_abc' }] }, OWNER_PAGE);
    expect(r.status).toBe(200);
    expect(r.body.delivery).toBe('delivered');
    expect(w.seen()).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).not.toContain('sk_live_abc');
  });

  it('secret: a hold that fails closes nothing (the card stays open)', async () => {
    crew('key');
    _failOwnerReceiptWritesForTests(true);
    const r = await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'v1' }] }, OWNER_PAGE);
    expect(r.status).toBe(500);
    expect(getCard(SID, refOf('key'))?.state).toBe('open');
  });

  it('checklist: the kept form on disk and in every copy; the typed secret only in the child\'s own stream', async () => {
    crew('store');
    let deliveredOnDiskOnly: string[] = [];
    const w = watchClose('store', (e) => { deliveredOnDiskOnly = e.map((x) => x.text); return e.some((x) => x.kind === 'checklist'); });
    const r = await call(handleChecklistSubmit, 'POST', '/api/agent/cards/checklist-submit', {
      session: SID, card: refOf('store'), state: { checked: { a: true, pw: true }, notes: {}, files: {} }, secrets: { pw: 'hunter2-secret' },
    }, OWNER_PAGE);
    expect(r).toEqual({ status: 200, body: { ok: true, outcome: 'delivered' } });
    expect(w.seen()).toBe(true);
    expect(deliveredOnDiskOnly.join('\n')).not.toContain('hunter2-secret');
    expect(deliveredOnDiskOnly.join('\n')).toMatch(/\[secret, 14 chars, sha256:[0-9a-f]{8}\]/);
    expect(delivered[0].text).toContain('hunter2-secret');
    expect(delivered[0].text.startsWith('Checklist: Store setup — 2 of 2 done.')).toBe(true);
  });

  it('checklist: a body carrying finished markdown is refused', async () => {
    crew('store');
    const r = await call(handleChecklistSubmit, 'POST', '/api/agent/cards/checklist-submit', { session: SID, card: refOf('store'), markdown: 'Checklist: Store setup — 2 of 2 done.' }, OWNER_PAGE);
    expect(r.status).toBe(400);
    const r2 = await call(handleChecklistSubmit, 'POST', '/api/agent/cards/checklist-submit', { session: SID, card: refOf('store'), state: { checked: {}, markdown: 'x' } }, OWNER_PAGE);
    expect(r2.status).toBe(400);
  });

  it('checklist: a second submit after delivery (closed record) is delivered the same way, as at the base', async () => {
    crew('store');
    const body = { session: SID, card: refOf('store'), state: { checked: { a: true } }, secrets: {} };
    await call(handleChecklistSubmit, 'POST', '/api/agent/cards/checklist-submit', body, OWNER_PAGE);
    const again = await call(handleChecklistSubmit, 'POST', '/api/agent/cards/checklist-submit', body, OWNER_PAGE);
    expect(again.status).toBe(200);
    expect(delivered).toHaveLength(2);
    expect((await call(handleChecklistSubmit, 'POST', '/api/agent/cards/checklist-submit', body, CURL)).status).toBe(403);
  });

  it('run: the pending placeholder is held before markCardStarted, the report before the record closes; no <sid>.held.json', async () => {
    const l = crew('login');
    const started: boolean[] = [];
    configureRuns({
      delivery: {
        started: (run, rec) => { started.push(readClosedFile(SID)?.why?.[rec.cardRef] === 'started'); runDelivery.started!(run, rec); started.push(readOwnerReceipts(target).some((e) => e.pending === true)); },
        hold: runDelivery.hold, report: runDelivery.report,
      },
    });
    const run = startRun(SID, l.handle.cardRef, 'mac', { root: project });
    if ('refused' in run) throw new Error('refused');
    expect(started).toEqual([false, true]);
    expect(readClosedFile(SID)?.why?.[l.handle.cardRef]).toBe('started');
    const w = watchClose('login', (e) => e.some((x) => !x.pending && x.text.startsWith('[ran in chat]')));
    ptys[0].pty.end(0);
    await _lastCrewDeliveryForTests();
    expect(w.seen()).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(readHeld(SID)).toEqual([]);
  });

  it('two actions on one child keep their own entries; delivering one leaves the other', () => {
    const a = holdOwnerReceipt(target, { id: 'run-a', cardRef: refOf('login'), kind: 'run', text: 'A' })!;
    holdOwnerReceipt(target, { id: 'run-b', cardRef: refOf('login'), kind: 'run', text: 'B' });
    markOwnerReceiptDelivered(target, a);
    expect(readOwnerReceipts(target).map((e) => e.id)).toEqual(['run-b']);
  });

  it('a phone-started crew run writes no <sid>.held.json either', async () => {
    crew('login');
    const run = startRun(SID, refOf('login'), 'phone', { root: project });
    if ('refused' in run) throw new Error('refused');
    expect(readHeld(SID)).toEqual([]);
    ptys[0].pty.end(1);
    await _lastCrewDeliveryForTests();
    expect(readHeld(SID)).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it('a non-crew card keeps today\'s path: the report is held in <sid>.held.json', () => {
    const run = startRun(SID, refOf('login'), 'mac', { root: project });
    if ('refused' in run) throw new Error('refused');
    expect(readHeld(SID)[0]?.pending).toBe(true);
    expect(readOwnerReceipts(target)).toEqual([]);
  });
});

describe('K6 after a restart', () => {
  it('mid-run restart, first run: one cut-off notice built from the record\'s command; the slot says cut off', async () => {
    const l = crew('login');
    const run = startRun(SID, l.handle.cardRef, 'mac', { root: project });
    if ('refused' in run) throw new Error('refused');
    restartServer();
    const cmd = (ref: string) => (ref === l.handle.cardRef ? RUN.command : null);
    const notes = takeInterruptedNotices(target, cmd);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain(RUN.command);
    expect(notes[0].text.endsWith(CUT_OFF_NOTICE_TAIL)).toBe(true);
    expect(takeInterruptedNotices(target, cmd)).toEqual([]);
    const GET = { host: '127.0.0.1:4173', 'sec-fetch-site': 'same-origin', [OWNER_KEY_HEADER]: KEY };
    const s = await call(handleCardState, 'GET', `/api/agent/cards/state?session=${SID}&card=${l.handle.cardRef}`, undefined, GET);
    expect(s.body.cutOff).toBe(true);
    // ▶ Run again after the restart: a fresh proven entry, delivered; the stale placeholder goes with it.
    const again = startRun(SID, l.handle.cardRef, 'mac', { root: project, rerun: true });
    if ('refused' in again) throw new Error(again.refused);
    ptys.at(-1)!.pty.end(0);
    await _lastCrewDeliveryForTests();
    expect(delivered).toHaveLength(1);
    expect(readOwnerReceipts(target)).toEqual([]);
  });

  it('mid-run restart of a rerun after delivery: one notice; a hand-written pending entry for an unknown card sends nothing', async () => {
    const l = crew('login', false);
    const first = startRun(SID, l.handle.cardRef, 'mac', { root: project });
    if ('refused' in first) throw new Error('refused');
    ptys[0].pty.end(0);
    await _lastCrewDeliveryForTests();
    expect(delivered).toHaveLength(1);
    const rerun = startRun(SID, l.handle.cardRef, 'mac', { root: project, rerun: true });
    if ('refused' in rerun) throw new Error(rerun.refused);
    restartServer();
    holdOwnerReceipt(target, { id: 'forged', cardRef: 'f'.repeat(32), kind: 'run', text: 'rm -rf', pending: true });
    _restartOwnerReceiptsForTests();
    const cmd = (ref: string) => (ref === l.handle.cardRef ? RUN.command : null);
    expect(takeInterruptedNotices(target, cmd)).toHaveLength(1);
    expect(takeInterruptedNotices(target, cmd)).toHaveLength(0);
  });

  it('secret re-entry: Enter again on the closed record while its result is owed unverified → 200, delivered', async () => {
    crew('key');
    // Held before a restart, never delivered (no deliverer then).
    registerOwnerReceiptDeliverer(async () => 'held');
    await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'v1' }] }, OWNER_PAGE);
    expect(getCard(SID, refOf('key'))?.state).toBe('closed');
    _restartOwnerReceiptsForTests();
    registerOwnerReceiptDeliverer(async (t) => {
      for (const { entry, text } of deliverableOwnerReceipts(t)) { delivered.push({ t, text }); markOwnerReceiptDelivered(t, entry); }
      return 'delivered';
    });
    const curl = await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'v2' }] }, CURL);
    expect(curl.status).toBe(403);
    const r = await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'v2' }] }, OWNER_PAGE);
    expect(r.status).toBe(200);
    expect(delivered).toHaveLength(1);
    // Every older unverified entry for the card went with the proven one.
    expect(readOwnerReceipts(target)).toEqual([]);
    // Nothing owed now: the base 409.
    const again = await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'v3' }] }, OWNER_PAGE);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('card_closed');
  });

  it('secret re-entry is refused when the item is closed, even with an unverified entry', async () => {
    crew('key', false);
    registerOwnerReceiptDeliverer(async () => 'held');
    await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'v1' }] }, OWNER_PAGE);
    _restartOwnerReceiptsForTests();
    const r = await call(handleAgentSecret, 'POST', '/api/agent/secret', { sessionId: SID, cardRef: refOf('key'), entries: [{ key: 'STRIPE_KEY', value: 'v2' }] }, OWNER_PAGE);
    expect(r.status).toBe(409);
  });
});

describe('Not needed', () => {
  it('closes the item through the registered closer and drops what was held for the card', async () => {
    const l = crew('store');
    holdOwnerReceipt(target, { id: 's-1', cardRef: l.handle.cardRef, kind: 'checklist', text: 'kept', full: 'full' });
    const r = await call(handleCardNotNeeded, 'POST', '/api/agent/cards/not-needed', { session: SID, card: l.handle.cardRef }, OWNER_PAGE);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(closed).toEqual(['owner-store']);
    expect(readOwnerReceipts(target)).toEqual([]);
    expect(getCard(SID, l.handle.cardRef)?.state).toBe('closed');
  });

  it('a card nothing waits on is 404', async () => {
    const r = await call(handleCardNotNeeded, 'POST', '/api/agent/cards/not-needed', { session: SID, card: refOf('store') }, OWNER_PAGE);
    expect(r.status).toBe(404);
  });
});
