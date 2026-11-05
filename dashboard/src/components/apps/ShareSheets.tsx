import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApi, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { AppIcon } from './AppIcon';
import { About, CanList, FactStrip, ProductTop, Shots, WhatsNew, shortDate, type CanLine, type StoreEntry } from './StorePage';
import { askAgent } from './askAgent';

/**
 * Shared apps on the Apps page (paylasilan-app-ler plan r3): Share, Install, Settings, Update,
 * My own copy, Uninstall. Every decision is the owner's click (`ownerPost`); the server re-checks
 * everything the screen showed (the gate, the sha).
 */

interface GateFinding { id: string; rule: string; file: string; line?: number; label: string; term?: string }
interface GateReport { ok: boolean; send: Array<{ path: string; size: number }>; notSent: Array<{ path: string; why: string }>; blocks: GateFinding[]; approvable: GateFinding[]; unapproved: string[]; totalBytes: number }
export interface ConfigField { key: string; type: string; label: string; required: boolean; help?: string; choices?: string[]; value?: string | number | null; set?: boolean }

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/** `t` with `{name}` slots filled. */
export function useShareT(): (key: string, vars?: Record<string, string>) => string {
  const { t } = useI18n();
  return (key, vars) => (vars ? Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), t(key)) : t(key));
}

/** A counted phrase: `<key>.one` for 1, `<key>.other` (with `{n}`) for everything else. */
function useShareN(): (key: string, n: number) => string {
  const t = useShareT();
  return (key, n) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n: String(n) });
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The open sheets, oldest first: the last one is on top and owns the keyboard. */
const OPEN_SHEETS: object[] = [];

export function Sheet({ title, onClose, children, foot, page }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; page?: boolean }) {
  const t = useShareT();
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Focus moves in on open and back to the opener on close (the ObjectionDialog pattern).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('.share-sheet__body ' + FOCUSABLE.split(', ').join(', .share-sheet__body ')) ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => { opener?.focus?.(); };
  }, []);
  // Esc and Tab belong to the sheet: capture phase, so a drawer's own Esc does not fire too. A
  // sheet opened from an app's page sits on top of it: only the topmost one answers the keys.
  useEffect(() => {
    const token = {};
    OPEN_SHEETS.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (OPEN_SHEETS[OPEN_SHEETS.length - 1] !== token) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const all = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!all.length) return;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && ref.current.contains(active);
      if (e.shiftKey && (!inside || active === all[0])) { e.preventDefault(); all[all.length - 1].focus(); }
      else if (!e.shiftKey && (!inside || active === all[all.length - 1])) { e.preventDefault(); all[0].focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const at = OPEN_SHEETS.indexOf(token);
      if (at >= 0) OPEN_SHEETS.splice(at, 1);
    };
  }, []);
  // On body: a page frame with a transform would otherwise hold the fixed backdrop inside it.
  return createPortal(
    <div className="share-sheet__backdrop" onClick={onClose}>
      <div className={`share-sheet${page ? ' share-sheet--page' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="share-sheet__head">
          {/* A store page names the app in its own top block (the dialog keeps its label): the bar only closes. */}
          {!page && <h2>{title}</h2>}
          <button type="button" className="share-sheet__x" aria-label={t('share.close')} onClick={onClose}>×</button>
        </header>
        <div className="share-sheet__body">{children}</div>
        {foot && <footer className="share-sheet__foot">{foot}</footer>}
      </div>
    </div>,
    document.body,
  );
}

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

export function PublishSheet({ slug, name, icon, placeholder, publishedPublic, onClose, onDone }: { slug: string; name: string; icon?: string | null; placeholder?: boolean; publishedPublic?: boolean; onClose: () => void; onDone: () => void }) {
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
  useEffect(() => {
    // Only the newest answer counts: a slow report for the other visibility never lands here.
    let live = true;
    setErr(null);
    if (lastVis.current !== visibility) { lastVis.current = visibility; setPv(null); setApproved(new Set()); }
    const q = new URLSearchParams({ visibility });
    if (typed.note) q.set('note', typed.note);
    if (typed.tagline) q.set('tagline', typed.tagline);
    api.get<typeof pv>(`/apps/${encodeURIComponent(slug)}/publish/preview?${q}`).then((v) => {
      if (!live || !v) return;
      setPv(v);
      setApproved((a) => new Set([...a].filter((id) => v.report.approvable.some((x) => x.id === id))));
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
  const ask = (what: 'about' | 'icon') => { onClose(); askAgent(bus, t(what === 'icon' ? 'store.ask.icon' : 'store.ask.about', { slug })); };

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

// ─── Install ────────────────────────────────────────────────────────────────────────

interface Preview {
  previewId: string; fullName: string; sha: string; publisher: string; publisherSince: string | null; repoUpdated: string | null; public: boolean;
  name: string; slug: string; license: string; warning: string; readme: string; config: ConfigField[];
  facts: { backend: string | null; build: string | null; mcp: string[]; agent: string | null; schedules: number; actions: number; dangerActions: number; dependencies: number; urls: string[] };
  icon?: string | null;
  store?: { readme: { tagline: string | null; category: string | null; about: string | null; whatsNew: StoreEntry[] }; shots: Array<{ alt: string; src: string }>; can: CanLine[] };
  gate: { ok: boolean; blocks: GateFinding[] };
}

function ConfigInputs({ fields, values, setValues }: { fields: ConfigField[]; values: Record<string, string>; setValues: (v: Record<string, string>) => void }) {
  const t = useShareT();
  return (
    <>
      {fields.map((f) => (
        <label key={f.key} className="share-field">
          <span>{f.label}{f.required ? ' *' : ''}</span>
          {f.type === 'choice' ? (
            <select value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              <option value="">—</option>
              {(f.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            f.type === 'secret' ? (
              // Uncontrolled: a typed key never becomes the input's value attribute in the DOM.
              <input type="password" autoComplete="off" placeholder={f.set ? t('share.config.secretSet') : f.help ?? ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ) : (
              <input type={f.type === 'number' ? 'number' : 'text'} autoComplete="off" value={values[f.key] ?? ''} placeholder={f.help ?? ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )
          )}
        </label>
      ))}
    </>
  );
}

function splitValues(fields: ConfigField[], values: Record<string, string>) {
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === '') continue;
    if (f.type === 'secret') secrets[f.key] = v; else config[f.key] = v;
  }
  return { config, secrets };
}

export function InstallSheet({ initialRef, onClose, onDone }: { initialRef?: string; onClose: () => void; onDone: (slug: string) => void }) {
  const api = useApi();
  const t = useShareT();
  const tn = useShareN();
  const [ref, setRef] = useState(initialRef ?? '');
  const [pv, setPv] = useState<Preview | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'install' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The store page first; an app that asks for settings takes them on a second step, before Install.
  const [step, setStep] = useState<'page' | 'settings'>('page');

  // Every ask gets its own number: only the newest answer lands, so an older ask's error never
  // sits under a newer, valid preview (the same link asked twice races too).
  const asked = useRef(0);
  const preview = async (r = ref) => {
    // A new link starts from nothing: no tick, no key typed for another app.
    const n = ++asked.current;
    setBusy('preview'); setErr(null); setPv(null); setValues({}); setUnderstood(false); setStep('page');
    try {
      const v = await api.post<Preview>('/apps/install/preview', { ref: r });
      if (asked.current === n) setPv(v);
    } catch (e) { if (asked.current === n) setErr(errText(e)); } finally { if (asked.current === n) setBusy(null); }
  };
  // The opening preview goes once: a second, simultaneous fetch of the same repo can fail and
  // would then be the newest answer (React's dev double-run of effects does exactly that).
  const opened = useRef(false);
  useEffect(() => { if (initialRef && !opened.current) { opened.current = true; void preview(initialRef); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const missing = pv ? pv.config.filter((f) => f.required && !values[f.key]).map((f) => f.label) : [];
  // On the page, Install waits only for what the page asks (the gate, the tick); the settings come next.
  const pageWhy = !pv ? null : !pv.gate.ok ? t('share.install.refused') : pv.public && !understood ? t('share.install.tick') : null;
  const why = pageWhy ?? (missing.length ? t('share.install.fill', { fields: missing.join(', ') }) : null);

  const install = async () => {
    if (!pv) return;
    setBusy('install'); setErr(null);
    try {
      const out = await api.ownerPost<{ slug: string }>('/apps/install', { previewId: pv.previewId, sha: pv.sha, ...splitValues(pv.config, values) });
      onDone(out.slug);
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const onInstall = () => { if (pv && pv.config.length && step === 'page') setStep('settings'); else void install(); };

  const f = pv?.facts;
  const st = pv?.store;
  const top = st?.readme.whatsNew[0];
  const facts = f ? [
    { value: String(f.actions), label: tn('store.facts.actions', f.actions) },
    { value: String(f.schedules), label: tn('store.facts.schedules', f.schedules) },
    { value: f.urls.length ? String(f.urls.length) : t('store.none'), label: t('store.fact.web') },
    ...(top ? [{ value: `v${top.version}`, label: shortDate(top.date) || t('store.version.label') }] : pv?.repoUpdated ? [{ value: shortDate(pv.repoUpdated), label: t('store.fact.updated') }] : []),
  ] : [];
  const chip = pv ? (pv.public ? t('store.chip.public', { license: t(`share.license.${pv.license}`) }) : t('store.chip.private')) : '';
  const installBtn = pv && (
    <button type="button" className="app-card__launch pp-btn-lg" disabled={!!pageWhy || busy !== null} onClick={onInstall}>{busy === 'install' ? t('share.install.installing') : t('share.install.go')}</button>
  );

  return (
    <Sheet page={!!pv && step === 'page'} title={pv ? t('share.install.titleOf', { name: pv.name }) : t('share.install.title')} onClose={onClose} foot={
      step === 'settings' && pv ? (
        <>
          {why && <span className="share-why">{why}</span>}
          <button type="button" className="app-card__stop" onClick={() => setStep('page')}>{t('store.back')}</button>
          <button type="button" className="app-card__launch" disabled={!!why || busy !== null} onClick={() => void install()}>{busy === 'install' ? t('share.install.installing') : t('share.install.go')}</button>
        </>
      ) : !pv ? <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button> : undefined
    }>
      {!initialRef && step === 'page' && (
        <form className="share-row pp-link" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
          <label className="share-field share-field--grow"><span>{t('share.install.link')}</span><input value={ref} onChange={(e) => { setRef(e.target.value); asked.current++; setBusy((b) => (b === 'preview' ? null : b)); setPv(null); setValues({}); setUnderstood(false); }} placeholder="https://github.com/owner/repo" autoFocus /></label>
          <button type="submit" className="app-card__stop" disabled={!ref.trim() || busy !== null}>{busy === 'preview' ? t('share.checking') : t('share.install.look')}</button>
        </form>
      )}
      {busy === 'preview' && initialRef && <p className="share-muted">{t('share.checking')}</p>}
      {pv && f && step === 'page' && (
        <>
          <ProductTop
            icon={pv.icon ?? null}
            name={pv.name}
            slug={pv.slug}
            by={pv.publisher}
            tagline={st?.readme.tagline}
            actions={<>{installBtn}<span className="app-chip">{chip}</span>{st?.readme.category && <span className="app-chip">{st.readme.category}</span>}</>}
            note={pageWhy && <span className="share-why pp-why">{pageWhy}</span>}
          />
          <FactStrip facts={facts} />
          <Shots shots={st?.shots ?? []} sub={t('store.shots.from')} />
          <About text={st?.readme.about} />
          <CanList lines={st?.can ?? []} />
          <WhatsNew entry={top} />
          <section className="pp-sec" aria-label={t('store.safety')}>
            <h3>{t('store.safety')}</h3>
            <div className={`pp-safety${pv.public ? ' pp-safety--public' : ''}`}>
              <span className="pp-safety__mark" aria-hidden />
              <div className="pp-safety__body">
                <p className="share-lede">{t('share.install.warning', { who: pv.publisher })}</p>
                <p className="share-muted">{pv.public ? t('share.install.publicWarning') : t('store.safety.private', { who: pv.publisher })}</p>
                <dl className="share-facts">
                  <div><dt>{t('share.install.runs')}</dt><dd>{f.backend ? <code>{f.backend}</code> : t('share.install.pageOnly')}{f.build ? <> · <code>{f.build}</code></> : null}</dd></div>
                  {f.agent && <div><dt>{t('share.install.assistant')}</dt><dd>{f.agent}</dd></div>}
                  {f.mcp.length > 0 && <div><dt>MCP</dt><dd>{f.mcp.join(', ')}</dd></div>}
                  {f.dangerActions > 0 && <div><dt>{t('share.install.does')}</dt><dd>{t('share.install.danger', { n: String(f.dangerActions) })}</dd></div>}
                  {f.dependencies > 0 && <div><dt>npm</dt><dd>{tn('share.install.deps', f.dependencies)}</dd></div>}
                  <div><dt>{t('share.install.talksTo')}</dt><dd>{f.urls.length ? f.urls.join(', ') : t('share.install.noUrls')}</dd></div>
                  <div><dt>{t('store.fact.repo')}</dt><dd>{pv.fullName} · {pv.public ? t('share.public') : t('share.private')} · {t(`share.license.${pv.license}`)}</dd></div>
                </dl>
                <p className="share-muted">{t('store.safety.nothing')}</p>
                {!pv.gate.ok && <ul className="share-blocks">{pv.gate.blocks.map((b) => <li key={b.id}><code>{b.file}</code> {b.label}</li>)}</ul>}
                {pv.public && <label className="share-check"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> {t('share.install.understand')}</label>}
              </div>
            </div>
          </section>
        </>
      )}
      {pv && step === 'settings' && pv.config.length > 0 && (
        <section className="share-report">
          <div className="pp-mini"><AppIcon src={pv.icon ?? null} name={pv.name} slug={pv.slug} size={44} /><span>{t('share.config.title')}</span></div>
          <p className="share-muted">{t('share.config.where')}</p>
          <ConfigInputs fields={pv.config} values={values} setValues={setValues} />
        </section>
      )}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────────────

export function ConfigSheet({ slug, name, onClose, onDone }: { slug: string; name: string; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const t = useShareT();
  const [fields, setFields] = useState<ConfigField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ fields: ConfigField[] }>(`/apps/${encodeURIComponent(slug)}/config`).then((r) => {
      setFields(r.fields);
      setValues(Object.fromEntries(r.fields.filter((f) => f.type !== 'secret' && f.value !== null && f.value !== undefined).map((f) => [f.key, String(f.value)])));
    }, (e) => setErr(errText(e)));
  }, [api, slug]);
  const save = async () => {
    if (!fields) return;
    setBusy(true); setErr(null);
    const { config, secrets } = splitValues(fields, values);
    try { await api.ownerPost(`/apps/${encodeURIComponent(slug)}/config`, { values: config, secrets }); onDone(); onClose(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet title={t('share.config.titleOf', { name })} onClose={onClose} foot={<>
      <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button>
      <button type="button" className="app-card__launch" disabled={!fields || busy} onClick={() => void save()}>{t('share.config.save')}</button>
    </>}>
      <p className="share-muted">{t('share.config.where')}</p>
      {!fields && !err && <p className="share-muted">{t('share.checking')}</p>}
      {fields && <ConfigInputs fields={fields} values={values} setValues={setValues} />}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}

// ─── Update ─────────────────────────────────────────────────────────────────────────

type Check =
  | { state: 'none'; sha: string }
  | { state: 'available'; sha: string; manifestChanged: boolean; manifestChanges: string[]; edited: { files: string[]; commits: number } | null; notes: string[]; wouldLose: string[] }
  | { state: 'problem'; code: string; message: string };

export function UpdateSheet({ slug, name, from, onClose, onDone, onDetach }: { slug: string; name: string; from: string; onClose: () => void; onDone: () => void; onDetach: () => void }) {
  const api = useApi();
  const t = useShareT();
  const tn = useShareN();
  const [c, setC] = useState<Check | null>(null);
  const [approve, setApprove] = useState(false);
  const [how, setHow] = useState<'merge' | 'set-aside' | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ patch?: string } | null>(null);
  useEffect(() => { api.post<Check>(`/apps/${encodeURIComponent(slug)}/update/check`, {}).then(setC, (e) => setErr(errText(e))); }, [api, slug]);

  const av = c?.state === 'available' ? c : null;
  const why = !av ? null : av.manifestChanged && !approve ? t('share.update.approveFirst') : av.edited && !how ? t('share.update.pickHow') : null;
  const apply = async () => {
    if (!av) return;
    setBusy(true); setErr(null);
    try { setApplied(await api.ownerPost<{ patch?: string }>(`/apps/${encodeURIComponent(slug)}/update`, { sha: av.sha, approveManifest: approve, how: how || undefined })); onDone(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true); setErr(null);
    try { await api.ownerPost(`/apps/${encodeURIComponent(slug)}/update/undo`, {}); onDone(); onClose(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  if (applied) {
    return (
      <Sheet title={t('share.update.doneTitle', { name })} onClose={onClose} foot={<>
        <button type="button" className="app-card__stop" disabled={busy} onClick={() => void undo()}>{t('share.update.undo')}</button>
        <button type="button" className="app-card__launch" onClick={onClose}>{t('share.close')}</button>
      </>}>
        <p className="share-lede">{t('share.update.done')}</p>
        {applied.patch && <p className="share-muted">{t('share.update.patchKept')} <code>{applied.patch}</code></p>}
        {err && <p className="app-card__note app-card__note--bad">{err}</p>}
      </Sheet>
    );
  }

  return (
    <Sheet title={t('share.update.title', { name })} onClose={onClose} foot={av ? <>
      {why && <span className="share-why">{why}</span>}
      <button type="button" className="app-card__stop" onClick={onClose}>{t('share.later')}</button>
      <button type="button" className="app-card__launch" disabled={!!why || busy} onClick={() => void apply()}>{busy ? t('share.update.updating') : t('share.update.go')}</button>
    </> : <button type="button" className="app-card__stop" onClick={onClose}>{t('share.close')}</button>}>
      {!c && !err && <p className="share-muted">{t('share.checking')}</p>}
      {c?.state === 'none' && <p className="share-lede">{t('share.update.none')}</p>}
      {c?.state === 'problem' && <p className="app-card__note app-card__note--warn">{c.message}</p>}
      {av && (
        <>
          <p className="share-lede">{t('share.update.from', { from })}</p>
          {av.notes.length > 0 && (
            <section className="share-report">
              <h3>{t('share.update.notes')}</h3>
              <ul className="share-notes">{av.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </section>
          )}
          {av.manifestChanged && (
            <label className="share-check share-check--warn">
              <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
              <span>{t('share.update.manifest', { what: av.manifestChanges.join(', ') })}</span>
            </label>
          )}
          {av.edited && (
            <section className="share-report">
              <h3>{tn('share.update.edited', av.edited.files.length)}</h3>
              {av.wouldLose.length > 0 && <p className="share-muted">{t('share.update.wouldLose', { files: av.wouldLose.join(', ') })}</p>}
              <fieldset className="share-choice">
                <label><input type="radio" name="how" checked={how === 'merge'} onChange={() => setHow('merge')} /> <span><strong>{t('share.update.merge')}</strong><small>{t('share.update.mergeHint')}</small></span></label>
                <label><input type="radio" name="how" checked={how === 'set-aside'} onChange={() => setHow('set-aside')} /> <span><strong>{t('share.update.aside')}</strong><small>{t('share.update.asideHint')}</small></span></label>
              </fieldset>
              <button type="button" className="share-link" onClick={onDetach}>{t('share.update.orOwn')}</button>
            </section>
          )}
        </>
      )}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}

// ─── My own copy, uninstall ─────────────────────────────────────────────────────────

export function ConfirmSheet({ kind, slug, name, onClose, onDone }: { kind: 'detach' | 'uninstall'; slug: string; name: string; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const t = useShareT();
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api.ownerPost(`/apps/${encodeURIComponent(slug)}/${kind}`, kind === 'uninstall' ? { deleteData } : {}); onDone(); onClose(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet title={t(`share.${kind}.title`, { name })} onClose={onClose} foot={<>
      <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button>
      <button type="button" className={`app-card__launch${kind === 'uninstall' ? ' app-card__launch--danger' : ''}`} disabled={busy} onClick={() => void go()}>{t(`share.${kind}.go`)}</button>
    </>}>
      <p className="share-lede">{t(`share.${kind}.body`)}</p>
      {kind === 'uninstall' && <label className="share-check"><input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} /> {t('share.uninstall.data')}</label>}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}

// ─── Shared Apps ────────────────────────────────────────────────────────────────────

export interface SharedList {
  signedIn: boolean; login: string | null; host: string; problem?: string;
  invitations: Array<{ id: string; fullName: string; inviter: string }>;
  shared: Array<{ fullName: string; owner: string; name: string | null; tagline?: string | null; public: boolean; installed?: string }>;
}

/** An installed app as the store row needs it: its icon, and whether an update waits. */
export interface InstalledLook { slug: string; name: string; icon: string | null; update: boolean }

/**
 * The Shared Apps tab (app-paylasim-magaza r2 section 2): invitations on top, then every app
 * shared with this account. The button says the state: Get, Open, or Update. A row opens the app's
 * page: the install page for one not here yet, its own page for one installed.
 */
export function SharedApps({ list, err, loading, installedLook, onRefresh, onInstall, onOpen, onAccepted }: {
  list: SharedList | null; err: string | null; loading: boolean;
  installedLook: (slug: string) => InstalledLook | null;
  onRefresh: () => void; onInstall: (fullName: string) => void; onOpen: (slug: string) => void; onAccepted: () => void;
}) {
  const api = useApi();
  const t = useShareT();
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptErr, setAcceptErr] = useState<string | null>(null);
  const accept = async (id: string) => {
    if (accepting) return;
    setAccepting(id); setAcceptErr(null);
    try { await api.ownerPost('/apps/shared/accept', { id }); onAccepted(); } catch (e) { setAcceptErr(errText(e)); } finally { setAccepting(null); }
  };
  const repoName = (fullName: string) => fullName.split('/').pop() ?? fullName;
  return (
    <div className="apps-store">
      {loading && !list && <p className="apps-page__muted">{t('share.checking')}</p>}
      {(err || acceptErr) && <p className="app-card__note app-card__note--bad">{err ?? acceptErr}</p>}
      {list && !list.signedIn && <p className="apps-page__muted">{t('share.shared.signIn')}</p>}
      {list?.problem && <p className="app-card__note app-card__note--warn">{list.problem}</p>}
      {list && list.invitations.length > 0 && (
        <section className="apps-shelf" aria-labelledby="apps-inv-h">
          <div className="apps-shelf__head"><h2 id="apps-inv-h">{t('store.invitations')}</h2></div>
          <ul className="store-list">
            {list.invitations.map((i) => (
              <li key={i.id} className="store-row">
                <AppIcon src={null} name={repoName(i.fullName).replace(/-app$/, '').replace(/-/g, ' ')} slug={repoName(i.fullName)} size={64} />
                <div className="store-row__t"><p className="store-row__nm">{repoName(i.fullName)}</p><p className="store-row__by">{t('share.shared.invited', { who: i.inviter })}</p></div>
                <button type="button" className="app-tile__btn app-tile__btn--primary" disabled={accepting !== null} onClick={() => void accept(i.id)}>{t('share.shared.accept')}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {list?.signedIn && (
        <section className="apps-shelf" aria-labelledby="apps-shared-h">
          <div className="apps-shelf__head">
            <h2 id="apps-shared-h">{t('share.shared.title')}</h2>
            <button type="button" className="share-link" onClick={onRefresh}>{t('share.shared.refresh')}</button>
          </div>
          {!list.shared.length && <p className="apps-page__muted">{t('share.shared.empty')}</p>}
          {list.shared.length > 0 && (
            <ul className="store-list">
              {list.shared.map((s) => {
                const look = s.installed ? installedLook(s.installed) : null;
                const name = look?.name ?? s.name ?? repoName(s.fullName);
                const open = () => (s.installed ? onOpen(s.installed) : onInstall(s.fullName));
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
                    <button type="button" className="app-tile__btn" onClick={open}>{!s.installed ? t('store.get') : look?.update ? t('share.card.update') : t('store.open')}</button>
                  </li>
                );
              })}
            </ul>
          )}
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
