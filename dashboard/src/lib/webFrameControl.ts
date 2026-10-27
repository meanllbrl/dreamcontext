import { useEffect, useReducer } from 'react';
import { CLEAR_PATH, WEB_CARD_KEY, pathOf, readWebCardMessage, upstreamHref, type WebPick } from './webPick';

/**
 * One web card's handle on its page (owner 2026-10-22): Reload, Clear cache and Inspect on the
 * card's toolbar act through it, and the page's picks come back through it.
 *
 * The frame (`PageFrame`) attaches itself with what it loaded: the proxy's origin and Clear
 * token when the page is an approved dev server served by the session proxy, or nothing extra
 * for a page on the web. Only a proxied page carries the bridge, so only it can be cleared or
 * inspected; a message is read only from THIS frame's window at the proxy's origin.
 */

export interface WebFrameInfo {
  /** The page's address as its own server knows it (`http://localhost:5173/…`). */
  href: string;
  /** The session proxy's origin (`http://127.0.0.1:<port>`); absent for a page loaded directly. */
  proxyOrigin?: string;
  clearToken?: string;
}

interface Listener {
  pick?: (pick: WebPick) => void;
  /** The page left Inspect itself (Esc pressed inside it). */
  inspectOff?: () => void;
  /** Bridged / not, the frame attached or gone. */
  change?: () => void;
}

export class WebFrameControl {
  private frame: HTMLIFrameElement | null = null;
  private info: WebFrameInfo | null = null;
  /** The frame's current address (the proxy's spelling), as its bridge last said. */
  private current = '';
  private bridgedNow = false;
  /** The frame's own address (its first `src`): Clear points `src` at the clear page, so a
   *  later Reload must never read it back from the attribute (it would clear again). */
  private home = '';
  private readonly listeners = new Set<Listener>();

  /** Every document the frame loads must say it carries the bridge again: a page the app
   *  navigated to elsewhere (another port, a site) has none, and Inspect must not pick there. */
  private readonly onLoad = () => {
    const was = this.bridgedNow;
    this.bridgedNow = false;
    this.current = '';
    if (was) this.emit('change');
    this.post({ kind: 'where' });
  };

  private readonly onMessage = (e: MessageEvent) => {
    const frame = this.frame;
    const origin = this.info?.proxyOrigin;
    if (!frame || !origin || e.source !== frame.contentWindow || e.origin !== origin) return;
    const m = readWebCardMessage(e.data);
    if (!m) return;
    if (m.kind === 'hello') {
      this.current = m.href;
      if (!this.bridgedNow) { this.bridgedNow = true; this.emit('change'); }
      else this.emit('change');
      return;
    }
    if (m.kind === 'inspect') { if (!m.on) this.listeners.forEach((l) => l.inspectOff?.()); return; }
    this.listeners.forEach((l) => l.pick?.(m.pick));
  };

  attach(frame: HTMLIFrameElement, info: WebFrameInfo): void {
    if (this.frame && this.frame !== frame) this.detach(this.frame);
    this.frame = frame;
    this.info = info;
    this.home = frame.getAttribute('src') ?? frame.src;
    this.current = '';
    this.bridgedNow = false;
    if (info.proxyOrigin) {
      window.addEventListener('message', this.onMessage);
      frame.addEventListener('load', this.onLoad);
    }
    this.emit('change');
  }

  detach(frame: HTMLIFrameElement): void {
    if (this.frame !== frame) return;
    window.removeEventListener('message', this.onMessage);
    frame.removeEventListener('load', this.onLoad);
    this.frame = null;
    this.info = null;
    this.current = '';
    this.bridgedNow = false;
    this.emit('change');
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private emit(kind: 'change'): void {
    this.listeners.forEach((l) => l[kind]?.());
  }

  get attached(): boolean { return !!this.frame; }
  /** The page answered through its bridge: Inspect can pick in it. */
  get bridged(): boolean { return this.bridgedNow; }
  /** Served by the session proxy (a page on this computer): its bridge is on its way. */
  get proxied(): boolean { return !!this.frame && !!this.info?.proxyOrigin; }
  /** The page is served by the session proxy: Clear can reach its storage. */
  get canClear(): boolean { return !!this.frame && !!this.info?.proxyOrigin && !!this.info.clearToken; }

  /** Where the page is now, as its server knows it. */
  pageHref(): string {
    const info = this.info;
    if (!info) return '';
    if (!info.proxyOrigin || !this.current) return info.href;
    let upstream = '';
    try { upstream = new URL(info.href).origin; } catch { return this.current; }
    return upstreamHref(this.current, info.proxyOrigin, upstream);
  }

  private post(m: Record<string, unknown>): boolean {
    const w = this.frame?.contentWindow;
    const origin = this.info?.proxyOrigin;
    if (!w || !origin) return false;
    try { w.postMessage({ [WEB_CARD_KEY]: m }, origin); return true; } catch { return false; }
  }

  /** Reload where the page is now (its bridge), or go back to its own address (a page that
   *  has no bridge: one the app navigated elsewhere, or one that failed to load). */
  reload(): void {
    const frame = this.frame;
    if (!frame) return;
    if (this.bridgedNow && this.post({ kind: 'reload' })) return;
    const origin = this.info?.proxyOrigin;
    frame.src = origin && this.current ? `${origin}${pathOf(this.current)}` : this.home;
  }

  /** Clear its cookies, storage and cache, then come back where it was. False: not possible here. */
  clear(): boolean {
    const frame = this.frame;
    const info = this.info;
    if (!frame || !info?.proxyOrigin || !info.clearToken) return false;
    const next = pathOf(this.current || info.href);
    this.bridgedNow = false;
    frame.src = `${info.proxyOrigin}${CLEAR_PATH}?t=${encodeURIComponent(info.clearToken)}&next=${encodeURIComponent(next)}`;
    this.emit('change');
    return true;
  }

  setInspect(on: boolean): void {
    if (this.bridgedNow) this.post({ kind: 'inspect', on });
  }
}

/** Re-render on the control's changes (attached, bridged). */
export function useWebFrameControl(control: WebFrameControl | undefined): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (control ? control.subscribe({ change: bump }) : undefined), [control]);
}
