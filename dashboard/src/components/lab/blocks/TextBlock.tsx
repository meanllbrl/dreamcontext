import { useMemo } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { useI18n } from '../../../context/I18nContext';
import { stripRemoteMedia } from './safeMarkdown';
import type { BlockViewProps } from './blockCommon';

/** A one-line `# ...` to `###### ...` markdown: the text of a section heading, else null. */
export function headingText(markdown: string): string | null {
  const m = /^\s*#{1,6}[ \t]+([^\n]*?)[ \t#]*$/.exec(markdown.trim());
  return m && m[1].trim() ? m[1].trim() : null;
}

/**
 * `text`: markdown notes and headings through MarkdownPreview (DOMPurify), remote images stripped first.
 * A block that is ONE heading line (a derived group heading, `### Growth`) draws as a section
 * heading, plain text in the heading type, not as a markdown document in a box.
 */
export function TextBlock({ options }: BlockViewProps) {
  const { t } = useI18n();
  const markdown = typeof options.markdown === 'string' ? options.markdown : '';
  const safe = useMemo(() => stripRemoteMedia(markdown), [markdown]);
  const heading = useMemo(() => headingText(safe), [safe]);
  if (!safe.trim()) return <div className="lab-block-empty">{t('lab.blocks.text.empty')}</div>;
  if (heading) {
    return (
      <div className="lab-block-heading" role="heading" aria-level={2} title={heading} data-lab-heading>
        {heading}
      </div>
    );
  }
  return (
    <div className="lab-block-scroll lab-block-text">
      <MarkdownPreview content={safe} />
    </div>
  );
}
