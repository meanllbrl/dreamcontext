import { useMemo } from 'react';
import { ProseSegment } from '../sleepy/chat/TranscriptItem';
import { MIN_FOLDED_SECTIONS, splitReport } from '../../lib/reportSections';

/**
 * A run's report, answer first and detail folded (see `lib/reportSections.ts` for the why).
 *
 * The lead renders as the chat's own prose; every `##` section is a native `<details>` row that
 * names itself and previews its first line, so the reader scans six rows instead of six
 * screens and opens the one they came for. A short report (under two sections) is shown whole:
 * folding one section only adds a click.
 *
 * Native `<details>` on purpose: keyboard, screen-reader state and find-in-page all come free,
 * and nothing here needs to remember which rows were open.
 */
export function FoldedReport({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
}) {
  const report = useMemo(() => splitReport(text), [text]);

  if (report.sections.length < MIN_FOLDED_SECTIONS) {
    return <ProseSegment text={text} onOpenFile={onOpenFile} />;
  }

  return (
    <div className="agent-report">
      {report.lead && (
        <div className="agent-report-lead">
          <ProseSegment text={report.lead} onOpenFile={onOpenFile} />
        </div>
      )}
      <div className="agent-report-sections">
        {report.sections.map((s, i) => (
          <details key={`${i}-${s.title}`} className="agent-report-section">
            <summary className="agent-report-summary">
              <span className="agent-report-chevron" aria-hidden="true" />
              <span className="agent-report-title">{s.title}</span>
              {s.preview && <span className="agent-report-preview">{s.preview}</span>}
            </summary>
            <div className="agent-report-body">
              <ProseSegment text={s.body} onOpenFile={onOpenFile} />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
