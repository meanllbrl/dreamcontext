/**
 * W4 — a detail button in a notch answer opens THAT project's window on the right page.
 *
 * The button carries `vault` (`chatActions.toAction`); the notch posts it to the owner route
 * `POST /api/assistant/open`, which mints an ordinary `open` relay command — so a click reaches a
 * project through the same claimed, nonce-bound path as the assistant's own verbs.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const h = fs.mkdtempSync(`${os.tmpdir()}/assistant-detail-home-`);
  process.env.HOME = h;
  return h;
});

const { toAction } = await import('../../dashboard/src/components/sleepy/chat/chatActions');
const routes = await import('../../src/server/routes/assistant.js');
const { addVault } = await import('../../src/lib/vaults.js');

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { body = JSON.parse(String(data)); } catch { body = {}; } },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function post(body: unknown, remote = '127.0.0.1'): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url: '/api/assistant/open',
    headers: { host: '127.0.0.1:4173', 'content-type': 'application/json' },
    socket: { remoteAddress: remote, setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

describe('the button: dream-actions carry the project', () => {
  it('a task / knowledge / core button keeps a project name', () => {
    expect(toAction({ label: 'Open', action: 'task', id: 'fix-login', vault: 'acme app' }))
      .toEqual({ label: 'Open', action: 'task', id: 'fix-login', vault: 'acme app' });
    expect(toAction({ label: 'Doc', action: 'knowledge', id: 'auth', vault: 'acme' })?.vault).toBe('acme');
  });
  it('a path-shaped project is dropped — the button still opens its page locally', () => {
    for (const vault of ['../etc', 'a/b', 'x.y', 'c:\\\\d', '']) {
      const a = toAction({ label: 'Open', action: 'task', id: 'fix-login', vault });
      expect(a).toEqual({ label: 'Open', action: 'task', id: 'fix-login' });
    }
  });
  it('other kinds never carry one', () => {
    expect(toAction({ label: 'Ask', action: 'ask', text: 'hi', vault: 'acme' })).toEqual({ label: 'Ask', action: 'ask', text: 'hi' });
  });
});

describe('the owner route POST /api/assistant/open', () => {
  beforeAll(() => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const root = join(HOME, 'projects', 'acme');
    mkdirSync(join(root, '_dream_context'), { recursive: true });
    addVault('acme', root, HOME);
  });
  const run = async (body: unknown, remote?: string) => {
    const r = makeRes();
    await routes.handleAssistantOpen(post(body, remote), r.res);
    return r;
  };

  it('refuses a non-loopback caller', async () => {
    expect((await run({ vault: 'acme', page: 'tasks/x' }, '100.64.1.2')).status()).toBe(403);
  });
  it('refuses an unknown project and a page outside tasks|knowledge|core', async () => {
    const unknown = await run({ vault: 'nope', page: 'tasks/x' });
    expect(unknown.status()).toBe(400);
    for (const page of ['settings/x', 'tasks/../x', 'tasks/a/b']) {
      const r = await run({ vault: 'acme', page });
      expect(r.status(), page).toBe(400);
      expect(r.body()).toMatchObject({ error: 'invalid_args' });
    }
  });
  it('a valid click is relayed — with no notch listening it is no_surface (409), never a direct window write', async () => {
    const r = await run({ vault: 'acme', page: 'tasks/fix-login' });
    expect(r.status()).toBe(409);
    expect(r.body()).toMatchObject({ ok: false, error: 'no_surface' });
  });
});
