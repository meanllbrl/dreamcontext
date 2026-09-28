/**
 * THE RESOLVER CONTRACT for the dreamcontext Assistant's hidden vault.
 *
 * Vault resolution is not centralized in this codebase — there are a dozen places that turn a
 * vault name into a path. The hidden `__assistant__` vault must be reachable through exactly
 * TWO of them (the chat upgrade and the generic REST resolver, both only for a loopback caller
 * inside the desktop app) and refused by every other one. This file enumerates each resolver
 * and pins accept/refuse, so a new resolver that forgets the rule — or an old one that loses
 * it — fails here by name.
 *
 * Runs against a scratch HOME (`pattern-test-isolation-injectable`): one real vault
 * (`acme-app`) is registered, and the hidden vault is scaffolded by the real `createAssistant`
 * with a fake CLI runner.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const home = fs.mkdtempSync(`${os.tmpdir()}/assistant-contract-home-`);
  process.env.HOME = home;
  return home;
});

const home = await import('../../src/lib/assistant/home.js');
const { createAssistant } = await import('../../src/server/routes/assistant.js');
const { resolveVaultProjectRoot } = await import('../../src/server/routes/agent-spawn-shared.js');
const { resolveRequestVault } = await import('../../src/server/index.js');
const { resolveVaultContextRoot, addVault, listVaults, vaultsFilePath } = await import('../../src/lib/vaults.js');
const { resolvePeer } = await import('../../src/lib/peer-delivery.js');
const { addConnection } = await import('../../src/lib/connections.js');
const { resolveConnectedVaults } = await import('../../src/lib/federation-recall.js');
const { refreshPeerSummaries } = await import('../../src/lib/federation-peer-summary.js');
const { attachAgentChat } = await import('../../src/server/routes/agent-chat.js');
const { attachAgentTerminal } = await import('../../src/server/routes/agent-terminal.js');
const launcher = await import('../../src/server/routes/launcher.js');
const { handleVaultsGet } = await import('../../src/server/routes/vaults.js');

const NETWORK_TOKEN = 'n'.repeat(43);
const ACME = join(HOME, 'projects', 'acme-app');

function makeRes() {
  let status = 0;
  let body: unknown = null;
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { body = JSON.parse(String(data)); } catch { body = data; } },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body as Record<string, unknown> };
}

function req(opts: { method?: string; url: string; remote?: string; headers?: Record<string, string>; body?: unknown }): IncomingMessage {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  return Object.assign(Readable.from(payload), {
    method: opts.method ?? 'GET',
    url: opts.url,
    headers: { host: '127.0.0.1:4173', ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

/** Drive a WS upgrade handler with a fake server/socket and read the status it answered. */
function upgradeStatus(attach: (s: import('node:http').Server) => void, url: string, remote: string, headers?: Record<string, string>): number | 'accepted' {
  const server = Object.assign(new EventEmitter(), { address: () => ({ port: 4173 }) });
  attach(server as unknown as import('node:http').Server);
  let written = '';
  // An inert stream double: an ACCEPTED upgrade reaches the real `ws` handshake after the
  // status is read, and `ws` wires listeners on the socket — without these it throws an
  // unhandled rejection into whichever test runs next.
  const socket: Record<string, unknown> = { write: (s: string) => { written += s; }, destroy: () => {}, writable: false, readable: false };
  for (const fn of ['on', 'once', 'off', 'removeListener', 'end', 'setTimeout', 'setNoDelay', 'setKeepAlive', 'pause', 'resume']) socket[fn] = () => socket;
  server.emit('upgrade', req({ url, remote, headers }), socket, Buffer.alloc(0));
  const m = /^HTTP\/1\.1 (\d{3})/.exec(written);
  return m ? Number(m[1]) : 'accepted';
}

let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  savedEnv = { DREAMCONTEXT_DESKTOP: process.env.DREAMCONTEXT_DESKTOP, DREAMCONTEXT_REMOTE: process.env.DREAMCONTEXT_REMOTE };
  process.env.DREAMCONTEXT_DESKTOP = '1';
  mkdirSync(join(ACME, '_dream_context', 'state'), { recursive: true });
  addVault('acme-app', ACME, HOME);
  // The real create path, with a fake runner standing in for `dreamcontext init` + `setup`.
  await createAssistant({ name: 'Nova', character: 'Terse.' }, async (args, cwd) => {
    if (args[0] === 'init') {
      mkdirSync(join(cwd, '_dream_context', 'core'), { recursive: true });
      writeFileSync(join(cwd, '_dream_context', 'core', '0.soul.md'), '---\nname: Nova\n---\n\n## Project Identity\n\nx\n');
    }
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('the hidden vault exists but is registered nowhere', () => {
  it('is scaffolded under ~/.dreamcontext/assistant and NEVER written to vaults.json', () => {
    expect(existsSync(join(HOME, '.dreamcontext', 'assistant', '_dream_context'))).toBe(true);
    expect(readFileSync(vaultsFilePath(HOME), 'utf-8')).not.toContain('__assistant__');
    expect(listVaults(HOME).map((v) => v.name)).toEqual(['acme-app']);
  });

  it('never appears in the Launcher list / ⌘P switcher source (GET /api/vaults)', async () => {
    const r = makeRes();
    await handleVaultsGet(req({ url: '/api/vaults' }), r.res, {}, null as unknown as string);
    expect(JSON.stringify(r.body())).not.toContain('__assistant__');
  });

  it('the character landed in the soul, under one section', () => {
    const soul = readFileSync(join(home.assistantContextRoot(HOME), 'core', '0.soul.md'), 'utf-8');
    expect(soul).toContain('## Character\n\nTerse.');
  });

  it('addVault refuses the reserved name', () => {
    expect(() => addVault('__assistant__', ACME, HOME)).toThrow(/reserved/);
  });
});

describe('ACCEPT — exactly two resolvers, only for loopback + desktop', () => {
  it('resolveVaultProjectRoot maps __assistant__ ONLY when the caller allows it', () => {
    expect(resolveVaultProjectRoot('__assistant__', { allowAssistant: true })).toBe(home.assistantProjectRoot(HOME));
    expect(resolveVaultProjectRoot('__assistant__')).toBeNull();
    expect(resolveVaultProjectRoot('acme-app')).toBe(ACME);
  });

  it('resolveRequestVault (generic REST) maps it for a loopback desktop request', () => {
    expect(resolveRequestVault(req({ url: '/api/agent/chat-history', headers: { 'x-dreamcontext-vault': '__assistant__' } })))
      .toBe(home.assistantContextRoot(HOME));
  });

  it('the chat WS upgrade accepts a loopback desktop caller (past every gate)', () => {
    expect(upgradeStatus((s) => attachAgentChat(s, { networkToken: NETWORK_TOKEN }), '/api/agent/chat?vault=__assistant__', '127.0.0.1')).toBe('accepted');
    // The app's own page sends a loopback Origin — still accepted.
    expect(upgradeStatus((s) => attachAgentChat(s, { networkToken: NETWORK_TOKEN }), '/api/agent/chat?vault=__assistant__', '127.0.0.1', { origin: 'http://127.0.0.1:4173' })).toBe('accepted');
  });
});

describe('REFUSE — the tailnet, a non-desktop server, and every other resolver', () => {
  it('resolveRequestVault: a NON-LOOPBACK request with a VALID network token is refused (403)', () => {
    const r = req({ url: `/api/agent/chat-history?token=${NETWORK_TOKEN}`, remote: '100.64.1.2', headers: { 'x-dreamcontext-vault': '__assistant__', cookie: `dreamcontext_token=${NETWORK_TOKEN}` } });
    expect(resolveRequestVault(r)).toBe('FORBIDDEN');
  });

  it('resolveRequestVault: loopback but NOT the desktop app is refused', () => {
    process.env.DREAMCONTEXT_DESKTOP = '0';
    try {
      expect(resolveRequestVault(req({ url: '/x', headers: { 'x-dreamcontext-vault': '__assistant__' } }))).toBe('FORBIDDEN');
    } finally { process.env.DREAMCONTEXT_DESKTOP = '1'; }
  });

  it('chat WS upgrade: a tailnet peer with remote access ON and a VALID token is refused 403 for __assistant__', () => {
    process.env.DREAMCONTEXT_REMOTE = '1';
    try {
      const url = `/api/agent/chat?vault=__assistant__&token=${NETWORK_TOKEN}`;
      expect(upgradeStatus((s) => attachAgentChat(s, { networkToken: NETWORK_TOKEN }), url, '100.64.1.2')).toBe(403);
      // Control: the SAME peer and token pass the trust gate for an ordinary vault name (and
      // only then fail as an unknown vault) — so the 403 above is the assistant branch.
      const control = `/api/agent/chat?vault=not-a-vault&token=${NETWORK_TOKEN}`;
      expect(upgradeStatus((s) => attachAgentChat(s, { networkToken: NETWORK_TOKEN }), control, '100.64.1.2')).toBe(400);
    } finally { delete process.env.DREAMCONTEXT_REMOTE; }
  });

  it('chat WS upgrade: a WEBSITE the owner visits (loopback, foreign Origin) is refused 403 for __assistant__', () => {
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1.evil.example']) {
      expect(upgradeStatus((s) => attachAgentChat(s, { networkToken: NETWORK_TOKEN }), '/api/agent/chat?vault=__assistant__', '127.0.0.1', { origin }), origin).toBe(403);
    }
  });

  it('the terminal WS upgrade refuses __assistant__ by name (403), even from loopback', () => {
    expect(upgradeStatus((s) => attachAgentTerminal(s), '/api/agent/terminal?vault=__assistant__', '127.0.0.1')).toBe(403);
  });

  it('resolveVaultContextRoot refuses early — the raw-path fallback cannot resolve it', () => {
    const cwd = process.cwd();
    const scratch = mkdtempSync(join(tmpdir(), 'assistant-cwd-'));
    // Even a folder literally named __assistant__ in the cwd, with a brain inside, is refused.
    mkdirSync(join(scratch, '__assistant__', '_dream_context'), { recursive: true });
    process.chdir(scratch);
    try {
      expect(() => resolveVaultContextRoot('__assistant__', HOME)).toThrow(/Assistant/);
    } finally { process.chdir(cwd); }
  });

  it('peer delivery (resolvePeer) refuses it', () => {
    expect(() => resolvePeer('__assistant__', HOME)).toThrow();
  });

  it('connections refuse it as a peer', () => {
    expect(() => addConnection(join(ACME, '_dream_context'), 'acme-app', '__assistant__', 'both', null, HOME)).toThrow();
  });

  it('federation resolves no __assistant__ target and peer summaries never list it', () => {
    const targets = resolveConnectedVaults({ name: 'acme-app', path: ACME }, join(ACME, '_dream_context'), HOME);
    expect(targets.map((t) => t.name)).not.toContain('__assistant__');
    const peers = refreshPeerSummaries(join(ACME, '_dream_context'), HOME);
    expect(peers.map((p) => p.vault)).not.toContain('__assistant__');
  });

  it('every launcher.ts vault lookup answers unknown_vault', async () => {
    const cases: Array<[string, (rq: IncomingMessage, rs: ServerResponse) => Promise<void>, IncomingMessage]> = [
      ['logo (GET)', (a, b) => launcher.handleLauncherLogo(a, b, {}, null), req({ url: '/api/launcher/logo?vault=__assistant__' })],
      ['logo (set)', (a, b) => launcher.handleLauncherLogoSet(a, b, {}, null), req({ method: 'POST', url: '/api/launcher/logo?vault=__assistant__', body: {} })],
      ['update', (a, b) => launcher.handleLauncherUpdate(a, b, {}, null), req({ method: 'POST', url: '/api/launcher/update', body: { name: '__assistant__' } })],
      ['connection create', (a, b) => launcher.handleLauncherConnectionCreate(a, b, {}, null), req({ method: 'POST', url: '/x', body: { from: '__assistant__', to: 'acme-app', direction: 'both' } })],
      ['connection remove', (a, b) => launcher.handleLauncherConnectionRemove(a, b, {}, null), req({ method: 'POST', url: '/x', body: { from: '__assistant__', to: 'acme-app' } })],
      ['sync create (vaultRoot)', (a, b) => launcher.handleLauncherSyncCreate(a, b, {}, null), req({ method: 'POST', url: '/x', body: { from: 'acme-app', to: '__assistant__' } })],
    ];
    for (const [name, handler, rq] of cases) {
      const r = makeRes();
      await handler(rq, r.res);
      expect(r.status(), name).toBeGreaterThanOrEqual(400);
      expect(r.status(), name).toBeLessThan(500);
    }
  });
});
