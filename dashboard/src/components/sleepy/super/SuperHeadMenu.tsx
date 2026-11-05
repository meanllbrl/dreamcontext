import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { IconButton } from './SuperContainer';
import { useStageMenu } from './useStageMenu';

/**
 * The Super chat head's ⋯ (owner 2026-11-05: "the head is too wordy"): New session and Turn off
 * live in this small menu instead of two worded buttons; "+ Add" stays the head's one visible
 * action. What each row does is unchanged, only where it sits.
 *
 * New session (task super-agent-devrini-…, owner 2026-10-22): one press asks the server for a
 * `[super fresh]` turn; the super writes its handoff, its pane rotates into a fresh session, and
 * the stage stays as it is. No confirm: a browser `confirm()` is a silent no-op in the desktop
 * app's webview, and nothing is lost by a press. While the request is on its way the row reads
 * "Handing over…" and is greyed; a refusal or a failed post shows one short line beside the ⋯.
 *
 * Turn off is the last row, under a rule: it asks first (the stage's own dialog), as before.
 */
export function SuperHeadMenu({ fresh, onTurnOff }: {
  /** Absent: this head starts no session (a remote screen). */
  fresh?: { pending: boolean; onPress: () => Promise<boolean> };
  /** Absent: this head cannot turn the Super Agent off (a remote screen, the dock, a member). */
  onTurnOff?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);
  if (!fresh && !onTurnOff) return null;

  const busy = !!fresh && (fresh.pending || posting);
  const toggleEl = () => wrapRef.current?.querySelector<HTMLButtonElement>('[data-testid="super-head-more"]') ?? null;
  const close = (focusBack: boolean) => {
    setOpen(false);
    if (focusBack) toggleEl()?.focus();
  };
  const pressFresh = () => {
    if (!fresh || busy) return;
    close(true);
    setPosting(true);
    setError(null);
    fresh.onPress()
      .then((queued) => { if (!queued) setError(t('super.fresh.busy')); })
      .catch((err: { code?: string }) => setError(err?.code === 'rotating' ? t('super.fresh.busy') : t('super.fresh.failed')))
      .finally(() => setPosting(false));
  };
  const pressOff = () => {
    close(false);
    onTurnOff?.();
  };

  return (
    <div ref={wrapRef} className="super-head-more" data-busy={busy ? 'true' : undefined}>
      {error && <span className="super-fresh-error" role="status" data-testid="super-fresh-error">{error}</span>}
      <IconButton icon="more" label={t('super.head.more')} testId="super-head-more" menu expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <HeadMenu
          toggle={toggleEl}
          onClose={(why) => close(why === 'escape')}
          fresh={fresh ? { busy, onPress: pressFresh } : undefined}
          onTurnOff={onTurnOff ? pressOff : undefined}
        />
      )}
    </div>
  );
}

function HeadMenu({ toggle, onClose, fresh, onTurnOff }: {
  toggle: () => Element | null;
  onClose: (why: 'escape' | 'outside') => void;
  fresh?: { busy: boolean; onPress: () => void };
  onTurnOff?: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useStageMenu(ref, onClose, toggle);
  return (
    <div ref={ref} className="super-size-menu super-head-menu" role="menu" aria-label={t('super.head.more')} data-testid="super-head-menu"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {fresh && (
        <button type="button" role="menuitem" className="super-head-menu-item" data-testid="super-head-fresh"
          aria-disabled={fresh.busy || undefined} title={t('super.fresh.title')} onClick={fresh.onPress}>
          <svg className="super-head-menu-glyph" width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M13 8a5 5 0 1 1-1.46-3.54" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M13 3v2.5h-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{fresh.busy ? t('super.fresh.pending') : t('super.fresh.button')}</span>
        </button>
      )}
      {fresh && onTurnOff && <div className="super-head-menu-rule" role="separator" />}
      {onTurnOff && (
        <button type="button" role="menuitem" className="super-head-menu-item super-head-menu-item--off" data-testid="super-head-off"
          title={t('super.off.title')} onClick={onTurnOff}>
          <svg className="super-head-menu-glyph" width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M8 2.5V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M4.6 4.4a5 5 0 1 0 6.8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>{t('super.off.button')}</span>
        </button>
      )}
    </div>
  );
}
