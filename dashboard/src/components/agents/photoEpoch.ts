import { useSyncExternalStore } from 'react';

/**
 * The window's agent-photo epoch: bumped after any photo upload, read by every AgentAvatar
 * that has no version of its own.
 *
 * A photo lives at a stable URL served `no-cache` with an ETag, and WebKit reuses a URL it
 * already validated in this document without asking again. So after a replace, a face drawn
 * from the bare URL (the side panel's members) would keep the old picture until the app
 * restarts. One counter for every face, because uploads are rare and a bump costs each face
 * one 304 at most.
 */
let epoch = 0;
const listeners = new Set<() => void>();

export function bumpPhotoEpoch(): void {
  epoch += 1;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** 0 until the first upload of this window, so an untouched session keeps the bare URL. */
export function usePhotoEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch, () => epoch);
}
