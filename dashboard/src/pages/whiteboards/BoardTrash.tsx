/**
 * "Recently deleted" at the foot of the Boards list (moved here from the retired tab strip's
 * "All boards" panel, 2026-11-11). A delete only moves the board into `whiteboards/.trash/`,
 * which is gitignored: the history lives on this machine alone, and one click puts a board back
 * (under a new slug if its old one was taken since) and opens it.
 */
import { useEffect, useId, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useRestoreWhiteboard, useWhiteboardTrash, type TrashedWhiteboard } from '../../hooks/useWhiteboards';
import { ChevronRightGlyph, TrashGlyph } from './boardGlyphs';

export function TrashSection({ onRestored }: { onRestored: (slug: string) => void }) {
  const { t } = useI18n();
  const { data: trash, refetch } = useWhiteboardTrash();
  useEffect(() => { void refetch(); }, [refetch]);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (!trash || trash.length === 0) return null;
  return (
    <div className="wbx-trash" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="wbx-trash-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        title={t('whiteboard.switcher.trashHint')}
        onClick={() => setOpen((v) => !v)}
      >
        <TrashGlyph />
        <span className="wbx-trash-title">{t('whiteboard.switcher.trash')}</span>
        <span className="wbx-trash-count">{trash.length}</span>
        <span className="wbx-twisty" data-open={open ? '' : undefined}><ChevronRightGlyph /></span>
      </button>
      {/* Always rendered, so the fold can animate open and shut (K18). */}
      <div className="wbx-trash-fold" id={bodyId} inert={!open}>
        <ul className="wbx-trash-list">
          {trash.map((item) => <TrashRow key={item.id} item={item} onRestored={onRestored} />)}
        </ul>
      </div>
    </div>
  );
}

function TrashRow({ item, onRestored }: { item: TrashedWhiteboard; onRestored: (slug: string) => void }) {
  const { t, locale } = useI18n();
  const restore = useRestoreWhiteboard();
  const deleted = new Date(item.deletedAt);
  return (
    <li className="wbx-trash-row">
      <span className="wbx-trash-text">
        <span className="wbx-trash-name">{item.name}</span>
        <span className="wbx-trash-meta" title={Number.isNaN(deleted.getTime()) ? undefined : deleted.toLocaleString(locale)}>
          {item.elements === 1 ? t('whiteboard.switcher.elementsOne') : t('whiteboard.page.elements').replace('{n}', String(item.elements))}
          {!Number.isNaN(deleted.getTime()) && <> · {agoText(item.deletedAt, locale)}</>}
        </span>
        {restore.isError && <span className="wbx-trash-error">{restore.error?.message}</span>}
      </span>
      <button
        type="button"
        className="wbx-trash-restore"
        disabled={restore.isPending}
        onClick={() => restore.mutate(item.id, { onSuccess: (res) => { if (res?.slug) onRestored(res.slug); } })}
      >
        {t('whiteboard.switcher.restore')}
      </button>
    </li>
  );
}

/** "3 minutes ago" in the reader's language: when it went matters, the clock time does not. */
function agoText(iso: string, locale: string): string {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(0, 'minute');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
