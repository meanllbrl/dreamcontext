import { forwardRef, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { emitInstance, useVault } from '../../context/VaultContext';
import { useRunBrainSync } from '../../hooks/useBrainStatus';
import { fillOutcome, syncOutcome, type SyncOutcome } from './syncOutcome';
import './BoardSyncButton.css';

/** How long a calm outcome stays under the button (ms); a red one stays until the next press. */
export const OUTCOME_SHOW_MS = 6000;

interface Props {
  /** Send what the board holds now and wait for it to land. */
  flushAndWait: () => Promise<void>;
  /** Read the open board from disk again. */
  refresh: () => Promise<void>;
}

/**
 * The board's Sync button (owner, 2026-11-18): the project's normal brain sync, run now. It
 * sends what it can and takes what it can; boards changed on both sides merge element by
 * element, and other files a team merge leaves wait for sleep (the server's board exchange).
 * The open board then reads its file again, so a teammate's drawing shows at once.
 */
export const BoardSyncButton = forwardRef<HTMLSpanElement, Props>(function BoardSyncButton({ flushAndWait, refresh }, ref) {
  const { t } = useI18n();
  const { bus } = useVault();
  const qc = useQueryClient();
  const runSync = useRunBrainSync();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // Set on every mount: StrictMode mounts, unmounts and mounts again, and a cleanup-only effect
  // would leave it false for good (the button stuck on Syncing..., found by the screen check).
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  const show = (o: SyncOutcome) => {
    if (!alive.current) return;
    setOutcome(o);
    if (timer.current) clearTimeout(timer.current);
    timer.current = o.tone === 'bad' ? null : setTimeout(() => setOutcome(null), OUTCOME_SHOW_MS);
  };

  const press = async () => {
    if (busy || runSync.isPending) return;
    setBusy(true);
    setOutcome(null);
    try {
      // The stroke drawn just before the press is on disk before the sync reads the folder.
      await flushAndWait();
      const result = await runSync.mutateAsync('auto');
      // A teammate's drawing came in (or a merge rewrote the file): the open board reads it now.
      await refresh();
      void qc.invalidateQueries({ queryKey: ['whiteboards'] });
      show(syncOutcome(result));
    } catch {
      show(syncOutcome(null));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const text = outcome?.lines.map((l) => fillOutcome(t(l.key), l.vars)).join(' · ') ?? '';
  return (
    <span className="wbp-sync" ref={ref}>
      <button
        type="button"
        className={`wbp-sync-btn${outcome?.tone === 'bad' ? ' wbp-sync-btn--bad' : ''}`}
        onClick={() => void press()}
        aria-disabled={busy}
        aria-busy={busy}
        title={t('whiteboard.sync.tip')}
      >
        <SyncGlyph spinning={busy} />
        {busy ? t('whiteboard.sync.running') : t('whiteboard.sync.button')}
      </button>
      {outcome && (
        <span className={`wbp-sync-note wbp-sync-note--${outcome.tone}`} role={outcome.tone === 'bad' ? 'alert' : 'status'}>
          <span className="wbp-sync-note-text">{text}</span>
          {outcome.settings && (
            <button
              type="button"
              className="wbp-sync-note-link"
              onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: 'brain' })}
            >
              {t('whiteboard.sync.openSettings')}
            </button>
          )}
          <button type="button" className="wbp-sync-note-close" aria-label={t('whiteboard.sync.dismiss')} onClick={() => setOutcome(null)}>×</button>
        </span>
      )}
    </span>
  );
});

function SyncGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg className={spinning ? 'wbp-sync-glyph wbp-sync-glyph--spin' : 'wbp-sync-glyph'} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 6.5A5.5 5.5 0 0 0 3.4 4.6" /><path d="M3 2v3h3" />
      <path d="M2.5 9.5a5.5 5.5 0 0 0 10.1 1.9" /><path d="M13 14v-3h-3" />
    </svg>
  );
}
