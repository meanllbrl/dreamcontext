/**
 * `whiteboard export`'s camera: the board drawn by the app's OWN renderer and photographed,
 * section by section (owner, 2026-11-17: "Neden pixel pixel ve ayrıca boş duruyor" — the
 * in-process pixel renderer drew text in a bitmap font and could not draw what the app draws).
 *
 * How:
 *  1. The dashboard this CLI ships (`dist/dashboard`) is served on a one-off loopback port by the
 *     same request handler and router the app's server uses, pinned to this project, GET only.
 *  2. Headless Chromium (the binary `page-pdf.ts` finds: `DREAMCONTEXT_CHROMIUM`, Playwright's,
 *     an installed Chrome) opens `/?boardprint=<slug>`: the board in the same Excalidraw canvas
 *     and widget slot a read-only board uses in the app (dashboard BoardPrint.tsx), light theme,
 *     its fonts, its pictures, every widget with its content.
 *  3. Driven over `--remote-debugging-pipe` (Chrome DevTools Protocol on fds 3/4, no package,
 *     no port): for each shot the viewport is sized to the section, the page draws only that
 *     section's elements filling it, settles (fonts, widget fetches, pictures), and the shot is
 *     taken at 2x.
 *
 * No browser, no dashboard build, or a page that never comes up: {@link BoardShotError}, said
 * plainly. There is no silent fallback to the layout renderer.
 *
 * The browser reaches nothing but this loopback port (dead proxy, a resolver that resolves
 * nothing), with a throwaway profile that is always removed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { BBox } from './ops.js';
import { withPngText } from './raster.js';
import { RENDER_KIND_KEY } from './render-mark.js';

/** Device pixels per CSS pixel in a shot: sharp text on a phone. */
export const SHOT_DPR = 2;
const PAGE_TIMEOUT_MS = 60_000;
const SHOW_TIMEOUT_MS = 45_000;

export class BoardShotError extends Error {}

export interface ShotPlan {
  /** The board rectangle the picture shows. */
  region: BBox;
  /** Only these elements are drawn (absent: everything in the region). */
  ids?: ReadonlySet<string> | null;
  /** Output width in pixels. */
  width: number;
}

export interface ShotResult {
  png: Buffer;
  width: number;
  height: number;
}

export interface BoardShots {
  shots: ShotResult[];
  /** Picture file ids the board names that the page could not load. */
  missingPictures: string[];
}

/** Output height for a plan: the region's shape at the plan's width. */
export function shotHeight(plan: Pick<ShotPlan, 'region' | 'width'>): number {
  return Math.max(1, Math.round((plan.region.h * plan.width) / Math.max(1, plan.region.w)));
}

// ─── Chrome DevTools Protocol over a pipe ──────────────────────────────────────────────

/** Splits the browser's NUL-terminated JSON messages, across chunk boundaries. */
export class PipeFramer {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i = this.buf.indexOf('\0');
    while (i >= 0) {
      out.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
      i = this.buf.indexOf('\0');
    }
    return out;
  }
}

interface CdpReply { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string }

class Cdp {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private framer = new PipeFramer();
  private closed: Error | null = null;
  readonly events: CdpReply[] = [];

  constructor(private readonly out: Writable, input: Readable) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      for (const raw of this.framer.push(chunk)) {
        let msg: CdpReply;
        try { msg = JSON.parse(raw) as CdpReply; } catch { continue; }
        if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
          else p.resolve(msg.result);
        } else if (msg.method) {
          if (this.events.length < 200) this.events.push(msg);
        }
      }
    });
    input.on('close', () => this.fail(new Error('the browser closed')));
    out.on('error', (err: Error) => this.fail(err));
  }

  fail(err: Error): void {
    if (this.closed) return;
    this.closed = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v as T); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
}

/** The flags: headless, a throwaway profile, the CDP pipe, and no network but `port`. */
export function shotArgs(profileDir: string, port: number): string[] {
  return [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars', '--force-color-profile=srgb', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--user-data-dir=${profileDir}`,
    '--proxy-server=http://127.0.0.1:9', `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-pipe',
    'about:blank',
  ];
}

// ─── the one-off dashboard server ──────────────────────────────────────────────────────

/**
 * Why the one-off server refuses a request, or null to serve it: reads only (GET/HEAD), addressed
 * to this exact loopback port (a page another site rebinds to 127.0.0.1 sends its own Host), and
 * never naming a vault (the page reads the project this export pinned, no other).
 */
export function shotGateRefusal(req: Pick<import('node:http').IncomingMessage, 'method' | 'headers' | 'url'>, port: number): number | null {
  const m = (req.method ?? 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return 405;
  if (req.headers.host !== `127.0.0.1:${port}`) return 403;
  if (req.headers['x-dreamcontext-vault'] !== undefined) return 403;
  try {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.has('vault')) return 403;
  } catch { return 400; }
  return null;
}

type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void;

async function serveDashboard(contextRoot: string): Promise<{ port: number; server: Server }> {
  const srv = await import('../../server/index.js');
  const dashboardDir = srv.getDashboardDir();
  if (!existsSync(join(dashboardDir, 'index.html'))) {
    throw new BoardShotError(`the dashboard build is missing (${dashboardDir}): whiteboard export draws the board with the app's own page. Reinstall dreamcontext, or in a source checkout run \`npm run build\`.`);
  }
  let port = 0;
  const inner: Handler = srv.makeRequestHandler({
    gate: (req, res) => {
      const refusal = shotGateRefusal(req, port);
      if (refusal === null) return true;
      res.writeHead(refusal).end();
      return false;
    },
    router: srv.buildRouter(),
    dashboardDir,
    contextRoot,
  });
  const server = createServer((req, res) => { void inner(req, res); });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done());
  });
  const a = server.address();
  if (!a || typeof a === 'string') { server.close(); throw new BoardShotError('could not open a loopback port for the board page'); }
  port = a.port;
  return { port, server };
}

// ─── the shots ─────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ShootOptions {
  contextRoot: string;
  slug: string;
  plans: readonly ShotPlan[];
  /** The browser binary; absent = `findChromium()`. */
  chromium?: string | null;
  /** Called after each shot (progress). */
  onShot?: (i: number, total: number) => void;
}

export async function shootBoard(opts: ShootOptions): Promise<BoardShots> {
  const bin = opts.chromium !== undefined ? opts.chromium : (await import('../../server/telegram/page-pdf.js')).findChromium();
  if (!bin) {
    throw new BoardShotError('whiteboard export draws the board in a browser and found none: install Google Chrome (or Chromium), or point DREAMCONTEXT_CHROMIUM at one. Nothing was exported.');
  }
  const { port, server } = await serveDashboard(opts.contextRoot);
  const profile = mkdtempSync(join(tmpdir(), 'dc-board-shot-'));
  let child: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    child = spawn(bin, shotArgs(profile, port), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => { if (stderr.length < 4000) stderr += s; });
    const spawned = child;
    const startFail = new Promise<never>((_, reject) => {
      spawned.once('error', (err) => reject(new BoardShotError(`the browser did not start (${bin}): ${err.message}`)));
      spawned.once('exit', (code) => reject(new BoardShotError(`the browser exited (${code}) before the board was drawn${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`)));
    });
    startFail.catch(() => { /* observed through the race below */ });
    const toBrowser = child.stdio[3] as Writable;
    const fromBrowser = child.stdio[4] as Readable;
    cdp = new Cdp(toBrowser, fromBrowser);
    const c = cdp;
    const run = async (): Promise<BoardShots> => {
      const { targetId } = await c.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      await c.send('Page.enable', {}, sessionId);
      await c.send('Runtime.enable', {}, sessionId);
      const metrics = (w: number, h: number) => c.send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), deviceScaleFactor: SHOT_DPR, mobile: false,
      }, sessionId);
      const evaluate = async <T>(expression: string, timeoutMs = 10_000): Promise<T> => {
        const r = await c.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
          'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs,
        );
        if (r.exceptionDetails) throw new BoardShotError(`the board page failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'error'}`);
        return r.result?.value as T;
      };
      await metrics(1170 / SHOT_DPR, 1200);
      await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/?boardprint=${encodeURIComponent(opts.slug)}` }, sessionId);
      const deadline = Date.now() + PAGE_TIMEOUT_MS;
      let state: { state?: string; error?: string; missing?: string[] } | null = null;
      while (Date.now() < deadline) {
        state = await evaluate<{ state?: string; error?: string; missing?: string[] } | null>(
          'window.__dcBoardPrint ? { state: window.__dcBoardPrint.state, error: window.__dcBoardPrint.error, missing: window.__dcBoardPrint.missingPictures } : null',
        ).catch(() => null);
        if (state?.state === 'ready' || state?.state === 'error') break;
        await sleep(150);
      }
      if (state?.state !== 'ready') {
        const why = state?.state === 'error' ? state.error : 'it did not finish loading in time';
        throw new BoardShotError(`the board page could not draw '${opts.slug}': ${why ?? 'unknown'}`);
      }
      const shots: ShotResult[] = [];
      for (const [i, plan] of opts.plans.entries()) {
        const width = Math.max(1, Math.round(plan.width));
        const height = shotHeight({ region: plan.region, width });
        await metrics(width / SHOT_DPR, height / SHOT_DPR);
        const arg = JSON.stringify({ region: plan.region, ids: plan.ids ? [...plan.ids] : null });
        const shown = await evaluate<{ ok: boolean; error?: string }>(
          `(() => { const a = ${arg}; return window.__dcBoardPrint.show(a.region, a.ids); })()`, SHOW_TIMEOUT_MS,
        );
        if (!shown?.ok) throw new BoardShotError(`the board page could not draw section ${i + 1}: ${shown?.error ?? 'unknown'}`);
        const shot = await c.send<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId, SHOW_TIMEOUT_MS);
        const png = withPngText(Buffer.from(shot.data, 'base64'), { [RENDER_KIND_KEY]: 'export' });
        shots.push({ png, width, height });
        opts.onShot?.(i + 1, opts.plans.length);
      }
      return { shots, missingPictures: state.missing ?? [] };
    };
    return await Promise.race([run(), startFail]);
  } finally {
    try { await cdp?.send('Browser.close', {}, undefined, 2000); } catch { /* already gone */ }
    cdp?.fail(new Error('closed'));
    if (child && child.exitCode === null) {
      const c = child;
      await Promise.race([new Promise<void>((r) => c.once('exit', () => r())), sleep(2000)]);
      if (c.exitCode === null) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    }
    server.closeAllConnections?.();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
