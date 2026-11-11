/**
 * A8 (Apps audit, 2026-11-12): an own copy of someone's app under a licence that forbids sharing
 * it again showed Share; the click opened a chat and only then Claude reported the refusal. The
 * grant route now says why at the click, with the same sentence publish would give.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handlePublishGrant } from '../../src/server/routes/apps-share.js';
import { setAppsHomeForTests } from '../../src/server/routes/apps.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { registerApp, updateAppShare } from '../../src/lib/apps/registry.js';

const KEY = 'a5'.repeat(32);
const PORT = 4173;
const OWNER_CLICK = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [OWNER_KEY_HEADER]: KEY };

let home: string;
let project: string;
let contextRoot: string;
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function app(slug: string): void {
  const root = join(home, 'proj-apps', slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: slug }));
  registerApp(home, { projectRoot: project, vault: 'v', slug, name: slug, root });
}

async function grant(slug: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let body: Record<string, unknown> = {};
  const req = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', url: '/', headers: OWNER_CLICK, socket: { remoteAddress: '127.0.0.1', setTimeout() {} }, setTimeout() {} }) as unknown as IncomingMessage;
  const res = { writeHead(c: number) { status = c; }, setHeader() {}, end(d?: string) { try { body = JSON.parse(String(d)); } catch { body = {}; } } } as unknown as ServerResponse;
  await handlePublishGrant(req, res, { slug }, contextRoot);
  return { status, body };
}

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-share-lic-')));
  project = join(home, 'proj');
  contextRoot = join(project, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  setAppsHomeForTests(home);
  setOwnerKey(KEY);
  app('closed-copy');
  updateAppShare(home, project, 'closed-copy', { provenance: { fullName: 'someone/closed-app', license: 'restricted' } });
  app('mit-copy');
  updateAppShare(home, project, 'mit-copy', { provenance: { fullName: 'someone/open-app', license: 'MIT' } });
});
afterAll(() => {
  setOwnerKey(null);
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(home, { recursive: true, force: true });
});

describe('Share on a copy of someone else\'s app', () => {
  it('a licence that forbids sharing again: refused at the click, with the reason', async () => {
    const r = await grant('closed-copy');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('license_forbids');
    expect(String(r.body.message)).toContain('someone/closed-app');
    expect(String(r.body.message)).toContain('does not allow sharing it again');
  });

  it('an open licence: the grant opens as before', async () => {
    const r = await grant('mit-copy');
    expect(r.status).toBe(200);
    expect(String(r.body.grant)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});
