import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiClient } from '../../api/client';
import { useApi } from '../../context/VaultContext';
import { Sheet, useShareT } from '../apps/Sheet';
import { Toggle } from '../settings/SettingRow';
import { copyPreservingUnicode } from '../../lib/clipboard';
import { closeLiveShare, openLiveShare, revealLiveShare, useLiveShares, useRefreshShares, type ShareKind } from '../../lib/sharesApi';
import { errorKey, passwordOk, sheetPhase, shareFor, stageStep, suggestPassword, PASSWORD_MIN } from './shareSheetModel';
import './ShareSheet.css';

/**
 * The live-link sheet (tunel-paylasim, approved drawing rapor.html section 2): before opening
 * (what the guest can do, the AI switch for an app with an agent, the optional password), while
 * starting (the stage, never a link that does not answer yet), open (link, password, Kopyala,
 * who is connected, Linki kapat) and failed (the reason, Tekrar dene).
 */
export interface ShareSheetProps {
  kind: ShareKind;
  vault: string;
  slug: string;
  name: string;
  onClose: () => void;
  /** app: the settings the app reads with the owner's keys (its store's `settings` line), if any. */
  settingsLine?: string | null;
  /** app: the agent its questions reach (shows the AI switch), or null. */
  agent?: string | null;
  /** app: stopped by the owner (no link until it runs again). */
  stopped?: boolean;
  /** A link being opened again (the pill's Yeniden aç): its AI and password choices seed the form. */
  prior?: { ai: boolean; password: boolean };
}

interface AppFacts { agent: string | null; settingsLine: string | null; stopped: boolean; loading: boolean }

/**
 * app: what the form says about the app (its agent, the keys line, stopped). Taken from the
 * caller when it passed them (the app page); otherwise read from the app itself by vault and slug,
 * so a form opened from anywhere (the pill) never shows less than the app page's form does.
 * Same query keys as the Apps page and the app page: one cache.
 */
function useAppFacts(kind: ShareKind, vault: string, slug: string, given: Pick<ShareSheetProps, 'agent' | 'settingsLine' | 'stopped'>): AppFacts {
  const vapi = useMemo(() => new ApiClient(vault), [vault]);
  const needRow = kind === 'app' && (given.agent === undefined || given.stopped === undefined);
  const needStore = kind === 'app' && given.settingsLine === undefined;
  const apps = useQuery({
    queryKey: ['apps', vault],
    queryFn: () => vapi.get<{ apps: Array<{ slug: string; agent?: string | null; stoppedByOwner?: boolean }> }>('/apps'),
    enabled: needRow,
    staleTime: 3000,
  });
  const store = useQuery({
    queryKey: ['app-store', vault, slug],
    queryFn: () => vapi.get<{ can?: Array<{ kind: string; text: string }> }>(`/apps/${encodeURIComponent(slug)}/store`),
    enabled: needStore,
    staleTime: 10_000,
  });
  const row = apps.data?.apps.find((a) => a.slug === slug);
  return {
    agent: given.agent !== undefined ? given.agent : (row?.agent ?? null),
    stopped: given.stopped !== undefined ? given.stopped : !!row?.stoppedByOwner,
    settingsLine: given.settingsLine !== undefined ? given.settingsLine : (store.data?.can?.find((c) => c.kind === 'settings')?.text ?? null),
    loading: (needRow && apps.isPending) || (needStore && store.isPending),
  };
}

export function ShareSheet({ kind, vault, slug, name, onClose, prior, ...given }: ShareSheetProps) {
  const api = useApi();
  const t = useShareT();
  const refresh = useRefreshShares();
  const rows = useLiveShares();
  const share = shareFor(rows.data, kind, vault, slug);
  const phase = sheetPhase(share);
  const facts = useAppFacts(kind, vault, slug, given);
  const { agent, settingsLine, stopped } = facts;

  // The AI choice starts from the link being opened again (a broken row, or the pill's prior),
  // never silently off; the owner's own flip wins.
  const [aiPick, setAi] = useState<boolean | null>(null);
  const ai = aiPick ?? !!(prior?.ai ?? (share?.state === 'broken' ? share.ai : false));
  const [pwOn, setPwOn] = useState(!!prior?.password);
  const [pw, setPw] = useState(() => suggestPassword());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: string; link: string; password?: string } | null>(null);
  const [copied, setCopied] = useState<'link' | 'pw' | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  // The link and password are read back once per open share, by the owner's own page (D8).
  const shareId = phase === 'open' ? share!.id : null;
  useEffect(() => {
    if (!shareId || secret?.id === shareId) return;
    let live = true;
    revealLiveShare(api, shareId)
      .then((r) => { if (live) setSecret({ id: shareId, ...r }); })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [api, shareId, secret?.id]);

  const start = async () => {
    if (busy) return;
    if (pwOn && !passwordOk(pw)) { setErr(t('liveShare.password.short', { n: String(PASSWORD_MIN) })); return; }
    setBusy(true); setErr(null);
    try {
      await openLiveShare(api, { kind, vault, slug, password: pwOn ? pw : null, ai: kind === 'app' && !!agent && ai });
      refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const close = async (then?: () => void) => {
    if (!share || busy) return;
    setBusy(true); setErr(null);
    try { await closeLiveShare(api, share.id); setSecret(null); refresh(); then?.(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  /** A failed start: drop it and start again with the sheet's settings. A failed link that had a
   *  password this sheet never saw (opened elsewhere) goes back to the form, never opens without one. */
  const retry = async () => {
    if (!share || busy) return;
    const hadPassword = share.password;
    setBusy(true); setErr(null);
    try {
      await closeLiveShare(api, share.id);
      if (hadPassword && !pwOn) { setPwOn(true); refresh(); return; }
      await openLiveShare(api, { kind, vault, slug, password: pwOn ? pw : null, ai: kind === 'app' && !!agent && ai });
      refresh();
    } catch (e) { setErr((e as Error).message); refresh(); } finally { setBusy(false); }
  };
  const copy = async (what: 'link' | 'pw', text: string) => {
    if (await copyPreservingUnicode(text)) {
      setCopied(what);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1600);
    } else setErr(t('liveShare.copyFailed'));
  };

  const title = t(phase === 'open' ? 'liveShare.titleOpen' : 'liveShare.title', { name });
  const errLine = err && <p className="live-share__err" role="alert">{err}</p>;

  let body: ReactNode;
  let foot: ReactNode;
  if (phase === 'form') {
    body = (
      <>
        <p className="live-share__sub">{t(kind === 'app' ? 'liveShare.sub.app' : 'liveShare.sub.board')}</p>
        {kind === 'app' && (
          <>
            <div className="live-share__lbl">{t('liveShare.can')}</div>
            <ul className="live-share__list live-share__list--yes">
              <li>{t('liveShare.can.use')}</li>
              <li>{t('liveShare.can.data')}</li>
              {settingsLine && <li>{t('liveShare.can.keys', { what: settingsLine })}</li>}
            </ul>
          </>
        )}
        <div className="live-share__lbl">{t('liveShare.never')}</div>
        <ul className="live-share__list live-share__list--no">
          <li>{t('liveShare.never.brain')}</li>
          <li>{t('liveShare.never.files')}</li>
        </ul>
        {kind === 'app' && agent && (
          <div className="live-share__switch">
            <span>
              {t('liveShare.ai')}
              <span className="live-share__hint">{t('liveShare.ai.hint')}</span>
              {ai && <span className="live-share__warn" role="note">{t('liveShare.ai.warn', { agent })}</span>}
            </span>
            <Toggle checked={ai} onChange={setAi} label={t('liveShare.ai')} />
          </div>
        )}
        <div className="live-share__switch">
          <span>{t('liveShare.password')}</span>
          <Toggle checked={pwOn} onChange={(on) => { setPwOn(on); setErr(null); }} label={t('liveShare.password')} />
        </div>
        {pwOn && (
          <>
            <label className="live-share__lbl" htmlFor="live-share-pw">{t('liveShare.password.label', { n: String(PASSWORD_MIN) })}</label>
            <div className="live-share__field">
              <input id="live-share-pw" className="live-share__input" value={pw} spellCheck={false} autoComplete="off" onChange={(e) => setPw(e.target.value)} />
              <button type="button" className="app-card__stop" onClick={() => setPw(suggestPassword())}>{t('liveShare.password.new')}</button>
            </div>
            <p className="live-share__hint">{t('liveShare.password.note')}</p>
          </>
        )}
        {stopped && <p className="live-share__hint" role="note">{t('liveShare.stopped')}</p>}
        {errLine}
      </>
    );
    foot = (
      <>
        <button type="button" className="app-card__stop" onClick={onClose}>{t('liveShare.cancel')}</button>
        <button type="button" className="app-card__launch" disabled={busy || !!stopped || facts.loading} onClick={() => void start()}>{t('liveShare.open')}</button>
      </>
    );
  } else if (phase === 'starting') {
    body = (
      <>
        <p className="live-share__sub" role="status"><span className="live-share__spin" aria-hidden="true" />{t(`liveShare.stage.${share!.stage ?? 'download'}`, { n: String(stageStep(share!.stage)) })}</p>
        <p className="live-share__hint">{t('liveShare.starting.note')}</p>
        {errLine}
      </>
    );
    foot = (
      <>
        <button type="button" className="app-card__stop" disabled={busy} onClick={() => void close()}>{t('liveShare.cancel')}</button>
        <button type="button" className="app-card__launch" disabled>{t('liveShare.open')}</button>
      </>
    );
  } else if (phase === 'open') {
    body = (
      <>
        <p className="live-share__sub">{t('liveShare.open.sub')}</p>
        <label className="live-share__lbl" htmlFor="live-share-link">{t('liveShare.link')}</label>
        <div className="live-share__field">
          <input id="live-share-link" className="live-share__input" readOnly value={secret?.link ?? ''} placeholder="…" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="app-card__launch" disabled={!secret} onClick={() => secret && void copy('link', secret.link)}>{copied === 'link' ? t('liveShare.copied') : t('liveShare.copy')}</button>
        </div>
        {share!.password && (
          <>
            <label className="live-share__lbl" htmlFor="live-share-pass">{t('liveShare.passwordShort')}</label>
            <div className="live-share__field">
              <input id="live-share-pass" className="live-share__input" readOnly value={secret?.password ?? ''} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="app-card__stop" disabled={!secret?.password} onClick={() => secret?.password && void copy('pw', secret.password)}>{copied === 'pw' ? t('liveShare.copied') : t('liveShare.copy')}</button>
            </div>
          </>
        )}
        <p className="live-share__hint">{t('liveShare.lid')}</p>
        {errLine}
      </>
    );
    foot = (
      <>
        <span className="live-share__live"><span className="live-share__dot" aria-hidden="true" />{share!.people === 0 ? t('liveShare.people.none') : t('liveShare.people.now', { n: String(share!.people) })}</span>
        <span className="live-share__grow" />
        <button type="button" className="app-card__stop" disabled={busy} onClick={() => void close()}>{t('liveShare.closeLink')}</button>
      </>
    );
  } else {
    body = (
      <>
        <p className="live-share__err" role="alert">{t(errorKey(share!.error))}</p>
        {err && <p className="live-share__err">{err}</p>}
      </>
    );
    foot = (
      <>
        <button type="button" className="app-card__stop" disabled={busy} onClick={() => void close(onClose)}>{t('liveShare.dismiss')}</button>
        <button type="button" className="app-card__launch" disabled={busy} onClick={() => void retry()}>{t('liveShare.retry')}</button>
      </>
    );
  }

  return (
    <Sheet title={title} onClose={onClose} foot={foot}>
      <div className="live-share">{body}</div>
    </Sheet>
  );
}

/** "Canlı link" beside an app's Open/Stop/Share or on a board's top row; "● Canlı link açık" while one is live. */
export function LiveShareButton(props: Omit<ShareSheetProps, 'onClose'> & { className?: string }) {
  const t = useShareT();
  const rows = useLiveShares();
  const [open, setOpen] = useState(false);
  const share = shareFor(rows.data, props.kind, props.vault, props.slug);
  const live = !!share && share.state === 'open';
  return (
    <>
      <button type="button" className={`${props.className ?? 'app-card__stop'} live-share-btn`} data-live={live ? 'true' : undefined} onClick={() => setOpen(true)} data-testid={`live-share-${props.kind}`}>
        {live && <span className="live-share__dot" aria-hidden="true" />}
        {t(live ? 'liveShare.buttonOn' : 'liveShare.button')}
      </button>
      {open && <ShareSheet {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
