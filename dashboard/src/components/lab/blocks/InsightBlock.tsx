import { useI18n } from '../../../context/I18nContext';
import { chartEntry, detailBodyFor } from '../chartRegistry';
import { HtmlInsightBody } from '../HtmlInsightBody';
import { LabAppBody } from '../LabAppBody';
import { useBlockSize, type BlockViewProps } from './blockCommon';
import './dataBlocks.css';

/**
 * `insight`: the card's insight EXACTLY as v1 draws it, through the chart
 * registry, with v1's precedence: an app/v1 body, then an html/v1 body (both
 * keep the `lk-` kit), then the render's typed body (funnel, breakdown and the
 * rest). The detail variant (`full`) uses the registry's detail body, as the
 * v1 panel does. This is the migration path: a legacy card is one of these.
 *
 * A chart render (registry `fit: 'fill'`) fills the cell like the new blocks:
 * its body mounts in a box of definite size that never scrolls, and gets the
 * box's measured `height`. Table-like renders, app/v1 and html/v1 bodies keep
 * their natural height and scroll inside the cell.
 */
export function InsightBlock({ summary, cache, full }: BlockViewProps) {
  const { t } = useI18n();
  // ONE root across every state, so the size observer never loses its element
  // when the cache arrives or the render changes.
  const [ref, box] = useBlockSize();
  const entry = summary ? chartEntry(summary.render) : null;
  const fill = !!entry && !cache?.app && !cache?.html && entry.fit === 'fill';
  return (
    <div
      ref={ref}
      className={fill ? 'lab-block-insight lab-block-insight--fill' : 'lab-block-scroll lab-block-insight lab-block-insight--scroll'}
      data-insight-fit={fill ? 'fill' : 'scroll'}
    >
      {!summary || !entry ? (
        <div className="lab-block-empty">{t('lab.blocks.insight.missing')}</div>
      ) : (
        <InsightBody summary={summary} cache={cache ?? null} full={full} fill={fill} height={Math.floor(box.height)} />
      )}
    </div>
  );
}

function InsightBody({ summary, cache, full, fill, height }: {
  summary: NonNullable<BlockViewProps['summary']>;
  cache: NonNullable<BlockViewProps['cache']> | null;
  full?: boolean;
  fill: boolean;
  height: number;
}) {
  const entry = chartEntry(summary.render);
  const series = cache?.series ?? [];
  const Body = full ? detailBodyFor(summary.render) : entry.CardBody;
  if (fill) {
    return (
      <div className="lab-block-insight-body">
        <Body summary={summary} cache={cache} series={series} full={full} emptyHint={entry.emptyHint} height={height} />
      </div>
    );
  }
  return cache?.app ? (
    <LabAppBody summary={summary} cache={cache} series={series} emptyHint={entry.emptyHint} />
  ) : cache?.html ? (
    <HtmlInsightBody html={cache.html} title={summary.title} full={full} />
  ) : (
    <Body summary={summary} cache={cache} series={series} full={full} emptyHint={entry.emptyHint} />
  );
}
