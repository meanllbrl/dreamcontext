// Live links, the board kind (tunel-paylasim C7, D5): what a guest sees of a whiteboard (the
// projection), which viewer files it may load (the share.html manifest closure), the closed GET
// table through a real share listener, and the two ways a board's end closes its link.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { addVault } from '../../src/lib/vaults.js';
import { createWhiteboard, mutateWhiteboard } from '../../src/lib/whiteboards/store.js';
import { fileIdFor, writeBoardFile } from '../../src/lib/whiteboards/files.js';
import { guestElements, guestPictureIds } from '../../src/lib/whiteboards/guest-view.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';
import { VIEWER_CSP, setShareViewerDirForTests, viewerAssets } from '../../src/server/shares/board-kind.js';
import { handleWhiteboardDelete } from '../../src/server/routes/whiteboards.js';
import { closeAllShares, getShare, openShare, type Share } from '../../src/server/shares/registry.js';
import { fakeWorld, openAndWait, sessionCookie, viaTunnel, waitFor, type FakeWorld } from './share-fixture.js';

const el = (id: string, patch: Record<string, unknown>): WhiteboardElement => ({ id, type: 'rectangle', version: 1, ...patch });

// ─── the projection ─────────────────────────────────────────────────────────

describe('guestElements: a guest sees the drawing, never the brain behind a card', () => {
  const scene: WhiteboardElement[] = [
    el('task', { type: 'embeddable', link: 'dreamcontext://task/secret-slug', customData: { dc: { v: 1, kind: 'task', ref: 'secret-slug', title: 'Lansman', markdown: 'gizli', url: 'https://x.test', size: 'm', color: 'blue' } } }),
    el('untitled', { type: 'embeddable', customData: { dc: { v: 1, kind: 'insight', ref: 'mrr', markdown: 'fallback', url: 'https://y.test' } } }),
    el('note', { type: 'embeddable', customData: { dc: { v: 1, kind: 'note', title: 'Not', markdown: '# merhaba' } } }),
    el('todo', { type: 'embeddable', customData: { dc: { v: 1, kind: 'todo', title: 'Liste', items: [{ text: 'bir', done: true, id: 'x' }, { text: 'iki', done: false }] } } }),
    el('html', { type: 'embeddable', customData: { dc: { v: 1, kind: 'html', title: 'Sayfa', html: '<script>steal()</script>' } } }),
    el('plain', { customData: { dcTag: 'grup', secret: 1 }, link: 'https://ok.example/a' }),
    el('js', { link: 'javascript:alert(1)' }),
    el('dc', { link: 'dreamcontext://knowledge/inner' }),
    el('frame', { type: 'iframe', link: 'https://frame.example' }),
    el('gone', { isDeleted: true }),
    el('embed', { type: 'embeddable', link: 'https://youtube.example/v' }),
    el('pic', { type: 'image', fileId: 'abcdefgh12' }),
    el('pic-dead', { type: 'image', fileId: 'deadbeef99', isDeleted: true }),
  ];
  const out = guestElements(scene);
  const byId = Object.fromEntries(out.map((e) => [e.id, e]));

  it('a widget keeps {kind, title} and a dreamcontext://<kind> link, never its ref, url or body', () => {
    expect(byId.task.customData).toEqual({ dc: { v: 1, kind: 'task', title: 'Lansman', size: 'm', color: 'blue' } });
    expect(byId.task.link).toBe('dreamcontext://task');
    expect(JSON.stringify(out)).not.toMatch(/secret-slug|gizli|x\.test|y\.test|fallback|mrr|steal/);
  });
  it('no title: the kind alone, no fallback to ref, url or markdown', () => {
    expect(byId.untitled.customData).toEqual({ dc: { v: 1, kind: 'insight' } });
  });
  it('a note keeps its own text, a todo its items (text and done only), an html card loses its body', () => {
    expect((byId.note.customData as { dc: { markdown: string } }).dc.markdown).toBe('# merhaba');
    expect((byId.todo.customData as { dc: { items: unknown } }).dc.items).toEqual([{ text: 'bir', done: true }, { text: 'iki', done: false }]);
    expect(byId.html.customData).toEqual({ dc: { v: 1, kind: 'html', title: 'Sayfa' } });
  });
  it('a plain element loses customData; only an http(s) link survives', () => {
    expect(byId.plain.customData).toBeUndefined();
    expect(byId.plain.link).toBe('https://ok.example/a');
    expect(byId.js.link).toBeNull();
    expect(byId.dc.link).toBeNull();
  });
  it('iframes and deleted elements are gone; a non-widget embeddable loses its link', () => {
    expect(byId.frame).toBeUndefined();
    expect(byId.gone).toBeUndefined();
    expect(byId.embed.link).toBeNull();
  });
  it('the picture ids are the live images only', () => {
    expect([...guestPictureIds(out)]).toEqual(['abcdefgh12']);
  });
  it('the source scene is not mutated', () => {
    expect(scene[0].link).toBe('dreamcontext://task/secret-slug');
    expect((scene[5].customData as Record<string, unknown>).secret).toBe(1);
  });
});

// ─── the viewer's files ─────────────────────────────────────────────────────

function viewerFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-share-viewer-'));
  mkdirSync(join(dir, '.vite'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'excalidraw-assets'), { recursive: true });
  writeFileSync(join(dir, 'share.html'), '<!doctype html><title>viewer</title><script type="module" src="/assets/share-1.js"></script>');
  const manifest = {
    'share.html': { file: 'assets/share-1.js', isEntry: true, imports: ['_shared-2.js'], dynamicImports: ['lazy.tsx'], css: ['assets/share-1.css'] },
    '_shared-2.js': { file: 'assets/shared-2.js', assets: ['assets/font-3.woff2'] },
    'lazy.tsx': { file: 'assets/lazy-4.js', imports: ['_shared-2.js'] },
    'index.html': { file: 'assets/main-9.js', isEntry: true, imports: ['_shared-2.js', '_owner-8.js'], css: ['assets/main-9.css'] },
    '_owner-8.js': { file: 'assets/owner-8.js' },
  };
  writeFileSync(join(dir, '.vite', 'manifest.json'), JSON.stringify(manifest));
  for (const f of ['share-1.js', 'shared-2.js', 'font-3.woff2', 'lazy-4.js', 'share-1.css', 'main-9.js', 'main-9.css', 'owner-8.js']) {
    writeFileSync(join(dir, 'assets', f), `/* ${f} */`);
  }
  writeFileSync(join(dir, 'excalidraw-assets', 'Virgil.woff2'), 'font');
  return dir;
}

describe('viewerAssets: the share.html closure only', () => {
  it('lists the entry, its imports, dynamic imports, css and assets, never a main-only file', () => {
    const files = viewerAssets(viewerFixture());
    expect([...files].sort()).toEqual(['assets/font-3.woff2', 'assets/lazy-4.js', 'assets/share-1.css', 'assets/share-1.js', 'assets/shared-2.js']);
  });
  it('no manifest serves nothing', () => {
    expect(viewerAssets(mkdtempSync(join(tmpdir(), 'dc-share-none-'))).size).toBe(0);
  });
});

// ─── through the share listener ─────────────────────────────────────────────

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let w: FakeWorld;
let ctx: string;
let slug: string;
let picId: string;

async function openBoard(s: string): Promise<{ share: Share; cookie: string }> {
  const share = await openAndWait(() => openShare({ kind: 'board', vault: 'northwind', slug: s }).share);
  expect(share.state).toBe('open');
  const cookie = sessionCookie(await viaTunnel(share, 'GET', `/k/${share.token}`, { accept: 'text/html' }));
  return { share, cookie };
}

beforeAll(async () => {
  w = fakeWorld();
  const project = mkdtempSync(join(tmpdir(), 'dc-board-share-'));
  ctx = join(project, '_dream_context');
  mkdirSync(ctx, { recursive: true });
  addVault('northwind', project, w.home);
  setShareViewerDirForTests(viewerFixture());
  slug = createWhiteboard(ctx, 'Lansman Panosu').slug;
  picId = fileIdFor(PNG);
  writeBoardFile(ctx, slug, picId, PNG);
  writeBoardFile(ctx, slug, fileIdFor(Buffer.concat([PNG, Buffer.from([0])])), Buffer.concat([PNG, Buffer.from([0])]));
  await mutateWhiteboard(ctx, slug, (b) => {
    b.elements.push(
      el('card', { type: 'embeddable', link: 'dreamcontext://task/gizli-gorev', customData: { dc: { v: 1, kind: 'task', ref: 'gizli-gorev', title: 'Lansman' } } }),
      el('pic', { type: 'image', fileId: picId }),
    );
  });
});
afterAll(async () => {
  await closeAllShares('shutdown');
  setShareViewerDirForTests(null);
});

describe('the board guest table (GET/HEAD only, closed)', () => {
  let share: Share;
  let cookie: string;
  beforeAll(async () => { ({ share, cookie } = await openBoard(slug)); });
  afterAll(async () => { await closeAllShares('owner'); });

  const get = (path: string, method = 'GET', body?: string) => viaTunnel(share, method, path, { cookie, origin: share.origin ?? '' }, body);

  it('/ is the viewer page with its own CSP', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<title>viewer</title>');
    expect(r.headers['content-security-policy']).toBe(VIEWER_CSP);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });
  it('/assets/* serves the share closure, 404s the owner app files and traversal', async () => {
    expect((await get('/assets/share-1.js')).status).toBe(200);
    expect((await get('/assets/font-3.woff2')).headers['content-type']).toBe('font/woff2');
    expect((await get('/assets/main-9.js')).status).toBe(404);
    expect((await get('/assets/owner-8.js')).status).toBe(404);
    expect((await get('/assets/../share.html')).status).toBe(404);
    expect((await get('/excalidraw-assets/Virgil.woff2')).status).toBe(200);
    expect((await get('/excalidraw-assets/../.vite/manifest.json')).status).toBe(404);
  });
  it('/__share/rev is {rev} only', async () => {
    const r = await get('/__share/rev');
    expect(r.status).toBe(200);
    expect(Object.keys(JSON.parse(r.body))).toEqual(['rev']);
  });
  it('/__share/board is the projected scene', async () => {
    const r = await get('/__share/board');
    expect(r.status).toBe(200);
    const b = JSON.parse(r.body) as { name: string; rev: string; elements: WhiteboardElement[] };
    expect(b.name).toBe('Lansman Panosu');
    expect(b.elements.find((e) => e.id === 'card')?.link).toBe('dreamcontext://task');
    expect(r.body).not.toContain('gizli-gorev');
  });
  it('/__share/files/<id> serves a live picture nosniff; an unreferenced file id 404s', async () => {
    const r = await get(`/__share/files/${picId}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(`/__share/files/${fileIdFor(Buffer.concat([PNG, Buffer.from([0])]))}`)).status).toBe(404);
    expect((await get('/__share/files/nothere12345')).status).toBe(404);
  });
  it('a write is 405, an unknown path 404, the owner board API is not reachable', async () => {
    expect((await get('/__share/board', 'POST', '{}')).status).toBe(405);
    expect((await get('/__share/board', 'PUT', '{}')).status).toBe(405);
    expect((await get('/api/whiteboards')).status).toBe(404);
    expect((await get(`/api/whiteboards/${slug}`)).status).toBe(404);
  });
});

describe('the board ending closes its live link', () => {
  it('the delete route closes the share at once', async () => {
    const s2 = createWhiteboard(ctx, 'Silinecek Pano').slug;
    const { share } = await openBoard(s2);
    let status = 0;
    const res = { writeHead: (c: number) => { status = c; return res; }, setHeader: () => {}, end: () => {}, headersSent: false } as unknown as ServerResponse;
    await handleWhiteboardDelete({} as IncomingMessage, res, { slug: s2 }, ctx);
    expect(status).toBe(200);
    await waitFor(() => getShare(share.id)?.state !== 'open', 3000, 'share closed by delete');
    expect(['closing', 'closed']).toContain(getShare(share.id)?.state ?? 'closed');
  });

  it('two missing reads at least 5 s apart close it; one miss does not', async () => {
    const s3 = createWhiteboard(ctx, 'Kaybolan Pano').slug;
    const { share, cookie } = await openBoard(s3);
    const { rmSync } = await import('node:fs');
    rmSync(join(ctx, 'whiteboards', s3), { recursive: true, force: true });
    const first = await viaTunnel(share, 'GET', '/__share/rev', { cookie });
    expect(first.status).toBe(404);
    w.now += 2_000;
    expect((await viaTunnel(share, 'GET', '/__share/rev', { cookie })).status).toBe(404);
    expect(getShare(share.id)?.state).toBe('open');
    w.now += 4_000;
    // The closing answer still reaches the guest (the socket is torn down after it).
    expect((await viaTunnel(share, 'GET', '/__share/rev', { cookie })).status).toBe(404);
    await waitFor(() => getShare(share.id)?.state !== 'open', 3000, 'share closed by board_gone');
  });
});
