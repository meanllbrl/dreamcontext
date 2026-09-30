import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { ChartEmpty, type ChartBodyProps } from './chartBody';
import { LabAppFrame } from './LabAppFrame';
import './lab-app-card-nav.css';

/**
 * The board card's body for `render: app` (chartRegistry.ts's `app` entry,
 * and the first branch InsightBlock's `app -> html -> typed` ternary reaches
 * when `cache.app` is present).
 *
 * PREVIEW (default, `nav` off): previews one page in the network-less
 * sandboxed iframe LabAppFrame owns, in card mode. No `onNavigate` is passed:
 * the preview is a single click target, never a router. The page is the
 * pinned `pageId` when the insight block names one, else `spec.card ??
 * spec.entry` (today's card, unchanged).
 *
 * IN-CARD NAV (`nav` on): page pills above the frame, the frame interactive
 * (mode 'full', it fills the block), and both a pill click and the page's own
 * `lab.navigate` switch the page INSIDE the card through `onNavigate` (the
 * board card holds the open page, so fullscreen keeps it). In-page params are
 * not kept on a board: a navigation lands on the page's start.
 *
 * Either way the frame is keyed `${slug}:${page}`, so a page switch is always a
 * REMOUNT (fresh nonce, fresh load count: LabAppFrame's teardown contract).
 * A pinned page the app no longer declares falls back to `spec.card ??
 * spec.entry` and says so. Unsynced (no `cache.app` yet) falls back to the
 * registry's `emptyHint` (`ChartEmpty`).
 */
export interface LabAppBodyProps extends ChartBodyProps {
  /** The page to show (the block's open page or its `page` option); null = the app's card page. */
  pageId?: string | null;
  /** Page pills in the card, the frame interactive. */
  nav?: boolean;
  /** Switch the card's page (the board card's view state). Absent = the body keeps it itself. */
  onNavigate?: (pageId: string) => void;
}

export function LabAppBody({ summary, cache, emptyHint, pageId = null, nav = false, onNavigate }: LabAppBodyProps) {
  const { t } = useI18n();
  const [local, setLocal] = useState<string | null>(null);
  const app = cache?.app;
  if (!app) return <ChartEmpty hint={emptyHint} />;

  const spec = app.spec;
  const start = spec.card ?? spec.entry;
  const want = onNavigate ? pageId : local ?? pageId;
  const known = !want || spec.pages.some((p) => p.id === want);
  const page = want && known ? want : start;
  const go = (id: string) => {
    if (id === page) return;
    if (onNavigate) onNavigate(id);
    else setLocal(id);
  };
  const missing = !known && want ? (
    <p className="lab-app-card-note" data-lab-app-page-missing={want}>
      {t('lab.blocks.insight.pageMissing').replace('{page}', want)}
    </p>
  ) : null;

  if (!nav) {
    return (
      <>
        {missing}
        <LabAppFrame
          key={`${summary.slug}:${page}`}
          slug={summary.slug}
          spec={spec}
          pageId={page}
          params={{}}
          datasets={cache?.datasets?.bundle ?? null}
          mode="card"
          title={summary.title}
        />
      </>
    );
  }

  return (
    <div className="lab-app-card-nav" data-lab-app-nav data-lab-app-page={page}>
      {spec.pages.length > 1 && (
        <div
          className="lab-app-card-pills"
          role="tablist"
          aria-label={t('lab.blocks.insight.pages')}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {spec.pages.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              className="lab-app-card-pill"
              data-lab-app-pill={p.id}
              aria-selected={p.id === page}
              title={p.title}
              onClick={() => go(p.id)}
            >{p.title}</button>
          ))}
        </div>
      )}
      {missing}
      <div className="lab-app-card-frame">
        <LabAppFrame
          key={`${summary.slug}:${page}`}
          slug={summary.slug}
          spec={spec}
          pageId={page}
          params={{}}
          datasets={cache?.datasets?.bundle ?? null}
          mode="full"
          title={summary.title}
          onNavigate={(id) => go(id)}
        />
      </div>
    </div>
  );
}
