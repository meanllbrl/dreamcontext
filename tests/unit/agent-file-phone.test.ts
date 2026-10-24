/**
 * What the hands-free PHONE may see outside the project (task hands-free-phone-shows-every-
 * picture…, D1; owner 2026-10-23), driven through the real `GET /api/agent/file` and
 * `POST /api/agent/phone-grant` handlers on a socket the phone listener marked.
 *
 *   • inside the project: served, as before;
 *   • under the project's own linked repo, or a worktree of it: served without asking;
 *   • anywhere else: `needs_phone_grant` (with the REAL path), served after the phone's grant;
 *   • inside a project not chosen at start: `other_project`, and the grant is refused too —
 *     even when that project sits under one of this project's own linked roots;
 *   • outside, only media: no text, folder, SVG or PDF; a symlink named `.png` is judged by
 *     what it points at; a raster image must say so in its bytes;
 *   • desktop grants never count on the phone, and phone grants end with the run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const home = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/dc-phonefile-home-`));
  process.env.HOME = home;
  return home;
});

// The device a request carries: a test header instead of a signed cookie (the auth store's own
// tests cover the cookie). Everything else in the module is real.
const signedOut = vi.hoisted(() => new Set<string>());
vi.mock('../../src/server/handsfree-auth.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/handsfree-auth.js')>();
  return {
    ...real,
    deviceIdHash: (req: IncomingMessage) => (req.headers['x-test-device'] as string | undefined) ?? null,
    macHandsfreeAuth: () => ({ store: { isValidDeviceHash: (h: string) => !signedOut.has(h) } }),
  };
});

import { handleAgentFile, handleAgentPhoneGrant } from '../../src/server/routes/agent-chat.js';
import { markPhoneSocket, setMacExposedVaults } from '../../src/server/phone-origin.js';
import { setLinkedRepoPath } from '../../src/lib/linked-repos.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

function res(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown>; type: () => string | undefined } {
  let code = 0;
  let body: unknown = null;
  let type: string | undefined;
  const r = {
    writeHead(c: number, h?: Record<string, unknown>) { code = c; if (h?.['Content-Type']) type = String(h['Content-Type']); return r; },
    setHeader() {},
    write() { return true; },
    end(d?: string | Buffer) { if (typeof d === 'string') { try { body = JSON.parse(d); } catch { body = d; } } },
    on() { return r; }, once() { return r; }, emit() { return false; }, removeListener() { return r; }, destroy() { return r; },
  } as unknown as ServerResponse;
  return { res: r, status: () => code, body: () => body as Record<string, unknown>, type: () => type };
}

function phoneReq(url: string, device = 'dev-a', body?: string): IncomingMessage {
  const socket = {};
  markPhoneSocket(socket);
  const chunks = body ? [Buffer.from(body)] : [];
  const req = {
    url, socket, headers: { host: 'phone.test', 'x-test-device': device, 'content-type': 'application/json' },
    on(ev: string, fn: (c?: Buffer) => void) {
      if (ev === 'data') for (const c of chunks) fn(c);
      if (ev === 'end') queueMicrotask(() => fn());
      return req;
    },
    destroy() {},
  };
  return req as unknown as IncomingMessage;
}

async function file(path: string, device = 'dev-a', raw = true): Promise<ReturnType<typeof res>> {
  const r = res();
  await handleAgentFile(phoneReq(`/api/agent/file?path=${encodeURIComponent(path)}${raw ? '&raw=1' : ''}`, device), r.res, {}, contextRoot);
  // serveMedia pipes asynchronously; the status is written synchronously before it.
  return r;
}

async function grant(path: string, device = 'dev-a'): Promise<ReturnType<typeof res>> {
  const r = res();
  await handleAgentPhoneGrant(phoneReq('/api/agent/phone-grant', device, JSON.stringify({ path })), r.res, {}, contextRoot);
  return r;
}

const git = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }); };

let root: string;
let projectRoot: string;
let contextRoot: string;
let codeRepo: string;
let codeWorktree: string;
let elsewhere: string;
let otherProject: string;
let nestedOther: string;

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-phonefile-')));
  // The chosen project: the brain, with one linked code repo.
  projectRoot = join(root, 'brain');
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(projectRoot, 'tmp'), { recursive: true });
  writeFileSync(join(projectRoot, 'tmp', 'inside.png'), PNG);
  const url = 'https://github.com/acme/code.git';
  writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ linkedRepos: [{ name: 'code', gitRemoteUrl: url }] }));

  // The linked repo and a worktree of it (where a Super child writes its screenshots).
  codeRepo = join(root, 'code');
  mkdirSync(join(codeRepo, 'tmp'), { recursive: true });
  git(codeRepo, 'init', '-q');
  git(codeRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  writeFileSync(join(codeRepo, 'tmp', 'shot.png'), PNG);
  writeFileSync(join(codeRepo, 'tmp', 'notes.md'), '# not media\n');
  writeFileSync(join(codeRepo, 'tmp', 'fake.png'), 'not a png at all');
  writeFileSync(join(codeRepo, 'tmp', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  codeWorktree = join(root, 'worktrees', 'code-child');
  git(codeRepo, 'worktree', 'add', '-q', '--detach', codeWorktree);
  mkdirSync(join(codeWorktree, 'tmp'), { recursive: true });
  writeFileSync(join(codeWorktree, 'tmp', 'child.png'), PNG);
  setLinkedRepoPath(canonicalRemote(url) ?? url, codeRepo, HOME);

  // Somewhere with no owner (the Super's /tmp screenshots).
  elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'free.png'), PNG);
  writeFileSync(join(elsewhere, 'clip.mp4'), 'mp4 bytes');
  writeFileSync(join(elsewhere, 'secret.txt'), 'ssh keys\n');
  symlinkSync(join(elsewhere, 'secret.txt'), join(elsewhere, 'looks-like.png'));

  // A registered project the owner did NOT choose, and one nested inside the linked repo.
  otherProject = join(root, 'other');
  mkdirSync(join(otherProject, '_dream_context'), { recursive: true });
  writeFileSync(join(otherProject, 'private.png'), PNG);
  nestedOther = join(codeRepo, 'packages', 'sub');
  mkdirSync(join(nestedOther, '_dream_context'), { recursive: true });
  writeFileSync(join(nestedOther, 'nested.png'), PNG);
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'vaults.json'), JSON.stringify({
    vaults: [
      { name: 'brain', path: projectRoot },
      { name: 'other', path: otherProject },
      { name: 'sub', path: nestedOther },
    ],
  }));
  // A desktop grant for a file the phone must still ask about.
  writeFileSync(join(contextRoot, 'state', '.file-grants.json'), JSON.stringify({ paths: [join(elsewhere, 'free.png')] }));
});

afterAll(() => {
  setMacExposedVaults([]);
  rmSync(root, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  // A fresh run each time: phone grants and the roots cache start empty.
  setMacExposedVaults(['brain']);
});

describe('the phone, inside the project', () => {
  it('is served as before', async () => {
    const r = await file('tmp/inside.png');
    expect(r.status()).toBe(200);
    expect(r.type()).toBe('image/png');
  });
});

describe('the phone, under its own linked repo and worktrees', () => {
  it('shows a picture in the linked repo without asking', async () => {
    const r = await file(join(codeRepo, 'tmp', 'shot.png'));
    expect(r.status(), JSON.stringify(r.body())).toBe(200);
  });

  it('shows a picture in a worktree of it without asking', async () => {
    const r = await file(join(codeWorktree, 'tmp', 'child.png'));
    expect(r.status(), JSON.stringify(r.body())).toBe(200);
  });

  it('never a text file, an SVG, a folder listing or a text preview there', async () => {
    expect((await file(join(codeRepo, 'tmp', 'notes.md'))).body().error).toBe('phone_media_only');
    expect((await file(join(codeRepo, 'tmp', 'logo.svg'))).body().error).toBe('phone_media_only');
    expect((await file(join(codeRepo, 'tmp'))).body().error).toBe('phone_media_only');
    expect((await file(join(codeRepo, 'tmp', 'shot.png'), 'dev-a', false)).body().error).toBe('phone_media_only');
  });

  it('a file named .png whose bytes are not a PNG is refused', async () => {
    expect((await file(join(codeRepo, 'tmp', 'fake.png'))).body().error).toBe('phone_media_only');
  });
});

describe('the phone, anywhere else', () => {
  it('asks first, naming the real file, and the desktop grant does not count', async () => {
    const r = await file(join(elsewhere, 'free.png'));
    expect(r.status()).toBe(403);
    expect(r.body()).toMatchObject({ error: 'needs_phone_grant', path: join(elsewhere, 'free.png') });
  });

  it('serves the file after the phone grants it, for that device only', async () => {
    const g = await grant(join(elsewhere, 'free.png'));
    expect(g.status(), JSON.stringify(g.body())).toBe(200);
    expect((await file(join(elsewhere, 'free.png'))).status()).toBe(200);
    expect((await file(join(elsewhere, 'free.png'), 'dev-b')).body().error).toBe('needs_phone_grant');
  });

  it('grants a video too', async () => {
    expect((await grant(join(elsewhere, 'clip.mp4'))).status()).toBe(200);
    const r = await file(join(elsewhere, 'clip.mp4'));
    expect(r.status()).toBe(200);
    expect(r.type()).toBe('video/mp4');
  });

  it('a symlink named .png pointing at a text file is judged by its target, and cannot be granted', async () => {
    expect((await file(join(elsewhere, 'looks-like.png'))).body().error).toBe('phone_media_only');
    expect((await grant(join(elsewhere, 'looks-like.png'))).body().error).toBe('phone_media_only');
  });

  it('a phone grant ends with the run (Mac mode stopped and started)', async () => {
    await grant(join(elsewhere, 'free.png'));
    setMacExposedVaults([]);
    setMacExposedVaults(['brain']);
    expect((await file(join(elsewhere, 'free.png'))).body().error).toBe('needs_phone_grant');
  });

  it('a missing file is not found — never a "Show" that can only answer 404 — and cannot be granted', async () => {
    expect((await file(join(elsewhere, 'gone.png'))).status()).toBe(404);
    expect((await file(join(codeWorktree, 'tmp', 'gone.png'))).status()).toBe(404);
    expect((await grant(join(elsewhere, 'gone.png'))).status()).toBe(404);
  });

  it('a device signed out while its grant was on the way gets no grant', async () => {
    signedOut.add('dev-gone');
    try {
      expect((await grant(join(elsewhere, 'free.png'), 'dev-gone')).status()).toBe(409);
      expect((await file(join(elsewhere, 'free.png'), 'dev-gone')).body().error).toBe('needs_phone_grant');
    } finally { signedOut.delete('dev-gone'); }
  });
});

describe('the phone, inside a project not chosen at start', () => {
  it('is refused outright, without naming the file, and the grant is refused too', async () => {
    const r = await file(join(otherProject, 'private.png'));
    expect(r.status()).toBe(403);
    expect(r.body()).toEqual({ error: 'other_project', message: expect.any(String) });
    expect((await grant(join(otherProject, 'private.png'))).body().error).toBe('other_project');
  });

  it('wins over this project\'s own linked root that contains it (the closest root decides)', async () => {
    expect((await file(join(nestedOther, 'nested.png'))).body().error).toBe('other_project');
  });

  it('a project chosen at start is not refused', async () => {
    setMacExposedVaults(['brain', 'other']);
    expect((await file(join(otherProject, 'private.png'))).body().error).toBe('needs_phone_grant');
  });
});

describe('the boundary holds where git and links blur it (end review, security)', () => {
  const vaultsFile = (): string => join(HOME, '.dreamcontext', 'vaults.json');
  let saved = '';
  beforeEach(() => { saved = readFileSync(vaultsFile(), 'utf-8'); });
  afterEach(() => { writeFileSync(vaultsFile(), saved); setMacExposedVaults(['brain']); });
  const register = (extra: Array<{ name: string; path: string }>): void => {
    const v = JSON.parse(saved) as { vaults: Array<{ name: string; path: string }> };
    writeFileSync(vaultsFile(), JSON.stringify({ vaults: [...v.vaults, ...extra] }));
    setMacExposedVaults(['brain']); // a fresh run: the roots are rebuilt
  };

  it('a worktree of an unchosen project is refused, not offered', async () => {
    const repo = join(root, 'garden-app');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(root, 'worktrees', 'garden-app-child');
    git(repo, 'worktree', 'add', '-q', '--detach', wt);
    writeFileSync(join(wt, 'shot.png'), PNG);
    register([{ name: 'garden-app', path: repo }]);
    expect((await file(join(wt, 'shot.png'))).body().error).toBe('other_project');
    expect((await grant(join(wt, 'shot.png'))).body().error).toBe('other_project');
  });

  it('an unchosen project whose root this project also links is refused, never auto-shown', async () => {
    const shared = join(root, 'shared');
    mkdirSync(join(shared, '_dream_context'), { recursive: true });
    writeFileSync(join(shared, 'pic.png'), PNG);
    const url = 'https://github.com/acme/shared.git';
    const cfgPath = join(contextRoot, 'state', '.config.json');
    const cfg = readFileSync(cfgPath, 'utf-8');
    writeFileSync(cfgPath, JSON.stringify({ linkedRepos: [{ name: 'code', gitRemoteUrl: 'https://github.com/acme/code.git' }, { name: 'shared', gitRemoteUrl: url }] }));
    setLinkedRepoPath(canonicalRemote(url) ?? url, shared, HOME);
    try {
      register([{ name: 'shared', path: shared }]);
      expect((await file(join(shared, 'pic.png'))).body().error).toBe('other_project');
    } finally {
      writeFileSync(cfgPath, cfg);
    }
  });

  it('when git cannot list a registered repo\'s worktrees, nothing outside the auto roots is offered', async () => {
    const broken = join(root, 'broken');
    mkdirSync(join(broken, '_dream_context'), { recursive: true });
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/elsewhere\n');
    register([{ name: 'broken', path: broken }]);
    expect((await file(join(elsewhere, 'free.png'))).body().error).toBe('other_project');
    // The project's own linked repo still shows: its roots were listed.
    expect((await file(join(codeRepo, 'tmp', 'shot.png'))).status()).toBe(200);
  });
});

describe('the grant route', () => {
  it('is the phone\'s only', async () => {
    const r = res();
    const req = { url: '/api/agent/phone-grant', socket: {}, headers: { host: 'x' }, on() { return req; } } as unknown as IncomingMessage;
    await handleAgentPhoneGrant(req, r.res, {}, contextRoot);
    expect(r.status()).toBe(403);
  });

  it('takes an absolute path only', async () => {
    expect((await grant('tmp/inside.png')).status()).toBe(400);
  });

  it('has nothing to grant inside the project', async () => {
    expect((await grant(join(projectRoot, 'tmp', 'inside.png'))).body()).toEqual({ granted: true, inside: true });
  });
});
