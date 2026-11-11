/**
 * The board's writing field (owner 2026-11-11, plan K3/K5, criteria 4-12): at the bottom centre
 * of a ready board, it takes a change in plain words and hands it to this project's ONE Super
 * chat, naming the board and, as its own chip, the current selection. While the work that
 * message started runs, a pill above the field says so and the page outlines the sent area.
 *
 * Mounted only while Super mode is on (the page checks the presence first); its Super mark
 * carries what the corner pill carried, which steps aside while this is on screen.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useI18n } from '../../context/I18nContext';
import { BrandMark } from '../brand/BrandMark';
import { msgRef } from '../../lib/superTypes';
import {
  openSuperFromPage, publishFieldMounted, sendFromPage, useSuperPresence, workGoing,
  type SuperPageRefusal, type WorkTrack,
} from '../../lib/superPageBridge';
import type { SelectionRef } from './agentDrop';
import { composeFieldMessage, fieldKeyAction, selectionChipText, selectionSendable, settleSave, type SaveKind } from './superFieldLogic';
import './BoardSuperField.css';

/** The marks hold this long after the work last read as going (a turn ending, a child starting). */
const WORK_HYSTERESIS_MS = 3000;
/** Below this canvas width the field cannot sit beside the zoom/undo group (2 x its 272 px
 *  reserve + a 400 px field): it rises above that row instead. */
const NARROW_CANVAS_PX = 944;

export interface FieldWork {
  box: [number, number, number, number];
}

export function BoardSuperField({ bus, board, boardName, selection, onClearSelection, saveKind, flush, onWork }: {
  bus: EventTarget;
  board: string;
  boardName: string;
  /** The canvas's live selection (null: nothing selected). */
  selection: SelectionRef | null;
  onClearSelection: () => void;
  saveKind: SaveKind;
  flush: () => void;
  /** The area to outline while this field's message is being worked on (null: none). */
  onWork: (work: FieldWork | null) => void;
}) {
  const { t } = useI18n();
  const presence = useSuperPresence(bus);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [track, setTrack] = useState<(WorkTrack & { box: FieldWork['box'] | null }) | null>(null);
  const [working, setWorking] = useState(false);
  const sendingRef = useRef(false);
  const saveRef = useRef(saveKind);
  saveRef.current = saveKind;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  const onWorkRef = useRef(onWork);
  onWorkRef.current = onWork;
  // A canvas too narrow to fit the field between Excalidraw's bottom-left controls and their
  // mirror raises it above them (measured, not a viewport breakpoint: the list and the agents
  // panel change the canvas width).
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const host = wrapRef.current?.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => setNarrow(host.clientWidth < NARROW_CANVAS_PX);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // The corner pill steps aside while the field is on screen.
  useEffect(() => {
    publishFieldMounted(bus, true);
    return () => publishFieldMounted(bus, false);
  }, [bus]);

  // "Working": re-read every second, held a moment past the last going read (plan Decision 8).
  useEffect(() => {
    if (!track) { setWorking(false); onWorkRef.current(null); return undefined; }
    let lastGoing = Date.now();
    const tick = () => {
      const now = Date.now();
      if (workGoing(track, presenceRef.current, now)) lastGoing = now;
      const shown = now - lastGoing < WORK_HYSTERESIS_MS;
      setWorking(shown);
      onWorkRef.current(shown && track.box ? { box: track.box } : null);
      if (!shown) setTrack(null);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [track]);
  useEffect(() => () => onWorkRef.current(null), []);

  const refusal = (reason: SuperPageRefusal) => t(`whiteboard.field.${reason}`);

  const send = useCallback(async () => {
    if (sendingRef.current) return;
    // Board and selection are read at Enter time.
    const text = composeFieldMessage(draft, board, selection);
    if (!text) return;
    const box = selection && selectionSendable(selection) ? selection.box : null;
    sendingRef.current = true;
    setSending(true);
    setNote(null);
    try {
      const saved = await settleSave(() => saveRef.current, flush);
      if (saved === 'deleted') { setNote({ text: t('whiteboard.field.deleted'), bad: true }); return; }
      const res = sendFromPage(bus, text);
      if (!res.accepted) { setNote({ text: refusal(res.reason), bad: true }); return; }
      setDraft('');
      if (saved === 'unsaved') setNote({ text: t('whiteboard.field.unsaved'), bad: false });
      setTrack({ ref: msgRef(text), sentAt: Date.now(), box });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [draft, board, selection, flush, bus, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Keys typed here are the field's: Excalidraw's shortcuts never see them.
    e.stopPropagation();
    const action = fieldKeyAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode });
    if (action === 'send') { e.preventDefault(); void send(); }
    else if (action === 'blur') { e.preventDefault(); e.currentTarget.blur(); }
  };

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  const mark = presence?.mark ?? null;
  const markState = mark?.asking ? 'asking' : mark?.dots.some((d) => d.status === 'working') ? 'working' : mark?.news ? 'news' : 'idle';
  const showSel = !!selection && selectionSendable(selection);
  const typed = draft.trim().length > 0;

  return (
    <div ref={wrapRef} className="bsf-wrap" data-dock-open={presence?.dockOpen ? 'true' : undefined} data-narrow={narrow ? 'true' : undefined}>
      {working && (
        <div className="bsf-working" role="status" data-testid="board-super-working">
          <span className="bsf-working-dots" aria-hidden><i /><i /><i /></span>
          <span>{t('whiteboard.field.working')}</span>
          <span aria-hidden>·</span>
          <button type="button" className="bsf-link" onClick={() => openSuperFromPage(bus)}>{t('whiteboard.field.openChat')}</button>
        </div>
      )}
      <div className="bsf" data-testid="board-super-field">
        <div className="bsf-chips">
          {showSel && (
            <span className="bsf-chip bsf-chip--sel" data-testid="board-super-sel">
              <SelGlyph />
              <span className="bsf-chip-text">{selectionChipText(selection, t)}</span>
              <button type="button" className="bsf-chip-x" aria-label={t('whiteboard.field.clearSel')} title={t('whiteboard.field.clearSel')} onClick={onClearSelection}>×</button>
            </span>
          )}
          <span className="bsf-chip" title={boardName}>
            <BoardGlyph />
            <span className="bsf-chip-text">{boardName}</span>
          </span>
        </div>
        <div className="bsf-row">
          <button
            type="button"
            className="bsf-mark"
            data-testid="board-super-mark"
            data-state={markState}
            aria-label={t('whiteboard.field.mark')}
            title={t('whiteboard.field.mark')}
            onClick={() => openSuperFromPage(bus)}
          >
            <BrandMark size={18} title="" />
            {markState === 'asking' && <span className="bsf-mark-q" aria-hidden>?</span>}
            {(markState === 'working' || markState === 'news') && <span className="bsf-mark-dot" aria-hidden />}
          </button>
          <textarea
            ref={inputRef}
            className="bsf-input"
            rows={1}
            value={draft}
            placeholder={t('whiteboard.field.placeholder')}
            aria-label={t('whiteboard.field.label')}
            onChange={(e) => { setDraft(e.target.value); if (note) setNote(null); }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.stopPropagation()}
            onPaste={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="bsf-send"
            data-ready={typed && !sending ? 'true' : undefined}
            disabled={!typed || sending}
            aria-label={t('whiteboard.field.send')}
            title={t('whiteboard.field.send')}
            onClick={() => void send()}
          >
            <SendGlyph />
          </button>
        </div>
        {note && <p className={note.bad ? 'bsf-note bsf-note--bad' : 'bsf-note'} role={note.bad ? 'alert' : 'status'}>{note.text}</p>}
      </div>
    </div>
  );
}

function SelGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2.2 2" aria-hidden>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    </svg>
  );
}

function BoardGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 6.5h11M6.5 6.5v7" />
    </svg>
  );
}

function SendGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}
