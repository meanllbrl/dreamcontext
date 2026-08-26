import { ChartEmpty, type ChartBodyProps } from './chartBody';
import { LabAppFrame } from './LabAppFrame';

/**
 * The board card's body for `render: app` (chartRegistry.ts's `app` entry,
 * and the first branch InsightCard's `app -> html -> typed` ternary reaches
 * when `cache.app` is present).
 *
 * Card mode only: previews the `spec.card ?? spec.entry` page in the
 * network-less sandboxed iframe LabAppFrame owns. No `onNavigate` is passed —
 * the card is a single click target (the card's own `onClick` routes to the
 * full app via `isRoutedRender`); it is never a router itself. Unsynced (no
 * `cache.app` yet) falls back to the registry's `emptyHint`, the same idiom
 * every other card body uses (`ChartEmpty`).
 */
export function LabAppBody({ summary, cache, emptyHint }: ChartBodyProps) {
  const app = cache?.app;
  if (!app) return <ChartEmpty hint={emptyHint} />;

  const spec = app.spec;
  const pageId = spec.card ?? spec.entry;

  return (
    <LabAppFrame
      key={`${summary.slug}:${pageId}`}
      slug={summary.slug}
      spec={spec}
      pageId={pageId}
      params={{}}
      datasets={cache?.datasets?.bundle ?? null}
      mode="card"
      title={summary.title}
    />
  );
}
