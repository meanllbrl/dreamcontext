import { useI18n } from '../../../context/I18nContext';
import { MarkdownBlock } from './MarkdownBlock';

/** Constraints & Decisions: what was settled and why, through the sanitizing renderer. */
export function TaskDecisions({ slug, text }: { slug: string; text: string }) {
  const { t } = useI18n();
  if (!text.trim()) return <p className="tkp-empty">{t('taskPage.decisions.empty')}</p>;
  return <MarkdownBlock text={text} idPrefix={`tkp-dec-${slug}`} />;
}
