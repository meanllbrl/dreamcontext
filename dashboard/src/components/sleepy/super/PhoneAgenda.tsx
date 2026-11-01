import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperDigestWire, SuperQueueItem, SuperState } from '../../../lib/superTypes';
import { PhoneSheet, PhoneSheetClose } from './PhoneSheet';
import { SuperAgenda } from './SuperAgenda';
import { superNotepad, type AgendaRow, type JobLook } from './superHandover';
import type { SuperEventContext } from './superJobsStore';
import './PhoneAgenda.css';

/**
 * The Super Agent's agenda on the hands-free phone (task hands-free-telefonda-super-agent-
 * sohbeti-ajandayi…; the owner's chips of 1 Nov): one chip in the chat's header, nothing between
 * that bar and the conversation. The chip counts what waits on the owner (the pink mark), else
 * what is going on; a tap opens a sheet with all the counts and the desktop's own notepad
 * (`SuperAgenda` variant full, the same rows in the same order). The phone has no super record:
 * it draws from the `super_digest` the Mac pushes to its mirror.
 *
 * A row's ↩ stages it as an About chip in this phone's composer (`onWriteAbout`); the Super's
 * own question scrolls to its card in the chat (the sheet stays open when there is no card);
 * a child's permission or wait is read only (the phone never shows a child).
 */

/** The digest as the desktop notepad's input. Pure: `text` is the item's `ownerText`, a name is
 *  the Mac's job card title (the short session id when the digest names none). */
export function digestToNotepadInput(d: SuperDigestWire, superTitle: string): { state: Pick<SuperState, 'queue' | 'pad'>; look: JobLook } {
  const queue: SuperQueueItem[] = d.waiting.map((w) => ({
    id: w.id, kind: w.kind, state: w.state, createdAt: w.createdAt, sessionId: w.sessionId,
    ...(w.text ? { ownerText: w.text } : {}),
  }));
  return {
    state: { queue, pad: d.pad },
    look: {
      live: () => null,
      titleFor: (c) => d.names[c] ?? c.slice(0, 8),
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
    // An unnamed child (dropped from the record, past the digest's cap) reads as the desktop's
    // short id, never the whole session id.
    ctx: { ownerBatches: d.ownerBatches, titleFor: (c) => d.names[c] ?? c.slice(0, 8) },
    key: `${d.ownerBatches.join(',')}\u0002${JSON.stringify(d.names)}`,
  };
}

/** The Super's question card in the chat, or null when it is not drawn. */
function questionCard(item: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="super-question-card"][data-item="${CSS.escape(item)}"]`);
}

export function PhoneAgenda({ digest, onWriteAbout, onScreen }: {
  digest: SuperDigestWire | null;
  onWriteAbout: (row: AgendaRow) => void;
  /** The chat is on screen. Off (a link opened the drawer or another project): no sheet stays up. */
  onScreen: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  const input = useMemo(() => (digest ? digestToNotepadInput(digest, t('super.centre.name')) : null), [digest, t]);
  const counts = useMemo(() => {
    if (!input) return { waiting: 0, now: 0, done: 0 };
    const s = superNotepad(input.state, input.look);
    return { waiting: s.waiting.length, now: s.now.length, done: s.done.length };
  }, [input]);

  useEffect(() => { if (!onScreen) setOpen(false); }, [onScreen]);

  const close = useCallback(() => {
    setOpen(false);
    // The chip is in a bar that never moves: the chat stays where it was.
    requestAnimationFrame(() => chipRef.current?.focus({ preventScroll: true }));
  }, []);

  if (!digest || !input) return null;
  const empty = counts.waiting + counts.now + counts.done === 0;
  const summary = empty ? t('super.phoneAgenda.empty') : [
    ...(counts.waiting > 0 ? [t('super.phoneAgenda.waiting').replace('{n}', String(counts.waiting))] : []),
    t('super.phoneAgenda.now').replace('{n}', String(counts.now)),
    t('super.phoneAgenda.done').replace('{n}', String(counts.done)),
  ].join(' · ');

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="phone-chip"
        data-testid="phone-agenda-chip"
        data-waiting={counts.waiting > 0 ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('super.phoneAgenda.strip')}: ${summary}`}
        title={t('super.phoneAgenda.open')}
        onClick={() => setOpen(true)}
      >
        <span className="phone-chip-label">{t('super.phoneAgenda.strip')}</span>
        {counts.waiting > 0 ? (
          <span className="phone-chip-count" data-testid="phone-agenda-waiting">
            <span className="phone-chip-dot" aria-hidden />
            {counts.waiting}
          </span>
        ) : counts.now > 0 ? (
          <span className="phone-chip-count" data-testid="phone-agenda-now">{counts.now}</span>
        ) : null}
      </button>
      {open && onScreen && (
        <PhoneSheet
          testId="phone-agenda-sheet"
          labelledBy="phone-agenda-title"
          onClose={close}
          handle={(
            <div className="phone-agenda-head">
              <div className="phone-agenda-titles">
                <h2 id="phone-agenda-title" className="phone-agenda-title">{t('super.phoneAgenda.strip')}</h2>
                <span className="phone-agenda-sub" data-testid="phone-agenda-summary">{summary}</span>
              </div>
              <PhoneSheetClose testId="phone-agenda-close" label={t('super.phoneAgenda.close')} onClick={close} />
            </div>
          )}
        >
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
        </PhoneSheet>
      )}
    </>
  );
}
