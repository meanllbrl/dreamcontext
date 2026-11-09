import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useApi } from '../../context/VaultContext';
import { AppIcon } from './AppIcon';
import { isSvgFile, svgToPng } from './logoFile';
import { ConfigInputs, splitValues } from './InstallSheet';
import { Sheet, errText, useShareN, useShareT, type ConfigField } from './Sheet';

/** An installed or own app's rare actions: its settings, an update, my own copy, uninstall. */

// ─── Settings ───────────────────────────────────────────────────────────────────────

/** Mirror of the logo route's cap (`MAX_LOGO_BYTES` in `lib/apps/app-logo.ts`). */
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export function ConfigSheet({ slug, name, iconSrc, onClose, onDone }: { slug: string; name: string; iconSrc: string | null; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const t = useShareT();
  const [fields, setFields] = useState<ConfigField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The owner's own logo: a picked file waits for Save; "reset" goes back to the app's own icon.
  const [hasLogo, setHasLogo] = useState(false);
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const [reset, setReset] = useState(false);
  const [converting, setConverting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    api.get<{ fields: ConfigField[]; logo?: boolean }>(`/apps/${encodeURIComponent(slug)}/config`).then((r) => {
      setFields(r.fields);
      setHasLogo(!!r.logo);
      setValues(Object.fromEntries(r.fields.filter((f) => f.type !== 'secret' && f.value !== null && f.value !== undefined).map((f) => [f.key, String(f.value)])));
    }, (e) => setErr(errText(e)));
  }, [api, slug]);
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.url); }, [picked]);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    setErr(null);
    let file = chosen;
    // An SVG goes up as the PNG the page draws from it (logoFile.ts): the server takes no SVG.
    if (isSvgFile(chosen)) {
      setConverting(true);
      try { file = await svgToPng(chosen); } catch { setErr(t('share.config.logoSvgFailed')); return; } finally { setConverting(false); }
    }
    if (file.size > MAX_LOGO_BYTES) { setErr(t('share.config.logoTooLarge')); return; }
    setReset(false);
    setPicked({ file, url: URL.createObjectURL(file) });
  };
  const save = async () => {
    if (!fields) return;
    setBusy(true); setErr(null);
    const { config, secrets } = splitValues(fields, values);
    try {
      if (picked) await api.ownerPostBytes(`/apps/${encodeURIComponent(slug)}/logo`, picked.file);
      else if (reset) await api.ownerPost(`/apps/${encodeURIComponent(slug)}/logo/reset`, {});
      if (fields.length) await api.ownerPost(`/apps/${encodeURIComponent(slug)}/config`, { values: config, secrets });
      onDone(); onClose();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const custom = picked !== null || (hasLogo && !reset);
  return (
    <Sheet title={t('share.config.titleOf', { name })} onClose={onClose} foot={<>
      <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button>
      <button type="button" className="app-card__launch" disabled={!fields || busy || converting} onClick={() => void save()}>{t('share.config.save')}</button>
    </>}>
      <p className="share-muted">{t('share.config.where')}</p>
      {!fields && !err && <p className="share-muted">{t('share.checking')}</p>}
      {fields && (
        <div className="share-field share-field--logo">
          <span>{t('share.config.logo')}</span>
          <div className="share-logo-row">
            <AppIcon src={picked ? picked.url : reset ? (iconSrc ? `${iconSrc}&own=1` : null) : iconSrc} name={name} slug={slug} size={48} />
            <button type="button" className="app-card__stop" onClick={() => fileRef.current?.click()}>{t('share.config.logoPick')}</button>
            {custom && <button type="button" className="share-link" onClick={() => { setPicked(null); setReset(hasLogo); }}>{t('share.config.logoReset')}</button>}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,.svg" hidden onChange={(e) => void onFile(e)} />
          </div>
          <small className="share-muted">{t('share.config.logoHint')}</small>
        </div>
      )}
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

