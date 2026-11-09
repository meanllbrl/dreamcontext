/**
 * An agent asks for one app action, the owner says Onayla, the agent does exactly that once
 * (app-onay-karti plan r3). End to end on real git and the local host: the request route builds
 * the plan and opens the notch card, the decide route (owner key) mints the grant, the action
 * route spends it. Forging, drift, reuse and the wrong app or action all run nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { addVault } from '../../src/lib/vaults.js';
import { getApp, registerApp, updateAppShare } from '../../src/lib/apps/registry.js';
import { newConfigId } from '../../src/lib/apps/app-config.js';
import { appLogoPath } from '../../src/lib/apps/app-logo.js';
import { LocalHost } from '../../src/lib/apps/share/host.js';
import { publishApp } from '../../src/lib/apps/share/publish.js';
import { installApp, previewInstall } from '../../src/lib/apps/share/install.js';
import { clearSharedCache } from '../../src/lib/apps/share/shared.js';
import { resetAppGrants } from '../../src/lib/apps/share/app-grant.js';
import { RENEWAL_TITLE, findRequesterChat, resetAppRequests, setAppRequestDelivery } from '../../src/lib/apps/share/app-request.js';
import { listProposals, type ProposalView } from '../../src/lib/assistant/proposals.js';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { agentSessionId } from '../../src/lib/session-id.js';
import { requestHeaders } from '../../src/lib/apps/client.js';
import * as share from '../../src/server/routes/apps-share.js';
import * as requests from '../../src/server/routes/apps-requests.js';
import { handleAssistantProposalDecide } from '../../src/server/routes/assistant.js';
import { setAppsHomeForTests } from '../../src/server/routes/apps.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';

const KEY = 'b7'.repeat(32);
const ORIGIN = 'http://127.0.0.1:4173';
const OWNER = { host: '127.0.0.1:4173', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [OWNER_KEY_HEADER]: KEY };
/** What an agent's CLI sends: this Mac, no owner key. */
const AGENT = { host: '127.0.0.1:4173', 'content-type': 'application/json' };
/** A PNG's signature and IHDR (64x64): enough for the server's sniff and size read. */
const PNG = (() => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(64, 8);
  ihdr.writeUInt32BE(64, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(64, 7)]);
})();

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;

let home: string;
let pubProject: string;
let instProject: string;
let hostDir: string;
let appRoot: string;
const saved = { ...process.env };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Ayşe Yılmaz', GIT_AUTHOR_EMAIL: 'ayse@ornek.co', GIT_COMMITTER_NAME: 'Ayşe Yılmaz', GIT_COMMITTER_EMAIL: 'ayse@ornek.co' } });
const host = (login: string | null) => new LocalHost(hostDir, login);
const ctxOf = (project: string) => join(project, '_dream_context');

function req(method: string, url: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(chunks), {
    method, url, headers,
    socket: { remoteAddress: '127.0.0.1', setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

async function call(h: Handler, opts: { params?: Record<string, string>; headers?: Record<string, string>; body?: unknown; url?: string; method?: string; project?: string }) {
  let status = 0;
  let raw: Buffer = Buffer.alloc(0);
  let ended = false;
  const res = {
    get writableEnded() { return ended; },
    destroyed: false,
    writeHead(code: number) { status = code; return this; },
    setHeader() {},
    end(data?: string | Buffer) { ended = true; raw = data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(data) ? data : Buffer.from(String(data)); },
  } as unknown as ServerResponse;
  await h(req(opts.method ?? 'POST', opts.url ?? '/', opts.headers ?? AGENT, opts.body ?? {}), res, opts.params ?? {}, ctxOf(opts.project ?? pubProject));
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw.toString('utf-8')); } catch { body = {}; }
  return { status, body, raw };
}

const ask = (body: Record<string, unknown>, headers: Record<string, string> = AGENT, project?: string) => call(requests.handleAppRequestCreate, { body, headers, project });
const status = (id: string) => call(requests.handleAppRequestStatus, { method: 'GET', params: { id }, url: `/api/apps/requests/${id}` });
const card = (): ProposalView => {
  const all = listProposals().filter((p) => p.app);
  expect(all).toHaveLength(1);
  return all[0];
};
const decide = (p: ProposalView, action: 'approve' | 'reject', headers: Record<string, string> = OWNER, hash = p.app!.hash) =>
  call(handleAssistantProposalDecide as Handler, { params: { id: p.id }, headers, body: { action, hash } });
const lineOf = (p: ProposalView, label: string) => p.app!.lines.find((l) => l.label === label)?.value;

function commitChange(file: string, text: string, msg = 'change') {
  writeFileSync(join(appRoot, file), text);
  git(appRoot, 'add', '-A');
  git(appRoot, 'commit', '-qm', msg);
}

async function approvedGrant(body: Record<string, unknown>, project?: string): Promise<{ grant: string; command: string; request: string }> {
  const r = await ask(body, AGENT, project);
  expect(r.status).toBe(200);
  const d = await decide(card(), 'approve');
  expect(d.body).toMatchObject({ ok: true, state: 'approved' });
  const s = await status(String(r.body.request));
  const g = s.body.grant as { id: string; command: string };
  return { grant: g.id, command: g.command, request: String(r.body.request) };
}

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterAll(() => {
  setOwnerKey(null);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

beforeEach(async () => {
  setOwnerKey(KEY);
  resetAppRequests();
  resetAppGrants();
  _resetChatRegistry();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-onay-')));
  pubProject = join(home, 'yayinci-proje');
  instProject = join(home, 'kurucu-proje');
  hostDir = join(home, 'host');
  for (const p of [pubProject, instProject]) mkdirSync(join(p, '_dream_context'), { recursive: true });
  addVault('yayinci', pubProject, home);
  addVault('kurucu', instProject, home);
  appRoot = join(`${pubProject}-apps`, 'tahmin');
  const files: Record<string, string> = {
    'dreamcontext-app.json': JSON.stringify({ slug: 'tahmin', name: 'Tahmin', agent: { own: true } }, null, 2),
    'ASSISTANT.md': '# Tahmin\n\nYou help read a forecast.\n',
    'public/index.html': '<!doctype html><h1>Tahmin</h1>\n',
    'public/app.js': 'export const x = 1;\n',
    '.gitignore': '.env\ndata/\n',
  };
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(appRoot, p, '..'), { recursive: true }); writeFileSync(join(appRoot, p), t); }
  git(appRoot, 'init', '-q');
  git(appRoot, 'add', '-A');
  git(appRoot, 'commit', '-q', '-m', 'first');
  const r = registerApp(home, { projectRoot: pubProject, vault: 'yayinci', slug: 'tahmin', name: 'Tahmin', root: appRoot });
  updateAppShare(home, r.projectRoot, r.slug, { configId: newConfigId() });
  setAppsHomeForTests(home);
  process.env.DREAMCONTEXT_APPS_LOCAL_HOST = hostDir;
  process.env.DREAMCONTEXT_APPS_LOCAL_LOGIN = 'yayinci';
  clearSharedCache();
  // Published once, privately, by the owner's own hand: every publish card below is an update.
  await publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', invite: ['kurucu'] });
});
afterEach(() => {
  vi.useRealTimers();
  setAppRequestDelivery(null);
  resetAppRequests();
  rmSync(home, { recursive: true, force: true });
});

describe('publish: ask, Onayla, spend once', () => {
  it('an update publish asks with one card (no visibility or invite question) and runs exactly that plan once', async () => {
    commitChange('public/app.js', 'export const x = 2;\n');
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('pending');
    const p = card();
    expect(p.verb).toBe('app-publish');
    expect(p.app!.title).toBe('Yeni sürümü yayınla');
    expect(lineOf(p, 'Nereye')).toBe('yayinci/tahmin-app');
    expect(lineOf(p, 'Görünürlük')).toBe('Yalnız davet ettiklerin');
    expect(lineOf(p, 'Değişen dosyalar')).toContain('public/app.js');
    expect(p.app!.lines.some((l) => l.label === 'Ne değişti')).toBe(true);
    expect(p.app!.lines.some((l) => l.label === 'Davet')).toBe(false);
    // Any local process reads the proposal list: the request id is never in it.
    expect(JSON.stringify(listProposals())).not.toContain(String(r.body.request));

    // Before Onayla the request holds no grant.
    expect((await status(String(r.body.request))).body).toEqual({ state: 'pending' });
    expect((await decide(p, 'approve')).body).toMatchObject({ ok: true, state: 'approved' });
    expect(listProposals().filter((x) => x.app)).toHaveLength(0);
    const s = (await status(String(r.body.request))).body as { state: string; grant: { id: string; command: string } };
    expect(s.state).toBe('approved');
    expect(s.grant.command).toBe(`dreamcontext apps publish tahmin --go --grant ${s.grant.id}`);

    // The spend ignores what the body says: visibility, repo name, store line, confirm, invites.
    const go = await call(share.handlePublish, { params: { slug: 'tahmin' }, body: { grant: s.grant.id, visibility: 'public', repoName: 'baska', tagline: 'x', confirmName: 'Tahmin', invite: ['kotu'], fresh: true } });
    expect(go.status).toBe(200);
    expect(go.body.fullName).toBe('yayinci/tahmin-app');
    const meta = JSON.parse(readFileSync(join(hostDir, 'yayinci', 'tahmin-app.json'), 'utf-8'));
    expect(meta.private).toBe(true);
    expect(meta.invitations.map((i: { login: string }) => i.login)).toEqual(['kurucu']);
    expect((await status(String(r.body.request))).body.state).toBe('used');

    // Once only.
    const again = await call(share.handlePublish, { params: { slug: 'tahmin' }, body: { grant: s.grant.id } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('grant_used');
  });

  it('asking twice while the grant is live opens no second card', async () => {
    commitChange('public/app.js', 'export const x = 2;\n');
    const first = await approvedGrant({ action: 'publish', slug: 'tahmin' });
    const second = await ask({ action: 'publish', slug: 'tahmin' });
    expect(second.body).toMatchObject({ request: first.request, state: 'approved' });
    expect(listProposals().filter((x) => x.app)).toHaveLength(0);
  });

  it('nothing new since the last publish: no card', async () => {
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_ready');
    expect(listProposals().filter((x) => x.app)).toHaveLength(0);
  });

  it('gate findings the agent lets through are each a line on the card', async () => {
    commitChange('public/app.js', 'export const account = 4815162342;\n');
    const blocked = await ask({ action: 'publish', slug: 'tahmin' });
    expect(blocked.status).toBe(409);
    const report = blocked.body.report as { approvable: Array<{ id: string }>; blocks: unknown[] } | undefined;
    expect(report?.blocks ?? []).toHaveLength(0);
    const ids = (report?.approvable ?? []).map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    const r = await ask({ action: 'publish', slug: 'tahmin', approve: ids });
    expect(r.status).toBe(200);
    const waived = card().app!.lines.filter((l) => l.label === 'Geçirilecek');
    expect(waived).toHaveLength(ids.length);
    expect(waived.every((l) => l.tone === 'warn')).toBe(true);
  });
});

describe('forging and drift fail', () => {
  it('approve or reject without the owner key: 403, nothing minted, the card stays', async () => {
    commitChange('public/app.js', 'export const x = 2;\n');
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    const p = card();
    for (const action of ['approve', 'reject'] as const) {
      const d = await decide(p, action, { ...AGENT, origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
      expect(d.status).toBe(403);
      expect(d.body.error).toBe('owner_page_only');
    }
    expect((await status(String(r.body.request))).body).toEqual({ state: 'pending' });
    expect(card().id).toBe(p.id);
  });

  it('a tampered hash: card_changed, nothing minted', async () => {
    commitChange('public/app.js', 'export const x = 2;\n');
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    const d = await decide(card(), 'approve', OWNER, 'f'.repeat(64));
    expect(d.status).toBe(409);
    expect(d.body.error).toBe('card_changed');
    expect((await status(String(r.body.request))).body).toEqual({ state: 'pending' });
  });

  it('files changed after the card: stale at Onayla (no grant), and stale at the spend', async () => {
    commitChange('public/app.js', 'export const x = 2;\n');
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    commitChange('public/app.js', 'export const x = 3;\n');
    const d = await decide(card(), 'approve');
    expect(d.status).toBe(409);
    expect(d.body.error).toBe('stale_request');
    expect((await status(String(r.body.request))).body).toEqual({ state: 'stale' });

    const g = await approvedGrant({ action: 'publish', slug: 'tahmin' });
    commitChange('public/app.js', 'export const x = 4;\n');
    const go = await call(share.handlePublish, { params: { slug: 'tahmin' }, body: { grant: g.grant } });
    expect(go.status).toBe(409);
    expect(go.body.error).toBe('stale_request');
  });

  it('a grant is for its app and its action only', async () => {
    commitChange('public/app.js', 'export const x = 2;\n');
    const g = await approvedGrant({ action: 'publish', slug: 'tahmin' });
    const upd = await call(share.handleUpdateApply, { params: { slug: 'tahmin' }, body: { grant: g.grant } });
    expect(upd.status).toBe(403);
    const logo = await call(share.handleAppLogoSet, { params: { slug: 'tahmin' }, headers: { ...AGENT, [share.GRANT_HEADER]: g.grant }, body: PNG });
    expect(logo.status).toBe(403);
    const inst = await call(share.handleInstall, { body: { grant: g.grant, ref: 'yayinci/tahmin-app' } });
    expect(inst.status).toBe(403);
    // Still unspent for its own action.
    const go = await call(share.handlePublish, { params: { slug: 'tahmin' }, body: { grant: g.grant } });
    expect(go.status).toBe(200);
  });

  it('a made-up grant and no grant at all are refused before anything runs', async () => {
    for (const body of [{ grant: 'x'.repeat(24) }, {}]) {
      const r = await call(share.handlePublish, { params: { slug: 'tahmin' }, body });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('owner_page_only');
    }
  });
});

describe('Reddet, the hour and the day', () => {
  it('Reddet runs nothing; the same request within 10 minutes is a cooldown', async () => {
    commitChange('public/app.js', 'export const x = 2;\n');
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    expect((await decide(card(), 'reject')).body).toMatchObject({ ok: true, state: 'rejected' });
    expect((await status(String(r.body.request))).body).toEqual({ state: 'rejected' });
    const again = await ask({ action: 'publish', slug: 'tahmin' });
    expect(again.status).toBe(429);
    expect(again.body.error).toBe('cooldown');
  });

  it('an unused grant past its hour: the same ask again is a renewal card, one tap gives a new hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    commitChange('public/app.js', 'export const x = 2;\n');
    const g = await approvedGrant({ action: 'publish', slug: 'tahmin' });
    vi.setSystemTime(new Date('2026-11-09T11:01:00Z'));
    expect((await status(g.request)).body).toEqual({ state: 'expired' });
    const old = await call(share.handlePublish, { params: { slug: 'tahmin' }, body: { grant: g.grant } });
    expect(old.status).toBe(403);
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    expect(r.body.renewal).toBe(true);
    const p = card();
    expect(p.app!.title).toBe(RENEWAL_TITLE);
    expect(p.app!.renewal).toBe(true);
    await decide(p, 'approve');
    const s = (await status(String(r.body.request))).body as { grant: { id: string } };
    const go = await call(share.handlePublish, { params: { slug: 'tahmin' }, body: { grant: s.grant.id } });
    expect(go.status).toBe(200);
  });

  it('a request never lives past 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    commitChange('public/app.js', 'export const x = 2;\n');
    const r = await ask({ action: 'publish', slug: 'tahmin' });
    vi.setSystemTime(new Date('2026-11-10T10:00:01Z'));
    expect((await status(String(r.body.request))).body).toEqual({ state: 'unknown' });
  });
});

describe('logo', () => {
  it('the card carries the exact picture; the spend sets those bytes, never the body', async () => {
    const file = join(appRoot, 'logo.png');
    writeFileSync(file, PNG);
    const g = await (async () => {
      const r = await ask({ action: 'logo', slug: 'tahmin', logoPath: file });
      expect(r.status).toBe(200);
      const p = card();
      expect(p.verb).toBe('app-logo');
      expect(p.app!.image).toBe(`/api/apps/requests/${p.id}/logo`);
      const img = await call(requests.handleAppRequestLogo, { method: 'GET', params: { id: p.id } });
      expect(img.status).toBe(200);
      expect(img.raw.equals(PNG)).toBe(true);
      // The image path is the card's id, never the request's: a request id gets nothing.
      expect((await call(requests.handleAppRequestLogo, { method: 'GET', params: { id: String(r.body.request) } })).status).toBe(404);
      await decide(p, 'approve');
      return (await status(String(r.body.request))).body.grant as { id: string; command: string };
    })();
    expect(g.command).toBe(`dreamcontext apps logo tahmin --grant ${g.id}`);
    // The file changes after Onayla; the body sends something else: the card's bytes win.
    writeFileSync(file, Buffer.concat([PNG, Buffer.from('x')]));
    const other = Buffer.concat([PNG, Buffer.from('other')]);
    const set = await call(share.handleAppLogoSet, { params: { slug: 'tahmin' }, headers: { ...AGENT, [share.GRANT_HEADER]: g.id }, body: other });
    expect(set.status).toBe(200);
    const rec = getApp(home, pubProject, 'tahmin')!;
    const stored = readFileSync(appLogoPath(home, rec.configId!)!);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(PNG).digest('hex'));
    const again = await call(share.handleAppLogoSet, { params: { slug: 'tahmin' }, headers: { ...AGENT, [share.GRANT_HEADER]: g.id }, body: PNG });
    expect(again.body.error).toBe('grant_used');
  });

  it('refuses a symlink, outside the roots, the brain tmp, an SVG, an oversize and a non-image file', async () => {
    const outside = join(home, 'outside.png');
    writeFileSync(outside, PNG);
    const link = join(appRoot, 'link.png');
    symlinkSync(join(appRoot, 'public', 'index.html'), link);
    const svg = join(appRoot, 'logo.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svgPng = join(appRoot, 'sneaky.png');
    writeFileSync(svgPng, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    const big = join(appRoot, 'big.png');
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
    const text = join(appRoot, 'notes.png');
    writeFileSync(text, 'just text');
    const tmp = join(pubProject, '_dream_context', 'tmp');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'x.png'), PNG);
    for (const path of [outside, link, svg, svgPng, big, text, join(tmp, 'x.png'), 'relative.png']) {
      const r = await ask({ action: 'logo', slug: 'tahmin', logoPath: path });
      expect(r.status, path).toBe(400);
      expect(r.body.error, path).toBe('bad_logo');
    }
    expect(listProposals().filter((x) => x.app)).toHaveLength(0);
  });

  it("an app's own assistant: its own app, inside its own folder; never another app, never an install", async () => {
    const claim = (app: string) => ({ ...AGENT, 'x-dc-run': JSON.stringify({ class: 'agent', app }) });
    const inProject = join(pubProject, 'logo.png');
    writeFileSync(inProject, PNG);
    const outsideApp = await ask({ action: 'logo', slug: 'tahmin', logoPath: inProject }, claim('tahmin'));
    expect(outsideApp.status).toBe(400);
    const other = await ask({ action: 'logo', slug: 'tahmin', logoPath: inProject }, claim('sayac'));
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('not_your_app');
    const inst = await ask({ action: 'install', ref: 'yayinci/tahmin-app' }, claim('tahmin'));
    expect(inst.status).toBe(403);
    // Without the narrowing claim the project root is allowed.
    expect((await ask({ action: 'logo', slug: 'tahmin', logoPath: inProject })).status).toBe(200);
  });
});

describe('install and update', () => {
  async function installed() {
    const kur = host('kurucu');
    const inv = await kur.listInvitations();
    await kur.acceptInvitation(inv[0].id);
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'yayinci/tahmin-app', host: kur });
    const { rec } = await installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, npm: false });
    return rec;
  }

  it('install: the card names who wrote it and what it runs; Onayla installs exactly that once', async () => {
    const kur = host('kurucu');
    const inv = await kur.listInvitations();
    await kur.acceptInvitation(inv[0].id);
    process.env.DREAMCONTEXT_APPS_LOCAL_LOGIN = 'kurucu';
    const r = await ask({ action: 'install', ref: 'https://github.com/yayinci/tahmin-app' }, AGENT, instProject);
    expect(r.status).toBe(200);
    const p = card();
    expect(p.verb).toBe('app-install');
    expect(lineOf(p, 'Yazan')).toContain('yayinci');
    expect(lineOf(p, 'Çalıştırır')).toBeTruthy();
    expect(p.app!.warn).toBe('Bu app senin Mac\'inde senin izinlerinle çalışır.');
    await decide(p, 'approve');
    const g = (await status(String(r.body.request))).body.grant as { id: string; command: string };
    expect(g.command).toBe(`dreamcontext apps install yayinci/tahmin-app --go --grant ${g.id}`);
    // Another repo with this grant: refused. The right one: installed, once.
    const wrong = await call(share.handleInstall, { body: { grant: g.id, ref: 'yayinci/baska-app' }, project: instProject });
    expect(wrong.status).toBe(403);
    const go = await call(share.handleInstall, { body: { grant: g.id, ref: 'yayinci/tahmin-app', previewId: 'forged', sha: 'forged' }, project: instProject });
    expect(go.status).toBe(200);
    expect(go.body.slug).toBe('tahmin');
    const again = await call(share.handleInstall, { body: { grant: g.id, ref: 'yayinci/tahmin-app' }, project: instProject });
    expect(again.body.error).toBe('grant_used');
  });

  it('update: the card shows every permission change; a copy edited after Onayla is stale', async () => {
    const inst = await installed();
    // A new version that changes what the app may do.
    writeFileSync(join(appRoot, 'dreamcontext-app.json'), JSON.stringify({ slug: 'tahmin', name: 'Tahmin', agent: { own: true }, config: [{ key: 'insight', type: 'insight', label: 'Which insight' }] }, null, 2));
    commitChange('public/app.js', 'export const x = 2;\n', 'v2');
    await publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', note: 'v2' });
    process.env.DREAMCONTEXT_APPS_LOCAL_LOGIN = 'kurucu';
    clearSharedCache();
    const r = await ask({ action: 'update', slug: inst.slug }, AGENT, instProject);
    expect(r.status).toBe(200);
    const p = card();
    expect(p.verb).toBe('app-update');
    expect(p.app!.lines.filter((l) => l.label === 'İzin değişikliği').length).toBeGreaterThan(0);
    expect(p.app!.warn).toBeTruthy();
    await decide(p, 'approve');
    const g = (await status(String(r.body.request))).body.grant as { id: string; command: string };
    expect(g.command).toBe(`dreamcontext apps update ${inst.slug} --apply --grant ${g.id}`);
    // The owner's copy changes after Onayla: nothing runs.
    writeFileSync(join(inst.root, 'public', 'app.js'), 'export const mine = 1;\n');
    const stale = await call(share.handleUpdateApply, { params: { slug: inst.slug }, body: { grant: g.id }, project: instProject });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale_request');
  });
});

describe('the [app onayı] line reaches the asking chat (delivery only)', () => {
  /** A FAKE Codex bridge env: what the desktop app sets for a Codex chat's shell. No real Codex. */
  const FAKE_CODEX_BRIDGE_ENV = { DREAMCONTEXT_AGENT_TOOL: 'codex', CODEX_THREAD_ID: 'thread-0a1b2c3d' } as NodeJS.ProcessEnv;

  it("a Codex child's chat is FOUND from agentSessionId() and gets the line with the exact command", async () => {
    registerChat({ sessionId: 'tab-codex-1', conversationId: 'thread-0a1b2c3d', vault: 'yayinci', mode: 'develop' });
    const sid = agentSessionId(FAKE_CODEX_BRIDGE_ENV);
    expect(sid).toBe('thread-0a1b2c3d');
    expect(requestHeaders(FAKE_CODEX_BRIDGE_ENV)['x-dc-agent-session']).toBe(sid);
    const found = findRequesterChat(sid, 'yayinci');
    expect(found?.sessionId).toBe('tab-codex-1');
    expect(findRequesterChat(sid, 'kurucu')).toBeNull();

    const sent: Array<{ chat: string; text: string }> = [];
    setAppRequestDelivery(async (chat, text) => { sent.push({ chat: chat.sessionId, text }); });
    commitChange('public/app.js', 'export const x = 2;\n');
    const r = await ask({ action: 'publish', slug: 'tahmin' }, { ...AGENT, 'x-dc-agent-session': sid! });
    await decide(card(), 'approve');
    await new Promise((res) => setImmediate(res));
    const g = (await status(String(r.body.request))).body.grant as { id: string };
    expect(sent).toEqual([{ chat: 'tab-codex-1', text: `[app onayı] tahmin için yayın onaylandı. Bir kez çalıştır: dreamcontext apps publish tahmin --go --grant ${g.id}` }]);
  });
});
