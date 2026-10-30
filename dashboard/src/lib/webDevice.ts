import { useCallback, useEffect, useState } from 'react';
import { useVault } from '../context/VaultContext';
import { readScoped, writeScoped } from './scopedStorage';

/**
 * A web page's device width (owner 2026-10-27: "on the web board I must be able to switch to
 * phone size, tablet size and computer size"). The page is laid out at that viewport width and
 * scaled down to fit its box (never up: a phone page in a wide card is drawn at its real size,
 * centred). No device: the page fills its box, as before.
 *
 * Remembered per Super card (its id), per project: the card and its full-screen view read the
 * same choice. The record is capped (oldest dropped), so closed cards never pile up.
 */
export type WebDevice = 'phone' | 'tablet' | 'desktop';

export const WEB_DEVICES: readonly WebDevice[] = ['phone', 'tablet', 'desktop'];

export const DEVICE_WIDTH: Record<WebDevice, number> = { phone: 390, tablet: 820, desktop: 1440 };
/** The screen each width stands for (a 390x844 phone, an 820x1180 tablet, a 1440x900 laptop):
 *  on the Super stage a card shown side by side takes this shape (owner 2026-10-28: "the device
 *  switch changes the CARD, like presentation mode", superLayout's fitCard). */
export const DEVICE_HEIGHT: Record<WebDevice, number> = { phone: 844, tablet: 1180, desktop: 900 };

/** A device's width / height. */
export function deviceAspect(device: WebDevice): number {
  return DEVICE_WIDTH[device] / DEVICE_HEIGHT[device];
}

export interface DeviceFit {
  /** The viewport the page is laid out in, px. */
  w: number;
  h: number;
  /** Drawn at this scale (≤ 1) to fit the box. */
  scale: number;
}

/** The viewport and scale for `device` in a box of `box` px, or null to fill the box. */
export function deviceFit(device: WebDevice | null, box: { w: number; h: number } | null): DeviceFit | null {
  if (!device || !box || box.w <= 0 || box.h <= 0) return null;
  const w = DEVICE_WIDTH[device];
  const scale = Math.min(1, box.w / w);
  return { w, h: Math.round(box.h / scale), scale };
}

/** A site's desktop layout width, in css px (Super presentation layouts, plan-r2 D8). */
export const DESKTOP_WIDTH = 1280;

/** The scale a page laid out at {@link DESKTOP_WIDTH} takes in a box this wide: only between 60 %
 *  and 100 % (narrower it would be unreadable, wider it fits natively). Null: native. */
export function desktopScale(boxWidth: number): number | null {
  const s = boxWidth / DESKTOP_WIDTH;
  return s >= 0.6 && s < 1 ? s : null;
}

/** A frame laid out at the desktop width and scaled into its box (the box must be `position:
 *  relative; overflow: hidden`): as tall as the box once scaled. Shared by a server page's frame
 *  and a project page that fills its card, so the two draw a desktop page the same way. */
export function desktopFrameStyle(scale: number): {
  position: 'absolute'; left: 0; top: 0; width: number; height: string; transform: string; transformOrigin: string;
} {
  return { position: 'absolute', left: 0, top: 0, width: DESKTOP_WIDTH, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: '0 0' };
}

/**
 * A project web page's frame geometry (DocumentReader's HtmlPage). `fill` (a web card): the frame
 * IS its box, as a server page's frame is, and the page scrolls inside itself — never the height
 * the page reports, because a full-screen page (`height: 100vh`, `html, body { height: 100% }`)
 * reports the frame's own height back, and an auto-height frame then stays at the browser's
 * default 150 px (owner 2026-10-30: the card showed a 150 px strip). A desktop `scale` lays it
 * out at the desktop width. Not filling (a reading column): exactly the page's reported height.
 */
export function htmlFrameGeometry(fill: boolean, reported: number | null, scale: number | null): Record<string, string | number> {
  if (fill) return scale ? desktopFrameStyle(scale) : {};
  return reported === null ? {} : { height: reported, minHeight: 0 };
}

export function isWebDevice(v: unknown): v is WebDevice {
  return v === 'phone' || v === 'tablet' || v === 'desktop';
}

const KEY = 'super.webDevice';
/** Cards remembered at most; the least recently set is dropped. */
export const MAX_REMEMBERED = 60;
type Store = Array<[string, WebDevice]>;

function readStore(vault: string | null): Store {
  const raw = readScoped<unknown>(vault, KEY, []);
  return Array.isArray(raw) ? raw.filter((e): e is [string, WebDevice] => Array.isArray(e) && typeof e[0] === 'string' && isWebDevice(e[1])) : [];
}

/** The store with `id` set to `device` (null forgets it), newest last, capped. */
export function withDevice(store: Store, id: string, device: WebDevice | null): Store {
  const next = store.filter(([k]) => k !== id);
  if (device) next.push([id, device]);
  return next.slice(-MAX_REMEMBERED);
}

const listeners = new Set<() => void>();

/** Every remembered card's device, by card id (the stage plans side by side by them); follows
 *  every set. A stable string key, so a re-render that changed nothing changes nothing. */
export function useWebDevices(): string {
  const { vault } = useVault();
  const read = useCallback(() => readStore(vault).map(([k, d]) => `${k}=${d}`).sort().join(','), [vault]);
  const [key, setKey] = useState(read);
  useEffect(() => {
    setKey(read());
    const l = () => setKey(read());
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, [read]);
  return key;
}

/** A card's device width, read and set; every view of the same card follows. `id` null: kept in
 *  memory only (nothing to remember it by). */
export function useWebDevice(id: string | null): [WebDevice | null, (d: WebDevice | null) => void] {
  const { vault } = useVault();
  const read = useCallback(() => (id ? readStore(vault).find(([k]) => k === id)?.[1] ?? null : null), [vault, id]);
  const [device, setLocal] = useState<WebDevice | null>(read);
  useEffect(() => {
    setLocal(read());
    if (!id) return undefined;
    const l = () => setLocal(read());
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, [id, read]);
  const set = useCallback((d: WebDevice | null) => {
    setLocal(d);
    if (!id) return;
    writeScoped(vault, KEY, withDevice(readStore(vault), id, d));
    listeners.forEach((l) => l());
  }, [vault, id]);
  return [device, set];
}
