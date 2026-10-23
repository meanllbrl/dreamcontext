import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * What a web card's page keeps between app runs (owner 2026-10-22: "every reload loses what I
 * did"). The page of an approved dev server runs in a frame, and WKWebView keeps a cross-origin
 * frame's localStorage and IndexedDB in memory only (probe, 2026-10-22): they live through a
 * card reload or move, never through an app restart. Its COOKIES persist on their own once the
 * frame is same-site (the session proxy, `src/server/web-session-proxy.ts`).
 *
 * So the page's bridge posts its localStorage here and gets it back on the first load of the
 * next run, and lists the cookie names it set so "Clear cache" can expire them (an HttpOnly
 * cookie is invisible to the page; a cookie on 127.0.0.1 is shared by every port, so clearing
 * them all would log the owner out of his other cards too). The names kept are the page's own,
 * without the proxy's prefix.
 *
 * One session per PROJECT and dev-server port (`webSessionKey`): two projects that both run on
 * :3000 never see each other's storage or cookies (the proxy also prefixes every cookie name
 * with the key). `~/.dreamcontext/web-sessions/<key>.json`, 0600, atomic, a symlink refused, capped.
 */

export interface WebSessionCookie { name: string; path: string }
export interface WebSessionSnapshot {
  localStorage: Record<string, string>;
  cookies: WebSessionCookie[];
}

/** The largest snapshot kept (the page's localStorage is ~5 MB in every engine). */
export const MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024;
export const MAX_KEYS = 5000;
export const MAX_COOKIES = 200;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

const EMPTY: WebSessionSnapshot = Object.freeze({ localStorage: {}, cookies: [] }) as WebSessionSnapshot;

const KEY_RE = /^[a-f0-9]{8}$/;
const isKey = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k);

/** The session of one project's dev-server port: 8 hex characters (also the cookie prefix). */
export function webSessionKey(scope: string, port: number): string {
  return createHash('sha256').update(`${scope}\u0000${port}`).digest('hex').slice(0, 8);
}

export function webSessionsDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'web-sessions');
}

function fileOf(key: string, home: string): string {
  return join(webSessionsDir(home), `${key}.json`);
}

/** A cookie path a header can carry back (Clear expires it in a Set-Cookie): absolute,
 *  printable ASCII without `;`, short. Anything else is not kept (a page's `path=/şirket`
 *  would make the expiry header unwritable). */
function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !/^\/[\x20-\x3a\x3c-\x7e]{0,511}$/.test(p)) return null;
  return p;
}

/** The snapshot's shape enforced (what a page posted is untrusted). Never throws. */
export function sanitizeSnapshot(raw: unknown): WebSessionSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { localStorage: {}, cookies: [] };
  const r = raw as Record<string, unknown>;
  const localStorage: Record<string, string> = {};
  if (r.localStorage && typeof r.localStorage === 'object' && !Array.isArray(r.localStorage)) {
    let n = 0;
    for (const [k, v] of Object.entries(r.localStorage as Record<string, unknown>)) {
      if (typeof v !== 'string' || k.length > 1024) continue;
      if (++n > MAX_KEYS) break;
      localStorage[k] = v;
    }
  }
  const cookies: WebSessionCookie[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.cookies)) {
    for (const c of r.cookies) {
      if (!c || typeof c !== 'object') continue;
      const name = (c as Record<string, unknown>).name;
      const path = cleanPath((c as Record<string, unknown>).path) ?? '/';
      if (typeof name !== 'string' || !COOKIE_NAME.test(name)) continue;
      const key = `${name}\u0000${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push({ name, path });
      if (cookies.length >= MAX_COOKIES) break;
    }
  }
  return { localStorage, cookies };
}

export function readWebSession(key: string, home: string = homedir()): WebSessionSnapshot {
  if (!isKey(key)) return EMPTY;
  const path = fileOf(key, home);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return EMPTY;
    return sanitizeSnapshot(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return EMPTY;
  }
}

function writeRaw(key: string, snap: WebSessionSnapshot, home: string): void {
  const dir = webSessionsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = fileOf(key, home);
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('web session file is a symlink; refusing it');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const body = `${JSON.stringify(snap)}\n`;
  if (Buffer.byteLength(body) > MAX_SNAPSHOT_BYTES) throw new Error('web session snapshot is too large');
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/**
 * The page's localStorage replaces the stored one; the cookie names it reports join the ones
 * already known (a name is forgotten only by a clear). Returns false when nothing was written.
 */
export function saveWebSession(key: string, posted: unknown, home: string = homedir()): boolean {
  if (!isKey(key)) return false;
  const next = sanitizeSnapshot(posted);
  const cur = readWebSession(key, home);
  const cookies = sanitizeSnapshot({ cookies: [...cur.cookies, ...next.cookies] }).cookies;
  writeRaw(key, { localStorage: next.localStorage, cookies }, home);
  return true;
}

/** Cookie names the dev server itself set (seen by the proxy in its Set-Cookie headers). */
export function rememberCookies(key: string, cookies: readonly WebSessionCookie[], home: string = homedir()): void {
  if (!isKey(key) || !cookies.length) return;
  const cur = readWebSession(key, home);
  const merged = sanitizeSnapshot({ cookies: [...cur.cookies, ...cookies] }).cookies;
  if (merged.length === cur.cookies.length) return;
  writeRaw(key, { localStorage: cur.localStorage, cookies: merged }, home);
}

/** "Clear cache": forget everything kept for this page. */
export function clearWebSession(key: string, home: string = homedir()): void {
  if (!isKey(key)) return;
  try {
    const path = fileOf(key, home);
    if (lstatSync(path).isSymbolicLink()) return;
    unlinkSync(path);
  } catch { /* nothing kept */ }
}
