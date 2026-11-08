import { useI18n } from '../../../context/I18nContext';
import './ModelHtmlOff.css';

/**
 * Where a block of assistant-written HTML would have drawn in an app chat (`useInAppChat`): a
 * line saying it was not drawn, and its source as plain text behind a fold, so the conversation
 * stays readable and nothing goes missing without a word. The source is React text: escaped,
 * never parsed.
 */
export function ModelHtmlOff({ html, compact = false }: { html?: string; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`chat-html-off${compact ? ' compact' : ''}`} role="note" data-model-html-off="">
      <p className="chat-html-off-text">{t(compact ? 'appChat.widgetOff' : 'appChat.htmlOff')}</p>
      {!compact && html && html.trim() && (
        <details className="chat-html-off-source">
          <summary>{t('appChat.htmlOffSource')}</summary>
          <pre>{html}</pre>
        </details>
      )}
    </div>
  );
}
