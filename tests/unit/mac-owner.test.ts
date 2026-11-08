import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { handleMacOwnerInput, isMacOwnerRequest, noteMacOwnerInput } from '../../src/server/mac-owner.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { readFileSync } from 'node:fs';
import { isOwnerWords, noteOwnerAtMac, onOwnerAtMac } from '../../src/lib/telegram/back-at-mac.js';

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

/** Count the "back at the Mac" signals a block of code raises. */
function signals(run: () => void): number {
  let n = 0;
  const off = onOwnerAtMac(() => { n += 1; });
  try { run(); } finally { off(); }
  return n;
}
function fakeRes(): ServerResponse & { status?: number; body?: string } {
  const r = {
    writeHead(code: number) { r.status = code; return r; },
    end(b?: string) { r.body = b; },
  } as unknown as ServerResponse & { status?: number; body?: string };
  return r;
}
const withResume = (r: IncomingMessage) => Object.assign(r, { resume: () => r });

describe('THE one gate: noteMacOwnerInput', () => {
  it('the app page on this Mac counts', () => {
    expect(signals(() => noteMacOwnerInput(req()))).toBe(1);
    expect(signals(() => noteMacOwnerInput(req(), 'Mac\'ten yazdım'))).toBe(1);
  });

  it('must not count: the phone link, a tailnet device, a client with no Origin', () => {
    expect(signals(() => noteMacOwnerInput(req({ phone: true }), 'telefondan yazdım'))).toBe(0);
    expect(signals(() => noteMacOwnerInput(req({ addr: '100.64.0.7', host: '100.64.0.1:4173', origin: 'http://100.64.0.1:4173' })))).toBe(0);
    expect(signals(() => noteMacOwnerInput(req({ origin: null }), 'agent curl'))).toBe(0);
  });

  it('known words that are not his: empty, a slash command', () => {
    expect(signals(() => noteMacOwnerInput(req(), '   '))).toBe(0);
    expect(signals(() => noteMacOwnerInput(req(), '/compact'))).toBe(0);
  });

  it('POST /api/mac-owner/input (phone policy: deny): counts for the Mac page, not for the phone link; the answer is the same', () => {
    const mac = fakeRes();
    expect(signals(() => { void handleMacOwnerInput(withResume(req()), mac); })).toBe(1);
    const phone = fakeRes();
    expect(signals(() => { void handleMacOwnerInput(withResume(req({ phone: true })), phone); })).toBe(0);
    expect([mac.status, mac.body]).toEqual([200, '{"ok":true}']);
    expect([phone.status, phone.body]).toEqual([200, '{"ok":true}']);
  });
});

// The page's half: one call, from the two owner-input surfaces only.
const post = vi.fn((_path: string, _body: unknown) => Promise.resolve({ ok: true }));
vi.mock('../../dashboard/src/api/client', () => ({ api: { post: (p: string, b: unknown) => post(p, b) } }));

describe('the page\'s one call: noteOwnerWrote', () => {
  beforeEach(() => post.mockClear());
  it('posts to the one gate; a slash command or an empty text does not', async () => {
    const { noteOwnerWrote } = await import('../../dashboard/src/lib/ownerAtMac.js');
    noteOwnerWrote();
    noteOwnerWrote('Mac\'ten yazdım');
    noteOwnerWrote('/compact');
    noteOwnerWrote('  ');
    expect(post.mock.calls.map((c) => c[0])).toEqual(['/mac-owner/input', '/mac-owner/input']);
  });
  it('a failed call is swallowed (the automatic part simply stays on)', async () => {
    post.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    const { noteOwnerWrote } = await import('../../dashboard/src/lib/ownerAtMac.js');
    expect(() => noteOwnerWrote()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

// The wiring is read from source: the composer and the card are large React components whose
// gestures cannot be driven without a DOM. What must hold, per path, is pinned here.
describe('every owner input on the Mac passes the one call; nothing released later does', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf-8');
  const composer = read('dashboard/src/components/sleepy/chat/Composer.tsx');
  const commit = (() => {
    const at = composer.indexOf('  const commit = (mode: SubmitMode) => {');
    return composer.slice(at, composer.indexOf('\n  const submit = (mode: SubmitMode', at));
  })();
  const called = commit.indexOf('if (!slash) noteOwnerWrote();');
  const after = (needle: string) => {
    const at = commit.indexOf(needle);
    expect(at, needle).toBeGreaterThan(-1);
    expect(at, needle).toBeGreaterThan(called);
  };

  it('the composer says so once, right after it knows there is a message, before any delivery', () => {
    expect(called).toBeGreaterThan(commit.indexOf('if (!quoted.trim()) return;'));
    expect(commit.match(/noteOwnerWrote\(/g)).toHaveLength(1);
    // Nothing but a disconnected box or an empty message returns before it.
    const before = commit.slice(0, called);
    expect(before.match(/return;/g)).toHaveLength(2);
  });

  it('path 1, ⏎ while a card is open: the refused steer queues it, after the call', () => {
    after('if (!session.steer(message)) session.enqueue(message, { steerWhenPossible: true });');
  });

  it('path 2, ⌥⏎ adds to the queue, after the call (also on a taken-back remote tab)', () => {
    after("if (mode === 'queue') session.enqueue(message);");
    expect(commit.lastIndexOf("if (mode === 'queue') session.enqueue(message);")).toBeGreaterThan(called);
  });

  it('path 3, a sleeping tab: its first message goes through the composer\'s sendVia, after the call', () => {
    after('if (sendVia) { if (sendVia(message)) sent(); return; }');
    expect(read('dashboard/src/components/sleepy/ParkedChat.tsx')).toMatch(/sendVia=\{sendVia\}/);
  });

  it('path 4, a question card answered on the Mac: SurveyCard says so on a written answer or "unclear"', () => {
    const card = read('dashboard/src/components/sleepy/chat/SurveyCard.tsx');
    expect(card).toMatch(/resolveNotes\(questions, picks\)\)\) \{ hold\(\); return; \}\n(?:\s*\/\/.*\n)*\s*noteOwnerWrote\(\);/);
    expect(card).toMatch(/unclearMessage\(questions, picks\) \}\)\) \{ hold\(\); return; \}\n\s*noteOwnerWrote\(\);/);
    // The Super's own question, a child's question and a remote card are all drawn as SurveyCard.
    expect(read('dashboard/src/components/sleepy/super/SuperQuestionCard.tsx').match(/<SurveyCard\b/g)?.length).toBe(3);
  });

  it('must not count: the queue drain, an agent\'s send or card answer never pass the call', () => {
    for (const f of ['dashboard/src/components/sleepy/chatSession.ts', 'dashboard/src/components/sleepy/chat/postToSession.ts',
      'dashboard/src/components/sleepy/AgentSurface.tsx', 'dashboard/src/components/sleepy/windowVerbs.ts']) {
      expect(read(f), f).not.toMatch(/ownerAtMac|noteOwnerWrote/);
    }
  });

  it('must not count: nothing the server releases (a held or queued turn, a Telegram turn) raises it; only the gate does', () => {
    expect(read('src/server/routes/agent-chat.ts')).not.toMatch(/noteOwnerAtMac|noteMacOwnerInput|back-at-mac/);
    expect(read('src/server/telegram/hub.ts')).not.toMatch(/noteOwnerAtMac\(|noteMacOwnerInput/);
    expect(read('src/server/routes/automations.ts').match(/noteOwnerAtMac\(/g)).toBeNull();
    const index = read('src/server/index.ts');
    expect(index).toMatch(/router\.post\('\/api\/mac-owner\/input', handleMacOwnerInput\);/);
    expect(index).toMatch(/'\/api\/mac-owner'\]/);
  });

  // Owner 2026-11-09: Allow / Deny on a permission card on the Mac counts too.
  it('path 5, a permission card clicked on the Mac: PermissionCard, PlanCard and the Super bar say so once the answer is written', () => {
    const perm = read('dashboard/src/components/sleepy/chat/PermissionCard.tsx');
    expect(perm).toMatch(/if \(session\.answer\(item\.requestId, \{ behavior: 'allow', updatedInput: item\.input \}\)\) noteOwnerWrote\(\);/);
    expect(perm).toMatch(/if \(session\.answer\(item\.requestId, \{ behavior: 'deny', message: 'Denied by user\.' \}\)\) noteOwnerWrote\(\);/);
    // "Run here" (the owner ran it in a terminal) is not an Allow/Deny click: untouched.
    expect(perm.match(/noteOwnerWrote\(/g)).toHaveLength(2);
    const plan = read('dashboard/src/components/sleepy/chat/PlanCard.tsx');
    expect(plan.match(/noteOwnerWrote\(\); setSent\(true\)/g)).toHaveLength(2);
    const peer = read('dashboard/src/components/sleepy/chat/PeerSessionCard.tsx');
    expect(peer.match(/\)\) noteOwnerWrote\(\); \}\}/g)).toHaveLength(2);
    // The notch's Allow / Deny / Y / N / spoken answer all ride one owner-gated route that notes after the relay succeeds.
    expect(read('src/server/routes/assistant.ts')).toMatch(/if \(r\.ok\) \{[^}]*noteMacOwnerInput\(req\);/);
    const bar = read('dashboard/src/components/sleepy/super/JobBar.tsx');
    expect(bar.match(/if \(ok\) noteOwnerWrote\(\)/g)).toHaveLength(2);
  });

  it('must not count: a decision from the phone, the Super answering a child, or any agent never passes a card', () => {
    // The phone's Allow/Deny card posts to the server; the Super's superAllow and the window verbs answer through the session.
    for (const f of ['dashboard/src/components/sleepy/super/SuperPermissionCard.tsx', 'dashboard/src/components/sleepy/super/superAllow.ts',
      'src/server/routes/super-phone-questions.ts', 'src/lib/t3-bridge/session.ts']) {
      expect(read(f), f).not.toMatch(/ownerAtMac|noteOwnerWrote|noteMacOwnerInput|noteOwnerAtMac/);
    }
  });

  it('server side: the click reaches the one gate; the phone link and a no-Origin client do not count', () => {
    expect(signals(() => noteMacOwnerInput(req()))).toBe(1);
    expect(signals(() => noteMacOwnerInput(req({ phone: true })))).toBe(0);
    expect(signals(() => noteMacOwnerInput(req({ origin: null })))).toBe(0);
  });
});
