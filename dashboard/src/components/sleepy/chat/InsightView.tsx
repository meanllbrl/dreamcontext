import { useLabInsight, type InsightSummary } from '../../../hooks/useLab';
import { CHART_REGISTRY, type Render } from '../../lab/chartRegistry';
import type { InsightViewSpec } from '../../../lib/chatViewSpec';
import './InsightView.css';

/**
 * A `{"type":"insight"}` view — a Lab insight drawn BY SLUG, with no markup from the agent.
 *
 * WHY THIS EXISTS ALONGSIDE `dream-html`. Everything else on this surface moved the other
 * way on 2026-08-26: the agent writes the presentation and we only guarantee it is safe.
 * A tracked metric is the one thing that must not work that way. It already HAS a canonical
 * rendering — the synced cache, the render its manifest declares, the staleness stamp the
 * board shows — and an agent retyping those figures into HTML would fork the truth: two
 * spellings of one number, one of them a transcription made at some earlier moment. So for
 * anything the Lab tracks, the agent names the slug and the app draws it, through the SAME
 * `CHART_REGISTRY` the board and the reports page render from.
 *
 * It COMPOSES and never mutates: no tweak PATCH, no sync trigger, no write of any kind. A
 * chat message must not be able to silently re-configure a board card. `spec.breakdown`
 * therefore only seeds the pivot's opening axes (`ChartBodyProps.pivot`) — the card's own
 * controls stay live and win from the first click.
 */

/** The board's own summary shape, rebuilt from the detail response. Mirrors ReportPage's
 *  `itemSummary` — the registry bodies read title/unit/slug/latest and little else. */
function toSummary(detail: NonNullable<ReturnType<typeof useLabInsight>['data']>): InsightSummary {
  const m = detail.insight;
  return {
    slug: m.slug,
    title: m.title,
    category: m.category,
    group: m.group,
    render: m.render,
    size: m.size,
    unit: m.unit,
    binding: m.binding,
    latest: detail.cache?.latest ?? null,
    fetchedAt: detail.cache?.fetchedAt ?? null,
    granularity: detail.cache?.granularity ?? null,
    error: detail.cache?.error ?? null,
    errorAt: detail.cache?.errorAt ?? null,
    ttlMinutes: m.refresh.ttl_minutes,
    staleMinutes: null,
    stale: null,
    tweaks: m.tweaks,
  };
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function InsightView({ spec }: { spec: InsightViewSpec }) {
  const { data, isLoading, isError } = useLabInsight(spec.id);

  if (isLoading) {
    return (
      <div className="chat-insightcard chat-insightcard--loading" aria-label={`${spec.id} — loading`}>
        <div className="chat-insightcard-skeleton" />
      </div>
    );
  }

  // Honest failure, not an empty box: a renamed or deleted insight is a real thing that
  // happens between the agent's memory and now, and the user needs to be told which slug.
  if (isError || !data) {
    return (
      <div className="chat-insightcard chat-insightcard--missing" role="alert">
        ⚠ No insight named <code>{spec.id}</code> — it may have been renamed or removed.
      </div>
    );
  }

  const summary = toSummary(data);
  const entry = CHART_REGISTRY[summary.render as Render] ?? CHART_REGISTRY.number;
  const full = spec.view === 'full';
  // `full` asks for the fuller story, and only some renders have a distinct one.
  const Body = (full && entry.DetailBody) ? entry.DetailBody : entry.CardBody;

  return (
    <div className="chat-insightcard">
      <div className="chat-insightcard-head">
        <span className="chat-insightcard-title">{summary.title}</span>
        {summary.unit && <span className="chat-insightcard-unit">{summary.unit}</span>}
      </div>
      <div className="chat-insightcard-body">
        <Body
          summary={summary}
          cache={data.cache}
          series={data.cache?.series ?? []}
          full={full}
          emptyHint={entry.emptyHint}
          pivot={spec.breakdown}
        />
      </div>
      <div className="chat-insightcard-foot">
        {summary.fetchedAt
          ? `as of ${fmtWhen(summary.fetchedAt)}`
          : 'never synced — no data yet'}
      </div>
    </div>
  );
}
