import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../../context/VaultContext';
import { useShareT } from '../apps/Sheet';
import { copyPreservingUnicode } from '../../lib/clipboard';
import { closeAllLiveShares, closeLiveShare, revealLiveShare, useLiveShares, useRefreshShares, type LiveShare } from '../../lib/sharesApi';
import { minutesOpen, pillState, stageStep } from './shareSheetModel';
import { ShareSheet } from './ShareSheet';
import './ShareSheet.css';

/**
 * Open live links, always in sight (tunel-paylasim, rapor.html section 4): a pill at the foot of
 * the sidebar (or a row on the new shell's rail) while any link is starting, open or broken; its
 * list names each with who is connected and whether it has a password, and Kopyala, Kapat and
 * Hepsini kapat work from there. No link: nothing is drawn.
 *
 * Every shell that draws it gets a face that fits: the text pill in the open sidebar; the glyph
 * and dot (name in aria-label and data-tip) on the new shell's rail and in the collapsed sidebar.
 */
export function LiveSharesPill({ variant, collapsed = false }: { variant: 'sidebar' | 'rail'; collapsed?: boolean }) {
  const t = useShareT();
  const rows = useLiveShares();
  const pill = pillState(rows.data);
  const [open, setOpen] = useState(false);
  const [again, setAgain] = useState<LiveShare | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { if (!pill) setOpen(false); }, [pill]);

  if (!pill && !again) return null;
  const label = pill ? t(pill.count === 1 ? 'liveShare.pill.one' : 'liveShare.pill.other', { n: String(pill.count) }) : '';
  const glyphFace = variant === 'rail' || collapsed;
  return (
    <>
      {pill && (!glyphFace ? (
        <button ref={btn} type="button" className="live-pill" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} data-testid="live-shares-pill">
          <span className={`live-share__dot${pill.bad ? ' live-share__dot--bad' : ''}`} aria-hidden="true" />
          {label}
        </button>
      ) : (
        <button ref={btn} type="button" className={variant === 'rail' ? 'ns-rail-btn live-rail' : 'live-pill live-pill--glyph live-rail'} aria-expanded={open} aria-haspopup="dialog" aria-label={label} data-tip={label} onClick={() => setOpen((o) => !o)} data-testid="live-shares-pill">
          <LinkGlyph />
          <span className={`live-share__dot${pill.bad ? ' live-share__dot--bad' : ''}`} aria-hidden="true" />
        </button>
      ))}
      {open && pill && <SharesPopover anchor={btn.current} side={glyphFace ? 'right' : 'above'} rows={rows.data ?? []} onClose={() => setOpen(false)} onAgain={(s) => { setOpen(false); setAgain(s); }} />}
      {again && <ShareSheet kind={again.kind} vault={again.vault} slug={again.slug} name={again.name} prior={{ ai: again.ai, password: again.password }} onClose={() => setAgain(null)} />}
    </>
  );
}

function SharesPopover({ anchor, side, rows, onClose, onAgain }: { anchor: HTMLElement | null; side: 'above' | 'right'; rows: LiveShare[]; onClose: () => void; onAgain: (s: LiveShare) => void }) {
  const t = useShareT();
  const api = useApi();
  const refresh = useRefreshShares();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; bad?: boolean } | null>(null);

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    if (!r) return;
    setPos(side === 'right'
      ? { left: r.right + 8, bottom: Math.max(16, window.innerHeight - r.bottom) }
      : { left: Math.max(16, r.left), bottom: window.innerHeight - r.top + 8 });
  }, [anchor, side]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (ref.current?.contains(n) || anchor?.contains(n)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  }, [anchor, onClose]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(id); setNote(null);
    try { await fn(); } catch (e) { setNote({ id, text: (e as Error).message, bad: true }); } finally { setBusy(null); refresh(); }
  };
  const copy = (s: LiveShare) => act(s.id, async () => {
    const r = await revealLiveShare(api, s.id);
    const ok = await copyPreservingUnicode(r.link);
    setNote({ id: s.id, text: t(ok ? 'liveShare.copied' : 'liveShare.copyFailed'), bad: !ok });
  });

  const now = Date.now();
  const live = rows.filter((s) => s.state !== 'closing');
  return createPortal(
    <div ref={ref} className="live-pop" role="dialog" aria-label={t('liveShare.pop.title')} style={pos}>
      <h3>{t('liveShare.pop.title')}</h3>
      {live.map((s) => {
        const kind = t(s.kind === 'app' ? 'liveShare.kind.app' : 'liveShare.kind.board');
        const mins = minutesOpen(s.openedAt, now);
        return (
          <div key={s.id} className="live-pop__row">
            <span className="live-pop__name">{s.name} · {kind}</span>
            <span className="live-pop__meta">
              {s.state === 'broken' ? (
                <span className="live-share__live"><span className="live-share__dot live-share__dot--bad" aria-hidden="true" />{t('liveShare.pop.broken')}</span>
              ) : s.state === 'starting' ? (
                <>
                  <span className="live-share__live"><span className="live-share__spin" aria-hidden="true" />{t(`liveShare.stage.${s.stage ?? 'download'}`, { n: String(stageStep(s.stage)) })}</span>
                  <span>· {t(s.password ? 'liveShare.pop.withPw' : 'liveShare.pop.noPw')}</span>
                </>
              ) : (
                <>
                  {s.people > 0
                    ? <span className="live-share__live"><span className="live-share__dot" aria-hidden="true" />{t('liveShare.people.n', { n: String(s.people) })}</span>
                    : <span>{t('liveShare.people.none')}</span>}
                  <span>· {t(s.password ? 'liveShare.pop.withPw' : 'liveShare.pop.noPw')}</span>
                  <span>· {mins === 0 ? t('liveShare.pop.justNow') : t('liveShare.pop.age', { n: String(mins) })}</span>
                </>
              )}
              {note?.id === s.id && <span className={note.bad ? 'live-share__warn' : undefined} role="status">{note.text}</span>}
            </span>
            <span className="live-pop__acts">
              {s.state === 'broken' ? (
                <>
                  <button type="button" className="app-card__launch" disabled={busy !== null} onClick={() => void act(s.id, async () => { await closeLiveShare(api, s.id); onAgain(s); })}>{t('liveShare.pop.again')}</button>
                  <button type="button" className="app-card__stop" disabled={busy !== null} onClick={() => void act(s.id, () => closeLiveShare(api, s.id))}>{t('liveShare.pop.remove')}</button>
                </>
              ) : (
                <>
                  {s.state === 'open' && <button type="button" className="app-card__stop" disabled={busy !== null} onClick={() => void copy(s)}>{t('liveShare.copy')}</button>}
                  <button type="button" className="app-card__stop" disabled={busy !== null} onClick={() => void act(s.id, () => closeLiveShare(api, s.id))}>{t('liveShare.close')}</button>
                </>
              )}
            </span>
          </div>
        );
      })}
      <div className="live-pop__foot">
        <span className="live-share__hint">{t('liveShare.pop.foot')}</span>
        <button type="button" className="app-card__stop" disabled={busy !== null} onClick={() => void act('all', () => closeAllLiveShares(api))}>{t('liveShare.pop.closeAll')}</button>
      </div>
    </div>,
    document.body,
  );
}

function LinkGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </svg>
  );
}
