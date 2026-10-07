import { useContext } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { chartEntry, detailBodyFor } from '../chartRegistry';
import { LabFrameFill } from '../frameFill';
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
 *
 * A v1 APP insight takes two options: `page` pins the page the card shows,
 * `nav` (true) puts the app's page pills in the card and makes the frame
 * interactive, filling the cell. The open page lives in the card's view state
 * (`appPage` / `onAppPage`), so fullscreen keeps it; it wins over `page`.
 *
 * In a host-sized box (`LabFrameFill`, a whiteboard widget) an app/v1 or html/v1 body fills the
 * cell like `nav` does, instead of standing as a 320px preview over an empty band.
 */
export function InsightBlock({ summary, cache, full, options, appPage, onAppPage }: BlockViewProps) {
  const { t } = useI18n();
  // ONE root across every state, so the size observer never loses its element
  // when the cache arrives or the render changes.
  const [ref, box] = useBlockSize();
  const entry = summary ? chartEntry(summary.render) : null;
  const fill = !!entry && !cache?.app && !cache?.html && entry.fit === 'fill';
  const nav = !!cache?.app && options.nav === true;
  const frameFill = useContext(LabFrameFill) && !full && (!!cache?.app || !!cache?.html);
  const page = appPage ?? (typeof options.page === 'string' && options.page ? options.page : null);
  const app: AppView = { pageId: page, nav, fill: frameFill, onNavigate: onAppPage };
  return (
    <div
      ref={ref}
      className={fill || nav || frameFill ? 'lab-block-insight lab-block-insight--fill' : 'lab-block-scroll lab-block-insight lab-block-insight--scroll'}
      data-insight-fit={fill || nav || frameFill ? 'fill' : 'scroll'}
    >
      {!summary || !entry ? (
        <div className="lab-block-empty">{t('lab.blocks.insight.missing')}</div>
      ) : nav || frameFill ? (
        <div className="lab-block-insight-body">
          <InsightBody summary={summary} cache={cache ?? null} full={full} fill={false} height={Math.floor(box.height)} app={app} />
        </div>
      ) : (
        <InsightBody summary={summary} cache={cache ?? null} full={full} fill={fill} height={Math.floor(box.height)} app={app} />
      )}
    </div>
  );
}

interface AppView {
  pageId: string | null;
  nav: boolean;
  /** The frame fills the block (`LabFrameFill`). */
  fill: boolean;
  onNavigate?: (pageId: string) => void;
}

function InsightBody({ summary, cache, full, fill, height, app }: {
  summary: NonNullable<BlockViewProps['summary']>;
  cache: NonNullable<BlockViewProps['cache']> | null;
  full?: boolean;
  fill: boolean;
  height: number;
  app: AppView;
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
    <LabAppBody
      summary={summary}
      cache={cache}
      series={series}
      emptyHint={entry.emptyHint}
      pageId={app.pageId}
      nav={app.nav}
      fill={app.fill}
      onNavigate={app.onNavigate}
    />
  ) : cache?.html ? (
    <HtmlInsightBody html={cache.html} title={summary.title} full={full} fill={app.fill} />
  ) : (
    <Body summary={summary} cache={cache} series={series} full={full} emptyHint={entry.emptyHint} />
  );
}
