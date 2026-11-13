import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { AppIcon } from './AppIcon';
import { errText, useShareT } from './Sheet';

// ─── Shared Apps ────────────────────────────────────────────────────────────────────

export interface SharedInvitation {
  id: string; fullName: string; repoId: string; inviter: string;
  /** S2: someone this account works with (the brain repo, apps installed from shares, people I invited). */
  known: boolean;
  /** The readable name ("Toplanti Notu"), until the manifest can be read after acceptance. */
  title: string;
}

export interface SharedList {
  signedIn: boolean; login: string | null; host: string; problem?: string;
  invitations: SharedInvitation[];
  shared: Array<{ fullName: string; owner: string; name: string | null; tagline?: string | null; public: boolean; installed?: string }>;
}

/** An installed app as the store row needs it: its icon, and whether an update waits. */
export interface InstalledLook { slug: string; name: string; icon: string | null; update: boolean }

/**
 * The Shared Apps tab (app-paylasim-magaza r2 section 2; app-ux-genel K1, K2, S2): invitations on
 * top, each with its readable name, who shared it and ONE Kur (it accepts the invitation and opens
 * the install page); an invitation from a GitHub account this account does not work with sits
 * apart and says so. Then every app shared with this account: Get, Open, or Update.
 */
export function SharedApps({ list, err, loading, installedLook, installing, onRefresh, onInstall, onOpen, onAccepted, onSignIn }: {
  list: SharedList | null; err: string | null; loading: boolean;
  installedLook: (slug: string) => InstalledLook | null;
  /** The server's in-flight installs (K8): the row says "Installing…" while one runs. */
  installing: (fullName: string) => boolean;
  onRefresh: () => void; onInstall: (fullName: string) => void; onOpen: (slug: string) => void; onAccepted: () => void; onSignIn: () => void;
}) {
  const api = useApi();
  const t = useShareT();
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptErr, setAcceptErr] = useState<string | null>(null);
  // Kur on an invitation is the owner's click (K2): accept exactly it, then the install page.
  const kur = async (i: SharedInvitation) => {
    if (accepting) return;
    setAccepting(i.id); setAcceptErr(null);
    try { await api.ownerPost('/apps/shared/accept', { id: i.id }); onAccepted(); onInstall(i.fullName); } catch (e) { setAcceptErr(errText(e)); } finally { setAccepting(null); }
  };
  const repoName = (fullName: string) => fullName.split('/').pop() ?? fullName;
  const known = list?.invitations.filter((i) => i.known) ?? [];
  const unknown = list?.invitations.filter((i) => !i.known) ?? [];
  const invRow = (i: SharedInvitation) => {
    const busy = accepting === i.id || installing(i.fullName);
    return (
      <li key={i.id} className="store-row">
        <AppIcon src={null} name={i.title} slug={repoName(i.fullName).replace(/-app$/, '')} size={64} />
        <div className="store-row__t">
          <p className="store-row__nm">{i.title}</p>
          <p className="store-row__by">{i.known ? t('share.shared.invited', { who: i.inviter }) : t('store.inv.unknown', { who: i.inviter })}</p>
        </div>
        <button type="button" className={i.known ? 'app-tile__btn app-tile__btn--primary' : 'app-tile__btn'} disabled={accepting !== null || busy} onClick={() => void kur(i)}>
          {busy ? t('store.inv.installing') : t('share.install.go')}
        </button>
      </li>
    );
  };
  return (
    <div className="apps-store">
      {loading && !list && <p className="apps-page__muted">{t('share.checking')}</p>}
      {(err || acceptErr) && <p className="app-card__note app-card__note--bad">{acceptErr ?? err}</p>}
      {list && !list.signedIn && (
        <p className="apps-page__muted">
          {t('share.shared.signIn')}{' '}
          <button type="button" className="share-link" onClick={onSignIn}>{t('share.install.signIn')}</button>
        </p>
      )}
      {list?.problem && <p className="app-card__note app-card__note--warn">{list.problem}</p>}
      {known.length > 0 && (
        <section className="apps-shelf" aria-labelledby="apps-inv-h">
          <div className="apps-shelf__head"><h2 id="apps-inv-h">{t('store.invitations')}</h2></div>
          <ul className="store-list">{known.map(invRow)}</ul>
        </section>
      )}
      {list?.signedIn && (
        <section className="apps-shelf" aria-labelledby="apps-shared-h">
          <div className="apps-shelf__head">
            <h2 id="apps-shared-h">{t('share.shared.title')}</h2>
            <button type="button" className="share-link" onClick={onRefresh}>{t('share.shared.refresh')}</button>
          </div>
          {!list.shared.length && !list.invitations.length && <p className="apps-page__muted">{t('share.shared.empty')}</p>}
          {list.shared.length > 0 && (
            <ul className="store-list">
              {list.shared.map((s) => {
                const look = s.installed ? installedLook(s.installed) : null;
                const name = look?.name ?? s.name ?? repoName(s.fullName);
                const open = () => (s.installed ? onOpen(s.installed) : onInstall(s.fullName));
                const busy = !s.installed && installing(s.fullName);
                return (
                  <li key={s.fullName} className="store-row">
                    <button type="button" className="store-row__open" onClick={open}>
                      <AppIcon src={look?.icon ?? null} name={name} slug={look?.slug ?? repoName(s.fullName).replace(/-app$/, '')} size={64} />
                      <span className="store-row__t">
                        <span className="store-row__nm">{name}</span>
                        <span className="store-row__by">{s.owner}{s.public ? ` · ${t('share.public')}` : ''}</span>
                        {s.tagline && <span className="store-row__tg">{s.tagline}</span>}
                      </span>
                    </button>
                    <button type="button" className="app-tile__btn" disabled={busy} onClick={open}>{busy ? t('store.inv.installing') : !s.installed ? t('store.get') : look?.update ? t('share.card.update') : t('store.open')}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {/* S2: outside input from people this account does not work with: apart, said plainly, never the dot. */}
      {unknown.length > 0 && (
        <section className="apps-shelf" aria-labelledby="apps-inv-unknown-h">
          <div className="apps-shelf__head"><h2 id="apps-inv-unknown-h">{t('store.inv.unknownTitle')}</h2></div>
          <ul className="store-list">{unknown.map(invRow)}</ul>
        </section>
      )}
    </div>
  );
}

export function TrashList({ onChanged }: { onChanged: () => void }) {
  const api = useApi();
  const t = useShareT();
  const [items, setItems] = useState<Array<{ id: string; name: string; fullName: string | null }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [open, setOpen] = useState(false);
  const load = useMemo(() => () => api.get<{ trash: typeof items }>('/apps/trash').then((r) => setItems(r.trash), () => setItems([])), [api]);
  useEffect(() => { void load(); }, [load]);
  if (!items.length) return null;
  return (
    <section className="apps-section apps-trash" aria-labelledby="apps-trash-h">
      {/* Folded: removed apps are rare business, one quiet line until asked for. */}
      <h2 id="apps-trash-h" className="apps-section__small">
        <button type="button" className="apps-trash__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{t('share.trash.title')} ({items.length}) {open ? '▾' : '›'}</button>
      </h2>
      {open && (
        <ul className="apps-others">
          {items.map((i) => (
            <li key={i.id} className="apps-other">
              <div className="apps-other__text"><span className="apps-other__name">{i.name}</span>{i.fullName && <span className="apps-other__note">{i.fullName}</span>}</div>
              <button type="button" className="apps-other__btn" disabled={restoring} onClick={async () => { setRestoring(true); try { await api.ownerPost('/apps/trash/restore', { id: i.id }); await load(); onChanged(); } catch (e) { setErr(errText(e)); } finally { setRestoring(false); } }}>{t('share.trash.restore')}</button>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </section>
  );
}

