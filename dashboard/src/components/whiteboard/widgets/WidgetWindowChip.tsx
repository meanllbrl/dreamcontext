import { useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useApplyTweaks, useLabInsight } from '../../../hooks/useLab';
import { chartEntry } from '../../lab/chartRegistry';
import { RangeControl } from '../../lab/RangeControl';
import { BoardPopover } from '../../lab/board/BoardPopover';
import { useWbText, useWhiteboardHost } from '../whiteboardHost';
import { dataWindow, formatWindow } from './windowModel';
import '../../lab/board/board.css';
import './labCardWidget.css';

/**
 * The date window on an insight or Lab card widget: always printed ("6 Tem – 4 Eki"), and a
 * button that opens the Lab range control (the insight's declared presets, quick windows and a
 * custom from/to) once the widget is interactive.
 *
 * The window is the INSIGHT's, as everywhere in Lab: applying writes the insight's range tweak
 * and re-syncs (`useApplyTweaks`, the same chain as a Lab card's Range menu), so every surface
 * drawing that insight moves with it and the label follows the data, not the request.
 * An insight whose render has no window (a raw table, an app with none) prints nothing.
 */
export function WidgetWindowChip({ slug }: { slug: string }) {
  const { locale } = useI18n();
  const tx = useWbText();
  const host = useWhiteboardHost();
  const { data } = useLabInsight(slug);
  const apply = useApplyTweaks();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!data || !chartEntry(data.insight.render).supportsWindow) return null;
  const win = dataWindow(data);
  const label = win ? formatWindow(win, locale) : tx('whiteboard.window.unknown', 'Date range');
  const title = data.insight.title;

  const onApply = (values: Record<string, string>) => {
    setOpen(false);
    apply.mutate({ slug, tweaks: values }, {
      onSuccess: ({ synced, error }) => host.toast(synced
        ? tx('whiteboard.window.applied', 'Date range updated: {title}').replace('{title}', title)
        : tx('whiteboard.window.syncFailed', 'Saved the range, but {title} did not refresh: {error}').replace('{title}', title).replace('{error}', error ?? '')),
      onError: (err) => host.toast(tx('whiteboard.window.failed', 'Could not change the range of {title}: {error}')
        .replace('{title}', title).replace('{error}', (err as Error).message)),
    });
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`wb-window-chip${apply.isPending ? ' is-busy' : ''}`}
        data-wb-window={win ? `${win.fromISO}..${win.toISO}` : ''}
        title={win ? `${tx('whiteboard.window.label', 'Date range')}: ${win.fromISO} → ${win.toISO}` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span aria-hidden="true">🗓</span>
        <span className="wb-window-chip-label">{apply.isPending ? tx('whiteboard.window.syncing', 'Syncing…') : label}</span>
      </button>
      {open && (
        <BoardPopover
          anchor={anchor}
          onClose={() => setOpen(false)}
          label={tx('whiteboard.window.label', 'Date range')}
          role="dialog"
          className="board-popover--wide wb-window-pop"
        >
          <RangeControl tweaks={data.insight.tweaks} disabled={apply.isPending} onApply={onApply} />
        </BoardPopover>
      )}
    </>
  );
}
