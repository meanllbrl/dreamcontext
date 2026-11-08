import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { AppIcon } from './AppIcon';
import { About, CanList, FactStrip, ProductTop, Shots, WhatsNew, shortDate, type CanLine, type StoreEntry } from './StorePage';
import { Sheet, errText, useShareN, useShareT, type ConfigField, type GateFinding } from './Sheet';

/** Install as a store page (app-paylasim-magaza r2 section 1); settings are its second step. */

interface Preview {
  previewId: string; fullName: string; sha: string; publisher: string; publisherSince: string | null; repoUpdated: string | null; public: boolean;
  name: string; slug: string; license: string; warning: string; readme: string; config: ConfigField[];
  facts: { backend: string | null; build: string | null; mcp: string[]; agent: string | null; schedules: number; actions: number; dangerActions: number; dependencies: number; urls: string[] };
  icon?: string | null;
  store?: { readme: { tagline: string | null; category: string | null; about: string | null; whatsNew: StoreEntry[] }; shots: Array<{ alt: string; src: string }>; can: CanLine[] };
  gate: { ok: boolean; blocks: GateFinding[] };
}

export function ConfigInputs({ fields, values, setValues }: { fields: ConfigField[]; values: Record<string, string>; setValues: (v: Record<string, string>) => void }) {
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

export function splitValues(fields: ConfigField[], values: Record<string, string>) {
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
            note={(err || pageWhy) && <span className={err ? 'app-card__note app-card__note--bad pp-why' : 'share-why pp-why'} role={err ? 'alert' : undefined}>{err ?? pageWhy}</span>}
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
      {/* On the store page an error stands beside Install, where the owner is looking. */}
      {err && !(pv && step === 'page') && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}

