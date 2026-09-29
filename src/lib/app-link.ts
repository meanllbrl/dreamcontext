import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { listVaults, RESERVED_ASSISTANT_NAME, type Vault } from './vaults.js';

/**
 * The `dreamcontext://` link WRITER, the Node half of the app's external entry point.
 *
 * A macOS banner can only hand its click to `open(1)`, and `open` takes a URL as happily as a
 * path, so a link is what turns "a notification happened" into "the notification lands you in
 * the exact place". The desktop shell claims the scheme (Info.plist `CFBundleURLTypes`) and the
 * dashboard's `lib/appLink.ts` parses and routes it.
 *
 * VALIDATION IS DUPLICATED ON PURPOSE. The dashboard parser re-checks every rule below, and
 * neither side trusts the other: a link arrives from the operating system, so anything that
 * reached the app by `open` is outside input no matter who claims to have written it. The
 * grammar lives in the task contract, and a drift test round-trips every shape through both.
 *
 * Grammar (anything else is invalid and dropped whole; total length at most 4096):
 *   dreamcontext://project/<vault>
 *   dreamcontext://project/<vault>/session/<claudeId>
 *   dreamcontext://project/<vault>/automation/<slug>[?file=<brain-relative path>]
 *   dreamcontext://project/<vault>/page/<page>[/<id>]
 *   dreamcontext://project/<vault>/view?path=<project-relative path>
 *   dreamcontext://inbox
 */

export const APP_LINK_SCHEME = 'dreamcontext';
const PREFIX = `${APP_LINK_SCHEME}://`;
export const APP_LINK_MAX_LENGTH = 4096;
const VAULT_MAX_CHARS = 128;
const PATH_MAX_CHARS = 512;

export const APP_LINK_PAGES = [
  'sleep', 'automations', 'tasks', 'knowledge', 'core', 'lab', 'roadmap', 'hypotheses', 'settings',
] as const;
export type AppLinkPage = (typeof APP_LINK_PAGES)[number];
/** The pages whose link may name one item. Every other page is a bare destination. */
const PAGES_WITH_ID: ReadonlySet<string> = new Set(['tasks', 'knowledge', 'core']);

const CLAUDE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PAGE_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type AppLinkTarget =
  | { kind: 'project'; vault: string }
  | { kind: 'session'; vault: string; claudeId: string }
  | { kind: 'automation'; vault: string; slug: string; file?: string | null }
  | { kind: 'page'; vault: string; page: AppLinkPage; id?: string | null }
  | { kind: 'view'; vault: string; path: string }
  | { kind: 'inbox' };

/** What a link names, minus the vault: the shape a caller that only knows a contextRoot passes. */
export type AppLinkPlace =
  | { kind: 'project' }
  | { kind: 'session'; claudeId: string }
  | { kind: 'automation'; slug: string; file?: string | null }
  | { kind: 'page'; page: AppLinkPage; id?: string | null }
  | { kind: 'view'; path: string };

/** A target the grammar refuses. The message names the part that failed, for a CLI to print. */
export class AppLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppLinkError';
  }
}

// ─── Part validators (shared by the writer and the parser) ──────────────────

export function isValidVaultName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const chars = [...name].length;
  if (chars < 1 || chars > VAULT_MAX_CHARS) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return !CONTROL_RE.test(name);
}

/** The `file`/`path` rule: relative, no leading `/`, no `..` segment, at most 512 chars. */
export function isValidLinkPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX_CHARS) return false;
  if (path.startsWith('/')) return false;
  return !path.split('/').some((segment) => segment === '..');
}

function isPage(value: string): value is AppLinkPage {
  return (APP_LINK_PAGES as readonly string[]).includes(value);
}

// ─── Writer ─────────────────────────────────────────────────────────────────

/**
 * Compose a link. Throws {@link AppLinkError} naming the offending part rather than writing a
 * link the app would drop: a banner that silently opens nothing is worse than one that says why.
 */
export function buildAppLink(target: AppLinkTarget): string {
  if (target.kind === 'inbox') return `${PREFIX}inbox`;
  if (!isValidVaultName(target.vault)) {
    throw new AppLinkError(`"${target.vault}" is not a valid vault name for a link.`);
  }
  const base = `${PREFIX}project/${encodeURIComponent(target.vault)}`;
  const link = composeTail(base, target);
  if (link.length > APP_LINK_MAX_LENGTH) {
    throw new AppLinkError(`The link is longer than ${APP_LINK_MAX_LENGTH} characters.`);
  }
  return link;
}

function composeTail(base: string, target: Exclude<AppLinkTarget, { kind: 'inbox' }>): string {
  switch (target.kind) {
    case 'project':
      return base;
    case 'session':
      if (!CLAUDE_ID_RE.test(target.claudeId)) {
        throw new AppLinkError(`"${target.claudeId}" is not a Claude session id (8 to 64 letters, digits or dashes).`);
      }
      return `${base}/session/${target.claudeId}`;
    case 'automation': {
      if (!SLUG_RE.test(target.slug)) throw new AppLinkError(`"${target.slug}" is not an automation slug.`);
      const file = target.file ?? null;
      if (file === null) return `${base}/automation/${target.slug}`;
      if (!isValidLinkPath(file)) throw new AppLinkError(`"${file}" is not a brain-relative file path.`);
      return `${base}/automation/${target.slug}?file=${encodeURIComponent(file)}`;
    }
    case 'page': {
      if (!isPage(target.page)) throw new AppLinkError(`"${String(target.page)}" is not a page a link can open.`);
      const id = target.id ?? null;
      if (id === null) return `${base}/page/${target.page}`;
      if (!PAGES_WITH_ID.has(target.page)) throw new AppLinkError(`The ${target.page} page takes no item id.`);
      if (!PAGE_ID_RE.test(id)) throw new AppLinkError(`"${id}" is not a valid item id.`);
      return `${base}/page/${target.page}/${id}`;
    }
    case 'view':
      if (!isValidLinkPath(target.path)) throw new AppLinkError(`"${target.path}" is not a project-relative file path.`);
      return `${base}/view?path=${encodeURIComponent(target.path)}`;
  }
}

// ─── Parser ─────────────────────────────────────────────────────────────────

function decode(part: string): string | null {
  try { return decodeURIComponent(part); } catch { return null; }
}

/** `key=value` with exactly one pair and the expected key, or null. */
function singleQueryValue(query: string, key: string): string | null {
  if (query.includes('&')) return null;
  const eq = query.indexOf('=');
  if (eq < 0 || query.slice(0, eq) !== key) return null;
  return decode(query.slice(eq + 1));
}

/**
 * The strict reader, the same rules as the dashboard's. Returns null for anything outside the
 * grammar: an unknown kind, an extra segment, an unexpected query, a malformed escape.
 */
export function parseAppLink(raw: string): AppLinkTarget | null {
  if (typeof raw !== 'string' || raw.length > APP_LINK_MAX_LENGTH || !raw.startsWith(PREFIX)) return null;
  const rest = raw.slice(PREFIX.length);
  if (rest.includes('#') || CONTROL_RE.test(rest)) return null;
  const q = rest.indexOf('?');
  const pathPart = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? null : rest.slice(q + 1);
  const parts = pathPart.split('/');

  if (parts[0] === 'inbox') return parts.length === 1 && query === null ? { kind: 'inbox' } : null;
  if (parts[0] !== 'project' || parts.length < 2) return null;
  const vault = decode(parts[1]);
  if (vault === null || !isValidVaultName(vault)) return null;
  return parseProjectTail(vault, parts.slice(2), query);
}

function parseProjectTail(vault: string, tail: string[], query: string | null): AppLinkTarget | null {
  if (tail.length === 0) return query === null ? { kind: 'project', vault } : null;
  const [kind, value, extra] = tail;
  if (kind === 'session') {
    return tail.length === 2 && query === null && CLAUDE_ID_RE.test(value) ? { kind: 'session', vault, claudeId: value } : null;
  }
  if (kind === 'automation') {
    if (tail.length !== 2 || !SLUG_RE.test(value)) return null;
    if (query === null) return { kind: 'automation', vault, slug: value };
    const file = singleQueryValue(query, 'file');
    return file !== null && isValidLinkPath(file) ? { kind: 'automation', vault, slug: value, file } : null;
  }
  if (kind === 'page') {
    if (query !== null || tail.length < 2 || tail.length > 3 || !isPage(value)) return null;
    if (tail.length === 2) return { kind: 'page', vault, page: value };
    return PAGES_WITH_ID.has(value) && PAGE_ID_RE.test(extra) ? { kind: 'page', vault, page: value, id: extra } : null;
  }
  if (kind === 'view') {
    if (tail.length !== 1 || query === null) return null;
    const path = singleQueryValue(query, 'path');
    return path !== null && isValidLinkPath(path) ? { kind: 'view', vault, path } : null;
  }
  return null;
}

export function isValidAppLink(raw: string): boolean {
  return parseAppLink(raw) !== null;
}

// ─── Vault resolution ───────────────────────────────────────────────────────

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Find the registered vault whose project directory is exactly `projectDir` (realpath). */
function registeredVaultAt(projectDir: string, vaults: Vault[]): Vault | null {
  const target = realOrResolved(projectDir);
  for (const vault of vaults) {
    if (vault.name === RESERVED_ASSISTANT_NAME || !isValidVaultName(vault.name)) continue;
    if (realOrResolved(vault.path) === target) return vault;
  }
  return null;
}

/**
 * The registered vault NAME for a brain, or null when this project is not in the registry (a
 * link has to name a vault the app knows, and an unregistered project has no window to land in).
 * Accepts the `_dream_context/` root or the project directory. Matches on realpath, because the
 * registry stores whatever path `vaults add` was given and a temp dir or a symlinked checkout
 * reads differently from each side.
 */
export function vaultNameForContextRoot(contextRoot: string, home?: string): string | null {
  const projectDir = basename(contextRoot) === '_dream_context' ? dirname(contextRoot) : contextRoot;
  return registeredVaultAt(projectDir, listVaults(home))?.name ?? null;
}

/**
 * The registered vault that CONTAINS `dir`: `dir` itself or its nearest registered ancestor.
 * What a hook's `cwd` resolves through, since a session may sit in a subfolder of its project.
 */
export function findRegisteredVault(dir: string, home?: string): Vault | null {
  const vaults = listVaults(home);
  let current = realOrResolved(dir);
  for (;;) {
    const hit = registeredVaultAt(current, vaults);
    if (hit) return hit;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * A link to `place` in the project that owns `contextRoot`, or null when the project is not
 * registered or the place fails the grammar. Never throws: this runs on notification paths,
 * where a missing link means "fall back to the file", never "lose the banner".
 */
export function appLinkForContextRoot(contextRoot: string, place: AppLinkPlace, home?: string): string | null {
  const vault = vaultNameForContextRoot(contextRoot, home);
  if (vault === null) return null;
  try {
    return buildAppLink({ ...place, vault } as AppLinkTarget);
  } catch {
    return null;
  }
}

/**
 * `absolutePath` relative to the brain (`_dream_context/`), in `/` form, or null when it lives
 * outside the brain (a custom output dir) and so cannot ride a `?file=` param.
 */
export function brainRelativePath(contextRoot: string, absolutePath: string): string | null {
  const attempt = (root: string, path: string): string | null => {
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const posix = rel.split(sep).join('/');
    return isValidLinkPath(posix) ? posix : null;
  };
  return attempt(resolve(contextRoot), resolve(absolutePath))
    ?? attempt(realOrResolved(contextRoot), realOrResolved(absolutePath));
}
