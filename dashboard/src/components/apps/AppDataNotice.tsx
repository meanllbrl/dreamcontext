import { useId, useState } from 'react';
import { useApi, useVault, emitInstance } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useShareT, useShareN } from './Sheet';
import { askAgent } from './askAgent';

/**
 * The owner's side of an app's team data (app-veri-ortak r6, K9). The hand-made data
 * (emekle üretilmiş veri) a team makes in an app can be shared with everyone on this brain;
 * re-fetchable cache, personal and secret data stay on this Mac. The agent that builds the app
 * writes which is which in its manifest; the owner approves it once, HERE, on dreamcontext's own
 * Apps page and never in the app's own screen (the app draws that one and could fake a yes).
 *
 * Where each state lives:
 *  - above the shelves (`AppDataNotices`): only the one-time approval notice(s) and a pull that is
 *    landing, both temporary. The first notice holds the page's one filled button.
 *  - on each app's tile (`AppDataTileLine`): "not decided yet", with "Agent'a belirlet" for an own
 *    app (an installed app's manifest is its publisher's: no button).
 *  - on the app's own page (`AppDataLine`): where its data stands now, counts only.
 * The pull state is ONE piece (`PullState`), the same full sentence and commands everywhere.
 */

/** `data` of one app in `GET /api/apps` (src/server/routes/apps.ts `appDataField`). */
export interface AppDataView {
  mode: 'shared' | 'local' | 'undecided' | 'pending' | 'sync_off' | 'error' | string;
  /** false = no `data` field (undecided); null = the server could not read it (nothing to act on). */
  declared: boolean | null;
  sharedCount: number;
  sharedBytes: number;
  held: Partial<Record<string, number>>;
  missing: number;
  conflicts: number;
  pendingPaths: Array<{ path: string; why: string; files: number; bytes: number }>;
  sharedPaths: Array<{ path: string; why: string; files: number; bytes: number; state: string }>;
  localPaths: Array<{ path: string; why: string }>;
  declined: boolean;
  remote: { name: string; public: boolean | null } | null;
  syncOff: boolean;
  pull: 'none' | 'landing' | 'waiting_merge' | 'user_merge' | string;
}

interface DataApp { slug: string; name: string; origin?: 'own' | 'installed'; data?: AppDataView }

/** A size in the reader's own number format (a Turkish decimal comma). */
export function formatBytes(n: number, locale: string): string {
  const f = (v: number, digits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  if (n < 1024) return `${f(n, 0)} B`;
  if (n < 1024 * 1024) return `${f(Math.round(n / 1024), 0)} KB`;
  return `${f(n / 1024 / 1024, 1)} MB`;
}

const heldTotal = (d: AppDataView) => Object.values(d.held ?? {}).reduce<number>((s, v) => s + (v ?? 0), 0);

/** Wrap a path anywhere: a long one never runs out of a 390 px card. */
const WRAP = { overflowWrap: 'anywhere' as const, minWidth: 0 };

/**
 * A team pull of this app, in full: landing, waiting for the team merge, or held by the owner's
 * own git merge, then with the commands that finish it. The only place these words are drawn.
 */
export function PullState({ pull }: { pull: AppDataView['pull'] }) {
  const t = useShareT();
  if (pull === 'landing') return <>{t('apps.data.pull.landing')}</>;
  if (pull === 'waiting_merge') return <>{t('apps.data.pull.waiting')}</>;
  if (pull === 'user_merge') {
    return (
      <>
        {t('apps.data.pull.user')} <code>/dream-sync</code> {t('apps.data.pull.or')} <code>git merge --continue</code> / <code>git merge --abort</code>.
      </>
    );
  }
  return null;
}

/** The first notice: what the team will see, what stays here, where it goes; two buttons. */
function ApprovalNotice({ app, primary, onChanged }: { app: DataApp; primary: boolean; onChanged: () => void }) {
  const api = useApi();
  const { bus } = useVault();
  const { locale } = useI18n();
  const t = useShareT();
  const tn = useShareN();
  const titleId = useId();
  const d = app.data!;
  // Unticked = excluded: that part stays on this Mac, and the agent cannot open it again.
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await api.ownerPost(`/apps/${encodeURIComponent(app.slug)}/data-share`, body); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const paths = d.pendingPaths.map((p) => p.path);
  const approve = paths.filter((p) => !off.has(p));
  const exclude = paths.filter((p) => off.has(p));
  const toggle = (p: string, on: boolean) => setOff((cur) => { const next = new Set(cur); if (on) next.delete(p); else next.add(p); return next; });
  return (
    <section className="app-card" aria-labelledby={titleId}>
      <h2 id={titleId} className="app-card__list-name" style={WRAP}>{t('apps.data.notice.title', { name: app.name })}</h2>
      <div>
        <h3 className="app-card__state">{t('apps.data.notice.team')}</h3>
        <ul className="app-card__list">
          {d.pendingPaths.map((p) => (
            <li key={p.path}>
              <label className="share-link--check" style={WRAP}>
                <input type="checkbox" checked={!off.has(p.path)} disabled={busy || d.syncOff} onChange={(e) => toggle(p.path, e.target.checked)} />
                <span className="app-card__list-name" style={WRAP}>{p.path}</span>
                <span className="app-card__list-meta">{tn('apps.data.files', p.files)} · {formatBytes(p.bytes, locale)}</span>
              </label>
              <span className="app-card__list-meta">{t('apps.data.notice.why', { why: p.why })}</span>
            </li>
          ))}
        </ul>
        <p className="app-card__list-meta">{t('apps.data.notice.untick')}</p>
      </div>
      {d.localPaths.length > 0 && (
        <div>
          <h3 className="app-card__state">{t('apps.data.notice.local')}</h3>
          <ul className="app-card__list">
            {d.localPaths.map((p) => (
              <li key={p.path}>
                <span className="app-card__list-name" style={WRAP}>{p.path}</span>
                <span className="app-card__list-meta">{p.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="app-card__list-meta">
        {d.remote ? t('apps.data.notice.where', { repo: d.remote.name }) : t('apps.data.notice.whereNone')}
        {d.remote?.public === true && <> <span className="app-chip app-chip--warn">{t('apps.data.notice.public')}</span></>}
      </p>
      {d.syncOff ? (
        <div className="app-card__note app-card__note--warn app-card__mcp">
          <span>{t('apps.data.syncOff')}</span>
          <button type="button" className="app-card__stop" onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: 'brain' })}>{t('apps.data.openSettings')}</button>
        </div>
      ) : (
        <div className="app-card__foot">
          {/* Every part unticked shares nothing: the button that says it shares is off then. */}
          <button type="button" className={primary ? 'app-card__launch' : 'app-card__stop'} disabled={busy || approve.length === 0} onClick={() => void send({ approve, ...(exclude.length ? { exclude } : {}) })}>{t('apps.data.share')}</button>
          <button type="button" className="app-card__stop" disabled={busy} onClick={() => void send({ decline: true })}>{t('apps.data.keepLocal')}</button>
        </div>
      )}
      {err && <p className="app-card__note app-card__note--bad" role="alert">{err}</p>}
    </section>
  );
}

/**
 * Above the shelves: a pull landing (temporary) and the first notice of an app awaiting the owner
 * (one-time). Never one row per undecided app: that lives on its tile.
 */
export function AppDataNotices({ apps, onChanged }: { apps: DataApp[]; onChanged: () => void }) {
  const pulls = apps.filter((a) => a.data && a.data.pull !== 'none');
  const asks = apps.filter((a) => a.data && a.data.declared === true && a.data.pendingPaths.length > 0 && a.data.pull === 'none');
  if (!pulls.length && !asks.length) return null;
  return (
    <div className="apps-setup">
      {pulls.map((a) => (
        <div key={`p:${a.slug}`} className="apps-setup__row" role="status">
          <span style={WRAP}><strong>{a.name}</strong> · <PullState pull={a.data!.pull} /></span>
        </div>
      ))}
      {asks.map((a, i) => <ApprovalNotice key={`n:${a.slug}`} app={a} primary={i === 0} onChanged={onChanged} />)}
    </div>
  );
}

/** The tile's short line while the app's data is undecided. Nothing otherwise. */
export function AppDataTileLine({ app, canLaunch }: { app: DataApp; canLaunch: boolean }) {
  const t = useShareT();
  const { bus } = useVault();
  const d = app.data;
  if (!d || d.declared !== false) return null;
  const installed = app.origin === 'installed';
  return (
    <p className="app-tile__sub">
      {installed ? t('apps.data.undecidedInstalled') : t('apps.data.undecided')}
      {!installed && canLaunch && (
        <> · <button type="button" className="share-link" onClick={() => askAgent(bus, t('apps.data.askText', { name: app.name }))}>{t('apps.data.askAgent')}</button></>
      )}
    </p>
  );
}

/** The app's own page: where its data stands now, counts only. */
export function AppDataLine({ app, canLaunch, onChanged }: { app: DataApp; canLaunch: boolean; onChanged: () => void }) {
  const api = useApi();
  const { bus } = useVault();
  const { locale } = useI18n();
  const t = useShareT();
  const tn = useShareN();
  const [err, setErr] = useState<string | null>(null);
  const d = app.data;
  // Unread (a server read failure): nothing to act on, nothing said that could be wrong.
  if (!d || d.declared === null) return null;
  if (d.declared === false) {
    const installed = app.origin === 'installed';
    return (
      <div className="app-card__note app-card__note--warn app-card__mcp">
        <span>{installed ? t('apps.data.undecidedInstalled') : t('apps.data.undecided')}</span>
        {!installed && canLaunch && <button type="button" className="app-card__stop" onClick={() => askAgent(bus, t('apps.data.askText', { name: app.name }))}>{t('apps.data.askAgent')}</button>}
      </div>
    );
  }
  const extra = [
    heldTotal(d) > 0 ? tn('apps.data.held', heldTotal(d)) : '',
    d.missing > 0 ? tn('apps.data.missing', d.missing) : '',
    d.conflicts > 0 ? tn('apps.data.conflicts', d.conflicts) : '',
  ].filter(Boolean);
  const askAgain = async () => {
    setErr(null);
    try { await api.ownerPost(`/apps/${encodeURIComponent(app.slug)}/data-share`, { decline: false }); onChanged(); } catch (e) { setErr((e as Error).message); }
  };
  const head = d.mode === 'shared'
    ? t('apps.data.sharedLine', { files: tn('apps.data.files', d.sharedCount), size: formatBytes(d.sharedBytes, locale) })
    : d.syncOff ? t('apps.data.syncOff')
      : d.mode === 'pending' ? t('apps.data.pendingLine')
        : t('apps.data.localLine');
  return (
    <>
      <p className="app-card__note app-card__note--warn">
        {head}
        {extra.length > 0 && ` · ${extra.join(' · ')}`}
      </p>
      {d.pull !== 'none' && <p className="app-card__note app-card__note--warn" role="status" style={WRAP}><PullState pull={d.pull} /></p>}
      {d.declined && canLaunch && (
        <div className="app-card__mcp">
          <span className="app-card__list-meta">{t('apps.data.declined')}</span>
          <button type="button" className="share-link" onClick={() => void askAgain()}>{t('apps.data.askAgain')}</button>
        </div>
      )}
      {err && <p className="app-card__note app-card__note--bad" role="alert">{err}</p>}
    </>
  );
}
