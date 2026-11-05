import { useEffect, useRef, useState } from 'react';
import { useApi, useVault } from '../../context/VaultContext';
import { AppIcon } from './AppIcon';
import { askAgent } from './askAgent';
import { Sheet, errText, useShareN, useShareT, type GateFinding, type GateReport } from './Sheet';
import type { StoreEntry } from './StorePage';

/** Share (paylasilan-app-ler plan r3) with the store block (app-paylasim-magaza r2 section 4). */

function FileList({ title, items }: { title: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="share-files">
      <button type="button" className="share-files__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{title} ({items.length})</button>
      {open && <ul>{items.map((i) => <li key={i}><code>{i}</code></li>)}</ul>}
    </div>
  );
}

// ─── Share (publish) ────────────────────────────────────────────────────────────────

interface PublishStore { tagline: string | null; suggestedTagline: string | null; hasAbout: boolean; whatsNew: StoreEntry | null; ready: number; missing: string[]; iconPlaceholder: boolean; hasIcon: boolean }

const TAGLINE_MAX = 80;

/**
 * Approvals follow the line's words, not its number: the store edits move README lines (a header
 * on top, an entry under What's new), and a tick must stay on the same words. Same rule, file and
 * term, in the order they appear; consent never moves to a different line's words.
 */
function contentKeys(list: GateFinding[]): string[] {
  const seen = new Map<string, number>();
  return list.map((a) => {
    const k = `${a.rule}|${a.file}|${a.term ?? ''}|${a.label}`;
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    return `${k}#${i}`;
  });
}

export function PublishSheet({ slug, name, icon, placeholder, publishedPublic, onClose, onLeave, onDone }: { slug: string; name: string; icon?: string | null; placeholder?: boolean; publishedPublic?: boolean; onClose: () => void; onLeave?: () => void; onDone: () => void }) {
  const api = useApi();
  const { bus } = useVault();
  const t = useShareT();
  const tn = useShareN();
  // A public app stays public: the sheet starts where the app already is.
  const [visibility, setVisibility] = useState<'private' | 'public'>(publishedPublic ? 'public' : 'private');
  const [invite, setInvite] = useState('');
  const [note, setNote] = useState('');
  const [tagline, setTagline] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [pv, setPv] = useState<{ login: string | null; signedIn: boolean; fullName: string | null; license: string; report: GateReport; published: { fullName: string } | null; store?: PublishStore } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ fullName: string; url: string; invited: string[]; inviteFailed?: string[] } | null>(null);

  // The words the publish writes into the README travel too, so the check reads them: the preview
  // is asked again a moment after the one line or the note changes. A tick on a line that is still
  // there stays ticked.
  const [typed, setTyped] = useState({ note: '', tagline: '' });
  useEffect(() => {
    const id = window.setTimeout(() => setTyped({ note, tagline: tagline ?? '' }), 600);
    return () => window.clearTimeout(id);
  }, [note, tagline]);
  const lastVis = useRef(visibility);
  const lastApprovable = useRef<GateFinding[]>([]);
  useEffect(() => {
    // Only the newest answer counts: a slow report for the other visibility never lands here.
    let live = true;
    setErr(null);
    if (lastVis.current !== visibility) { lastVis.current = visibility; lastApprovable.current = []; setPv(null); setApproved(new Set()); }
    const q = new URLSearchParams({ visibility });
    if (typed.note) q.set('note', typed.note);
    if (typed.tagline) q.set('tagline', typed.tagline);
    api.get<typeof pv>(`/apps/${encodeURIComponent(slug)}/publish/preview?${q}`).then((v) => {
      if (!live || !v) return;
      const before = lastApprovable.current;
      lastApprovable.current = v.report.approvable;
      setPv(v);
      setApproved((a) => {
        const oldKeys = contentKeys(before);
        const kept = new Set(before.map((x, i) => (a.has(x.id) ? oldKeys[i] : null)).filter((k): k is string => k !== null));
        const newKeys = contentKeys(v.report.approvable);
        return new Set(v.report.approvable.filter((_, i) => kept.has(newKeys[i])).map((x) => x.id));
      });
      // The one line starts as the README's (or its suggested first sentence); the owner's typing wins.
      setTagline((cur) => (cur === null ? v.store?.tagline ?? v.store?.suggestedTagline ?? '' : cur));
    }, (e) => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [api, slug, visibility, typed]);

  const r = pv?.report;
  const waiting = r ? r.approvable.filter((a) => !approved.has(a.id)).length : 0;
  const settling = typed.note !== note || typed.tagline !== (tagline ?? '');
  const why = !pv ? (err ? null : t('share.checking'))
    : !pv.signedIn ? t('share.publish.needSignIn')
    : settling ? t('share.checking')
    : r!.blocks.length ? tn('share.publish.fixFirst', r!.blocks.length)
    : waiting ? tn('share.publish.approveFirst', waiting)
    : visibility === 'public' && confirmName.trim() !== name ? t('share.publish.typeName', { name })
    : null;

  // Store page: x of 3, counting what this publish will write.
  const st = pv?.store;
  const has = { tagline: !!(tagline ?? '').trim(), about: !!st?.hasAbout, whatsNew: !!st?.whatsNew || !!note.trim() || !pv?.published };
  const ready = Number(has.tagline) + Number(has.about) + Number(has.whatsNew);
  const missingText = [!has.tagline && t('store.ready.tagline'), !has.about && t('store.ready.about'), !has.whatsNew && t('store.ready.whatsNew')].filter(Boolean).join(', ');
  // Chat opens under nothing: the page this sheet sits on closes too (onLeave), not only the sheet.
  const ask = (what: 'about' | 'icon') => { (onLeave ?? onClose)(); askAgent(bus, t(what === 'icon' ? 'store.ask.icon' : 'store.ask.about', { slug })); };

  const publish = async () => {
    setBusy(true); setErr(null);
    try {
      const out = await api.ownerPost<{ fullName: string; url: string; invited: string[]; inviteFailed?: string[] }>(`/apps/${encodeURIComponent(slug)}/publish`, {
        visibility, invite: invite.split(/[\s,]+/).filter(Boolean), approvals: [...approved], note, tagline: tagline ?? '', confirmName,
      });
      setDone(out); onDone();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Sheet title={t('share.publish.doneTitle')} onClose={onClose} foot={<button type="button" className="app-card__launch" onClick={onClose}>{t('share.close')}</button>}>
        <p className="share-lede">{t('share.publish.done', { repo: done.fullName })}</p>
        {done.invited.length > 0 && <p className="share-muted">{t('share.publish.invited', { who: done.invited.join(', ') })}</p>}
        {(done.inviteFailed?.length ?? 0) > 0 && <p className="app-card__note app-card__note--warn">{t('share.publish.inviteFailed', { who: done.inviteFailed!.join(', ') })}</p>}
      </Sheet>
    );
  }

  return (
    <Sheet title={t('share.publish.title', { name })} onClose={onClose} foot={
      <>
        {why && <span className="share-why">{why}</span>}
        <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button>
        <button type="button" className="app-card__launch" disabled={!pv || !!why || busy} onClick={() => void publish()}>{busy ? t('share.publish.publishing') : pv?.published ? t('share.publish.update') : t('share.publish.go')}</button>
      </>
    }>
      <div className="pp-mini">
        <AppIcon src={placeholder ? null : icon ?? null} name={name} slug={slug} size={64} />
        <div className="pp-mini__text"><strong>{name}</strong>{(tagline ?? '').trim() ? <span>{tagline}</span> : <span className="share-muted">{t('store.looks')}</span>}</div>
      </div>
      {pv && (
        <div className="pp-ready" role="status">
          <span><strong>{t('store.ready.title')}</strong> · {t('store.ready.count', { n: String(ready) })}</span>
          {ready < 3 && (
            <span className="share-muted">
              {t('store.ready.missing', { what: missingText })}
              {!has.about && <> · <button type="button" className="share-link" onClick={() => ask('about')}>{t('store.ask')}</button></>}
            </span>
          )}
        </div>
      )}
      {(placeholder || st?.iconPlaceholder) && (
        <div className="app-card__note app-card__note--warn app-card__mcp">
          <span>{t('store.icon.placeholder')}</span>
          <button type="button" className="app-card__stop" onClick={() => ask('icon')}>{t('store.ask')}</button>
        </div>
      )}
      <label className="share-field">
        <span>{t('store.tagline')}</span>
        <input value={tagline ?? ''} maxLength={TAGLINE_MAX} onChange={(e) => setTagline(e.target.value)} placeholder={st?.suggestedTagline ?? t('store.tagline.ph')} />
        <small className="share-muted">{t('store.tagline.hint', { n: String(TAGLINE_MAX - (tagline ?? '').length) })}</small>
      </label>
      <fieldset className="share-choice">
        <legend>{t('share.publish.who')}</legend>
        <label><input type="radio" name="vis" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> <span><strong>{t('share.publish.private')}</strong><small>{t('share.publish.privateHint')}</small></span></label>
        <label><input type="radio" name="vis" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> <span><strong>{t('share.publish.public')}</strong><small>{t('share.publish.publicHint')}</small></span></label>
      </fieldset>
      {pv && <p className="share-muted">{t('share.publish.repo', { repo: pv.fullName ?? '—' })}</p>}
      {visibility === 'private' && (
        <label className="share-field"><span>{t('share.publish.invite')}</span><input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder={t('share.publish.invitePh')} /></label>
      )}
      <label className="share-field"><span>{t('share.publish.note')}</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={pv?.published ? '' : t('share.publish.notePh')} /></label>
      {r && (
        <section className="share-report" aria-label={t('share.publish.check')}>
          <h3>{r.ok || (!r.blocks.length && !waiting) ? t('share.publish.clear') : t('share.publish.check')}</h3>
          <FileList title={t('share.publish.sends')} items={r.send.map((s) => s.path)} />
          <FileList title={t('share.publish.stays')} items={r.notSent.map((s) => `${s.path}: ${s.why}`)} />
          {r.blocks.length > 0 && (
            <ul className="share-blocks">
              {r.blocks.map((b) => <li key={b.id}><code>{b.file}{b.line ? `:${b.line}` : ''}</code> {b.label}</li>)}
            </ul>
          )}
          {r.approvable.length > 0 && (
            <div className="share-approve">
              <p>{t('share.publish.approveLede')}</p>
              {r.approvable.map((a) => (
                <label key={a.id}>
                  <input type="checkbox" checked={approved.has(a.id)} onChange={(e) => { const n = new Set(approved); if (e.target.checked) n.add(a.id); else n.delete(a.id); setApproved(n); }} />
                  <span><code>{a.file}{a.line ? `:${a.line}` : ''}</code> {a.label}: <strong>{a.term}</strong></span>
                </label>
              ))}
            </div>
          )}
        </section>
      )}
      {visibility === 'public' && (
        <label className="share-field"><span>{t('share.publish.confirm', { name })}</span><input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} /></label>
      )}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}

