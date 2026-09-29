import { useMemo } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { useI18n } from '../../../context/I18nContext';
import { stripRemoteMedia } from './safeMarkdown';
import type { BlockViewProps } from './blockCommon';

/** `text`: markdown notes and headings through MarkdownPreview (DOMPurify), remote images stripped first. */
export function TextBlock({ options }: BlockViewProps) {
  const { t } = useI18n();
  const markdown = typeof options.markdown === 'string' ? options.markdown : '';
  const safe = useMemo(() => stripRemoteMedia(markdown), [markdown]);
  if (!safe.trim()) return <div className="lab-block-empty">{t('lab.blocks.text.empty')}</div>;
  return (
    <div className="lab-block-scroll lab-block-text">
      <MarkdownPreview content={safe} />
    </div>
  );
}
