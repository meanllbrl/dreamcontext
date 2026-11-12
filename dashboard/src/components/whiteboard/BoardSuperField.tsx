/**
 * The board's writing field (owner 2026-11-11, plan K3/K5, criteria 4-12): at the bottom centre
 * of a ready board, it takes a change in plain words and hands it to this project's ONE Super
 * chat, naming the board and, as its own chip, the current selection. While the work that
 * message started runs, a pill above the field says so and the page outlines the sent area.
 *
 * Two modes in the one field (task tahta-hizli-duzenle, plan r4 Decisions 1, 2): "Hızlı
 * düzenle" (default) sends the words to the board's quick edit, a server job that draws in a few
 * seconds with one click back; "Super'e sor" hands them to the Super as before. The field shows
 * whatever Super's state: with Super off its segment is disabled and says why. An empty region
 * the owner dragged out rides both modes.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useI18n } from '../../context/I18nContext';
import { BrandMark } from '../brand/BrandMark';
import { msgRef } from '../../lib/superTypes';
import {
  openSuperFromPage, publishFieldMounted, sendFromPage, startTrack, useSuperPresence, workGoing,
  type SuperPageRefusal, type WorkTrack,
} from '../../lib/superPageBridge';
import type { SelectionRef } from './agentDrop';
import {
  composeFieldMessage, fieldKeyAction, fieldLayout, selectionChipText, selectionSendable, settleSave,
  type CanvasBox, type SaveKind,
} from './superFieldLogic';
import {
  QUICK_SCOPE_MAX, addedIds, areaOf, effectiveMode, lineOfJob, readFieldMode, regionChipText, startRefusalKey, writeFieldMode,
  type FieldMode, type QuickJobView, type QuickLine, type Region,
} from './quickEditLogic';
import { useQuickEdit } from '../../hooks/useQuickEdit';
import type { WhiteboardCanvasApi } from './LazyWhiteboardCanvas';
import './BoardSuperField.css';

/** The marks hold this long after the work last read as going (a turn ending, a child starting). */
const WORK_HYSTERESIS_MS = 3000;
/** The gap kept between the field's top and Excalidraw's "Scroll back to content" button. */
const SCROLL_BACK_GAP_PX = 8;

export interface FieldWork {
  box: [number, number, number, number];
}

/** What a quick edit asked, kept so "Super'e sor" can send the same words and area. */
interface LastAsk { words: string; sel: SelectionRef | null; area: Region | null }

const storage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

export function BoardSuperField({ bus, board, boardName, selection, onClearSelection, saveKind, flush, onWork, canvas, region, onClearRegion, canvasApi, onQuickBox }: {
  bus: EventTarget;
  /** The canvas's measured box (the page measures it once for its controls and this field). */
  canvas: CanvasBox | null;
  board: string;
  boardName: string;
  /** The canvas's live selection (null: nothing selected). */
  selection: SelectionRef | null;
  onClearSelection: () => void;
  saveKind: SaveKind;
  flush: () => void;
  /** The area to outline while this field's message is being worked on (null: none). */
  onWork: (work: FieldWork | null) => void;
  /** The empty region the owner dragged out (null: none). */
  region: Region | null;
  onClearRegion: () => void;
  /** The canvas's handle: the quick edit's scope, applying its result, selecting what it added. */
  canvasApi: () => WhiteboardCanvasApi | null;
  /** The box a quick edit is drawing in (it glows), or null. */
  onQuickBox: (box: Region | null) => void;
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
  const onQuickBoxRef = useRef(onQuickBox);
  onQuickBoxRef.current = onQuickBox;

  // ── the mode and the quick edit ──
  const quick = useQuickEdit(board);
  const superOn = !!presence?.on;
  const quickOk = quick.status?.ok !== false;
  const [picked, setPicked] = useState<FieldMode>(() => readFieldMode(storage()));
  const mode = effectiveMode(picked, superOn, quickOk);
  const pick = (m: FieldMode) => { setPicked(m); writeFieldMode(storage(), m); };
  /** Jobs this field started that have not ended (one runs, one may wait on the server). */
  const [runs, setRuns] = useState<{ job: string; startedAt: number }[]>([]);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [line, setLine] = useState<QuickLine | null>(null);
  const [lastAsk, setLastAsk] = useState<LastAsk | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const followers = useRef<{ stopped: boolean }[]>([]);
  useEffect(() => () => { followers.current.forEach((f) => { f.stopped = true; }); onQuickBoxRef.current(null); }, []);
  // "Çiziyor · N sn": a second's tick only while something runs.
  useEffect(() => {
    if (runs.length === 0) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [runs.length]);
  // "Geri al" survives a reload: the board's latest edit not yet undone.
  useEffect(() => {
    let live = true;
    void quick.last().then((edit) => {
      if (live && edit) setLine((cur) => cur ?? { kind: 'done', reply: edit.reply, editId: edit.id, skipped: 0 });
    });
    return () => { live = false; };
  }, [board]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where the field sits: one rule for every canvas width, with the dock window open or not
  // (measured, not a viewport breakpoint: the list and the agents panel change the canvas).
  const layout = fieldLayout(canvas, !!presence?.dockOpen);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Excalidraw's "Scroll back to content" button sits bottom-centre too: the canvas lifts it
  // above the field (`--bsf-clear`, read by BoardSuperField.css), whatever the field's height.
  useEffect(() => {
    const wrap = wrapRef.current;
    const host = wrap?.parentElement;
    if (!wrap || !host) return undefined;
    const read = () => {
      const clear = layout.covered ? 0 : host.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top + SCROLL_BACK_GAP_PX;
      if (clear > 0) host.style.setProperty('--bsf-clear', `${Math.round(clear)}px`);
      else host.style.removeProperty('--bsf-clear');
    };
    read();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(wrap);
    ro?.observe(host);
    return () => { ro?.disconnect(); host.style.removeProperty('--bsf-clear'); };
  }, [layout.covered, layout.bottom, layout.width]);

  // The corner pill steps aside while the field is on screen.
  useEffect(() => {
    publishFieldMounted(bus, true);
    return () => publishFieldMounted(bus, false);
  }, [bus]);

  // "Working": re-read every second, held a moment past the last going read (plan Decision 8).
  useEffect(() => {
    if (!track) { setWorking(false); onWorkRef.current(null); return undefined; }
    let lastGoing = Date.now();
    let reported: boolean | null = null;
    const tick = () => {
      const now = Date.now();
      if (workGoing(track, presenceRef.current, now)) lastGoing = now;
      const shown = now - lastGoing < WORK_HYSTERESIS_MS;
      setWorking(shown);
      // Told only on a change: the page re-renders the canvas wrapper for each new box.
      if (reported !== shown) { reported = shown; onWorkRef.current(shown && track.box ? { box: track.box } : null); }
      if (!shown) setTrack(null);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [track]);
  useEffect(() => () => onWorkRef.current(null), []);

  const refusal = (reason: SuperPageRefusal) => t(`whiteboard.field.${reason}`);

  const sendSuper = useCallback(async (ask?: LastAsk) => {
    if (sendingRef.current) return;
    // Board, selection and region are read at Enter time (or are the quick edit's, re-asked).
    const sent = ask ? ask.words : draft;
    const sel = ask ? ask.sel : selection;
    const area = ask ? ask.area : region;
    const text = composeFieldMessage(sent, board, sel, area);
    if (!text) return;
    const box = area ?? (sel && selectionSendable(sel) ? sel.box : null);
    sendingRef.current = true;
    setSending(true);
    setNote(null);
    try {
      const saved = await settleSave(() => saveRef.current, flush);
      if (saved === 'deleted') { setNote({ text: t('whiteboard.field.deleted'), bad: true }); return; }
      const res = sendFromPage(bus, text);
      if (!res.accepted) { setNote({ text: refusal(res.reason), bad: true }); return; }
      // The field is read-only while a send settles, so the draft is still exactly what went.
      if (!ask) setDraft((cur) => (cur === sent ? '' : cur));
      else setLine(null);
      if (saved === 'unsaved') setNote({ text: t('whiteboard.field.unsaved'), bad: false });
      setTrack({ ...startTrack(msgRef(text), presenceRef.current, Date.now()), box });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [draft, board, selection, region, flush, bus, t]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The quick edit: save first (the identities it sends must be on disk), start, follow, apply. */
  const sendQuick = useCallback(async () => {
    if (sendingRef.current) return;
    const words = draft.trim();
    if (!words) return;
    sendingRef.current = true;
    setSending(true);
    setNote(null);
    let job: string | null = null;
    const area = region;
    const sel = selection;
    const box: Region | null = area ?? (sel ? sel.box : null);
    try {
      const saved = await settleSave(() => saveRef.current, flush);
      if (saved === 'deleted') { setNote({ text: t('whiteboard.field.deleted'), bad: true }); return; }
      const scope = canvasApi()?.quickScope() ?? null;
      if (scope && scope.ids.length > QUICK_SCOPE_MAX) { setNote({ text: t('whiteboard.quick.tooBig'), bad: true }); return; }
      const r = await quick.start({ text: words, scope, area: areaOf(area) });
      if (!r.ok) {
        // Refused in band: nothing started, the words stay in the field.
        setNote({ text: r.code === 'busy' || r.code === 'rate' ? r.message : t(startRefusalKey(r.status, r.code)), bad: true });
        if (r.code === 'no_claude') void quick.refreshStatus();
        return;
      }
      job = r.job;
      setDraft((cur) => (cur.trim() === words ? '' : cur));
      setLastAsk({ words, sel, area });
      setLine(null);
      setRuns((cur) => [...cur, { job: r.job, startedAt: Date.now() }]);
      onQuickBoxRef.current(box);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    if (!job) return;
    const before = canvasApi()?.sceneIds() ?? new Set<string>();
    const signal = { stopped: false };
    followers.current.push(signal);
    const view = await quick.follow(job, () => {}, signal);
    followers.current = followers.current.filter((f) => f !== signal);
    if (signal.stopped) return;
    const left = runsRef.current.filter((x) => x.job !== job);
    setRuns(left);
    if (left.length === 0) onQuickBoxRef.current(null);
    if (!view) { setLine({ kind: 'failed', text: t('whiteboard.quick.failed') }); return; }
    landJob(view, before);
  }, [draft, region, selection, flush, canvasApi, quick, t]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A finished job lands at once (Decision 6): its elements into the scene, what it added
   *  selected (Decision 8), the region cleared when the edit wrote something. */
  const landJob = (view: QuickJobView, before: Set<string>) => {
    const api = canvasApi();
    const written = view.elements ?? [];
    if (view.state === 'done' && written.length > 0 && api) {
      api.applyRemoteElements(written);
      const added = addedIds(written, before);
      if (added.length) api.selectIds(added);
      onClearRegion();
    }
    setLine(lineOfJob(view, t));
  };

  const stopAll = useCallback(async () => {
    for (const r of runsRef.current) void quick.stop(r.job);
  }, [quick]);

  const undo = useCallback(async (editId: string) => {
    const r = await quick.undo(editId);
    if (!r.ok) { setNote({ text: r.message, bad: true }); return; }
    if (r.elements.length) canvasApi()?.applyRemoteElements(r.elements);
    setLine({ kind: 'undone', skipped: r.skipped.length });
  }, [quick, canvasApi]);

  const send = () => (mode === 'quick' ? sendQuick() : sendSuper());

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Keys typed here are the field's: Excalidraw's shortcuts never see them.
    e.stopPropagation();
    const action = fieldKeyAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode });
    if (action === 'send') { e.preventDefault(); if (canSend) void send(); }
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
  // Quick mode sends any live selection (its scope is not the Super wire's 12-id one).
  const showSel = !!selection && (mode === 'quick' ? selection.n > 0 : selectionSendable(selection));
  const typed = draft.trim().length > 0;
  const modeUsable = mode === 'quick' ? quickOk : superOn;
  const canSend = typed && !sending && modeUsable;
  const running = runs.length > 0;
  const runSeconds = running ? Math.max(0, Math.floor((now - runs[0].startedAt) / 1000)) : 0;
  const offReason = !quickOk && !superOn
    ? (quick.status && !quick.status.ok ? quick.status.text : t('whiteboard.quick.noClaude'))
    : null;

  return (
    <div
      ref={wrapRef}
      className="bsf-wrap"
      data-narrow={layout.narrow ? 'true' : undefined}
      data-covered={layout.covered ? 'true' : undefined}
      style={{ left: layout.left, bottom: layout.bottom, width: layout.width }}
    >
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
          {region && (
            <span className="bsf-chip bsf-chip--sel" data-testid="board-quick-region-chip">
              <SelGlyph />
              <span className="bsf-chip-text">{regionChipText(region, t)}</span>
              <button type="button" className="bsf-chip-x" aria-label={t('whiteboard.quick.clearRegion')} title={t('whiteboard.quick.clearRegion')} onClick={onClearRegion}>×</button>
            </span>
          )}
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
          <span className="bsf-chips-spacer" />
          <span className="bsf-modes" role="group" aria-label={t('whiteboard.quick.modes')} data-testid="board-field-modes">
            <button
              type="button"
              className="bsf-mode"
              aria-pressed={mode === 'quick'}
              disabled={!quickOk}
              title={!quickOk && quick.status && !quick.status.ok ? quick.status.text : t('whiteboard.quick.modeQuick')}
              onClick={() => pick('quick')}
              data-testid="board-mode-quick"
            >
              <BoltGlyph />{t('whiteboard.quick.modeQuick')}
            </button>
            <button
              type="button"
              className="bsf-mode"
              aria-pressed={mode === 'super'}
              disabled={!superOn}
              title={superOn ? t('whiteboard.quick.modeSuper') : t('whiteboard.quick.superOff')}
              onClick={() => pick('super')}
              data-testid="board-mode-super"
            >
              <GemGlyph />{superOn ? t('whiteboard.quick.modeSuper') : `${t('whiteboard.quick.modeSuper')} · ${t('whiteboard.quick.superOff')}`}
            </button>
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
            placeholder={mode === 'quick' ? t('whiteboard.quick.placeholder') : t('whiteboard.field.placeholder')}
            aria-label={mode === 'quick' ? t('whiteboard.quick.label') : t('whiteboard.field.label')}
            readOnly={sending}
            onChange={(e) => { setDraft(e.target.value); if (note) setNote(null); }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.stopPropagation()}
            onPaste={(e) => e.stopPropagation()}
          />
          {running && !typed ? (
            <button type="button" className="bsf-btn" onClick={() => void stopAll()} data-testid="board-quick-stop">{t('whiteboard.quick.stop')}</button>
          ) : (
            <button
              type="button"
              className="bsf-send"
              data-ready={canSend ? 'true' : undefined}
              disabled={!canSend}
              aria-label={t('whiteboard.field.send')}
              title={t('whiteboard.field.send')}
              onClick={() => void send()}
            >
              <SendGlyph />
            </button>
          )}
        </div>
        {running && (
          <div className="bsf-line" role="status" data-testid="board-quick-running">
            <span className="bsf-working-dots" aria-hidden><i /><i /><i /></span>
            <span className="bsf-line-text">
              <span className="bsf-line-strong">{t('whiteboard.quick.running')}</span>
              {' · '}{t('whiteboard.quick.seconds').replace('{n}', String(runSeconds))}
              {runs.length > 1 && <>{' · '}{t('whiteboard.quick.queued').replace('{n}', String(runs.length - 1))}</>}
            </span>
            {typed && <button type="button" className="bsf-btn" onClick={() => void stopAll()} data-testid="board-quick-stop">{t('whiteboard.quick.stop')}</button>}
          </div>
        )}
        {!running && line && (
          <QuickLineView
            line={line}
            t={t}
            superOn={superOn}
            onUndo={(id) => void undo(id)}
            onAskSuper={lastAsk ? () => void sendSuper(lastAsk) : null}
          />
        )}
        {offReason && <p className="bsf-note bsf-note--bad" role="status" data-testid="board-quick-off">{offReason}</p>}
        {note && <p className={note.bad ? 'bsf-note bsf-note--bad' : 'bsf-note'} role={note.bad ? 'alert' : 'status'}>{note.text}</p>}
      </div>
    </div>
  );
}

/** The quick edit's last line: what it did and Geri al, or why it wrote nothing and Super'e sor. */
function QuickLineView({ line, t, superOn, onUndo, onAskSuper }: {
  line: QuickLine;
  t: (key: string) => string;
  superOn: boolean;
  onUndo: (editId: string) => void;
  onAskSuper: (() => void) | null;
}) {
  const skippedText = (n: number) => (n === 1 ? t('whiteboard.quick.skippedOne') : t('whiteboard.quick.skipped').replace('{n}', String(n)));
  const ask = onAskSuper && (
    <button
      type="button"
      className="bsf-btn bsf-btn--accent"
      disabled={!superOn}
      title={superOn ? undefined : t('whiteboard.quick.superOff')}
      onClick={onAskSuper}
      data-testid="board-quick-ask-super"
    >
      {t('whiteboard.quick.askSuper')}
    </button>
  );
  if (line.kind === 'done') {
    return (
      <div className="bsf-line" role="status" data-testid="board-quick-done">
        <span className="bsf-line-ok" aria-hidden>✓</span>
        <span className="bsf-line-text">
          {line.reply}
          {line.skipped > 0 && <>{' '}{skippedText(line.skipped)}</>}
        </span>
        {line.editId && <button type="button" className="bsf-btn" onClick={() => onUndo(line.editId as string)} data-testid="board-quick-undo">{t('whiteboard.quick.undo')}</button>}
      </div>
    );
  }
  if (line.kind === 'notBoard' || line.kind === 'outOfScope') {
    return (
      <div className="bsf-line" role="status" data-testid={line.kind === 'notBoard' ? 'board-quick-notboard' : 'board-quick-outofscope'}>
        <span className="bsf-line-text">{line.reply}</span>
        {ask}
      </div>
    );
  }
  if (line.kind === 'undone') {
    return (
      <div className="bsf-line" role="status" data-testid="board-quick-undone">
        <span className="bsf-line-ok" aria-hidden>✓</span>
        <span className="bsf-line-text">
          {t('whiteboard.quick.undone')}
          {line.skipped > 0 && <>{' '}{skippedText(line.skipped)}</>}
        </span>
      </div>
    );
  }
  if (line.kind === 'stopped') {
    return <div className="bsf-line" role="status" data-testid="board-quick-stopped"><span className="bsf-line-text">{t('whiteboard.quick.stopped')}</span></div>;
  }
  if (line.kind === 'failed') {
    return (
      <div className="bsf-line bsf-line--bad" role="alert" data-testid="board-quick-failed">
        <span className="bsf-line-text">{line.text}</span>
        {ask}
      </div>
    );
  }
  return null;
}

function BoltGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M9.2 1.5 3 9h4.3l-.9 5.5L13 7H8.6l.6-5.5Z" />
    </svg>
  );
}

function GemGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1.5 13 6.5 8 14.5 3 6.5Z" />
    </svg>
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
