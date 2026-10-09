import { useI18n } from '../../context/I18nContext';
import { GemConverge } from './GemConverge';

/**
 * The first thing a new person sees after the opening clip: the gem assembles again, then the
 * wordmark, what dreamcontext is in one headline and one sentence, and a single way on. Shown
 * only by the Launcher's automatic takeover (no projects yet); "+ Add Project" and "Finish
 * setting up" go straight to their step. The Mac readiness check is already running behind it
 * (`Onboarding` polls it), so the checklist usually opens with its rows filled in.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  const { t } = useI18n();
  return (
    <div className="ob-panel-body ob-welcome">
      <GemConverge />
      <span className="ob-welcome-word">dream<span>context</span></span>
      <h1 className="ob-welcome-title">{t('onboarding.welcome.title')}</h1>
      <p className="ob-welcome-body">{t('onboarding.welcome.body')}</p>
      <div className="ob-welcome-cta">
        <button type="button" className="ob-btn ob-btn--primary" onClick={onStart} autoFocus>
          {t('onboarding.welcome.start')}
        </button>
        <p className="ob-hint">{t('onboarding.welcome.next')}</p>
      </div>
    </div>
  );
}
