import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';
import { RequestError } from '../../../api/client';
import { phoneLogSnapshot } from '../../../lib/phoneConnLog';

/** How long the result line stays under the button. */
const NOTE_MS = 4000;

type Note = { tone: 'good' | 'bad'; text: string };

/**
 * "Bağlantı kaydını Mac'e gönder" — the Sohbetler list's footer row. Sends the phone's own
 * connection log (lib/phoneConnLog.ts: socket drops, reattaches, card mounts; no message text)
 * to the Mac, where the agent reads it when the owner says the phone misbehaved. The result is
 * an inline status line under the button (the phone list has no toasts): how many events
 * arrived, or the failure in words.
 */
export function PhoneLogSend() {
  const api = useApi();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const show = (n: Note) => {
    setNote(n);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const send = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; events: number }>('/handsfree/phone-log', phoneLogSnapshot());
      show({ tone: 'good', text: t('handsfree.phoneLog.sent').replace('{n}', String(r.events)) });
    } catch (err) {
      const status = err instanceof RequestError ? err.status : 0;
      show({
        tone: 'bad',
        text: t(status === 429 ? 'handsfree.phoneLog.tooSoon' : status === 0 ? 'handsfree.phoneLog.offline' : 'handsfree.phoneLog.refused'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mlist-log">
      <button type="button" className="mlist-log-btn" onClick={() => { void send(); }} disabled={busy} data-testid="phone-log-send">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10 13V3M6 7l4-4 4 4M5 13v4h10v-4" />
        </svg>
        <span className="mlist-log-text">
          <span className="mlist-log-title">{t('handsfree.phoneLog.send')}</span>
          <span className="mlist-log-sub">{t('handsfree.phoneLog.sub')}</span>
        </span>
      </button>
      <p className="mlist-foot-note" role="status" data-tone={note?.tone} data-testid="phone-log-note">{note?.text ?? ''}</p>
    </div>
  );
}
