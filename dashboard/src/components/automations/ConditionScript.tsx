import { useI18n } from '../../context/I18nContext';
import './ConditionScript.css';

/** What a door needs to draw a routine's condition (the detail and card payloads both carry it). */
export interface ConditionView {
  condition: string | null;
  /** true: the agent wakes when the script exits 0; false: when it exits 1. */
  conditionWake: boolean;
  /** Why it cannot run: the door offers no approve then. */
  conditionError: string | null;
}

/** The view from a payload that may come from an older backend (fields absent = no condition). */
export function conditionView(src: { condition?: string | null; conditionWake?: boolean; conditionError?: string | null } | null | undefined): ConditionView {
  return {
    condition: src?.condition ?? null,
    conditionWake: src?.conditionWake !== false,
    conditionError: src?.conditionError ?? null,
  };
}

/**
 * MOLECULE — the condition script a routine runs before its agent wakes, drawn the ONE way every
 * approve door draws it (kosullu-otomasyon C6, `onay-karti.html`): the whole script as it runs,
 * which answer wakes the agent, and that it runs as a plain shell command with his permissions.
 * A script that cannot run says why instead. Nothing when there is no condition.
 */
export function ConditionScript({ view, label = false }: { view: ConditionView; label?: boolean }) {
  const { t } = useI18n();
  if (!view.condition && !view.conditionError) return null;
  return (
    <div className="condition-script" data-condition-script>
      {label && <p className="condition-script-label">{t('chat.autocard.condition')}</p>}
      {view.condition && <pre className="condition-script-pre">{view.condition}</pre>}
      {view.conditionError
        ? <span className="condition-script-sub condition-script-error">{t('chat.autocard.condition.error').replace('{why}', view.conditionError)}</span>
        : <span className="condition-script-sub">{t(view.conditionWake ? 'chat.autocard.condition.wakeTrue' : 'chat.autocard.condition.wakeFalse')} {t('chat.autocard.condition.shell')}</span>}
    </div>
  );
}
