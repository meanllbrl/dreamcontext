import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperDigestWire, SuperQueueItem, SuperState } from '../../../lib/superTypes';
import { SuperAgenda } from './SuperAgenda';
import { superNotepad, type AgendaRow, type JobLook } from './superHandover';
import type { SuperEventContext } from './superJobsStore';
import './PhoneAgenda.css';

/**
 * The Super Agent's agenda on the hands-free phone (task hands-free-telefonda-super-agent-
 * sohbeti-ajandayi…, owner's pick A): one strip under the chat's header with the counts
 * ("Agenda · 1 waiting on you · Now 2 · Done 7"), and a sheet from the bottom with the desktop's
 * own notepad (`SuperAgenda` variant full, the same rows in the same order). The phone has no
 * super record: it draws from the `super_digest` the Mac pushes to its mirror.
 *
 * A row's ↩ stages it as an About chip in this phone's composer (`onWriteAbout`); the Super's
 * own question scrolls to its card in the chat (the sheet stays open when there is no card);
 * a child's permission or wait is read only (the phone never shows a child).
 */

/** The digest as the desktop notepad's input. Pure: `text` is the item's `ownerText`, a name is
 *  the Mac's job card title (a session id when the digest names none). */
export function digestToNotepadInput(d: SuperDigestWire, superTitle: string): { state: Pick<SuperState, 'queue' | 'pad'>; look: JobLook } {
  const queue: SuperQueueItem[] = d.waiting.map((w) => ({
    id: w.id, kind: w.kind, state: w.state, createdAt: w.createdAt, sessionId: w.sessionId,
    ...(w.text ? { ownerText: w.text } : {}),
  }));
  return {
    state: { queue, pad: d.pad },
    look: {
      live: () => null,
      titleFor: (c) => d.names[c] ?? c,
      nameFor: (c) => d.names[c] ?? '',
      superTitle,
    },
  };
}

/** What the phone's chat folds its event turns with, from the digest (the stage's own context
 *  comes from the record), and the key it is published under: only the batches and the names
 *  the lines read, so a new note never re-renders the transcript, and a new batch or child name
 *  always does. */
export function phoneEventContext(d: SuperDigestWire): { ctx: SuperEventContext; key: string } {
  return {
    ctx: { ownerBatches: d.ownerBatches, titleFor: (c) => d.names[c] ?? c },
    key: `${d.ownerBatches.join(',')}\u0002${JSON.stringify(d.names)}`,
  };
}

/** The Super's question card in the chat, or null when it is not drawn. */
function questionCard(item: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="super-question-card"][data-item="${CSS.escape(item)}"]`);
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
/** A downward drag on the sheet's handle past this closes it. */
const SWIPE_CLOSE_PX = 72;

export function PhoneAgenda({ digest, onWriteAbout }: {
  digest: SuperDigestWire | null;
  onWriteAbout: (row: AgendaRow) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const stripRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);

  const input = useMemo(() => (digest ? digestToNotepadInput(digest, t('super.centre.name')) : null), [digest, t]);
  const counts = useMemo(() => {
    if (!input) return { waiting: 0, now: 0, done: 0 };
    const s = superNotepad(input.state, input.look);
    return { waiting: s.waiting.length, now: s.now.length, done: s.done.length };
  }, [input]);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => stripRef.current?.focus());
  }, []);

  // Open: focus the sheet's close button; Escape closes; Tab stays inside (aria-modal).
  useEffect(() => {
    if (!open) return undefined;
    const sheet = sheetRef.current;
    sheet?.querySelector<HTMLElement>('[data-testid="phone-agenda-close"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      // The surface's own Esc yields while this sheet is up (AgentSurface).
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab' || !sheet) return;
      const all = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!digest || !input) return null;
  const empty = counts.waiting + counts.now + counts.done === 0;

  return (
    <>
      <button
        ref={stripRef}
        type="button"
        className="phone-agenda-strip"
        data-testid="phone-agenda-strip"
        data-waiting={counts.waiting > 0 ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('super.phoneAgenda.open')}
        onClick={() => setOpen(true)}
      >
        <span className="phone-agenda-strip-h">{t('super.phoneAgenda.strip')}</span>
        {empty ? (
          <span className="phone-agenda-strip-part" data-testid="phone-agenda-empty">{t('super.phoneAgenda.empty')}</span>
        ) : (
          <>
            {counts.waiting > 0 && (
              <span className="phone-agenda-strip-part phone-agenda-strip-waiting" data-testid="phone-agenda-waiting">
                <span className="phone-agenda-strip-dot" aria-hidden />
                {t('super.phoneAgenda.waiting').replace('{n}', String(counts.waiting))}
              </span>
            )}
            <span className="phone-agenda-strip-part" data-testid="phone-agenda-now">{t('super.phoneAgenda.now').replace('{n}', String(counts.now))}</span>
            <span className="phone-agenda-strip-part" data-testid="phone-agenda-done">{t('super.phoneAgenda.done').replace('{n}', String(counts.done))}</span>
          </>
        )}
        <svg className="phone-agenda-strip-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="phone-agenda-layer">
          <div className="phone-agenda-backdrop" data-testid="phone-agenda-backdrop" onClick={close} aria-hidden />
          <div
            ref={sheetRef}
            className="phone-agenda-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-agenda-title"
            data-testid="phone-agenda-sheet"
          >
            <div
              className="phone-agenda-grip"
              data-testid="phone-agenda-grip"
              onTouchStart={(e) => { dragFrom.current = e.touches[0]?.clientY ?? null; }}
              onTouchMove={(e) => {
                const from = dragFrom.current;
                const y = e.touches[0]?.clientY;
                if (from !== null && y !== undefined && y - from > SWIPE_CLOSE_PX) { dragFrom.current = null; close(); }
              }}
              onTouchEnd={() => { dragFrom.current = null; }}
            >
              <span className="phone-agenda-grip-bar" aria-hidden />
              <div className="phone-agenda-head">
                <div className="phone-agenda-titles">
                  <h2 id="phone-agenda-title" className="phone-agenda-title">{t('super.phoneAgenda.strip')}</h2>
                  <span className="phone-agenda-sub">{t('super.phoneAgenda.sub')}</span>
                </div>
                <button type="button" className="phone-agenda-close" data-testid="phone-agenda-close" aria-label={t('super.phoneAgenda.close')} onClick={close}>
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                    <path d="M5 5l10 10M15 5L5 15" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="phone-agenda-body">
              <SuperAgenda
                state={input.state}
                look={input.look}
                variant="full"
                canShowChild={() => false}
                onShowChild={() => { /* the phone never shows a child */ }}
                onShowQuestion={(item) => {
                  const card = questionCard(item);
                  if (!card) return;
                  setOpen(false);
                  requestAnimationFrame(() => card.scrollIntoView({ block: 'center' }));
                }}
                onWriteAbout={(row) => { onWriteAbout(row); setOpen(false); }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
