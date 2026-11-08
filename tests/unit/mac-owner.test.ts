import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isMacOwnerRequest } from '../../src/server/mac-owner.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { readFileSync } from 'node:fs';
import { isOwnerWords, macOwnerTurn, noteOwnerAtMac, onOwnerAtMac } from '../../src/lib/telegram/back-at-mac.js';

/** "Back at the Mac" rests on what the server sees of the request, never on a flag anyone sends. */

const HOST = '127.0.0.1:4173';
function req(o: { addr?: string; origin?: string | null; host?: string; site?: string; phone?: boolean } = {}): IncomingMessage {
  const socket = { remoteAddress: o.addr ?? '127.0.0.1' };
  if (o.phone) markPhoneSocket(socket);
  const headers: Record<string, string> = { host: o.host ?? HOST };
  if (o.origin !== null) headers.origin = o.origin ?? `http://${HOST}`;
  if (o.site) headers['sec-fetch-site'] = o.site;
  return { socket, headers } as unknown as IncomingMessage;
}

let desktop: string | undefined;
beforeEach(() => { desktop = process.env.DREAMCONTEXT_DESKTOP; process.env.DREAMCONTEXT_DESKTOP = '1'; });
afterEach(() => { if (desktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = desktop; });

describe('isMacOwnerRequest', () => {
  it('the app page on this Mac: loopback, same origin, Origin present', () => {
    expect(isMacOwnerRequest(req())).toBe(true);
  });

  it('the phone link is not the Mac, although cloudflared dials from 127.0.0.1', () => {
    expect(isMacOwnerRequest(req({ phone: true }))).toBe(false);
  });

  it('a tailnet device is not the Mac', () => {
    expect(isMacOwnerRequest(req({ addr: '100.64.0.7', host: '100.64.0.1:4173', origin: 'http://100.64.0.1:4173' }))).toBe(false);
  });

  it('a CLI or an agent\'s curl sends no Origin: not the owner at the Mac', () => {
    expect(isMacOwnerRequest(req({ origin: null }))).toBe(false);
  });

  it('a foreign page or a cross-site fetch is not the Mac', () => {
    expect(isMacOwnerRequest(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(isMacOwnerRequest(req({ site: 'cross-site' }))).toBe(false);
  });

  it('outside the desktop app nothing counts', () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect(isMacOwnerRequest(req())).toBe(false);
  });
});

describe('back-at-mac signal', () => {
  it('tells every listener; a throwing one does not stop the rest', () => {
    const got: number[] = [];
    const off1 = onOwnerAtMac(() => { throw new Error('x'); });
    const off2 = onOwnerAtMac((at) => got.push(at));
    noteOwnerAtMac(42);
    off1(); off2();
    noteOwnerAtMac(43);
    expect(got).toEqual([42]);
  });

  it('owner words: not empty, not a slash command', () => {
    expect(isOwnerWords('  ')).toBe(false);
    expect(isOwnerWords('/compact')).toBe(false);
    expect(isOwnerWords('Mac\'ten yazdım')).toBe(true);
  });
});

describe('one owner turn: macOwnerTurn', () => {
  const turn = (o: Partial<{ typedAtMac: boolean; telegram: boolean; server: boolean; text: string }>) =>
    macOwnerTurn({ typedAtMac: true, telegram: false, server: false, text: 'Mac\'ten yazdım', ...o });
  it('his composer send on the Mac counts; nothing else does', () => {
    expect(turn({})).toBe(true);
    expect(turn({ typedAtMac: false })).toBe(false); // phone link, a mirror, a queue drain, an agent send
    expect(turn({ telegram: true })).toBe(false);
    expect(turn({ server: true })).toBe(false); // a usage-reset continue, a run report
    expect(turn({ text: '' })).toBe(false);
    expect(turn({ text: '/compact' })).toBe(false);
  });
});

// The wiring is read from source: the chat route is a 6000-line socket handler whose owner path
// cannot be driven without a CLI child. What must hold is pinned here.
describe('the wiring that makes it "any chat, typed now"', () => {
  const chat = readFileSync(new URL('../../src/server/routes/agent-chat.ts', import.meta.url), 'utf-8');
  const session = readFileSync(new URL('../../dashboard/src/components/sleepy/chatSession.ts', import.meta.url), 'utf-8');
  const composer = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/Composer.tsx', import.meta.url), 'utf-8');

  it('the server needs the page\'s composer mark AND the socket\'s Mac facts, never a mirror frame', () => {
    expect(chat).toMatch(/const typedAtMac = msg\.typed === true && !\(typeof raw !== 'string' && mirrorFrames\.has\(raw\)\) && socketMac\.get\(ws\) === true;/);
    expect(chat).toMatch(/socketMac\.set\(ws, !phone && isMacOwnerRequest\(req\)\);/);
  });

  it('the signal fires in writeOwnerTurn for every chat kind, not behind the registry (the Assistant and card chats have none)', () => {
    const body = chat.slice(chat.indexOf('const writeOwnerTurn = (raw: string, typedAtMac = false)'));
    const fn = body.slice(0, body.indexOf('\n  };\n'));
    expect(fn).toMatch(/\n    if \(macOwnerTurn\(\{ typedAtMac, telegram: !!tgSource, server: serverContinue \|\| isServerTurnText\(text\), text \}\)\) noteOwnerAtMac\(\);/);
  });

  it('only the composer\'s send and a row\'s "Send now" carry the mark; the queue drain and agent deliveries do not', () => {
    expect(session).toMatch(/\.\.\.\(opts\.typed \? \{ typed: true as const \} : \{\}\)/);
    expect(composer).toMatch(/session\.steer\(message, TYPED_NOW\)/);
    expect(composer).toMatch(/session\.send\(message, TYPED_NOW\)/);
    expect(session).toMatch(/steer\(row\.text, TYPED\) : send\(row\.text, TYPED\)/);
    // maybeFlushQueue: the drain sends plain.
    expect(session).toMatch(/if \(!steer\(owed\.text\)\)/);
    expect(session).toMatch(/if \(!send\(next\.text\)\)/);
    const deliver = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/postToSession.ts', import.meta.url), 'utf-8');
    expect(deliver).not.toMatch(/typed/);
  });
});
