/**
 * The owner's own Share click on his Apps page (2026-11-08, `super/paylas-red`).
 *
 * Installed 0.41.5: "Share publicly" on his own app answered "Only the owner's own Apps page can
 * do this". The page sent the right Origin and `Sec-Fetch-Site`, but no owner key: the shell
 * handed its key to the notch window alone, and the Apps page lives in the Launcher (`main`) and
 * the project windows (`vault-*`). Replayed on the live server, the exact headers without the key
 * return that exact refusal. The fix is the shell's: those windows now get the key too.
 *
 * Here: with the key a page of the app sends, every owner-only Apps route lets the click through
 * (and Share publicly opens its grant); without the key, without an Origin, from another origin or
 * cross-site, the same click is refused as before. The last block ties the server's demand to the
 * shell's grant, so a route can never again ask a key the window that calls it cannot hold.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as share from '../../src/server/routes/apps-share.js';
import { setAppsHomeForTests } from '../../src/server/routes/apps.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { registerApp } from '../../src/lib/apps/registry.js';

const KEY = 'b7'.repeat(32);
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** What a click on the Apps page sends from a window that holds the key (`api.ownerPost`). */
const OWNER_CLICK = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [OWNER_KEY_HEADER]: KEY };

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;

/** Every route on the Apps page that decides in the owner's name, with a harmless target. */
const OWNER_ROUTES: Array<[string, Handler, Record<string, string>]> = [
  ['publish grant (Share, Share publicly)', share.handlePublishGrant, { slug: 'nope' }],
  ['accept an invitation', share.handleSharedAccept, {}],
  ['install', share.handleInstall, {}],
  ['settings and keys', share.handleAppConfigSet, { slug: 'nope' }],
  ['update', share.handleUpdateApply, { slug: 'nope' }],
  ['undo an update', share.handleUpdateUndo, { slug: 'nope' }],
  ['auto-update', share.handleAutoUpdate, { slug: 'nope' }],
  ['my own copy', share.handleDetach, { slug: 'nope' }],
  ['uninstall', share.handleUninstall, { slug: 'nope' }],
  ['restore from trash', share.handleTrashRestore, {}],
];

let home: string;
let contextRoot: string;
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-share-')));
  const project = join(home, 'proj');
  contextRoot = join(project, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  const root = join(home, 'proj-apps', 'yuk-izleme');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk-izleme', name: 'Yuk Izleme' }));
  registerApp(home, { projectRoot: project, vault: 'v', slug: 'yuk-izleme', name: 'Yuk Izleme', root });
  setAppsHomeForTests(home);
});
afterAll(() => {
  setOwnerKey(null);
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => setOwnerKey(KEY));

function post(headers: Record<string, string>, body: unknown = {}, remote = '127.0.0.1'): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', url: '/', headers,
    socket: { remoteAddress: remote, setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

async function call(h: Handler, params: Record<string, string>, headers: Record<string, string>, body: unknown = {}) {
  let status = 0;
  let out: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { out = JSON.parse(String(data)); } catch { out = {}; } },
  } as unknown as ServerResponse;
  await h(post(headers, body), res, params, contextRoot);
  return { status, body: out };
}

const without = (k: string) => Object.fromEntries(Object.entries(OWNER_CLICK).filter(([x]) => x !== k));

describe('the owner\'s click passes', () => {
  it('Share publicly on his own app opens a public grant (the click that was refused)', async () => {
    const r = await call(share.handlePublishGrant, { slug: 'yuk-izleme' }, OWNER_CLICK, { visibility: 'public' });
    expect(r.status).toBe(200);
    expect(r.body.visibility).toBe('public');
    expect(String(r.body.grant)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('Share (private) opens a private grant', async () => {
    const r = await call(share.handlePublishGrant, { slug: 'yuk-izleme' }, OWNER_CLICK, { visibility: 'private' });
    expect(r.status).toBe(200);
    expect(r.body.visibility).toBe('private');
  });

  for (const [what, h, params] of OWNER_ROUTES) {
    it(`${what}: the gate lets the owner's click through`, async () => {
      const r = await call(h, params, OWNER_CLICK);
      expect(r.body.error).not.toBe('owner_page_only');
      expect(r.status).not.toBe(403);
    });
  }
});

describe('anything else is refused exactly as before', () => {
  const refusals: Array<[string, Record<string, string>]> = [
    ['the right headers without the key (what 0.41.5\'s Apps page sent)', without(OWNER_KEY_HEADER)],
    ['the key without an Origin (an agent\'s curl that read the key)', without('origin')],
    ['the key without Fetch Metadata', without('sec-fetch-site')],
    ['the key from another loopback port', { ...OWNER_CLICK, origin: 'http://127.0.0.1:5173' }],
    ['the key on a cross-site request', { ...OWNER_CLICK, 'sec-fetch-site': 'cross-site' }],
    ['a made-up key', { ...OWNER_CLICK, [OWNER_KEY_HEADER]: 'c9'.repeat(32) }],
  ];
  for (const [what, headers] of refusals) {
    it(`${what}: 403 owner_page_only on every owner route`, async () => {
      for (const [, h, params] of OWNER_ROUTES) {
        const r = await call(h, params, headers);
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('owner_page_only');
      }
    });
  }

  it('a server the shell gave no key refuses even a perfect click', async () => {
    setOwnerKey(null);
    const r = await call(share.handlePublishGrant, { slug: 'yuk-izleme' }, OWNER_CLICK, { visibility: 'public' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner_page_only');
  });

  it('outside the desktop app nothing reaches the owner gate', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    try {
      const r = await call(share.handlePublishGrant, { slug: 'yuk-izleme' }, OWNER_CLICK, { visibility: 'public' });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('forbidden');
    } finally { process.env.DREAMCONTEXT_DESKTOP = '1'; }
  });
});

describe('the windows that draw the Apps page hold the key', () => {
  const tauri = join(__dirname, '..', '..', 'desktop', 'src-tauri');
  const caps = ['default', 'assistant', 'checklist', 'viewer', 'node-setup', 'splash'].map((c) => readFileSync(join(tauri, 'capabilities', `${c}.json`), 'utf-8'));
  const ownerKeyRs = readFileSync(join(tauri, 'src', 'owner_key.rs'), 'utf-8');
  const libRs = readFileSync(join(tauri, 'src', 'lib.rs'), 'utf-8');

  it('no static capability grants the key: theirs allow every loopback port, a web card\'s too', () => {
    for (const c of caps) expect(c).not.toMatch(/"allow-owner-key"/);
  });

  it('the shell grants it at runtime to the notch, the Launcher and the project windows, on the app\'s own port only', () => {
    expect(ownerKeyRs).toMatch(/const OWNER_WINDOWS: \[&str; 3\] = \["assistant", "main", "vault-\*"\];/);
    expect(ownerKeyRs).toMatch(/\[format!\("http:\/\/127\.0\.0\.1:\{port\}"\), format!\("http:\/\/localhost:\{port\}"\)\]/);
    expect(ownerKeyRs).toMatch(/\.local\(false\)/);
    expect(ownerKeyRs).toMatch(/\.permission\("allow-owner-key"\)/);
    // Granted right where the shell learns the port.
    expect(libRs).toMatch(/app\.manage\(DashboardPort\(port\)\);[\s\S]{0,500}owner_key::grant\(&app, port\)/);
  });

  it('the command answers the notch, the Launcher and the project windows, and only them', () => {
    const fn = ownerKeyRs.match(/fn is_owner_window\(label: &str\) -> bool \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(fn).toMatch(/label == "assistant"/);
    expect(fn).toMatch(/label == "main"/);
    expect(fn).toMatch(/label\.starts_with\("vault-"\)/);
    expect(fn).not.toMatch(/inbox|viewer|checklist/);
    // The origin check stays: a window on another port or host is never the app's page.
    expect(ownerKeyRs).toMatch(/if !is_owner_window\(webview\.label\(\)\) \|\| !is_app_page\(&url, port\)/);
  });

  it('every owner-only Apps click goes through ownerPost, the one call that sends the key', () => {
    const dash = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'apps');
    const files = ['AppCard.tsx', 'ManageSheets.tsx', 'InstallSheet.tsx', 'SharedApps.tsx'].map((f) => readFileSync(join(dash, f), 'utf-8')).join('\n');
    for (const path of ['/publish/grant', '/apps/shared/accept', '/apps/install', '/config', '/update', '/update/undo', '/auto-update', '/apps/trash/restore']) {
      expect(files).toMatch(new RegExp(`ownerPost[^\\n]*${path.replace(/\//g, '\\/')}`));
    }
    expect(files).not.toMatch(/api\.post[^\n]*\/(publish\/grant|uninstall|detach|config|auto-update|update\/undo|shared\/accept|trash\/restore)['`]/);
    expect(files).not.toMatch(/api\.post[^\n]*'\/apps\/install'/);
  });
});
