import { useI18n } from '../../../context/I18nContext';
import { chartEntry, detailBodyFor } from '../chartRegistry';
import { HtmlInsightBody } from '../HtmlInsightBody';
import { LabAppBody } from '../LabAppBody';
import type { BlockViewProps } from './blockCommon';

/**
 * `insight`: the card's insight EXACTLY as v1 draws it, through the chart
 * registry, with v1's precedence: an app/v1 body, then an html/v1 body (both
 * keep the `lk-` kit), then the render's typed body (funnel, breakdown and the
 * rest). The detail variant (`full`) uses the registry's detail body, as the
 * v1 panel does. This is the migration path: a legacy card is one of these.
 */
export function InsightBlock({ summary, cache, full }: BlockViewProps) {
  const { t } = useI18n();
  if (!summary) return <div className="lab-block-empty">{t('lab.blocks.insight.missing')}</div>;
  const entry = chartEntry(summary.render);
  const series = cache?.series ?? [];
  const Body = full ? detailBodyFor(summary.render) : entry.CardBody;
  return (
    <div className="lab-block-scroll lab-block-insight">
      {cache?.app ? (
        <LabAppBody summary={summary} cache={cache} series={series} emptyHint={entry.emptyHint} />
      ) : cache?.html ? (
        <HtmlInsightBody html={cache.html} title={summary.title} full={full} />
      ) : (
        <Body summary={summary} cache={cache ?? null} series={series} full={full} emptyHint={entry.emptyHint} />
      )}
    </div>
  );
}
