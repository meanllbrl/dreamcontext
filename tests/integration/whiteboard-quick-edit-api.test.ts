/**
 * The quick-edit routes (plan tahta-hizli-duzenle C1) over a real socket, on the REAL
 * `buildRouter()`, with the child replaced by a fake `claude` (the exec seam): deterministic
 * answers, the argv it was spawned with, and a stop that kills its "process group".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { buildRouter } from '../../src/server/index.js';
import { handleCors, isCrossSiteWrite, sendError } from '../../src/server/middleware.js';
import { createWhiteboard, identityKey, mutateWhiteboard, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { resetQuickJobsForTests, setQuickDepsForTests, QUICK_MAX_PER_MINUTE } from '../../src/lib/whiteboards/quick-edit-jobs.js';
import type { ClaudeExecution } from '../../src/lib/automations/runner.js';
import { readJournal } from '../../src/lib/whiteboards/quick-edit.js';
import { NO_ENV_GATE } from '../../src/lib/t3-bridge/env-gate.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';
import { deniedForEveryone } from '../../src/lib/apps/page-routes.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';

let tmp: string;
let roots: Record<string, string>;
let server: Server;
let port: number;

function call(method: string, path: string, body?: unknown, vault = 'a'): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { 'x-test-vault': vault, ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the fake claude ──
interface Spawned {
  args: string[]; stdin?: string; resolve: (stdout: string) => void; child: EventEmitter & { pid: number }; killed: string[];
  /** A Codex / Antigravity run: the program, its timeout, its working folder, and the turn file read while it ran. */
  command?: { file: string; prefix: string[] }; timeoutMs?: number; cwd?: string; turn?: string; pictureOnDisk?: boolean;
}
let spawned: Spawned[] = [];
let auto: ((args: string[]) => unknown) | null = null;
const envelope = (answer: unknown) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: answer, total_cost_usd: 0.004 });

function fakeExec(args: string[], opts: { onSpawned?: (c: unknown, at: Date) => void; stdin?: string; command?: { file: string; prefix: string[] }; timeoutMs?: number; cwd?: string }): Promise<ClaudeExecution> {
  return new Promise((resolve) => {
    const child = Object.assign(new EventEmitter(), { pid: 90000 + spawned.length });
    const turnArg = args.find((a) => a.startsWith('--prompt-file='));
    const turn = turnArg ? readFileSync(turnArg.slice('--prompt-file='.length), 'utf-8') : undefined;
    const pic = turn?.match(/^\[Picture 1: (.+)\]$/m)?.[1];
    const entry: Spawned = {
      args, child, killed: [], stdin: opts.stdin, command: opts.command, timeoutMs: opts.timeoutMs, cwd: opts.cwd, turn,
      pictureOnDisk: pic ? (() => { try { return readFileSync(pic).length > 0; } catch { return false; } })() : undefined,
      resolve: (stdout) => resolve({ spawned: true, timedOut: false, exitCode: 0, stdout, stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: null }),
    };
    spawned.push(entry);
    opts.onSpawned?.(child, new Date());
    if (auto) entry.resolve(envelope(auto(args)));
  });
}

function rect(id: string, x = 0, extra: Partial<WhiteboardElement> = {}): WhiteboardElement {
  return { id, type: 'rectangle', x, y: 0, width: 100, height: 60, angle: 0, version: 3, versionNonce: 500, index: `a${id}`, isDeleted: false, groupIds: [], boundElements: null, backgroundColor: '#d0bfff', ...extra } as WhiteboardElement;
}

async function boardWith(els: WhiteboardElement[], vault = 'a'): Promise<string> {
  const { slug } = createWhiteboard(roots[vault], `B ${Math.random().toString(36).slice(2, 8)}`);
  await mutateWhiteboard(roots[vault], slug, (b) => { b.elements.push(...els); });
  return slug;
}
const file = (slug: string, vault = 'a') => join(roots[vault], 'whiteboards', slug, `${slug}.excalidraw.md`);
const identitiesOf = (slug: string, wanted: string[]) => Object.fromEntries(readWhiteboard(roots.a, slug).board.elements.filter((e) => wanted.includes(e.id)).map((e) => [e.id, identityKey(e)]));

async function settle(slug: string, job: string, vault = 'a'): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', `/api/whiteboards/${slug}/quick-edit/${job}`, undefined, vault);
    if (['done', 'failed', 'stopped'].includes(r.body.state)) return r.body;
    await pause(20);
  }
  throw new Error('job never settled');
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-quick-api-')));
  roots = { a: join(tmp, 'a', '_dream_context'), b: join(tmp, 'b', '_dream_context') };
  for (const r of Object.values(roots)) mkdirSync(join(r, 'state'), { recursive: true });
  const router = buildRouter();
  server = createServer(async (req, res) => {
    try {
      if (handleCors(req, res)) return;
      if (isCrossSiteWrite(req)) { sendError(res, 403, 'forbidden', 'Cross-site request blocked.'); return; }
      const url = new URL(req.url || '/', 'http://localhost');
      const match = router.match(req.method || 'GET', url.pathname);
      if (!match) { sendError(res, 404, 'not_found', 'No route'); return; }
      await match.handler(req, res, match.params, roots[String(req.headers['x-test-vault'] ?? 'a')]);
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, 'internal', (err as Error).message);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  resetQuickJobsForTests();
  spawned = [];
  auto = null;
  setQuickDepsForTests({ exec: fakeExec as never, env: {}, system: () => 'SYS', status: () => ({ ok: true }), kill: (pid, sig) => {
    const s = spawned.find((x) => x.child.pid === -pid);
    s?.killed.push(sig);
  } });
});
afterEach(() => resetQuickJobsForTests());

describe('quick edit routes', () => {
  it('spawns the C5 argv, applies at once, returns the written elements; Geri al undoes after a "reload"', async () => {
    auto = () => ({ reply: 'Yeşil yapıldı.', notBoard: false, update: [{ id: 'A', fill: 'green' }] });
    const slug = await boardWith([rect('A'), rect('B', 300)]);
    const start = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'yeşil yap', scope: { ids: ['A'], identities: identitiesOf(slug, ['A']) } });
    expect(start.status).toBe(202);
    const view = await settle(slug, start.body.job);
    expect(view.state).toBe('done');
    expect(view.reply).toBe('Yeşil yapıldı.');
    expect(view.elements.map((e: WhiteboardElement) => e.id)).toEqual(['A']);
    expect(view.elements[0].backgroundColor).toBe('#b2f2bb');
    expect(view.timing.modelMs).toBeGreaterThanOrEqual(0);
    const args = spawned[0].args;
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    // The journal survives a reload: `last` offers it, undo writes the inverse.
    const last = await call('GET', `/api/whiteboards/${slug}/quick-edit/last`);
    expect(last.body.edit.id).toBe(view.edit.id);
    const undo = await call('POST', `/api/whiteboards/${slug}/quick-edit/${view.edit.id}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.body.elements[0].backgroundColor).toBe('#d0bfff');
    expect(readWhiteboard(roots.a, slug).board.elements.find((e) => e.id === 'A')!.backgroundColor).toBe('#d0bfff');
    expect((await call('GET', `/api/whiteboards/${slug}/quick-edit/last`)).body.edit).toBeUndefined();
  });

  it('undo refuses an older edit while a newer one is in force (not_latest)', async () => {
    const slug = await boardWith([rect('A')]);
    auto = () => ({ reply: '1', notBoard: false, move: [10, 0] });
    const j1 = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'sağa', scope: { ids: ['A'], identities: identitiesOf(slug, ['A']) } })).body.job);
    auto = () => ({ reply: '2', notBoard: false, move: [10, 0] });
    const j2 = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'sağa', scope: { ids: ['A'], identities: identitiesOf(slug, ['A']) } })).body.job);
    expect((await call('POST', `/api/whiteboards/${slug}/quick-edit/${j1.edit.id}/undo`)).body.error).toBe('not_latest');
    expect((await call('POST', `/api/whiteboards/${slug}/quick-edit/${j2.edit.id}/undo`)).status).toBe(200);
    expect((await call('POST', `/api/whiteboards/${slug}/quick-edit/${j1.edit.id}/undo`)).status).toBe(200);
    expect(readWhiteboard(roots.a, slug).board.elements[0].x).toBe(0);
  });

  it('an owner change during the edit survives (skipped and named)', async () => {
    const slug = await boardWith([rect('A'), rect('B', 300)]);
    const seen = identitiesOf(slug, ['A', 'B']);
    const start = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'büyüt', scope: { ids: ['A', 'B'], identities: seen } });
    await pause(20);
    // The owner moves B while the model thinks.
    await mutateWhiteboard(roots.a, slug, (b) => { const e = b.elements.find((x) => x.id === 'B')!; e.x = 999; e.version = 9; e.versionNonce = 1; });
    spawned[0].resolve(envelope({ reply: 'Büyütüldü.', notBoard: false, scale: 2 }));
    const view = await settle(slug, start.body.job);
    expect(view.skipped).toEqual(['B']);
    expect(readWhiteboard(roots.a, slug).board.elements.find((e) => e.id === 'B')!.x).toBe(999);
    expect(readWhiteboard(roots.a, slug).board.elements.find((e) => e.id === 'A')!.width).toBe(200);
  });

  it('a not-board answer and an out-of-scope answer write nothing', async () => {
    const slug = await boardWith([rect('A')]);
    const before = readFileSync(file(slug), 'utf-8');
    auto = () => ({ reply: 'Bu bir tahta değişikliği değil.', notBoard: true });
    const nb = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'kaç görev kapattık?', area: { x: 0, y: 0, w: 100, h: 100 } })).body.job);
    expect(nb.notBoard).toBe(true);
    auto = () => ({ reply: 'Önce A şeklini seç.', notBoard: false, update: [{ id: 'A', fill: 'green' }] });
    const oos = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'A yeşil olsun' })).body.job);
    expect(oos.outOfScope).toBe(true);
    expect(readFileSync(file(slug), 'utf-8')).toBe(before);
    expect(spawned[0].args.join('\n')).toContain('"area":{"x":0,"y":0,"w":100,"h":100}');
  });

  it('Durdur before the apply kills the process group and leaves the board byte-identical', async () => {
    const slug = await boardWith([rect('A')]);
    const before = readFileSync(file(slug), 'utf-8');
    const start = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'ekle' });
    await pause(20);
    const stop = await call('POST', `/api/whiteboards/${slug}/quick-edit/${start.body.job}/stop`);
    expect(stop.body.state).toBe('stopped');
    expect(spawned[0].killed).toContain('SIGTERM');
    spawned[0].resolve(envelope({ reply: 'x', notBoard: false, add: [{ at: [0, 0], spec: { elements: [{ type: 'ellipse' }] } }] }));
    await pause(50);
    expect(readFileSync(file(slug), 'utf-8')).toBe(before);
  });

  it('Durdur during the apply answers done and the edit stands', async () => {
    const slug = await boardWith([rect('A')]);
    // Hold the board's lock so the apply waits in `applying`.
    const lock = join(roots.a, 'whiteboards', '.locks', `${slug}.lock`);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    auto = () => ({ reply: 'ok', notBoard: false, move: [5, 0] });
    const start = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'sağa', scope: { ids: ['A'], identities: identitiesOf(slug, ['A']) } });
    await pause(50);
    expect((await call('GET', `/api/whiteboards/${slug}/quick-edit/${start.body.job}`)).body.state).toBe('applying');
    expect((await call('POST', `/api/whiteboards/${slug}/quick-edit/${start.body.job}/stop`)).body.state).toBe('done');
    rmSync(lock);
    expect((await settle(slug, start.body.job)).state).toBe('done');
    expect(readWhiteboard(roots.a, slug).board.elements[0].x).toBe(5);
  });

  it('one runs, one waits, a third is busy; scope over 150 is refused; the minute cap answers 429', async () => {
    const slug = await boardWith([rect('A')]);
    const first = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: '1' });
    const second = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: '2' });
    expect([first.status, second.status]).toEqual([202, 202]);
    expect((await call('GET', `/api/whiteboards/${slug}/quick-edit/${second.body.job}`)).body.state).toBe('queued');
    const third = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: '3' });
    expect([third.status, third.body.error]).toEqual([409, 'busy']);
    const big = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x', scope: { ids: Array.from({ length: 151 }, (_, i) => `e${i}`), identities: {} } });
    expect([big.status, big.body.error]).toEqual([413, 'scope_too_big']);
    resetQuickJobsForTests();
    setQuickDepsForTests({ exec: fakeExec as never, env: {}, system: () => 'SYS', status: () => ({ ok: true }), kill: () => {} });
    auto = () => ({ reply: 'x', notBoard: true });
    let last = 0;
    for (let i = 0; i <= QUICK_MAX_PER_MINUTE; i++) {
      const s = await boardWith([]);
      last = (await call('POST', `/api/whiteboards/${s}/quick-edit`, { text: 'x' })).status;
    }
    expect(last).toBe(429);
  });

  it('review r1: a follow-up queued on the same selection still writes; a change that cannot be made is not a success', async () => {
    const slug = await boardWith([rect('A')]);
    const seen = identitiesOf(slug, ['A']);
    const lock = join(roots.a, 'whiteboards', '.locks', `${slug}.lock`);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    auto = () => ({ reply: 'sağa', notBoard: false, move: [5, 0] });
    const first = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'sağa', scope: { ids: ['A'], identities: seen } });
    // The page has not got the first edit's elements yet: it sends the same identities again.
    const second = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'yine sağa', scope: { ids: ['A'], identities: seen } });
    rmSync(lock);
    expect((await settle(slug, first.body.job)).state).toBe('done');
    const v2 = await settle(slug, second.body.job);
    expect(v2.edit?.changed).toBe(1);
    expect(v2.skipped ?? []).toEqual([]);
    expect(readWhiteboard(roots.a, slug).board.elements[0].x).toBe(10);

    auto = () => ({ reply: "Kutuya 'Ödeme' yazıldı.", notBoard: false, update: [{ id: 'A', text: 'Ödeme' }] });
    const third = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: "kutuya Ödeme yaz", scope: { ids: ['A'], identities: identitiesOf(slug, ['A']) } });
    const v3 = await settle(slug, third.body.job);
    expect(v3).toMatchObject({ state: 'done', nothing: true });
    expect(v3.edit).toBeUndefined();
  });

  it('a job on another board or another vault is 404', async () => {
    auto = () => ({ reply: 'x', notBoard: true });
    const slug = await boardWith([rect('A')]);
    const other = await boardWith([rect('A')]);
    const job = (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x' })).body.job;
    await settle(slug, job);
    expect((await call('GET', `/api/whiteboards/${other}/quick-edit/${job}`)).status).toBe(404);
    mkdirSync(join(roots.b, 'whiteboards', slug), { recursive: true });
    writeFileSync(file(slug, 'b'), readFileSync(file(slug), 'utf-8'));
    expect((await call('GET', `/api/whiteboards/${slug}/quick-edit/${job}`, undefined, 'b')).status).toBe(404);
  });

  it('status never names an account; no Claude answers 412 before any spawn', async () => {
    setQuickDepsForTests({ exec: fakeExec as never, env: {}, status: () => ({ ok: false, reason: 'no_claude', text: 'Hızlı düzenle Claude ister: bu Mac\'te oturum açılmış bir Claude hesabı yok.' }) });
    const s = await call('GET', '/api/whiteboards/quick-edit/status');
    expect(s.body).toMatchObject({ ok: false, reason: 'no_claude' });
    expect(s.body.text).not.toMatch(/@/);
    const slug = await boardWith([]);
    expect((await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x' })).status).toBe(412);
    expect(spawned).toHaveLength(0);
  });
});

describe('quick edit reach', () => {
  it('an app (page and backend alike) is refused every quick-edit route; a board slugged quick-edit stays readable', () => {
    for (const p of ['/api/whiteboards/quick-edit/status', '/api/whiteboards/b/quick-edit', '/api/whiteboards/b/quick-edit/last', '/api/whiteboards/b/quick-edit/abc/undo']) {
      expect(deniedForEveryone(p)).toBe(true);
    }
    expect(deniedForEveryone('/api/whiteboards/quick-edit')).toBe(false);
    expect(deniedForEveryone('/api/whiteboards/quick-edit/rev')).toBe(false);
  });

  it('every quick-edit route has a phone row', () => {
    const routes = buildRouter().list().map((r) => `${r.method} ${r.path}`).filter((r) => r.includes('quick-edit'));
    expect(routes).toHaveLength(6);
    for (const r of routes) expect(ROUTE_POLICY[r]?.allow).toBe(true);
  });
});

describe('quick edit widgets (owner 12 Nov: insight, HTML, web page on the board)', () => {
  const insight = (slug: string, title: string) => {
    mkdirSync(join(roots.a, 'lab', 'insights'), { recursive: true });
    writeFileSync(join(roots.a, 'lab', 'insights', `${slug}.md`), `---\ntitle: ${title}\nrender: app\nsource:\n  adapter: script\n  script:\n    file: scripts/x.mjs\n---\n`);
  };

  it('adds a known insight inside the area, the catalog rides in the message, and Geri al removes it', async () => {
    insight('mrr', 'MRR');
    auto = () => ({ reply: 'MRR insight eklendi.', notBoard: false, widgets: [{ kind: 'insight', ref: 'mrr' }] });
    const slug = await boardWith([rect('A')]);
    const area = { x: 600, y: 400, w: 500, h: 300 };
    const start = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: "MRR insight'ını buraya ekle", area });
    const view = await settle(slug, start.body.job);
    expect(view.state).toBe('done');
    const card = view.elements.find((e: WhiteboardElement) => e.type === 'embeddable');
    expect(card.customData.dc).toMatchObject({ kind: 'insight', ref: 'mrr' });
    expect(card.x).toBe(600);
    expect(card.y).toBe(400);
    const user = spawned[0].args[spawned[0].args.indexOf('-p') + 1];
    expect(user).toMatch(/<catalog-[0-9a-f]+>/);
    expect(user).toContain('"mrr","MRR"');
    const undo = await call('POST', `/api/whiteboards/${slug}/quick-edit/${view.edit.id}/undo`);
    expect(undo.status).toBe(200);
    expect(readWhiteboard(roots.a, slug).board.elements.find((e) => e.id === card.id)?.isDeleted ?? true).toBe(true);
  });

  it('an unknown insight is refused by name and the board is left byte-identical', async () => {
    auto = () => ({ reply: 'Eklendi.', notBoard: false, widgets: [{ kind: 'insight', ref: 'churn-rate' }] });
    const slug = await boardWith([rect('A')]);
    const before = readFileSync(file(slug), 'utf-8');
    const view = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'churn insight ekle' })).body.job);
    expect(view.state).toBe('failed');
    expect(view.code).toBe('widget');
    expect(view.refusal).toEqual({ kind: 'insight', why: 'not_found', name: 'churn-rate' });
    expect(readFileSync(file(slug), 'utf-8')).toBe(before);
  });

  it('a web card pointing outside the project, or at localhost, is refused; https lands', async () => {
    const slug = await boardWith([rect('A')]);
    for (const url of ['../../etc/passwd.html', '/etc/hosts.html', 'http://localhost:3000', 'file:///Users/x/secret.pdf']) {
      auto = () => ({ reply: 'Kondu.', notBoard: false, widgets: [{ kind: 'web', url }] });
      const view = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'bunu koy' })).body.job);
      expect(view.code, url).toBe('widget');
      expect(view.refusal.why, url).toBe('web');
    }
    auto = () => ({ reply: 'Site kondu.', notBoard: false, widgets: [{ kind: 'web', url: 'https://example.com' }] });
    const ok = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'https://example.com koy' })).body.job);
    expect(ok.state).toBe('done');
    expect(ok.elements[0].customData.dc).toMatchObject({ kind: 'web', url: 'https://example.com/' });
  });
});

describe('quick edit attachments (owner 12 Nov: dropped and pasted pictures and files reach the prompt)', () => {
  // A 2x1 PNG: real bytes, so the server sniffs it as a picture.
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000010802000000' + '7b40e8dd0000000c4944415408d763f8cfc0f01f0005fe02fedb4a7a1e0000000049454e44ae426082', 'hex');
  const drop = (name: string, bytes: Buffer | string) => {
    const dir = join(roots.a, 'tmp', 'agent-drops');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${Date.now()}-${name}`);
    writeFileSync(p, bytes);
    return p;
  };

  it('a picture and a text file go into the turn on stdin; a picture asked to be placed lands as an image', async () => {
    const shot = drop('ekran.png', PNG);
    const notes = drop('notlar.txt', 'Giriş ekranı: e-posta, şifre, Giriş yap');
    auto = () => ({ reply: 'Resim kondu.', notBoard: false, pictures: [1] });
    const slug = await boardWith([rect('A')]);
    const view = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'bunu tahtaya koy', attachments: [shot, notes] })).body.job);
    expect(view.state).toBe('done');
    const args = spawned[0].args;
    expect(args).toContain('--input-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    const line = JSON.parse(spawned[0].stdin!);
    const content = line.message.content;
    expect(content[0].text).toContain('Request from the owner: bunu tahtaya koy');
    expect(content[0].text).toMatch(/<owner-file-[0-9a-f]+ name="notlar.txt">\nGiriş ekranı: e-posta, şifre, Giriş yap\n<\/owner-file-/);
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
    const img = view.elements.find((e: WhiteboardElement) => e.type === 'image');
    expect(img.fileId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it('a file outside the drop folder is never read; an unreadable one is refused by name', async () => {
    const slug = await boardWith([rect('A')]);
    const secret = join(tmp, 'a', 'secret.txt');
    writeFileSync(secret, 'TOKEN=1');
    auto = () => ({ reply: 'x', notBoard: false });
    const out = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'oku', attachments: [secret] })).body.job);
    expect(out.code).toBe('attachment');
    expect(out.refusal).toEqual({ kind: 'attachment', why: 'gone', name: 'secret.txt' });
    const bin = drop('veri.bin', Buffer.from([0, 1, 2, 255, 254]));
    const bad = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'oku', attachments: [bin] })).body.job);
    expect(bad.refusal).toMatchObject({ why: 'type', name: 'veri.bin' });
    expect(spawned).toHaveLength(0);
  });
});

describe('quick edit model pick (owner 12 Nov: "maybe I will use Gemini on the whiteboard")', () => {
  // What `t3-run` prints: the claude -p shape, the answer as text (no schema flag there).
  const toolEnvelope = (answer: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```json\n' + JSON.stringify(answer) + '\n```', total_cost_usd: 0.011, dc_tool: 'codex', ...extra });
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000010802000000' + '7b40e8dd0000000c4944415408d763f8cfc0f01f0005fe02fedb4a7a1e0000000049454e44ae426082', 'hex');
  beforeEach(() => {
    setQuickDepsForTests({ exec: fakeExec as never, env: {}, system: () => 'SYS', status: () => ({ ok: true }), bridge: () => ({ node: '/n/node', cli: '/c/cli.js' }) });
  });

  it('a Claude pick runs that model; no pick is Sonnet', async () => {
    auto = () => ({ reply: 'ok', notBoard: false, add: [] });
    const slug = await boardWith([rect('A')]);
    await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x', tool: 'claude', model: 'haiku' })).body.job);
    expect(spawned[0].args[spawned[0].args.indexOf('--model') + 1]).toBe('haiku');
    expect(spawned[0].command).toBeUndefined();
  });

  it('Codex: its read-only headless run in an empty temp folder, the same answer applied the same way, the model journaled', async () => {
    const slug = await boardWith([rect('A'), rect('B', 300)]);
    const job = (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'yeşil yap', tool: 'codex', model: 'gpt-5.5', scope: { ids: ['A'], identities: identitiesOf(slug, ['A']) } })).body.job;
    await pause(20);
    const sp = spawned[0];
    expect(sp.command).toEqual({ file: '/n/node', prefix: ['/c/cli.js'] });
    expect(sp.args.slice(0, 3)).toEqual(['t3-run', '--surface', 'board-quick']);
    expect(sp.args).toContain('--model');
    expect(sp.args[sp.args.indexOf('--model') + 1]).toBe('gpt-5.5');
    expect(sp.args).not.toContain('--tool');
    expect(sp.timeoutMs).toBe(120_000);
    // The turn file sits in the run's own temp folder, which holds nothing else of the project.
    const turnArg = sp.args.find((a) => a.startsWith('--prompt-file='))!;
    expect(turnArg.slice('--prompt-file='.length).startsWith(sp.cwd! + '/')).toBe(true);
    expect(sp.cwd).not.toContain(roots.a);
    expect(sp.turn).toMatch(/^SYS\n/);
    expect(sp.turn).toContain('"notBoard"');
    expect(sp.turn).toContain('Request from the owner: yeşil yap');
    sp.resolve(toolEnvelope({ reply: 'Yeşil yapıldı.', notBoard: false, update: [{ id: 'A', fill: 'green' }] }));
    const view = await settle(slug, job);
    expect(view.state).toBe('done');
    expect(view.costUsd).toBe(0.011);
    expect(readWhiteboard(roots.a, slug).board.elements.find((e) => e.id === 'A')!.backgroundColor).toBe('#b2f2bb');
    expect(readJournal(roots.a, slug).at(-1)!.model).toBe('codex:gpt-5.5');
  });

  it('Antigravity (Gemini): names the tool; a picture is a file in that folder, named on its own line', async () => {
    const dir = join(roots.a, 'tmp', 'agent-drops');
    mkdirSync(dir, { recursive: true });
    const shot = join(dir, `${Date.now()}-ekran.png`);
    writeFileSync(shot, PNG);
    const slug = await boardWith([rect('A')]);
    const job = (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'bunu tahtaya koy', tool: 'antigravity', model: '', attachments: [shot] })).body.job;
    await pause(20);
    const sp = spawned[0];
    expect(sp.args[sp.args.indexOf('--tool') + 1]).toBe('antigravity');
    expect(sp.args).not.toContain('--model');
    expect(sp.turn).toContain(`[Picture 1: ${sp.cwd}/picture-1.png]`);
    expect(sp.pictureOnDisk).toBe(true);
    sp.resolve(toolEnvelope({ reply: 'Resim kondu.', notBoard: false, pictures: [1] }, { dc_tool: 'antigravity', total_cost_usd: null }));
    const view = await settle(slug, job);
    expect(view.state).toBe('done');
    expect(readWhiteboard(roots.a, slug).board.elements.some((e) => e.type === 'image')).toBe(true);
  });

  it('a tool that cannot run the turn fails as `tool`, nothing written; Claude being signed out does not block it', async () => {
    setQuickDepsForTests({ exec: fakeExec as never, env: {}, system: () => 'SYS', status: () => ({ ok: false, reason: 'no_claude', text: 'x' }), bridge: () => ({ node: '/n/node', cli: '/c/cli.js' }) });
    const slug = await boardWith([rect('A')]);
    const before = readFileSync(file(slug), 'utf-8');
    const start = await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x', tool: 'codex', model: '' });
    expect(start.status).toBe(202);
    await pause(20);
    spawned[0].resolve(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Codex is signed out.', total_cost_usd: 0 }));
    const view = await settle(slug, start.body.job);
    expect(view).toMatchObject({ state: 'failed', code: 'tool' });
    expect(readFileSync(file(slug), 'utf-8')).toBe(before);
    // Codex's one-time Mac approval missing: its own code, so the page says how to give it.
    const g = (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x', tool: 'codex' })).body.job;
    await pause(20);
    spawned[1].resolve(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: NO_ENV_GATE, total_cost_usd: 0 }));
    expect(await settle(slug, g)).toMatchObject({ state: 'failed', code: 'gate' });
    // No Node for the bridge: refused before any spawn.
    setQuickDepsForTests({ exec: fakeExec as never, env: {}, system: () => 'SYS', status: () => ({ ok: true }), bridge: () => null });
    const v2 = await settle(slug, (await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x', tool: 'antigravity' })).body.job);
    expect(v2).toMatchObject({ state: 'failed', code: 'tool' });
    expect(spawned).toHaveLength(2);
  });

  it('a pick that is not a tool or a model name is refused 400 before any spawn', async () => {
    const slug = await boardWith([rect('A')]);
    for (const bad of [{ tool: 'gpt' }, { tool: 'claude', model: 'gpt-5.5' }, { tool: 'codex', model: 'sonnet' }, { tool: 'codex', model: 'gpt 5' }, { tool: 'codex', model: '--yolo' }, { tool: 'antigravity', model: 7 }]) {
      expect((await call('POST', `/api/whiteboards/${slug}/quick-edit`, { text: 'x', ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(spawned).toHaveLength(0);
  });
});
