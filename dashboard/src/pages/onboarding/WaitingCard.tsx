import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { copyPreservingUnicode } from '../../lib/clipboard';
import { openExternalUrl } from '../../lib/desktop';
import type { DeviceCode } from '../../lib/onboardingTypes';

/**
 * The inline card a checklist row opens while it waits on the person.
 *
 * Only ONE browser or device-code card is on screen at a time (the checklist decides which row
 * owns it). The macOS developer-tools wait is a quieter `dialog` variant: it never blocks the
 * rest of the list, so it reads as a note under its row rather than a call to act.
 */

export type WaitingVariant =
  | { kind: 'browser' }
  | { kind: 'device-code'; code: DeviceCode }
  | { kind: 'dialog' };

/** GitHub's own device page, used when a reported URL is not a GitHub https URL. */
const GITHUB_DEVICE_URL = 'https://github.com/login/device';

/** Only ever open GitHub's https device page, whatever the run reported. */
export function safeVerificationUrl(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : GITHUB_DEVICE_URL;
  } catch {
    return GITHUB_DEVICE_URL;
  }
}

/** Whole minutes left on a device code, never below one. */
export function minutesLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(1, Math.round((expiresAt - now) / 60_000));
}

interface Props {
  variant: WaitingVariant;
  onCancel?: () => void;
  /** Browser variant: start the sign-in again (a fresh browser tab). */
  onOpenAgain?: () => void;
}

export function WaitingCard({ variant, onCancel, onOpenAgain }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  if (variant.kind === 'dialog') {
    return (
      <div className="ob-wait ob-wait--quiet" role="status">
        <p className="ob-wait-title">{t('onboarding.wait.dialog.title')}</p>
        <p className="ob-wait-body">{t('onboarding.wait.dialog.body')}</p>
      </div>
    );
  }

  if (variant.kind === 'browser') {
    return (
      <div className="ob-wait" role="status" aria-live="polite">
        <p className="ob-wait-title">
          <span className="ob-live-dot" aria-hidden="true" />
          {t('onboarding.wait.browser.title')}
        </p>
        <p className="ob-wait-body">{t('onboarding.wait.browser.body')}</p>
        <div className="ob-wait-actions">
          {onOpenAgain && (
            <button type="button" className="ob-btn ob-btn--secondary" onClick={onOpenAgain}>
              {t('onboarding.wait.browser.openAgain')}
            </button>
          )}
          {onCancel && (
            <button type="button" className="ob-btn ob-btn--ghost" onClick={onCancel}>
              {t('onboarding.wait.cancel')}
            </button>
          )}
        </div>
      </div>
    );
  }

  const { code } = variant;
  async function copyCode() {
    const ok = await copyPreservingUnicode(code.userCode);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="ob-wait" role="status" aria-live="polite">
      <p className="ob-wait-title">
        <span className="ob-live-dot" aria-hidden="true" />
        {t('onboarding.wait.code.title')}
      </p>
      <p className="ob-wait-code" aria-label={code.userCode}>{code.userCode}</p>
      <p className="ob-wait-body">
        {t('onboarding.wait.code.expires').replace('{minutes}', String(minutesLeft(code.expiresAt)))}
      </p>
      <div className="ob-wait-actions">
        <button type="button" className="ob-btn ob-btn--secondary" onClick={() => void copyCode()}>
          {copied ? t('onboarding.wait.code.copied') : t('onboarding.wait.code.copy')}
        </button>
        <button
          type="button"
          className="ob-btn ob-btn--secondary"
          onClick={() => void openExternalUrl(safeVerificationUrl(code.verificationUri))}
        >
          {t('onboarding.wait.code.openGitHub')}
        </button>
        {onCancel && (
          <button type="button" className="ob-btn ob-btn--ghost" onClick={onCancel}>
            {t('onboarding.wait.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
