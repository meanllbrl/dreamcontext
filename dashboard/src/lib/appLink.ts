/**
 * `dreamcontext://` links: the app's one external entry point, read and routed here.
 *
 * A banner (an automation finishing, "Claude is asking", `dreamcontext notify`) carries a link
 * saying WHERE it wants to land: a project, one chat tab, an agent's thread, a page, a document.
 * macOS hands a clicked link to the desktop shell (`desktop/src-tauri/src/app_link.rs`), which
 * understands nothing about it — it parks the string in a take-once queue and rings a doorbell
 * with no payload. Every window that may route (`main` and `vault-*`) answers by taking links
 * until the queue is empty; take-once is the election, so exactly one window routes each link.
 *
 * THE GRAMMAR IS DUPLICATED ON PURPOSE. The writer is `src/lib/app-link.ts` (Node); this is the
 * reader. Neither trusts the other: a link is outside input by the time it reaches us (any app
 * on the machine can `open dreamcontext://…`), so it is validated here in full, and anything
 * that is not exactly one of the shapes below parses to null and is dropped whole. A drift test
 * round-trips every shape through both sides.
 *
 *   dreamcontext://inbox
 *   dreamcontext://project/<vault>
 *   dreamcontext://project/<vault>/session/<claudeId>
 *   dreamcontext://project/<vault>/automation/<slug>[?file=<brain-relative path>]
 *   dreamcontext://project/<vault>/page/<page>[/<id>]
 *   dreamcontext://project/<vault>/view?path=<project-relative path>
 *
 * ROUTING NEVER DUPLICATES A WINDOW. A project link goes to the window that already holds that
 * project (live tab first, then a cold chip that can be woken), found the same way the
 * Assistant's relay finds it (`findOpenProject`). Only when no window holds it is one built, and
 * the link rides in that window's URL (`&open=`) so it lands once the project is up.
 */
import { isDesktop, openInboxWindow, openVaultWindow, openViewerWindow, vaultWindowLabel } from './desktop';
import { findOpenProject } from './openProject';
import { thisWindowLabel } from './windowRegistry';

export const APP_LINK_PREFIX = 'dreamcontext://';
/** The shell's payload-less doorbell: "a link is waiting, take it". */
export const APP_LINK_EVENT = 'dream://app-link';
/** Router → the window that holds the project: `{ link }`, the raw link to land. */
export const APP_LINK_OPEN_EVENT = 'dream://app-link-open';
/** The shell command that pops the oldest waiting link (`string | null`). */
export const TAKE_APP_LINK_COMMAND = 'take_app_link';

export const MAX_APP_LINK_LENGTH = 4096;
const MAX_VAULT_CHARS = 128;
const MAX_REL_PATH = 512;
const CLAUDE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PAGE_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export const APP_LINK_PAGES = [
  'sleep', 'automations', 'tasks', 'knowledge', 'core', 'lab', 'roadmap', 'hypotheses', 'settings',
] as const;
export type AppLinkPage = typeof APP_LINK_PAGES[number];
/** The pages whose link may name one item. */
const PAGES_WITH_ID: ReadonlySet<AppLinkPage> = new Set(['tasks', 'knowledge', 'core']);

export type AppLink =
  | { kind: 'inbox' }
  | { kind: 'project'; vault: string }
  | { kind: 'session'; vault: string; claudeId: string }
  | { kind: 'automation'; vault: string; slug: string; file: string | null }
  | { kind: 'page'; vault: string; page: AppLinkPage; id: string | null }
  | { kind: 'view'; vault: string; path: string };

/** A link that lands inside one project's window (everything but `inbox` and `view`). */
export type ProjectAppLink = Extract<AppLink, { kind: 'project' | 'session' | 'automation' | 'page' }>;

/** A registered vault name as a link may carry it: 1..128 characters, no path separator, not a
 *  dot segment, no control characters. Counted in code points so a Turkish or emoji name is
 *  measured as the characters a person sees. */
export function isValidAppLinkVault(vault: string): boolean {
  const chars = Array.from(vault).length;
  if (chars < 1 || chars > MAX_VAULT_CHARS) return false;
  if (vault === '.' || vault === '..') return false;
  if (vault.includes('/') || vault.includes('\\')) return false;
  return !CONTROL_RE.test(vault);
}

/** A relative path as a link may carry it: non-empty, ≤ 512, no leading `/`, no `..` segment. */
export function isValidAppLinkPath(path: string): boolean {
  if (!path || path.length > MAX_REL_PATH) return false;
  if (path.startsWith('/')) return false;
  return !path.split('/').includes('..');
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null; // a malformed escape is not a link we wrote
  }
}

/**
 * The single query parameter a shape allows, or null when the query is anything else. `''`
 * (no query at all) answers `undefined`, so "optional" and "malformed" stay distinguishable.
 */
function onlyParam(query: string | null, key: string): string | null | undefined {
  if (query === null) return undefined;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== key) return null;
  return params.get(key);
}

/**
 * Parse a `dreamcontext://` link, or null when it is not exactly one of the grammar's shapes.
 * Strict by design: a link is outside input, and a half-understood one must never half-route.
 */
export function parseAppLink(raw: unknown): AppLink | null {
  if (typeof raw !== 'string' || raw.length > MAX_APP_LINK_LENGTH) return null;
  if (!raw.startsWith(APP_LINK_PREFIX)) return null;
  const rest = raw.slice(APP_LINK_PREFIX.length);
  const q = rest.indexOf('?');
  const pathPart = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? null : rest.slice(q + 1);
  const segments = pathPart.split('/');

  if (segments.length === 1 && segments[0] === 'inbox') return query === null ? { kind: 'inbox' } : null;
  if (segments[0] !== 'project' || segments.length < 2) return null;

  const vault = decodeSegment(segments[1]);
  if (vault === null || !isValidAppLinkVault(vault)) return null;
  const tail = segments.slice(2);

  if (tail.length === 0) return query === null ? { kind: 'project', vault } : null;

  const [kind, ...args] = tail;
  if (kind === 'session') {
    if (args.length !== 1 || query !== null) return null;
    const claudeId = decodeSegment(args[0]);
    return claudeId !== null && CLAUDE_ID_RE.test(claudeId) ? { kind: 'session', vault, claudeId } : null;
  }
  if (kind === 'automation') {
    if (args.length !== 1) return null;
    const slug = decodeSegment(args[0]);
    if (slug === null || !SLUG_RE.test(slug)) return null;
    const file = onlyParam(query, 'file');
    if (file === undefined) return { kind: 'automation', vault, slug, file: null };
    if (file === null || !isValidAppLinkPath(file)) return null;
    return { kind: 'automation', vault, slug, file };
  }
  if (kind === 'page') {
    if (args.length < 1 || args.length > 2 || query !== null) return null;
    const page = decodeSegment(args[0]) as AppLinkPage | null;
    if (page === null || !(APP_LINK_PAGES as readonly string[]).includes(page)) return null;
    if (args.length === 1) return { kind: 'page', vault, page, id: null };
    if (!PAGES_WITH_ID.has(page)) return null;
    const id = decodeSegment(args[1]);
    return id !== null && PAGE_ID_RE.test(id) ? { kind: 'page', vault, page, id } : null;
  }
  if (kind === 'view') {
    if (args.length !== 0) return null;
    const path = onlyParam(query, 'path');
    if (typeof path !== 'string' || !isValidAppLinkPath(path)) return null;
    return { kind: 'view', vault, path };
  }
  return null;
}

/** Write a link (the dashboard's own writer — the ask banner). Mirrors the Node writer. */
export function buildAppLink(link: AppLink): string {
  if (link.kind === 'inbox') return `${APP_LINK_PREFIX}inbox`;
  const base = `${APP_LINK_PREFIX}project/${encodeURIComponent(link.vault)}`;
  switch (link.kind) {
    case 'project': return base;
    case 'session': return `${base}/session/${encodeURIComponent(link.claudeId)}`;
    case 'automation': {
      const file = link.file ? `?file=${encodeURIComponent(link.file)}` : '';
      return `${base}/automation/${encodeURIComponent(link.slug)}${file}`;
    }
    case 'page': {
      const id = link.id ? `/${encodeURIComponent(link.id)}` : '';
      return `${base}/page/${link.page}${id}`;
    }
    case 'view': return `${base}/view?path=${encodeURIComponent(link.path)}`;
  }
}

/** True for the shapes that land inside one project's window. */
export function isProjectAppLink(link: AppLink): link is ProjectAppLink {
  return link.kind === 'project' || link.kind === 'session' || link.kind === 'automation' || link.kind === 'page';
}

/* ─────────────────────────────────────── routing ─────────────────────────────────────── */

/** What routing needs from the outside world — injected so the decisions are testable. */
export interface AppLinkRouteDeps {
  findOpenProject: (vault: string) => Promise<{ live: string[]; cold: string | null }>;
  emitTo: (label: string, event: string, payload: unknown) => Promise<void>;
  openVaultWindow: (vault: string, opts: { open: string }) => Promise<'focused' | 'created' | 'browser'>;
  vaultWindowLabel: (vault: string) => string;
  openViewerWindow: (vault: string, projectPath: string) => Promise<void>;
  openInboxWindow: () => Promise<void>;
}

async function tauriEmitTo(label: string, event: string, payload: unknown): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(label, event, payload);
}

export const defaultAppLinkRouteDeps: AppLinkRouteDeps = {
  findOpenProject,
  emitTo: tauriEmitTo,
  openVaultWindow: (vault, opts) => openVaultWindow(vault, undefined, opts),
  vaultWindowLabel,
  openViewerWindow,
  openInboxWindow,
};

/** Where a link went — returned for the caller's log line and for the tests. */
export type AppLinkRoute =
  | { to: 'dropped' }
  | { to: 'inbox' }
  | { to: 'viewer'; vault: string; path: string }
  | { to: 'holder'; label: string; viewer: string | null }
  | { to: 'window'; vault: string; built: boolean; viewer: string | null };

/**
 * Land one link. `view` and `inbox` open their small windows; a project link goes to the window
 * that already holds that project (`live[0] ?? cold`), or to a window of its own when none does.
 * An automation link that names a document ALSO opens it in the viewer, after the project has
 * been reached, so the document is the window on top.
 */
export async function routeAppLink(raw: string, deps: AppLinkRouteDeps = defaultAppLinkRouteDeps): Promise<AppLinkRoute> {
  const link = parseAppLink(raw);
  if (!link) return { to: 'dropped' };
  if (link.kind === 'inbox') {
    await deps.openInboxWindow();
    return { to: 'inbox' };
  }
  if (link.kind === 'view') {
    await deps.openViewerWindow(link.vault, link.path);
    return { to: 'viewer', vault: link.vault, path: link.path };
  }

  const viewer = link.kind === 'automation' && link.file ? `_dream_context/${link.file}` : null;
  const openDocument = async () => {
    if (!viewer) return;
    try {
      await deps.openViewerWindow(link.vault, viewer);
    } catch (err) {
      // The project was reached; only the document window failed. Say so, keep the landing.
      console.warn('[app-link] could not open the document window:', viewer, err);
    }
  };

  const { live, cold } = await deps.findOpenProject(link.vault);
  const holder = live[0] ?? cold ?? null;
  if (holder) {
    try {
      await deps.emitTo(holder, APP_LINK_OPEN_EVENT, { link: raw });
      await openDocument();
      return { to: 'holder', label: holder, viewer };
    } catch (err) {
      // The window went away between the lookup and the emit: fall through to its own window.
      console.warn('[app-link] the window holding', link.vault, 'did not take the link:', err);
    }
  }

  const built = await deps.openVaultWindow(link.vault, { open: raw });
  // An own window already existed (the lookups missed it): it never reads `&open=`, so the link
  // is handed over by event exactly as it would have been to any other holder.
  if (built === 'focused') {
    await deps.emitTo(deps.vaultWindowLabel(link.vault), APP_LINK_OPEN_EVENT, { link: raw });
  }
  await openDocument();
  return { to: 'window', vault: link.vault, built: built !== 'focused', viewer };
}

/* ─────────────────────────────────────── listener ─────────────────────────────────────── */

/** The windows allowed to take and route links: the launcher and the project windows. */
export function isAppLinkRouterWindow(label: string): boolean {
  return label === 'main' || label.startsWith('vault-');
}

/** A burst bigger than the shell's queue (8) is not a burst we can be behind on; the cap only
 *  guarantees a misbehaving shell can never spin this loop forever. */
const MAX_TAKES_PER_DRAIN = 16;

/**
 * Take links until the shell has none, routing each. Resolves to how many were taken. A take
 * that throws (an older shell has no such command, or the ACL refuses it) ends the drain
 * quietly: nothing can be waiting in a queue that does not exist.
 */
export async function drainAppLinks(
  take: () => Promise<string | null>,
  route: (raw: string) => Promise<unknown>,
): Promise<number> {
  let taken = 0;
  while (taken < MAX_TAKES_PER_DRAIN) {
    let raw: string | null;
    try {
      raw = await take();
    } catch {
      return taken;
    }
    if (typeof raw !== 'string') return taken;
    taken += 1;
    try {
      await route(raw);
    } catch (err) {
      console.warn('[app-link] routing failed:', raw.slice(0, 200), err);
    }
  }
  return taken;
}

let installed = false;

/**
 * Wire this window to the shell's doorbell (called once, from `main.tsx`). Acts only in `main`
 * and `vault-*` windows, and listens on THIS webview rather than globally: a global listener
 * hears every emit whatever window it was filtered to. Takes once on install too, because a
 * cold launch parks the link before any listener exists.
 */
export function installAppLinkListener(): void {
  if (installed || !isDesktop()) return;
  installed = true;
  void (async () => {
    const label = await thisWindowLabel();
    if (!isAppLinkRouterWindow(label)) return;
    let invoke: typeof import('@tauri-apps/api/core').invoke;
    try {
      ({ invoke } = await import('@tauri-apps/api/core'));
    } catch {
      return;
    }
    const take = () => invoke<string | null>(TAKE_APP_LINK_COMMAND);
    const route = (raw: string) => routeAppLink(raw);

    // One drain at a time: a doorbell during a drain only asks for one more pass after it.
    let running = false;
    let again = false;
    const drain = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          await drainAppLinks(take, route);
        } while (again);
      } finally {
        running = false;
      }
    };

    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      await getCurrentWebviewWindow().listen(APP_LINK_EVENT, () => { void drain(); });
    } catch (err) {
      console.warn('[app-link] could not listen for links:', err);
    }
    await drain();
  })();
}
