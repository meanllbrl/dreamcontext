import { useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';

/**
 * "Yeni oturum" / "New session" in the centre's head (task super-agent-devrini-…, owner
 * 2026-10-22: "Super agent'ta yeni session ya da sıfırla gibi bir yapı olmalı"). One press asks the
 * server for a `[super fresh]` turn: the super writes its handoff file, its pane rotates into a
 * fresh session, and the stage — children, pool, cards — stays as it is.
 *
 * No confirm dialog: a browser `confirm()` is a silent no-op in the desktop app's webview, and
 * nothing is lost by a press. Greyed with "Devrediliyor…" while the request is on its way
 * (`pending`, read from the pushed state) or posting; a refusal or a failed post shows one short
 * line under the head and frees the button.
 */
export function NewSessionButton({ pending, onPress }: {
  pending: boolean;
  onPress: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);
  const busy = pending || posting;
  const label = busy ? t('super.fresh.pending') : t('super.fresh.button');
  const press = () => {
    if (busy) return;
    setPosting(true);
    setError(null);
    onPress()
      .then((queued) => { if (!queued) setError(t('super.fresh.busy')); })
      .catch((err: { code?: string }) => setError(err?.code === 'rotating' ? t('super.fresh.busy') : t('super.fresh.failed')))
      .finally(() => setPosting(false));
  };
  return (
    <div className="super-fresh">
      {error && <span className="super-fresh-error" role="status" data-testid="super-fresh-error">{error}</span>}
      <button
        type="button"
        className="super-fresh-btn"
        data-testid="super-fresh-btn"
        data-busy={busy ? 'true' : undefined}
        aria-label={label}
        aria-busy={busy || undefined}
        title={t('super.fresh.title')}
        // aria-disabled, not `disabled`: a keyboard press keeps its focus on the button.
        aria-disabled={busy || undefined}
        onClick={press}
      >
        <svg className="super-fresh-glyph" width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M13 8a5 5 0 1 1-1.46-3.54" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M13 3v2.5h-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="super-fresh-btn-label">{label}</span>
      </button>
    </div>
  );
}
