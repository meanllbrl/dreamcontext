import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';

/**
 * Which loopback ports a web card may load without asking (jarvis plan r9, K4): held by the
 * SERVER per vault (`~/.dreamcontext/loopback-grants.json`), never in this window's localStorage,
 * because the desktop app's own origin (its port) changes on every launch and the trust would
 * go with it. Also the ports this app itself listens on right now, which no card ever loads.
 *
 * One read per vault per window, refreshed by every grant or revoke made here.
 */

/** `failed`: the server could not be asked; a card then offers no button at all (fail closed). */
export interface LoopbackGrantsView { grants: number[]; ownedPorts: number[]; failed?: true }

const EMPTY: LoopbackGrantsView = { grants: [], ownedPorts: [] };
const FAILED: LoopbackGrantsView = { grants: [], ownedPorts: [], failed: true };
const cache = new Map<string, LoopbackGrantsView>();
const inflight = new Map<string, Promise<LoopbackGrantsView>>();
const listeners = new Set<() => void>();

function shape(raw: unknown): LoopbackGrantsView {
  const r = raw as { grants?: unknown; ownedPorts?: unknown } | null;
  const ports = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? x : (x as { port?: unknown })?.port)).filter((x): x is number => typeof x === 'number') : []);
  return { grants: ports(r?.grants), ownedPorts: ports(r?.ownedPorts) };
}

/** `fresh`: ask the server now (the app's own ports change while the window lives: a live
 *  browser's CDP port, whisper), never the cached answer. */
export function readLoopbackGrants(api: ApiClient, vault: string, opts: { fresh?: boolean } = {}): Promise<LoopbackGrantsView> {
  const have = cache.get(vault);
  if (have && !opts.fresh) return Promise.resolve(have);
  let p = inflight.get(vault);
  if (!p) {
    // A failed read is not cached: the next card asks again.
    p = api.get<unknown>('/agent/loopback-grants').then(shape)
      .then((v) => { cache.set(vault, v); inflight.delete(vault); return v; }, () => { inflight.delete(vault); return FAILED; });
    inflight.set(vault, p);
  }
  return p;
}

export async function setLoopbackGrant(api: ApiClient, vault: string, port: number, op: 'grant' | 'revoke'): Promise<LoopbackGrantsView> {
  const v = shape(await api.post<unknown>('/agent/loopback-grant', { port, op }));
  cache.set(vault, v);
  for (const fn of [...listeners]) fn();
  return v;
}

/** The port a loopback `host` (`localhost:5173`, `[::1]:3000`) names; 80 when none is written. */
export function portOfHost(host: string): number {
  const m = /:(\d{1,5})$/.exec(host);
  return m ? Number(m[1]) : 80;
}

/** React view: the vault's grants, asked fresh when the component mounts (null until it lands).
 *  `fresh` false (Settings' list) reads the cache when there is one. */
export function useLoopbackGrants(api: ApiClient, vault: string | null, opts: { fresh?: boolean } = { fresh: true }): LoopbackGrantsView | null {
  const [view, setView] = useState<LoopbackGrantsView | null>(() => (vault ? (opts.fresh ? null : cache.get(vault) ?? null) : EMPTY));
  const fresh = !!opts.fresh;
  const read = useCallback((force: boolean) => {
    if (!vault) { setView(EMPTY); return; }
    void readLoopbackGrants(api, vault, { fresh: force }).then(setView);
  }, [api, vault]);
  useEffect(() => {
    read(fresh);
    const fn = () => read(false);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [read, fresh]);
  return view;
}

/** Tests only. */
export function __resetLoopbackGrantsForTests(): void {
  cache.clear();
  inflight.clear();
  listeners.clear();
}
