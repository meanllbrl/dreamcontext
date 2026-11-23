import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { phoneAllows } from '../../../lib/phoneSurface';
import './VoiceCard.css';

/** Characters of text shown before the fold. */
const FOLD_CHARS = 280;

type Phase = 'idle' | 'loading' | 'playing' | 'paused' | 'failed';

/**
 * A `dream-voice <title>` block, drawn as a voice message (Telegram turns the same block into
 * one). The text is always readable; the audio is made only when play is tapped, by the same
 * speech as the Telegram voice (`POST /api/agent/voice/summary`), and kept for replays.
 */
export function VoiceCard({ title, text }: { title: string; text: string }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [open, setOpen] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abort.current?.abort();
    audio.current?.pause();
    if (url.current) URL.revokeObjectURL(url.current);
  }, []);

  const play = async (): Promise<void> => {
    if (phase === 'loading') return;
    if (phase === 'playing') { audio.current?.pause(); setPhase('paused'); return; }
    if (!audio.current) {
      setPhase('loading');
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const res = await fetch('/api/agent/voice/summary', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: ctl.signal,
        });
        if (!res.ok || res.status === 204) { setPhase('failed'); return; }
        url.current = URL.createObjectURL(await res.blob());
        const a = new Audio(url.current);
        a.onended = () => setPhase('idle');
        audio.current = a;
      } catch {
        if (!ctl.signal.aborted) setPhase('failed');
        return;
      }
    }
    try {
      await audio.current.play();
      setPhase('playing');
    } catch {
      setPhase('failed');
    }
  };

  const canSpeak = phoneAllows('POST', '/api/agent/voice/summary');
  const long = text.length > FOLD_CHARS;
  const shown = open || !long ? text : `${text.slice(0, FOLD_CHARS).replace(/\s+\S*$/, '')}…`;
  const busy = phase === 'loading';
  const label = phase === 'playing' ? t('voicecard.pause') : t('voicecard.play');

  return (
    <div className="chat-voice" data-phase={phase} data-testid="chat-voice-card">
      {canSpeak && <button type="button" className="chat-voice-play" onClick={() => { void play(); }} disabled={busy} aria-label={label} title={label}>
        {busy ? <span className="chat-voice-spin" aria-hidden />
          : phase === 'playing'
            ? <svg viewBox="0 0 24 24" aria-hidden><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></svg>
            : <svg viewBox="0 0 24 24" aria-hidden><path d="M8 5.5v13l11-6.5z" /></svg>}
      </button>}
      <div className="chat-voice-main">
        <div className="chat-voice-head">
          <span className="chat-voice-kind">{t('voicecard.label')}</span>
          {title && <span className="chat-voice-title">{title}</span>}
        </div>
        <p className="chat-voice-text">{shown}</p>
        {long && (
          <button type="button" className="chat-voice-more" onClick={() => setOpen((o) => !o)}>
            {open ? t('voicecard.less') : t('voicecard.more')}
          </button>
        )}
        {(busy || phase === 'failed') && (
          <span className="chat-voice-note" role="status" data-failed={phase === 'failed'}>
            {busy ? t('voicecard.loading') : t('voicecard.failed')}
          </span>
        )}
      </div>
    </div>
  );
}
