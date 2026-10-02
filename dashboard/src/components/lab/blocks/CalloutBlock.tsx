import { useMemo } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { stripRemoteMedia } from './safeMarkdown';
import type { BlockViewProps } from './blockCommon';

export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

export function toCalloutTone(v: unknown): CalloutTone {
  return (CALLOUT_TONES as readonly unknown[]).includes(v) ? (v as CalloutTone) : 'info';
}

/** `callout`: a highlighted note. `tone` colors the rail and tint; the body is markdown, remote images stripped. */
export function CalloutBlock({ options }: BlockViewProps) {
  const tone = toCalloutTone(options.tone);
  const markdown = typeof options.markdown === 'string' ? options.markdown : '';
  const safe = useMemo(() => stripRemoteMedia(markdown), [markdown]);
  return (
    <div className={`lab-block-callout lab-block-callout--${tone}`} role="note" data-tone={tone}>
      <MarkdownPreview content={safe} />
    </div>
  );
}
