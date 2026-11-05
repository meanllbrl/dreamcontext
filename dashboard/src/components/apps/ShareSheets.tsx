import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';

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

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ title, onClose, children, foot }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode }) {
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
  // Esc and Tab belong to the sheet: capture phase, so a drawer's own Esc does not fire too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // On body: a page frame with a transform would otherwise hold the fixed backdrop inside it.
  return createPortal(
    <div className="share-sheet__backdrop" onClick={onClose}>
      <div className="share-sheet" ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="share-sheet__head">
          <h2>{title}</h2>
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

export function PublishSheet({ slug, name, publishedPublic, onClose, onDone }: { slug: string; name: string; publishedPublic?: boolean; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const t = useShareT();
  // A public app stays public: the sheet starts where the app already is.
  const [visibility, setVisibility] = useState<'private' | 'public'>(publishedPublic ? 'public' : 'private');
  const [invite, setInvite] = useState('');
  const [note, setNote] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [pv, setPv] = useState<{ login: string | null; signedIn: boolean; fullName: string | null; license: string; report: GateReport; published: { fullName: string } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ fullName: string; url: string; invited: string[]; inviteFailed?: string[] } | null>(null);

  useEffect(() => {
    // Only the newest answer counts: a slow report for the other visibility never lands here.
    let live = true;
    setPv(null); setErr(null); setApproved(new Set());
    api.get<typeof pv>(`/apps/${encodeURIComponent(slug)}/publish/preview?visibility=${visibility}`).then((v) => { if (live) setPv(v); }, (e) => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [api, slug, visibility]);

  const r = pv?.report;
  const waiting = r ? r.approvable.filter((a) => !approved.has(a.id)).length : 0;
  const why = !pv ? null
    : !pv.signedIn ? t('share.publish.needSignIn')
    : r!.blocks.length ? t('share.publish.fixFirst', { n: String(r!.blocks.length) })
    : waiting ? t('share.publish.approveFirst', { n: String(waiting) })
    : visibility === 'public' && confirmName.trim() !== name ? t('share.publish.typeName', { name })
    : null;

  const publish = async () => {
    setBusy(true); setErr(null);
    try {
      const out = await api.ownerPost<{ fullName: string; url: string; invited: string[]; inviteFailed?: string[] }>(`/apps/${encodeURIComponent(slug)}/publish`, {
        visibility, invite: invite.split(/[\s,]+/).filter(Boolean), approvals: [...approved], note, confirmName,
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
    <Sheet title={t('share.publish.title', { name })} onClose={onClose} foot={!pv ? undefined :
      <>
        {why && <span className="share-why">{why}</span>}
        <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button>
        <button type="button" className="app-card__launch" disabled={!!why || busy} onClick={() => void publish()}>{busy ? t('share.publish.publishing') : pv?.published ? t('share.publish.update') : t('share.publish.go')}</button>
      </>
    }>
      <fieldset className="share-choice">
        <legend>{t('share.publish.who')}</legend>
        <label><input type="radio" name="vis" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> <span><strong>{t('share.publish.private')}</strong><small>{t('share.publish.privateHint')}</small></span></label>
        <label><input type="radio" name="vis" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> <span><strong>{t('share.publish.public')}</strong><small>{t('share.publish.publicHint')}</small></span></label>
      </fieldset>
      {pv && <p className="share-muted">{t('share.publish.repo', { repo: pv.fullName ?? '—', license: t(`share.license.${pv.license}`) })}</p>}
      {visibility === 'private' && (
        <label className="share-field"><span>{t('share.publish.invite')}</span><input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder={t('share.publish.invitePh')} /></label>
      )}
      <label className="share-field"><span>{t('share.publish.note')}</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('share.publish.notePh')} /></label>
      {!pv && !err && <p className="share-muted">{t('share.checking')}</p>}
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
  name: string; license: string; warning: string; readme: string; config: ConfigField[];
  facts: { backend: string | null; build: string | null; mcp: string[]; agent: string | null; schedules: number; actions: number; dangerActions: number; dependencies: number; urls: string[] };
  gate: { ok: boolean; blocks: GateFinding[] };
}

function ConfigInputs({ fields, values, setValues }: { fields: ConfigField[]; values: Record<string, string>; setValues: (v: Record<string, string>) => void }) {
  const t = useShareT();
  return (
    <>
      {fields.map((f) => (
        <label key={f.key} className="share-field">
          <span>{f.label}{f.required ? ' *' : ''}{f.type === 'secret' ? ` · ${t('share.config.secret')}` : ''}</span>
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
  const [ref, setRef] = useState(initialRef ?? '');
  const [pv, setPv] = useState<Preview | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'install' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Every ask gets its own number: only the newest answer lands, so an older ask's error never
  // sits under a newer, valid preview (the same link asked twice races too).
  const asked = useRef(0);
  const preview = async (r = ref) => {
    // A new link starts from nothing: no tick, no key typed for another app.
    const n = ++asked.current;
    setBusy('preview'); setErr(null); setPv(null); setValues({}); setUnderstood(false);
    try {
      const v = await api.post<Preview>('/apps/install/preview', { ref: r });
      if (asked.current === n) setPv(v);
    } catch (e) { if (asked.current === n) setErr(errText(e)); } finally { if (asked.current === n) setBusy(null); }
  };
  useEffect(() => { if (initialRef) void preview(initialRef); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const missing = pv ? pv.config.filter((f) => f.required && !values[f.key]).map((f) => f.label) : [];
  const why = !pv ? null : !pv.gate.ok ? t('share.install.refused') : missing.length ? t('share.install.fill', { fields: missing.join(', ') }) : pv.public && !understood ? t('share.install.tick') : null;

  const install = async () => {
    if (!pv) return;
    setBusy('install'); setErr(null);
    try {
      const out = await api.ownerPost<{ slug: string }>('/apps/install', { previewId: pv.previewId, sha: pv.sha, ...splitValues(pv.config, values) });
      onDone(out.slug);
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };

  const f = pv?.facts;
  return (
    <Sheet title={pv ? t('share.install.titleOf', { name: pv.name }) : t('share.install.title')} onClose={onClose} foot={pv ? (
      <>
        {why && <span className="share-why">{why}</span>}
        <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button>
        <button type="button" className="app-card__launch" disabled={!!why || busy !== null} onClick={() => void install()}>{busy === 'install' ? t('share.install.installing') : t('share.install.go')}</button>
      </>
    ) : undefined}>
      {!initialRef && (
        <form className="share-row" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
          <label className="share-field share-field--grow"><span>{t('share.install.link')}</span><input value={ref} onChange={(e) => { setRef(e.target.value); asked.current++; setBusy((b) => (b === 'preview' ? null : b)); setPv(null); setValues({}); setUnderstood(false); }} placeholder="https://github.com/owner/repo" autoFocus /></label>
          <button type="submit" className="app-card__stop" disabled={!ref.trim() || busy !== null}>{busy === 'preview' ? t('share.checking') : t('share.install.look')}</button>
        </form>
      )}
      {busy === 'preview' && initialRef && <p className="share-muted">{t('share.checking')}</p>}
      {pv && f && (
        <>
          <p className="share-lede"><strong>{pv.name}</strong> · {pv.fullName} · {pv.public ? t('share.public') : t('share.private')} · {t(`share.license.${pv.license}`)}</p>
          <div className="share-warning" role="note">
            <strong>{t('share.install.warning', { who: pv.publisher })}</strong>
            {pv.public && <span>{t('share.install.publicWarning')}</span>}
          </div>
          <dl className="share-facts">
            <div><dt>{t('share.install.runs')}</dt><dd>{f.backend ? <code>{f.backend}</code> : t('share.install.pageOnly')}{f.build ? <> · <code>{f.build}</code></> : null}</dd></div>
            {f.agent && <div><dt>{t('share.install.assistant')}</dt><dd>{f.agent}</dd></div>}
            {f.mcp.length > 0 && <div><dt>MCP</dt><dd>{f.mcp.join(', ')}</dd></div>}
            {(f.actions > 0 || f.schedules > 0) && <div><dt>{t('share.install.does')}</dt><dd>{t('share.install.doesN', { a: String(f.actions), s: String(f.schedules) })}{f.dangerActions ? ` · ${t('share.install.danger', { n: String(f.dangerActions) })}` : ''}</dd></div>}
            {f.dependencies > 0 && <div><dt>npm</dt><dd>{t('share.install.deps', { n: String(f.dependencies) })}</dd></div>}
            <div><dt>{t('share.install.talksTo')}</dt><dd>{f.urls.length ? f.urls.join(', ') : t('share.install.noUrls')}</dd></div>
          </dl>
          {!pv.gate.ok && <ul className="share-blocks">{pv.gate.blocks.map((b) => <li key={b.id}><code>{b.file}</code> {b.label}</li>)}</ul>}
          {pv.config.length > 0 && (
            <section className="share-report">
              <h3>{t('share.config.title')}</h3>
              <p className="share-muted">{t('share.config.where')}</p>
              <ConfigInputs fields={pv.config} values={values} setValues={setValues} />
            </section>
          )}
          {pv.public && <label className="share-check"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> {t('share.install.understand')}</label>}
        </>
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
    </> : undefined}>
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
              <h3>{t('share.update.edited', { n: String(av.edited.files.length) })}</h3>
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
      <button type="button" className="app-card__launch" disabled={busy} onClick={() => void go()}>{t(`share.${kind}.go`)}</button>
    </>}>
      <p className="share-lede">{t(`share.${kind}.body`)}</p>
      {kind === 'uninstall' && <label className="share-check"><input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} /> {t('share.uninstall.data')}</label>}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}

// ─── Shared with you ────────────────────────────────────────────────────────────────

interface SharedList {
  signedIn: boolean; login: string | null; host: string; problem?: string;
  invitations: Array<{ id: string; fullName: string; inviter: string }>;
  shared: Array<{ fullName: string; owner: string; name: string | null; public: boolean; installed?: string }>;
}

export function SharedWithYou({ onInstall, onChanged }: { onInstall: (fullName: string) => void; onChanged: () => void }) {
  const api = useApi();
  const t = useShareT();
  const [list, setList] = useState<SharedList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useMemo(() => (refresh = false) => api.get<SharedList>(`/apps/shared${refresh ? '?refresh=1' : ''}`).then((l) => { setList(l); setErr(null); }, (e) => setErr(errText(e))), [api]);
  useEffect(() => { void load(); }, [load]);
  const [accepting, setAccepting] = useState<string | null>(null);
  const accept = async (id: string) => {
    if (accepting) return;
    setAccepting(id);
    try { await api.ownerPost('/apps/shared/accept', { id }); await load(true); onChanged(); } catch (e) { setErr(errText(e)); } finally { setAccepting(null); }
  };
  return (
    <section className="apps-section" aria-labelledby="apps-shared-h">
      <div className="apps-section__head">
        <h2 id="apps-shared-h">{t('share.shared.title')}</h2>
        {list?.signedIn && <button type="button" className="share-link" onClick={() => void load(true)}>{t('share.shared.refresh')}</button>}
      </div>
      {!list && !err && <p className="apps-page__muted">{t('share.checking')}</p>}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
      {list && !list.signedIn && <p className="apps-page__muted">{t('share.shared.signIn')}</p>}
      {list?.problem && <p className="app-card__note app-card__note--warn">{list.problem}</p>}
      {list?.signedIn && !list.invitations.length && !list.shared.length && <p className="apps-page__muted">{t('share.shared.empty')}</p>}
      {list && (list.invitations.length > 0 || list.shared.length > 0) && (
        <ul className="apps-others">
          {list.invitations.map((i) => (
            <li key={i.id} className="apps-other">
              <div className="apps-other__text"><span className="apps-other__name">{i.fullName}</span><span className="apps-other__note">{t('share.shared.invited', { who: i.inviter })}</span></div>
              <button type="button" className="apps-other__btn" disabled={accepting !== null} onClick={() => void accept(i.id)}>{t('share.shared.accept')}</button>
            </li>
          ))}
          {list.shared.map((s) => (
            <li key={s.fullName} className="apps-other">
              <div className="apps-other__text"><span className="apps-other__name">{s.name ?? s.fullName}</span><span className="apps-other__note">{t('share.shared.by', { who: s.owner, repo: s.fullName })}</span></div>
              {s.installed ? <span className="apps-other__note">{t('share.shared.installed')}</span> : <button type="button" className="apps-other__btn" onClick={() => onInstall(s.fullName)}>{t('share.install.go')}</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TrashList({ onChanged }: { onChanged: () => void }) {
  const api = useApi();
  const t = useShareT();
  const [items, setItems] = useState<Array<{ id: string; name: string; fullName: string | null }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const load = useMemo(() => () => api.get<{ trash: typeof items }>('/apps/trash').then((r) => setItems(r.trash), () => setItems([])), [api]);
  useEffect(() => { void load(); }, [load]);
  if (!items.length) return null;
  return (
    <section className="apps-section" aria-labelledby="apps-trash-h">
      <h2 id="apps-trash-h" className="apps-section__small">{t('share.trash.title')}</h2>
      <ul className="apps-others">
        {items.map((i) => (
          <li key={i.id} className="apps-other">
            <div className="apps-other__text"><span className="apps-other__name">{i.name}</span>{i.fullName && <span className="apps-other__note">{i.fullName}</span>}</div>
            <button type="button" className="apps-other__btn" disabled={restoring} onClick={async () => { setRestoring(true); try { await api.ownerPost('/apps/trash/restore', { id: i.id }); await load(); onChanged(); } catch (e) { setErr(errText(e)); } finally { setRestoring(false); } }}>{t('share.trash.restore')}</button>
          </li>
        ))}
      </ul>
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </section>
  );
}
