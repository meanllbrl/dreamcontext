import { useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { PhoneSheet, PhoneSheetClose } from '../../sleepy/super/PhoneSheet';
import { PhoneLogSend } from './PhoneLogSend';
import { usePushOptIn, type PushOptInState } from './PushOptIn';

const STATUS_KEY: Record<Exclude<PushOptInState, 'hidden' | 'off'>, 'handsfree.push.statusOn' | 'handsfree.push.statusOff' | 'handsfree.push.statusBlocked'> = {
  on: 'handsfree.push.statusOn',
  quick: 'handsfree.push.statusOff',
  install: 'handsfree.push.statusOff',
  blocked: 'handsfree.push.statusBlocked',
};

/**
 * The foot of the phone's drawer: one short row (owner, 1 Nov: the two sentences and the log's
 * line ate the screen). Left the notifications' status, or the turn-on button when it takes a tap;
 * right Send log. The long words are one tap away in a sheet. What the owner must act on stays
 * open above the row: the address warning while it stands in the way of notifications, and a
 * failure.
 */
export function PhoneDrawerFoot() {
  const { t } = useI18n();
  const push = usePushOptIn();
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const { state, quick } = push;
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => moreRef.current?.focus({ preventScroll: true }));
  };
  const longNote = state === 'on' ? 'handsfree.push.on'
    : state === 'install' ? 'handsfree.push.install'
    : state === 'blocked' ? 'handsfree.push.blocked' : null;

  return (
    <div className="mfoot" data-testid="push-optin" data-state={state}>
      {state === 'quick' && <p className="mchat-push-note mfoot-open" data-testid="push-needs-fixed">{t('handsfree.push.needsFixed')}</p>}
      {state === 'off' && quick && <p className="mchat-push-note mfoot-open" data-testid="push-quick-note">{t('handsfree.push.quickNote')}</p>}
      {push.failed && <p className="mchat-push-note mfoot-open" role="alert">{t('handsfree.push.failed')}</p>}
      <div className="mfoot-row" data-testid="drawer-foot-row">
        {state === 'off' && (
          <button type="button" className="mchat-push-btn mfoot-enable" onClick={() => void push.turnOn()} disabled={push.busy} data-testid="push-enable">
            {push.busy ? t('handsfree.push.enabling') : t('handsfree.push.enable')}
          </button>
        )}
        {(state === 'off' || state === 'hidden') ? (
          <button ref={moreRef} type="button" className="mfoot-more" aria-haspopup="dialog" aria-label={t('handsfree.foot.more')} onClick={() => setOpen(true)} data-testid="drawer-foot-more">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <circle cx="10" cy="10" r="7.5" /><path d="M10 9.5v4M10 6.5v.01" />
            </svg>
          </button>
        ) : (
          <button ref={moreRef} type="button" className="mfoot-status" aria-haspopup="dialog" onClick={() => setOpen(true)} data-testid="drawer-foot-more">
            <span className="mfoot-dot" aria-hidden />
            <span className="mfoot-status-text">{t(STATUS_KEY[state])}</span>
          </button>
        )}
        <PhoneLogSend />
      </div>
      {open && (
        <PhoneSheet
          testId="drawer-foot-sheet"
          label={t('handsfree.foot.title')}
          onClose={close}
          handle={(
            <div className="phone-agenda-head">
              <div className="phone-agenda-titles"><h2 className="phone-agenda-title">{t('handsfree.foot.title')}</h2></div>
              <PhoneSheetClose testId="drawer-foot-close" label={t('super.phoneJobs.close')} onClick={close} />
            </div>
          )}
        >
          <div className="phone-agenda-body mfoot-sheet">
            {longNote && <p className="mfoot-long">{t(longNote)}</p>}
            {quick && (state === 'on' || state === 'off') && <p className="mfoot-long">{t('handsfree.push.quickNote')}</p>}
            <p className="mfoot-long"><strong>{t('handsfree.phoneLog.send')}</strong><br />{t('handsfree.phoneLog.sub')}</p>
          </div>
        </PhoneSheet>
      )}
    </div>
  );
}
