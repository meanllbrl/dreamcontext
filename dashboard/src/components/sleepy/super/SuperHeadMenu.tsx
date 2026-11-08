import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { IconButton } from './SuperContainer';
import { useStageMenu } from './useStageMenu';
import { atName, rowOf, useTelegramStatus } from '../../../api/telegram';
import { TelegramBindSheet } from '../../telegram/TelegramBindSheet';

/**
 * The Super chat head's ⋯ (owner 2026-11-05: "the head is too wordy"): New session and Turn off
 * live in this small menu instead of two worded buttons. Add a card is its first row (owner
 * 2026-11-07: no "+ Add" in the head): it opens the stage's add menu (web, file, knowledge, task,
 * insight, whiteboard) under the ⋯. What each row does is unchanged, only where it sits.
 *
 * New session (task super-agent-devrini-…, owner 2026-10-22): one press asks the server for a
 * `[super fresh]` turn; the super writes its handoff, its pane rotates into a fresh session, and
 * the stage stays as it is. No confirm: a browser `confirm()` is a silent no-op in the desktop
 * app's webview, and nothing is lost by a press. While the request is on its way the row reads
 * "Handing over…" and is greyed; a refusal or a failed post shows one short line beside the ⋯.
 *
 * Turn off is the last row, under a rule: it asks first (the stage's own dialog), as before.
 *
 * Telegram (plan U, owner 2026-11-08) sits between New session and the rule: "Telegram'a bağla"
 * opens the bind sheet; bound, the row reads "Telegram", a green dot and the bot's @name and opens
 * the connected view. Only where Turn off is (the desktop stage's own head).
 */
export function SuperHeadMenu({ fresh, onTurnOff, onAdd }: {
  /** Absent: this head starts no session (a remote screen). */
  fresh?: { pending: boolean; onPress: () => Promise<boolean> };
  /** Absent: this head cannot turn the Super Agent off (a remote screen, the dock, a member). */
  onTurnOff?: () => void;
  /** Absent: this head opens no card (a remote screen, the dock). Given the ⋯ to anchor under. */
  onAdd?: (anchor: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telegram, setTelegram] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tgStatus = useTelegramStatus({ enabled: !!onTurnOff });
  const tgRow = rowOf(tgStatus.data, 'super');
  const tgBound = tgRow?.state === 'active' ? tgRow.botUsername : null;
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);
  if (!fresh && !onTurnOff && !onAdd) return null;

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
  const pressAdd = () => {
    const el = toggleEl();
    close(false);
    if (el) onAdd?.(el);
  };
  const pressOff = () => {
    close(false);
    onTurnOff?.();
  };
  const pressTelegram = () => {
    close(false);
    setTelegram(true);
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
          onAdd={onAdd ? pressAdd : undefined}
          telegram={onTurnOff ? { bound: tgBound, onPress: pressTelegram } : undefined}
        />
      )}
      {telegram && <TelegramBindSheet target="super" name={null} onClose={() => setTelegram(false)} />}
    </div>
  );
}

function HeadMenu({ toggle, onClose, fresh, onTurnOff, onAdd, telegram }: {
  toggle: () => Element | null;
  onClose: (why: 'escape' | 'outside') => void;
  fresh?: { busy: boolean; onPress: () => void };
  onTurnOff?: () => void;
  onAdd?: () => void;
  /** `bound`: the bot's username when a binding is live, else null. */
  telegram?: { bound: string | null; onPress: () => void };
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useStageMenu(ref, onClose, toggle);
  return (
    <div ref={ref} className="super-size-menu super-head-menu" role="menu" aria-label={t('super.head.more')} data-testid="super-head-menu"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {onAdd && (
        <button type="button" role="menuitem" className="super-head-menu-item" data-testid="super-head-add"
          aria-haspopup="menu" onClick={onAdd}>
          <svg className="super-head-menu-glyph" width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>{t('super.add.menuItem')}</span>
        </button>
      )}
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
      {telegram && (
        <button type="button" role="menuitem" className="super-head-menu-item" data-testid="super-head-telegram"
          data-bound={telegram.bound ? 'true' : undefined} onClick={telegram.onPress}>
          <svg className="super-head-menu-glyph" width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M14 2.5 1.8 7.3c-.5.2-.5.9 0 1.1l3 1.1 1.2 3.7c.1.4.6.5.9.2l1.7-1.6 3.1 2.3c.4.3.9.1 1-.4L14.9 3.3c.1-.5-.4-.9-.9-.8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="m4.8 9.5 6.4-4.2-4.4 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {telegram.bound ? (
            <>
              <span className="super-head-menu-grow">{t('telegram.menu.bound')}</span>
              <span className="super-head-menu-dot" aria-hidden />
              <span className="super-head-menu-aside">{atName(telegram.bound)}</span>
            </>
          ) : (
            <span>{t('telegram.menu.bind')}</span>
          )}
        </button>
      )}
      {(fresh || telegram) && onTurnOff && <div className="super-head-menu-rule" role="separator" />}
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
