/**
 * An insight stage card → PNG (plan T4, R5-R9 as narrowed by S/T): the Super window clones the
 * card (`hub_command render_card`), the server seals it (`insight-seal.ts`: scanner, allowlist,
 * root checks, html/v1 frames rebuilt from THIS project's lab cache by slug) with the app's own
 * bundled CSS read from its dashboard dir, and the shell's sealed webview renders it at the
 * card's on-screen size. Any refusal → null (the card goes as text).
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCache } from '../../lib/lab/store.js';
import type { RenderCardResult } from '../../lib/telegram/contract.js';
import { sealInsight } from '../../lib/telegram/insight-seal.js';
import { sendHubCommand, superTokenOfSession } from '../../lib/window-control.js';
import type { Snapshotter } from './pictures.js';
import type { ActiveBinding } from './hub.js';

const CSS_NAME = /^[A-Za-z0-9._-]+\.css$/;
let cssCache: string | null = null;

/** The app's bundled stylesheets: names from a `readdir` of `<dashboard>/assets`, never a
 *  window-supplied name; symlinks skipped. */
export function bundledAppCss(dashboardDir?: string): string {
  if (cssCache !== null && !dashboardDir) return cssCache;
  const dir = join(dashboardDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard'), 'assets');
  let out = '';
  try {
    for (const name of readdirSync(dir).sort()) {
      if (!CSS_NAME.test(name)) continue;
      const p = join(dir, name);
      if (!lstatSync(p).isFile()) continue;
      out += `${readFileSync(p, 'utf8')}\n`;
    }
  } catch { /* no dist (dev): no app CSS, the picture is unstyled but still sealed */ }
  if (!dashboardDir) cssCache = out;
  return out;
}

/** Parses the window's answer into the contract shape (anything else → null). */
export function parseRenderCard(r: unknown): Extract<RenderCardResult, { ok: true }> | null {
  const o = r as Record<string, unknown> | null;
  if (!o || o.ok !== true || typeof o.body !== 'string' || !Array.isArray(o.frames) || !o.root || !o.size) return null;
  return o as unknown as Extract<RenderCardResult, { ok: true }>;
}

export function insightRenderer(snapshot: Snapshotter, opts: { appCss?: () => string } = {}) {
  return async (ab: ActiveBinding, sessionId: string, containerId: string): Promise<Buffer[] | null> => {
    if (!ab.contextRoot) return null;
    const token = superTokenOfSession(sessionId);
    if (!token) return null;
    const r = await sendHubCommand(token, 'render_card', { target: { kind: 'container', id: containerId } }, { timeoutMs: 10_000 }).catch(() => null);
    const result = parseRenderCard(r);
    if (!result) return null;
    const root = ab.contextRoot;
    const page = sealInsight({ result, appCss: (opts.appCss ?? bundledAppCss)(), labHtml: (slug) => readCache(root, slug)?.html ?? null });
    if (!page) return null;
    return snapshot(sessionId, page, Math.max(200, Math.min(1600, Math.round(result.size.w))));
  };
}
