import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../../context/VaultContext';
import { useOptionalI18n } from '../../../context/I18nContext';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';

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
   *  grant must record. `phone`: the hands-free phone's own one-tap grant (its own route). */
  | { state: 'blocked'; path: string; phone?: boolean }
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
  const i18n = useOptionalI18n();
  const say = (key: string, fallback: string): string => {
    const v = i18n?.t(key);
    return v && v !== key ? v : fallback;
  };
  // Read through a ref inside the probe effect: the effect re-runs on `src` only.
  const sayRef = useRef(say);
  sayRef.current = say;
  const phone = isMacPhoneSurface();
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
          // The hands-free phone (agent-chat.ts `phoneOutsideMedia`): one tap, or never.
          if (body?.error === 'needs_phone_grant' && typeof body.path === 'string') {
            return { state: 'blocked', path: body.path, phone: true };
          }
          if (body?.error === 'other_project') return { state: 'explained', message: sayRef.current('chat.media.otherProject', 'in a project this phone can’t open') };
          if (body?.error === 'phone_media_only') return { state: 'explained', message: sayRef.current('chat.media.cantShow', 'can’t be shown on the phone') };
          return { state: 'explained', message: 'it can’t be read from here' };
        }
        if (r.status === 404) return { state: 'explained', message: phone ? sayRef.current('chat.media.gone', 'isn’t there any more') : 'it isn’t there any more' };
        // The bytes ARE reachable and the element still refused them: the file is damaged, or
        // in a format this engine has no decoder for. Saying "couldn't load" there would be a
        // guess the probe just disproved.
        if (r.ok || r.status === 206) {
          return { state: 'explained', message: 'this window can’t draw it — it may be damaged, or in a format the app can’t decode' };
        }
        return { state: 'explained', message: 'it couldn’t be loaded' };
      })
      .catch((): Probe => ({ state: 'explained', message: phone ? sayRef.current('chat.media.unreachable', 'couldn’t load') : 'it couldn’t be loaded' }))
      .then((next) => { if (!cancelled) setProbe(next); });
    return () => { cancelled = true; };
  }, [src]);

  const allow = (grantPath: string, phone = false) => {
    setGranting(true);
    // Never the desktop's grant from the phone: that route is laptop-only (route-policy.ts).
    void api.post(phone || isMacPhoneSurface() ? '/agent/phone-grant' : '/agent/grant', { path: grantPath }).then(
      () => onGranted(),
      () => setProbe({ state: 'explained', message: 'it couldn’t be allowed' }),
    ).finally(() => setGranting(false));
  };

  const noun = kind === 'file' ? 'file' : kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'audio';

  if (probe.state === 'checking') return <p className="chat-unavailable-note">{phone ? say('chat.media.checking', 'Checking…') : `Checking this ${noun}…`}</p>;

  if (probe.state === 'blocked' && probe.phone) {
    return (
      <div className="chat-unavailable">
        <p className="chat-unavailable-note">{say('chat.media.outside', 'outside the project')}</p>
        <button type="button" className="chat-btn" onClick={() => allow(probe.path, true)} disabled={granting}>
          {granting ? say('chat.media.showing', 'Showing…') : say('chat.media.show', 'Show')}
        </button>
      </div>
    );
  }

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

  // The phone reads its reason in its own language, never wrapped in an English sentence.
  if (phone) return <p className="chat-unavailable-note error">{probe.message}</p>;
  return <p className="chat-unavailable-note error">Couldn’t show this {noun} — {probe.message}.</p>;
}
