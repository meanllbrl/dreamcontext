import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_SOCKET_PARAMS, appChatUpgrade, type AppUpgradeInput } from '../../src/server/apps/app-chat-gate.js';
import { dropEmbedToken, mintEmbedToken } from '../../src/server/apps/embed-token.js';
import { createAppChat, lookupAppChat, rotateAppChat } from '../../src/lib/apps/chat-store.js';
import { APP_CHAT_MAX_LIVE, appChatHasRoom, reserveAppChat } from '../../src/lib/apps/assistant.js';
import { registerApp } from '../../src/lib/apps/registry.js';

/** The app socket's gate (plan r9, D8): a row per parameter, through the app gate and the generic one. */

let home: string; let project: string; let root: string; let hash: string; let tk: string; let otherTk: string;
const PORT = 5301; const OTHER = 5302;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gate-sock-')));
  project = join(home, 'proj'); mkdirSync(join(project, '_dream_context'), { recursive: true });
  root = join(home, 'proj-apps', 'yuk'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk', name: 'Yuk', agent: { own: true } }));
  writeFileSync(join(root, 'ASSISTANT.md'), '# Yuk\n');
  hash = registerApp(home, { projectRoot: project, vault: 'acme', slug: 'yuk', name: 'Yuk', root }).hash;
  tk = mintEmbedToken({ slug: 'yuk', vault: 'acme', projectRoot: project, gwPort: PORT });
  otherTk = mintEmbedToken({ slug: 'other', vault: 'acme', projectRoot: project, gwPort: OTHER });
});
afterEach(() => { dropEmbedToken(PORT); dropEmbedToken(OTHER); rmSync(home, { recursive: true, force: true }); });

const url = (q: string) => new URL(`http://127.0.0.1:9/api/agent/chat?${q}`);
const run = (q: string, over: Partial<AppUpgradeInput> = {}) => appChatUpgrade({
  url: url(q), vault: 'acme', projectRoot: project, phone: false, assistant: false, sameOrigin: () => true,
  isLive: () => false, hasTranscript: () => false, home, ...over,
});
const fresh = () => randomUUID();
const record = (over: Partial<{ hash: string; projectRoot: string }> = {}) => createAppChat({ id: randomUUID(), hash, slug: 'yuk', projectRoot: project, member: null, ...over }, home);

describe('the app gate', () => {
  it('leaves every ordinary chat alone', () => {
    expect(run(`vault=acme&sessionId=${fresh()}&bypass=1`)).toBeNull();
  });
  it('opens a new conversation, writing its record, and keeps only the allowlist', () => {
    const id = fresh();
    const out = run(`app=yuk&tk=${tk}&vault=acme&sessionId=${id}&model=sonnet&effort=high`);
    expect(out && 'url' in out).toBe(true);
    expect(lookupAppChat(id, home)).toMatchObject({ record: { slug: 'yuk', member: null } });
    if (out && 'url' in out) expect([...out.url.searchParams.keys()].sort()).toEqual(['effort', 'model', 'sessionId', 'vault']);
  });
  it.each(['bypass=1', 'prompt=x', 'promptToken=x', 'deferPrompt=1', 'mode=super', 'tool=codex', 'lean=1', 'mcp=a', 'account=x', 'origin=assistant', 'cardAgent=a', 'cardBoard=b', 'chatAgent=a', 'stage=1', 'tk=z'])('drops %s', (param) => {
    const out = run(`app=yuk&tk=${tk}&vault=acme&sessionId=${fresh()}&${param}`);
    expect(out && 'url' in out).toBe(true);
    if (out && 'url' in out) {
      for (const key of out.url.searchParams.keys()) expect(APP_SOCKET_PARAMS as readonly string[]).toContain(key);
    }
  });
  it.each([
    ['a wrong token', () => `app=yuk&tk=${'x'.repeat(43)}&vault=acme&sessionId=${fresh()}`],
    ['no token', () => `app=yuk&vault=acme&sessionId=${fresh()}`],
    ["another app's token", () => `app=yuk&tk=${otherTk}&vault=acme&sessionId=${fresh()}`],
    ['the wrong vault', () => `app=yuk&tk=${tk}&vault=other&sessionId=${fresh()}`],
    ['neither id', () => `app=yuk&tk=${tk}&vault=acme`],
  ])('refuses %s', (_n, q) => {
    const s = q();
    expect(run(s, { vault: new URL(`http://x/?${s}`).searchParams.get('vault') })).toEqual({ refuse: 403 });
  });
  it('refuses a phone socket, the Assistant, a foreign origin', () => {
    const q = `app=yuk&tk=${tk}&vault=acme&sessionId=${fresh()}`;
    expect(run(q, { phone: true })).toEqual({ refuse: 403 });
    expect(run(q, { assistant: true })).toEqual({ refuse: 403 });
    expect(run(q, { sameOrigin: () => false })).toEqual({ refuse: 403 });
  });
  it('a resume only for an id in this app\'s record', () => {
    const own = record();
    expect(run(`app=yuk&tk=${tk}&vault=acme&resume=${own.id}&reattach=passive`)).toMatchObject({ url: expect.any(URL) });
    expect(run(`app=yuk&tk=${tk}&vault=acme&resume=${fresh()}`)).toEqual({ refuse: 403 });
    const foreign = record({ hash: 'zzz' });
    expect(run(`app=yuk&tk=${tk}&vault=acme&resume=${foreign.id}`)).toEqual({ refuse: 403 });
  });
  it('a new id cannot pull in anything that exists', () => {
    expect(run(`app=yuk&tk=${tk}&vault=acme&sessionId=${fresh()}`, { hasTranscript: () => true })).toEqual({ refuse: 403 });
    expect(run(`app=yuk&tk=${tk}&vault=acme&sessionId=${fresh()}`, { isLive: () => true })).toEqual({ refuse: 403 });
    expect(run(`app=yuk&tk=${tk}&vault=acme&sessionId=${record().id}`)).toEqual({ refuse: 403 });
  });
  it('a missing role opens nothing, and says why', () => {
    rmSync(join(root, 'ASSISTANT.md'));
    expect(run(`app=yuk&tk=${tk}&vault=acme&sessionId=${fresh()}`)).toEqual({ say: expect.stringContaining('ASSISTANT.md') });
  });
  it('a rotated conversation opens by its pin, from the frame and from History', () => {
    const a = record();
    const b = rotateAppChat(a, randomUUID(), home);
    const framed = run(`app=yuk&tk=${tk}&vault=acme&resume=${b?.id}`);
    expect(framed && 'url' in framed && framed.url.searchParams.get('resume')).toBe(a.id);
    const main = run(`vault=acme&resume=${b?.id}`);
    expect(main && 'url' in main && main.url.searchParams.get('resume')).toBe(a.id);
  });
  it('an app with no agent and no member has no chat here; an old URL member still does', () => {
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk', name: 'Yuk' }));
    expect(run(`app=yuk&tk=${tk}&vault=acme&sessionId=${fresh()}`)).toEqual({ refuse: 409 });
    const id = fresh();
    expect(run(`app=yuk&tk=${tk}&vault=acme&sessionId=${id}&member=ua-manager`)).toMatchObject({ url: expect.any(URL) });
    expect(lookupAppChat(id, home)).toMatchObject({ record: { member: 'ua-manager' } });
  });
});

describe('the seventh chat', () => {
  it('is refused with no record left, and a seat taken at the gate lets go', () => {
    const held = Array.from({ length: APP_CHAT_MAX_LIVE }, () => reserveAppChat(hash, randomUUID()));
    const id = fresh();
    expect(run(`app=yuk&tk=${tk}&vault=acme&sessionId=${id}`)).toEqual({ say: expect.stringContaining('6 chats') });
    expect(lookupAppChat(id, home)).toEqual({ kind: 'none' });
    held.pop()?.();
    const out = run(`app=yuk&tk=${tk}&vault=acme&sessionId=${id}`);
    expect(out && 'hold' in out).toBe(true);
    expect(appChatHasRoom(hash, fresh())).toBe(false);
    if (out && 'hold' in out) { out.hold?.(); out.hold?.(); }
    expect(appChatHasRoom(hash, fresh())).toBe(true);
    for (const r of held) r();
  });
});

describe('the generic gate, naming a record', () => {
  it('rebuilds the URL with no token, whatever was asked', () => {
    const own = record();
    const out = run(`vault=acme&resume=${own.id}&bypass=1&mode=super&tool=codex&lean=1&account=x&prompt=hi`);
    expect(out && 'url' in out).toBe(true);
    if (out && 'url' in out) expect([...out.url.searchParams.keys()].sort()).toEqual(['resume', 'vault']);
  });
  it('refuses a phone, and a record of another project', () => {
    const own = record();
    expect(run(`vault=acme&resume=${own.id}`, { phone: true })).toEqual({ refuse: 403 });
    const elsewhere = record({ projectRoot: '/elsewhere' });
    expect(run(`vault=acme&resume=${elsewhere.id}`)).toEqual({ refuse: 403 });
  });
  it('refuses a damaged record, and as a sessionId too', () => {
    const own = record();
    writeFileSync(join(home, '.dreamcontext', 'apps', 'chats', `${own.id}.json`), 'x');
    expect(run(`vault=acme&resume=${own.id}`)).toEqual({ refuse: 403 });
    expect(run(`vault=acme&sessionId=${own.id}`)).toEqual({ refuse: 403 });
  });
});
