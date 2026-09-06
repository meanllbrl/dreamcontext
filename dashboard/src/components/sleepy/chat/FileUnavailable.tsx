import { useEffect, useState } from 'react';
import { useApi } from '../../../context/VaultContext';

/**
 * What a file surface says when the bytes did not arrive — and the one click that usually
 * fixes it.
 *
 * A media element reports failure and nothing else: no status, no reason. So the surfaces
 * that draw one used to fail in the emptiest way available — the lightbox showed the
 * engine's broken-file glyph over a full-window black screen, and the panel showed a
 * sentence pointing at a consent card that only exists when the answer happened to reference
 * the file INLINE (owner report 09-06: a screenshot that really was on disk, opened from a
 * tool row, unreadable and unexplained).
 *
 * This asks the endpoint WHY, exactly as `PdfViewer` does before it embeds and as the
 * transcript's inline media does on error: one ranged byte (the router serves GET only, so a
 * HEAD would 404 and make every blocked file look unreachable). A path outside the project
 * comes back 403 `needs_grant` carrying the file the SERVER resolved the reference to — the
 * grant has to record that, never the notation the answer typed, or the next read misses.
 *
 * `onGranted` is the caller's retry: consent changes the server's answer, not this card, so
 * the surface has to re-request the file (see `Lightbox`'s `reload` counter).
 */

type Probe =
  | { state: 'checking' }
  /** Outside the project root — `path` is the file the server resolved, which is what a
   *  grant must record. */
  | { state: 'blocked'; path: string }
  /** Reachable, or gone, or refused — either way the message says which. */
  | { state: 'explained'; message: string };

export function FileUnavailable({
  src, kind, onGranted,
}: {
  /** The URL the failing element was pointed at — probed as-is, so the answer is about the
   *  same request that failed. */
  src: string;
  /** What could not be shown, for a sentence that reads like the thing the user clicked. */
  kind: 'image' | 'video' | 'audio' | 'file';
  onGranted: () => void;
}) {
  const api = useApi();
  const [probe, setProbe] = useState<Probe>({ state: 'checking' });
  const [granting, setGranting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setProbe({ state: 'checking' });
    void fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then(async (r): Promise<Probe> => {
        if (r.status === 403) {
          const body = await r.json().catch(() => null) as { path?: unknown; error?: unknown } | null;
          if (body?.error === 'needs_grant') {
            return { state: 'blocked', path: typeof body.path === 'string' ? body.path : src };
          }
          return { state: 'explained', message: 'it can’t be read from here' };
        }
        if (r.status === 404) return { state: 'explained', message: 'it isn’t there any more' };
        // The bytes ARE reachable and the element still refused them: the file is damaged, or
        // in a format this engine has no decoder for. Saying "couldn't load" there would be a
        // guess the probe just disproved.
        if (r.ok || r.status === 206) {
          return { state: 'explained', message: 'this window can’t draw it — it may be damaged, or in a format the app can’t decode' };
        }
        return { state: 'explained', message: 'it couldn’t be loaded' };
      })
      .catch((): Probe => ({ state: 'explained', message: 'it couldn’t be loaded' }))
      .then((next) => { if (!cancelled) setProbe(next); });
    return () => { cancelled = true; };
  }, [src]);

  const allow = (grantPath: string) => {
    setGranting(true);
    void api.post('/agent/grant', { path: grantPath }).then(
      () => onGranted(),
      () => setProbe({ state: 'explained', message: 'it couldn’t be allowed' }),
    ).finally(() => setGranting(false));
  };

  const noun = kind === 'file' ? 'file' : kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'audio';

  if (probe.state === 'checking') return <p className="chat-unavailable-note">Checking this {noun}…</p>;

  if (probe.state === 'blocked') {
    return (
      <div className="chat-unavailable">
        <p className="chat-unavailable-note">
          This {noun} lives outside the project. Allow access to see it here, or hand it to
          your computer with “Open on computer”.
        </p>
        <button type="button" className="chat-btn" onClick={() => allow(probe.path)} disabled={granting}>
          {granting ? 'Allowing…' : 'Allow access'}
        </button>
      </div>
    );
  }

  return <p className="chat-unavailable-note error">Couldn’t show this {noun} — {probe.message}.</p>;
}
