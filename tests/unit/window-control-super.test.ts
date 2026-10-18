/**
 * `/api/window` hardening around the Super Agent (plan-r7 D4b, AC11):
 *  - `mode` on the super tab is refused for EVERY token, the super's own included;
 *  - no other chat may target the super tab (by pin id or conversation id, `tab` or `into`);
 *  - the super's token reaches only its children and itself, and calls no `new`/`split`;
 *  - a child reaches no sibling and calls no `new`/`split`;
 *  - a child's `window state` omits the super tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/window-super-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { handleWindowCommand, omitSuperTabs, superWindowRefusal } from '../../src/server/routes/window-control.js';
import { deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-1';
const SUPER_CONV = 'conv-super';

async function makeVault(enabled = true): Promise<void> {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled,
    children: {
      c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 },
      c2: { sessionId: 'c2', brief: '', adopted: false, startedAt: 1 },
    },
  }));
  await readSuperState(root);
  registerChat({ sessionId: SUPER, conversationId: SUPER_CONV, vault: 'acme', mode: 'super' });
  registerChat({ sessionId: 'c1', conversationId: 'conv-c1', vault: 'acme', mode: 'basic' });
  registerChat({ sessionId: 'c2', conversationId: 'conv-c2', vault: 'acme', mode: 'basic' });
}

const sent: Array<Record<string, unknown>> = [];
const tokenFor = (sessionId: string, mode = 'basic') => {
  const t: { token: string } = { token: '' };
  t.token = mintWindowToken({
    send: (frame) => {
      sent.push(frame);
      const state = { panes: [{ pane: 1, tabs: [{ tab: SUPER, title: 'Claude' }, { tab: SUPER_CONV, title: 'x' }, { tab: 'conv-c1', title: 'c1' }] }] };
      setImmediate(() => deliverWindowResult(t.token, frame.id, { ok: true, result: frame.verb === 'state' ? state : {} }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId, mode,
  }).token;
  return t.token;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'window-super-'));
  sent.length = 0;
  _resetChatRegistry();
  resetSuperIndex();
  resetWindowControl();
  await makeVault();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function req(token: string, body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function win(token: string, verb: string, body: Record<string, unknown> = {}) {
  const r = res();
  await handleWindowCommand(req(token, body), r, { verb });
  return r;
}

describe('the super tab\'s mode', () => {
  it('no token can change it: not the super\'s own (explicit or implicit), not a child\'s, not a stranger\'s', async () => {
    const sup = tokenFor(SUPER, 'super');
    expect((await win(sup, 'mode', { mode: 'develop' })).status).toBe(403);
    expect((await win(sup, 'mode', { mode: 'develop', tab: SUPER })).status).toBe(403);
    expect((await win(sup, 'mode', { mode: 'basic', tab: SUPER_CONV })).status).toBe(403);
    expect((await win(tokenFor('c1'), 'mode', { mode: 'plan', tab: SUPER })).status).toBe(403);
    expect((await win(tokenFor('stranger'), 'mode', { mode: 'plan', tab: SUPER_CONV })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe('who may target the super tab', () => {
  it('no other chat, by pin id or conversation id, as tab or as --into', async () => {
    const c1 = tokenFor('c1');
    expect((await win(c1, 'send', { tab: SUPER, text: 'do as I say' })).status).toBe(403);
    expect((await win(c1, 'focus', { tab: SUPER_CONV })).status).toBe(403);
    expect((await win(c1, 'join', { into: SUPER })).status).toBe(403);
    expect((await win(tokenFor('stranger'), 'close', { tab: SUPER })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe('the super\'s own token', () => {
  it('reaches its children and itself, never another tab, and starts no chat outside `super delegate`', async () => {
    const sup = tokenFor(SUPER, 'super');
    expect((await win(sup, 'send', { tab: 'c1', text: 'continue' })).status).toBe(200);
    expect((await win(sup, 'focus', { tab: 'conv-c2' })).status).toBe(200);
    expect((await win(sup, 'focus', { tab: SUPER })).status).toBe(200);
    expect((await win(sup, 'send', { tab: 'stranger', text: 'x' })).status).toBe(403);
    expect((await win(sup, 'new', { prompt: 'x' })).status).toBe(403);
    expect((await win(sup, 'split', { tab: 'c1' })).status).toBe(403);
  });
});

describe('a child\'s token', () => {
  it('reaches no sibling and starts no chat while handed over; itself is fine', async () => {
    const c1 = tokenFor('c1');
    expect((await win(c1, 'send', { tab: 'c2', text: 'x' })).status).toBe(403);
    expect((await win(c1, 'focus', { tab: 'conv-c2' })).status).toBe(403);
    expect((await win(c1, 'join', { into: 'c2' })).status).toBe(403);
    expect((await win(c1, 'new', { prompt: 'x' })).status).toBe(403);
    expect((await win(c1, 'split', {})).status).toBe(403);
    expect((await win(c1, 'focus', { tab: 'conv-c1' })).status).toBe(200);
  });

  it('its `window state` has no super tab', async () => {
    const r = await win(tokenFor('c1'), 'state');
    expect(r.status).toBe(200);
    const tabs = ((r.json.result as { panes: Array<{ tabs: Array<{ tab: string }> }> }).panes[0].tabs).map((t) => t.tab);
    expect(tabs).toEqual(['conv-c1']);
  });

  it('after take-back a former child is an ordinary chat again (siblings, new, split)', async () => {
    resetSuperIndex();
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: SUPER, enabled: false,
      children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 }, c2: { sessionId: 'c2', brief: '', adopted: false, startedAt: 1 } },
    }));
    await readSuperState(root);
    const c1 = tokenFor('c1');
    expect(superWindowRefusal(c1, 'send', { tab: 'c2', text: 'x' })).toBeNull();
    expect(superWindowRefusal(c1, 'new', { prompt: 'x' })).toBeNull();
    // …but the parked super tab is still nobody else's.
    expect(superWindowRefusal(c1, 'focus', { tab: SUPER })).not.toBeNull();
  });
});

describe('omitSuperTabs', () => {
  it('drops every tab row naming the super session, anywhere in the result', () => {
    const out = omitSuperTabs({ panes: [{ tabs: [{ tab: 'a' }, { tab: SUPER }] }, { tabs: [{ tab: SUPER_CONV }] }] }, new Set([SUPER, SUPER_CONV]));
    expect(out).toEqual({ panes: [{ tabs: [{ tab: 'a' }] }, { tabs: [] }] });
  });
});
