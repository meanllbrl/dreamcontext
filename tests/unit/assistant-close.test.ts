/**
 * `dreamcontext assistant close` through the real route: one session or a filtered set, never
 * the Assistant's own chat or a gone one, idle chats closed directly, busy ones skipped (or a
 * 409 for a single named one) unless `--force` — and a forced close of a busy chat is a notch
 * proposal below bypass, with every status re-read after the owner decides.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const h = fs.mkdtempSync(`${os.tmpdir()}/assistant-close-home-`);
  process.env.HOME = h;
  return h;
});

/** The window side of the relay: every close lands, unless a test says otherwise. */
const relayCommand = vi.hoisted(() => vi.fn(async (_verb: string, args: Record<string, unknown>) =>
  ({ ok: true as const, result: { sessionId: args.sessionId, closed: true } as unknown })));
vi.mock('../../src/lib/assistant/relay.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/assistant/relay.js')>()),
  relayCommand,
}));
const dismissDelegation = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/lib/assistant/delegations.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/assistant/delegations.js')>()),
  dismissDelegation,
}));

const state = await import('../../src/lib/assistant/session-state.js');
const { listProposals, resolveProposal } = await import('../../src/lib/assistant/proposals.js');
const { registerChat, _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { writeAssistantConfig } = await import('../../src/lib/assistant/home.js');
const { addVault } = await import('../../src/lib/vaults.js');
const routes = await import('../../src/server/routes/assistant.js');

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { res.writableEnded = true; try { body = JSON.parse(String(data)); } catch { body = {}; } },
  });
  return { res: res as unknown as ServerResponse, status: () => status, body: () => body };
}

function tokenReq(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', url: '/api/assistant/ui/close',
    headers: { host: '127.0.0.1:4173', 'x-dreamcontext-assistant-token': state.assistantToken() },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

const close = (body: unknown, r = makeRes()) => routes.handleAssistantUi(tokenReq(body), r.res, { verb: 'close' }).then(() => r);

/** A chat that finished its turn. */
function idle(sessionId: string, vault: string) {
  const h = registerChat({ sessionId, conversationId: null, vault, mode: 'basic' });
  h.userSent('do it');
  h.observe({ type: 'result' });
  return h;
}
/** A chat mid-turn. */
function working(sessionId: string, vault: string) {
  const h = registerChat({ sessionId, conversationId: null, vault, mode: 'basic' });
  h.userSent('do it');
  return h;
}

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  for (const name of ['alpha-app', 'beta-app']) {
    const root = join(HOME, 'p', name);
    mkdirSync(join(root, '_dream_context'), { recursive: true });
    addVault(name, root, HOME);
  }
  mkdirSync(join(HOME, '.dreamcontext', 'assistant', '_dream_context'), { recursive: true });
});

beforeEach(() => {
  state._resetAssistantState();
  _resetChatRegistry();
  relayCommand.mockClear();
  dismissDelegation.mockClear();
  writeAssistantConfig({ name: 'Nova', autonomy: 'auto' }, HOME);
});

describe('assistant close — the route', () => {
  it('a single idle chat closes directly, over the relay, and its delegation is dismissed', async () => {
    idle('a1', 'alpha-app');
    const r = await close({ sessionId: 'a1' });
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({ ok: true, closed: [{ sessionId: 'a1', vault: 'alpha-app' }], skipped: [], failed: [], summary: 'closed 1 of 1' });
    expect(relayCommand).toHaveBeenCalledWith('close', { sessionId: 'a1', vault: 'alpha-app' });
    expect(dismissDelegation).toHaveBeenCalledWith('a1');
    expect(listProposals()).toHaveLength(0);
  });

  it('a single BUSY chat without --force is a 409 session_busy that tells it to ask the owner', async () => {
    working('a2', 'alpha-app');
    const r = await close({ sessionId: 'a2' });
    expect(r.status()).toBe(409);
    expect(r.body()).toMatchObject({ error: 'session_busy' });
    expect(String(r.body().message)).toMatch(/busy: working — confirm with the owner, then re-run with --force/);
    expect(relayCommand).not.toHaveBeenCalled();
  });

  it('bulk with mixed statuses: idle closed, busy skipped with its reason', async () => {
    idle('a1', 'alpha-app');
    working('a2', 'alpha-app');
    idle('b1', 'beta-app');
    const r = await close({ vault: 'alpha-app' });
    expect(r.status()).toBe(200);
    expect(r.body().closed).toEqual([{ sessionId: 'a1', vault: 'alpha-app' }]);
    expect(r.body().skipped).toEqual([{ sessionId: 'a2', vault: 'alpha-app', status: 'working', reason: 'busy: working — confirm with the owner, then re-run with --force' }]);
    expect(r.body()).toMatchObject({ ok: true, failed: [], summary: 'closed 1 of 2' });
    expect(relayCommand).toHaveBeenCalledTimes(1);
  });

  it('never closes the Assistant\'s own chat, nor a gone one', async () => {
    idle('own', '__assistant__');
    idle('a1', 'alpha-app');
    idle('gone-1', 'beta-app').exited();
    const r = await close({ status: 'idle' });
    expect(r.body().closed).toEqual([{ sessionId: 'a1', vault: 'alpha-app' }]);
    expect(relayCommand).toHaveBeenCalledTimes(1);

    const own = await close({ sessionId: 'own' });
    expect(own.status()).toBe(400);
    expect(String(own.body().message)).toMatch(/its own chat/);
  });

  it('nothing to close is a plain ok', async () => {
    const r = await close({ vault: 'beta-app' });
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({ ok: true, closed: [], skipped: [], failed: [], summary: 'nothing to close' });
  });

  it('refuses with no target, an unknown project or status, and 404s an unknown session', async () => {
    for (const body of [{}, { force: true }, { vault: 'nope' }, { status: 'gone' }]) {
      const r = await close(body);
      expect(r.status(), JSON.stringify(body)).toBe(400);
      expect(r.body()).toMatchObject({ error: 'invalid_args' });
    }
    const r = await close({ sessionId: 'missing' });
    expect(r.status()).toBe(404);
    expect(r.body()).toMatchObject({ error: 'unknown_session' });
  });

  it('--force on a busy chat under auto is a notch PROPOSAL, even clean; approved, it closes', async () => {
    working('a2', 'alpha-app');
    const r = makeRes();
    const running = close({ sessionId: 'a2', force: true }, r);
    await vi.waitFor(() => expect(listProposals()).toHaveLength(1));
    const [p] = listProposals();
    expect(p).toMatchObject({ verb: 'close', target: 'alpha-app · a2' });
    expect(p.provenance).toMatch(/forced close/);
    expect(relayCommand).not.toHaveBeenCalled();
    resolveProposal(p.id, 'approve');
    await running;
    expect(r.body()).toMatchObject({ ok: true, approved: true, closed: [{ sessionId: 'a2', vault: 'alpha-app' }] });
  });

  it('--force on a busy chat under bypass closes without asking', async () => {
    writeAssistantConfig({ autonomy: 'bypass' }, HOME);
    working('a2', 'alpha-app');
    const r = await close({ sessionId: 'a2', force: true });
    expect(listProposals()).toHaveLength(0);
    expect(r.body()).toMatchObject({ ok: true, closed: [{ sessionId: 'a2', vault: 'alpha-app' }] });
  });

  it('status is RE-READ after approval: a chat that started working meanwhile is skipped', async () => {
    const h = idle('a1', 'alpha-app');
    state.markTainted();
    const r = makeRes();
    const running = close({ sessionId: 'a1' }, r);
    await vi.waitFor(() => expect(listProposals()).toHaveLength(1));
    h.userSent('one more thing');
    resolveProposal(listProposals()[0].id, 'approve');
    await running;
    expect(relayCommand).not.toHaveBeenCalled();
    expect(r.body()).toMatchObject({ ok: false, closed: [], skipped: [{ sessionId: 'a1', status: 'working' }] });
  });

  it('--force on chats idle when listed: one working by approval is skipped, not closed', async () => {
    const h = idle('a1', 'alpha-app');
    state.markTainted();
    const r = makeRes();
    const running = close({ sessionId: 'a1', force: true }, r);
    await vi.waitFor(() => expect(listProposals()).toHaveLength(1));
    expect(listProposals()[0].text).toContain('alpha-app · a1 (idle)');
    h.userSent('one more thing');
    resolveProposal(listProposals()[0].id, 'approve');
    await running;
    expect(relayCommand).not.toHaveBeenCalled();
    expect(r.body()).toMatchObject({ ok: false, closed: [], skipped: [{ sessionId: 'a1', status: 'working' }] });
    expect(String((r.body().skipped as Array<{ reason: string }>)[0].reason)).toMatch(/^became busy: working since it was listed/);
  });

  it('--force, all idle and clean: a chat that starts working mid-loop is skipped, not closed', async () => {
    idle('a1', 'alpha-app');
    const h2 = idle('a2', 'alpha-app');
    // The first close's relay is where the second chat starts a turn.
    relayCommand.mockImplementationOnce(async (_v, args) => { h2.userSent('go'); return { ok: true, result: { sessionId: args.sessionId, closed: true } }; });
    const r = await close({ vault: 'alpha-app', force: true });
    expect(listProposals()).toHaveLength(0);
    expect(relayCommand).toHaveBeenCalledTimes(1);
    expect(r.body().closed).toEqual([{ sessionId: 'a1', vault: 'alpha-app' }]);
    expect(r.body().skipped).toMatchObject([{ sessionId: 'a2', status: 'working' }]);
  });

  it('without --force, a chat busy when listed stays skipped even if it is idle by approval', async () => {
    idle('a1', 'alpha-app');
    const h2 = working('a2', 'alpha-app');
    state.markTainted();
    const r = makeRes();
    const running = close({ vault: 'alpha-app' }, r);
    await vi.waitFor(() => expect(listProposals()).toHaveLength(1));
    expect(listProposals()[0].text).not.toContain('a2');
    h2.observe({ type: 'result' });
    resolveProposal(listProposals()[0].id, 'approve');
    await running;
    expect(relayCommand).toHaveBeenCalledTimes(1);
    expect(r.body().closed).toEqual([{ sessionId: 'a1', vault: 'alpha-app' }]);
    expect(r.body().skipped).toMatchObject([{ sessionId: 'a2', status: 'working' }]);
  });

  it('--force with a busy chat in a bulk set under auto is a proposal; approved, the busy one closes', async () => {
    idle('a1', 'alpha-app');
    working('a2', 'alpha-app');
    const r = makeRes();
    const running = close({ vault: 'alpha-app', force: true }, r);
    await vi.waitFor(() => expect(listProposals()).toHaveLength(1));
    expect(listProposals()[0].text).toContain('alpha-app · a2 (working)');
    expect(relayCommand).not.toHaveBeenCalled();
    resolveProposal(listProposals()[0].id, 'approve');
    await running;
    expect(r.body()).toMatchObject({ ok: true, approved: true, skipped: [], failed: [] });
    expect(r.body().closed).toEqual([{ sessionId: 'a1', vault: 'alpha-app' }, { sessionId: 'a2', vault: 'alpha-app' }]);
  });

  it('a relay failure lands in failed; no notch for a single target is a 409', async () => {
    idle('a1', 'alpha-app');
    relayCommand.mockResolvedValueOnce({ ok: false, error: 'no_surface' } as never);
    const r = await close({ sessionId: 'a1' });
    expect(r.status()).toBe(409);
    expect(r.body()).toMatchObject({ ok: false, failed: [{ sessionId: 'a1', vault: 'alpha-app', error: 'no_surface' }] });
    expect(dismissDelegation).not.toHaveBeenCalled();
  });
});
