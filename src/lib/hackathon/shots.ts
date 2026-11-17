/**
 * Screen evidence (plan Decision 13, C4 helpers, criterion 11): the ONLY helper that executes
 * team code. A team's `out/build/` is copied as bytes into `.conductor/`, served by a byte-only
 * loopback server, and rendered at 390 and 1440 by headless Chromium running under a
 * `sandbox-exec` profile that allows network only to that server's port, denies name lookup,
 * and denies every home read except its own profile and the copy. Chromium's own flags (dead
 * proxy, empty resolver, WebRTC non-proxied UDP off, no service workers) are the second layer.
 *
 * macOS only: elsewhere `shotsSupported()` is false and the draft says "ekran kanıtı yok".
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { findChromium } from '../../server/telegram/page-pdf.js';
import { containedPath } from './run-store.js';

export const BUILD_FILE_MAX = 10 * 1024 * 1024;
export const BUILD_TREE_MAX = 120 * 1024 * 1024;
export const SHOT_WIDTHS = [390, 1440] as const;
export const SHOT_HEIGHT: Readonly<Record<number, number>> = { 390: 844, 1440: 900 };
export const SHOT_TIMEOUT_MS = 30_000;

export function shotsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
}

/** Copy `src` (a team's out/build) to `dest` as bytes: symlinks refused, size cut. */
export function copyBuild(src: string, dest: string): { ok: true; files: number } | { ok: false; reason: string } {
  try {
    const st = lstatSync(src);
    if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, reason: 'build/ klasörü yok' };
  } catch {
    return { ok: false, reason: 'build/ klasörü yok' };
  }
  rmSync(dest, { recursive: true, force: true });
  let total = 0;
  let files = 0;
  const walk = (rel: string): string | null => {
    const from = join(src, rel);
    for (const name of readdirSync(from)) {
      const r = rel ? join(rel, name) : name;
      const st = lstatSync(join(src, r));
      if (st.isSymbolicLink()) return `build/ içinde bağlantı (symlink) var: ${r}`;
      if (st.isDirectory()) {
        mkdirSync(join(dest, r), { recursive: true });
        const e = walk(r);
        if (e) return e;
      } else if (st.isFile()) {
        if (st.size > BUILD_FILE_MAX) return `build/ dosyası çok büyük: ${r}`;
        total += st.size;
        if (total > BUILD_TREE_MAX) return 'build/ çok büyük';
        mkdirSync(join(dest, rel), { recursive: true });
        copyFileSync(join(src, r), join(dest, r));
        files++;
      }
    }
    return null;
  };
  mkdirSync(dest, { recursive: true });
  const err = walk('');
  return err ? { ok: false, reason: err } : { ok: true, files };
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

export const BUILD_CSP = "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; worker-src 'none'; frame-src 'self'; form-action 'none'";

/** A byte-only server for the build copy: GET of a contained file, nothing else. */
export function serveBuild(dir: string): Promise<{ port: number; server: Server; close: () => void }> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    let path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    if (!path || path.endsWith('/')) path += 'index.html';
    const abs = containedPath(dir, path);
    if (!abs) { res.writeHead(404).end(); return; }
    let body: Buffer;
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) { res.writeHead(404).end(); return; }
      body = readFileSync(abs);
    } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': BUILD_CSP, 'Cache-Control': 'no-store',
      'Service-Worker-Allowed': 'none',
    });
    res.end(body);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (!a || typeof a === 'string') { server.close(); fail(new Error('no port')); return; }
      done({ port: a.port, server, close: () => { server.closeAllConnections?.(); server.close(); } });
    });
  });
}

const q = (p: string) => JSON.stringify(p);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The Seatbelt profile: network only to the build server's loopback port, no name resolution,
 * no home reads but the profile dir and the copy, writes only into the profile dir.
 */
export function sandboxProfile(o: { port: number; profileDir: string; readDirs: readonly string[]; home?: string }): string {
  const home = o.home ?? homedir();
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(allow network-outbound (remote ip ${q(`localhost:${o.port}`)}))`,
    // Chromium's own processes talk over socketpairs and Mach ports, never named network sockets.
    '(allow network* (remote unix-socket))',
    // …except the resolver's socket: no name lookup at all.
    '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")) (remote unix-socket (path-literal "/var/run/mDNSResponder")))',
    '(deny mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.dnssd.service") (global-name "com.apple.networkd") (global-name "com.apple.nehelper"))',
    `(deny file-read* (subpath ${q(home)}))`,
    `(allow file-read* ${[o.profileDir, ...o.readDirs].map((d) => `(subpath ${q(d)})`).join(' ')})`,
    // Path resolution walks the home's folders: names and sizes only, never contents.
    '(allow file-read-metadata)',
    `(deny file-write* (subpath ${q(home)}))`,
    `(allow file-write* (subpath ${q(o.profileDir)}))`,
  ].join('\n');
}

export function shotArgs(profileDir: string, url: string, png: string, width: number, port: number): string[] {
  const h = SHOT_HEIGHT[width] ?? 900;
  return [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-features=ServiceWorker,WebRtcHideLocalIpsWithMdns', '--disable-webrtc-hw-encoding',
    `--user-data-dir=${join(profileDir, 'profile')}`,
    '--proxy-server=http://127.0.0.1:9', `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    // The outer Seatbelt profile is the boundary; Chromium's own sandbox does not nest under it.
    '--no-sandbox',
    '--run-all-compositor-stages-before-draw', '--virtual-time-budget=6000',
    `--window-size=${width},${h}`, `--screenshot=${png}`,
    url,
  ];
}

/**
 * Run `bin` under the profile. Headless Chromium writes its screenshot and then often stays up,
 * so `until` (polled) ends the run early once the output is complete.
 */
function runSandboxed(profile: string, bin: string, args: string[], timeoutMs: number, until?: () => boolean): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, bin, ...args], { stdio: 'ignore', detached: true });
    let settled = false;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(t); clearInterval(poll); done(code); };
    const t = setTimeout(() => { kill(); finish(null); }, timeoutMs);
    let stable = 0;
    const poll = setInterval(() => {
      if (!until) return;
      if (until()) { if (++stable >= 3) { kill(); finish(0); } } else stable = 0;
    }, 200);
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
  });
}

function pngComplete(p: string): boolean {
  try {
    const b = readFileSync(p);
    // IEND chunk at the end: the file is written whole.
    return b.length > 64 && b.subarray(0, 8).equals(PNG_MAGIC) && b.subarray(b.length - 8, b.length - 4).toString('latin1') === 'IEND';
  } catch {
    return false;
  }
}

export interface ShotResult { width: number; file: string | null; reason?: string }

/**
 * Render `entry` of the build copy at each width; PNGs written into `destDir` (conductor-owned).
 * The browser binary's bundle is the only other readable place.
 */
export async function shootBuild(o: { buildCopy: string; entry: string; destDir: string; widths?: readonly number[]; chromium?: string | null }): Promise<ShotResult[]> {
  const widths = o.widths ?? SHOT_WIDTHS;
  if (!shotsSupported()) return widths.map((width) => ({ width, file: null, reason: 'ekran kanıtı yalnız macOS\'ta' }));
  const bin = o.chromium ?? findChromium();
  if (!bin) return widths.map((width) => ({ width, file: null, reason: 'Chromium bulunamadı' }));
  mkdirSync(o.destDir, { recursive: true });
  const served = await serveBuild(o.buildCopy);
  const results: ShotResult[] = [];
  try {
    for (const width of widths) {
      const profileDir = mkdtempSync(join(tmpdir(), 'dc-hack-shot-'));
      const png = join(profileDir, `shot-${width}.png`);
      const bundle = bin.includes('.app/') ? bin.slice(0, bin.indexOf('.app/') + 4) : dirname(bin);
      const profile = sandboxProfile({ port: served.port, profileDir, readDirs: [dirname(bundle), o.buildCopy] });
      const url = `http://127.0.0.1:${served.port}/${o.entry.split('/').map(encodeURIComponent).join('/')}`;
      await runSandboxed(profile, bin, shotArgs(profileDir, url, png, width, served.port), SHOT_TIMEOUT_MS, () => pngComplete(png));
      let ok = false;
      try { ok = readFileSync(png).subarray(0, 8).equals(PNG_MAGIC); } catch { /* none */ }
      if (ok) {
        const dest = join(o.destDir, `screen-${width}.png`);
        copyFileSync(png, dest);
        results.push({ width, file: dest });
      } else results.push({ width, file: null, reason: 'ekran görüntüsü alınamadı' });
      rmSync(profileDir, { recursive: true, force: true });
    }
  } finally {
    served.close();
  }
  return results;
}

/**
 * A team PDF as page images: rendered by `sips` under the same no-network, no-home profile, never
 * inline in the owner window. Returns the PNG of its first page (the stage shows page images).
 */
export async function pdfFirstPage(pdfBytes: Buffer, destPng: string): Promise<boolean> {
  if (!shotsSupported()) return false;
  const dir = mkdtempSync(join(tmpdir(), 'dc-hack-pdf-'));
  try {
    const src = join(dir, 'in.pdf');
    writeFileSync(src, pdfBytes);
    const out = join(dir, 'page.png');
    const profile = sandboxProfile({ port: 1, profileDir: dir, readDirs: [] });
    await runSandboxed(profile, '/usr/bin/sips', ['-s', 'format', 'png', src, '--out', out], SHOT_TIMEOUT_MS);
    const b = readFileSync(out);
    if (!b.subarray(0, 8).equals(PNG_MAGIC)) return false;
    mkdirSync(dirname(destPng), { recursive: true });
    writeFileSync(destPng, b);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
