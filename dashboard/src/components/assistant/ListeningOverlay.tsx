import { useEffect, useRef, useState } from 'react';
import { onVoiceActivity, onVoiceLevel, type VoiceActivity } from '../../lib/voice/voiceActivity';
import { playMicEarcon } from '../../lib/chime';
import { STT_RETRIES } from '../../lib/voice/useVoiceCapture';
import { useI18n } from '../../context/I18nContext';

/**
 * The notch LISTENING: impossible to miss (owner, 2026-10-04: "when I talk make it way more
 * understandable that you listen").
 *
 * While the Assistant's microphone is open, the open notch is taken over by one big state:
 * the avatar inside rings that swell with the owner's voice, the word "Listening", the take's
 * clock and how to send it. An earcon marks the mic opening and closing. Then "Got it", while
 * the take is transcribed, "trying again" while a failed one is retried (`STT_RETRIES`), and
 * a short line when it did not work. Every line is two to four words (owner, 2026-10-21); the
 * full reason of a failure rides on the card's `title`.
 *
 * Fed by the composer through `lib/voice/voiceActivity.ts` — the composer still owns the take;
 * this only draws it. The level never goes through React state: a ref'd element's custom
 * property is written on the animation frame (the same discipline as `VoiceMeter`).
 */

const SHOWN: ReadonlySet<VoiceActivity['phase']> = new Set(['recording', 'transcribing', 'error', 'silent', 'too-short']);
/** How long a "did not hear that" / failure line stays before the overlay steps aside. */
const NOTICE_MS = 2600;

function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ListeningOverlay({ vault, avatar, name, mode }: {
  vault: string;
  avatar: string | null;
  name: string;
  mode: 'hold' | 'toggle';
}) {
  const { t } = useI18n();
  const [act, setAct] = useState<VoiceActivity | null>(null);
  const [notice, setNotice] = useState(false);
  const orbRef = useRef<HTMLDivElement>(null);
  const prevPhase = useRef<VoiceActivity['phase']>('idle');

  useEffect(() => onVoiceActivity(vault, (a) => {
    const was = prevPhase.current;
    prevPhase.current = a.phase;
    if (a.phase === 'recording' && was !== 'recording') playMicEarcon('open');
    if (was === 'recording' && a.phase === 'transcribing') playMicEarcon('close');
    setAct(a);
  }), [vault]);

  // A failure or a silent take is said, then the overlay steps aside.
  const failing = act?.phase === 'error' || act?.phase === 'silent' || act?.phase === 'too-short';
  useEffect(() => {
    if (!failing) { setNotice(false); return; }
    setNotice(true);
    const t = window.setTimeout(() => setNotice(false), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [failing, act]);

  // The level: smoothed, written straight to the element on the next frame.
  const listening = act?.phase === 'recording';
  useEffect(() => {
    if (!listening) return;
    let target = 0;
    let shown = 0;
    let raf = 0;
    const off = onVoiceLevel(vault, (level) => { target = Math.min(1, level * 9); });
    const tick = () => {
      shown += (target - shown) * (target > shown ? 0.45 : 0.12);
      orbRef.current?.style.setProperty('--lvl', shown.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { off(); cancelAnimationFrame(raf); orbRef.current?.style.setProperty('--lvl', '0'); };
  }, [listening, vault]);

  if (!act || !SHOWN.has(act.phase) || (failing && !notice)) return null;

  let title: string;
  let sub: string;
  if (act.phase === 'recording') {
    title = t('voice.note.listening');
    sub = mode === 'toggle' ? t('voice.overlay.pressAgain') : t('voice.overlay.release');
  } else if (act.phase === 'transcribing') {
    title = act.attempt > 0 ? t('voice.overlay.retrying') : t('voice.overlay.gotIt');
    sub = act.attempt > 0 ? t('voice.note.retry').replace('{n}', String(act.attempt)).replace('{max}', String(STT_RETRIES)) : t('voice.overlay.writing');
  } else if (act.phase === 'error') {
    title = t('voice.overlay.failed');
    sub = t('voice.note.error');
  } else if (act.phase === 'too-short') {
    // A tap: one word, and the orb nudges (notch.css) — not a second line telling the owner off.
    title = t('voice.note.tap');
    sub = '';
  } else {
    title = t('voice.note.silent');
    sub = t('voice.overlay.closer');
  }

  return (
    <div className="dc-listen" data-phase={act.phase} role="status" aria-live="assertive" title={act.phase === 'error' ? act.error || undefined : undefined}>
      <div className="dc-listen__orb" ref={orbRef}>
        <span className="dc-listen__ring dc-listen__ring--3" aria-hidden />
        <span className="dc-listen__ring dc-listen__ring--2" aria-hidden />
        <span className="dc-listen__ring dc-listen__ring--1" aria-hidden />
        {avatar
          ? <img className="dc-listen__avatar" src={avatar} alt="" />
          : <span className="dc-listen__avatar dc-listen__avatar--initial" aria-hidden>{name.slice(0, 1)}</span>}
      </div>
      <p className="dc-listen__title">{title}</p>
      {sub && <p className="dc-listen__sub">{sub}</p>}
      {listening && <p className="dc-listen__clock" aria-hidden>{mmss(act.elapsed)}</p>}
    </div>
  );
}
