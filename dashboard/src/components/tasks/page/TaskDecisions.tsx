import { useI18n } from '../../../context/I18nContext';
import { TaskMarkdown } from './TaskMarkdown';

/** Constraints & Decisions: what was settled and why, through the sanitizing renderer. */
export function TaskDecisions({ slug, text }: { slug: string; text: string }) {
  const { t } = useI18n();
  if (!text.trim()) return <p className="tp-empty">{t('taskPage.decisions.empty')}</p>;
  return <TaskMarkdown text={text} idPrefix={`tp-dec-${slug}`} />;
}
