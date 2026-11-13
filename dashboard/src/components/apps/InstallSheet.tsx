import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApi, useVaultId } from '../../context/VaultContext';
import { installFailureOf, installFollowVersion, subscribeInstallFollow } from './installFollow';
import { About, CanList, FactStrip, ProductTop, Shots, WhatsNew, shortDate, type CanLine, type StoreEntry } from './StorePage';
import { Sheet, errText, useShareN, useShareT, type ConfigField, type GateFinding } from './Sheet';

/**
 * Install as a store page (app-paylasim-magaza r2 section 1). Its settings are Claude's by default
 * (owner 2026-11-13, app-kurulum-claude: "kişi bunu girmez ki"): Install installs at once and the
 * Apps page hands the settings to Claude in a chat of its own once the install is done (app-ux-genel
 * K8: the page that SEES the install finish does it, so closing this sheet loses nothing). "I'll fill
 * the settings myself" installs too, then opens the app's settings with pickers (K9).
 */

interface Preview {
  previewId: string; fullName: string; sha: string; publisher: string; publisherSince: string | null; repoUpdated: string | null; public: boolean;
  name: string; slug: string; license: string; warning: string; readme: string; config: ConfigField[];
  facts: { backend: string | null; build: string | null; mcp: string[]; agent: string | null; schedules: number; actions: number; dangerActions: number; dependencies: number; urls: string[] };
  icon?: string | null;
  store?: { readme: { tagline: string | null; category: string | null; about: string | null; whatsNew: StoreEntry[] }; shots: Array<{ alt: string; src: string }>; can: CanLine[] };
  gate: { ok: boolean; blocks: GateFinding[] };
}

/** How the settings go after the install: Claude's chat (the default), the owner's own form. */
export type SettingsWay = 'claude' | 'self';

/** Setting types the form offers as a pick list from this project (`GET /apps/:slug/config/suggest`). */
const PICKED = new Set(['insight', 'objective', 'agent', 'task-tag', 'mcp-tool']);

/**
 * The settings form (K9): required first, a pick list where this project has candidates (the same
 * list `apps config --suggest` prints), the author's hint under the field.
 */
export function ConfigInputs({ fields, values, setValues, suggest }: { fields: ConfigField[]; values: Record<string, string>; setValues: (v: Record<string, string>) => void; suggest?: Record<string, string[]> }) {
  const t = useShareT();
  const ordered = [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
  return (
    <>
      {ordered.map((f) => {
        const hint = f.find ?? f.help;
        const cur = values[f.key] ?? '';
        const options = f.type === 'choice' ? (f.choices ?? []) : PICKED.has(f.type) ? (suggest?.[f.key] ?? []) : [];
        const id = `cfg-${f.key}`;
        return (
          <div key={f.key} className="share-field">
            <label htmlFor={id}><span>{f.label}{f.required ? ' *' : ''}</span></label>
            {options.length > 0 ? (
              <select id={id} value={cur} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                <option value="">{t('share.install.pick')}</option>
                {cur && !options.includes(cur) && <option value={cur}>{cur}</option>}
                {options.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : f.type === 'secret' ? (
              // Uncontrolled: a typed key never becomes the input's value attribute in the DOM.
              <input id={id} type="password" autoComplete="off" placeholder={f.set ? t('share.config.secretSet') : ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ) : (
              <input id={id} type={f.type === 'number' ? 'number' : 'text'} autoComplete="off" value={cur}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
            {hint && <small className="share-muted share-field__hint">{hint}</small>}
          </div>
        );
      })}
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

export function InstallSheet({ initialRef, running, onStarted, onClose, onFinished }: {
  initialRef?: string;
  /** This repo is being installed right now (the server's list, K8): the button says so. */
  running?: (fullName: string) => boolean;
  /** Before the install request goes: the Apps page follows it from here on, whatever this sheet does. */
  onStarted: (start: { fullName: string; name: string; settings: number; way: SettingsWay }) => void;
  onClose: () => void;
  /** The install request answered (`error`: its refusal or failure): the install follow settles on
   *  it and the Apps page reads the server's list now instead of waiting. */
  onFinished: (fullName: string, error: string | null) => void;
}) {
  const api = useApi();
  const t = useShareT();
  const tn = useShareN();
  const [ref, setRef] = useState(initialRef ?? '');
  const [pv, setPv] = useState<Preview | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'install' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // An install's failure has one owner, the install follow: this sheet shows it whether it pressed
  // Install or was opened again while that install ran (review r2).
  const { vault } = useVaultId();
  useSyncExternalStore(subscribeInstallFollow, installFollowVersion);

  // Every ask gets its own number: only the newest answer lands, so an older ask's error never
  // sits under a newer, valid preview (the same link asked twice races too).
  const asked = useRef(0);
  const preview = async (r = ref) => {
    const n = ++asked.current;
    setBusy('preview'); setErr(null); setPv(null); setUnderstood(false);
    try {
      const v = await api.post<Preview>('/apps/install/preview', { ref: r });
      if (asked.current === n) setPv(v);
    } catch (e) { if (asked.current === n) setErr(errText(e)); } finally { if (asked.current === n) setBusy(null); }
  };
  // The opening preview goes once: a second, simultaneous fetch of the same repo can fail and
  // would then be the newest answer (React's dev double-run of effects does exactly that).
  const opened = useRef(false);
  useEffect(() => { if (initialRef && !opened.current) { opened.current = true; void preview(initialRef); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Install waits only for what the page asks (the gate, the tick); never for a setting.
  const pageWhy = !pv ? null : !pv.gate.ok ? t('share.install.refused') : pv.public && !understood ? t('share.install.tick') : null;
  const elsewhere = !!pv && busy !== 'install' && !!running?.(pv.fullName);
  const installing = busy === 'install' || elsewhere;
  const failed = pv && !installing ? installFailureOf(vault ?? '', pv.fullName) : null;

  // The install outlives this sheet (K8): once it is closed, or another app's sheet replaced it,
  // its answer must not close or touch whatever is open now. The follow reports the outcome.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const install = async (way: SettingsWay) => {
    if (!pv || installing) return;
    const fullName = pv.fullName;
    setBusy('install'); setErr(null);
    onStarted({ fullName, name: pv.name, settings: pv.config.length, way });
    try {
      // `ref` names the repo, so the server's in-flight list is keyed by it (K8).
      await api.ownerPost<{ slug: string }>('/apps/install', { previewId: pv.previewId, sha: pv.sha, ref: fullName });
      onFinished(fullName, null);
      if (mounted.current) onClose();
    } catch (e) {
      // The failure is told by the install follow (any sheet for this repo reads it), never here.
      onFinished(fullName, errText(e));
    } finally { if (mounted.current) setBusy(null); }
  };

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
    <button type="button" className="app-card__launch pp-btn-lg" disabled={!!pageWhy || busy !== null || installing} onClick={() => void install('claude')}>{installing ? t('share.install.installing') : t('share.install.go')}</button>
  );
  // Under Install: what is happening (one calm line while it runs), what stops it, or the second way.
  const note = installing ? (
    <span className="share-muted pp-why" role="status">{t('share.install.working')} {t('share.install.busyWhy')}</span>
  ) : (err || failed || pageWhy) ? (
    <span className={err || failed ? 'app-card__note app-card__note--bad pp-why' : 'share-why pp-why'} role={err || failed ? 'alert' : undefined}>{err ?? (failed ? t('share.install.failedWhy', { why: failed }) : pageWhy)}</span>
  ) : pv && pv.config.length > 0 ? (
    <span className="share-muted pp-why pp-claude">
      {t('share.install.claudeNote')}{' '}
      <button type="button" className="share-link" disabled={busy !== null} onClick={() => void install('self')}>{t('share.install.selfFill')}</button>
    </span>
  ) : null;

  return (
    <Sheet page={!!pv} title={pv ? t('share.install.titleOf', { name: pv.name }) : t('share.install.title')} onClose={onClose} foot={
      !pv ? <button type="button" className="app-card__stop" onClick={onClose}>{t('share.cancel')}</button> : undefined
    }>
      {!initialRef && (
        <form className="share-row pp-link" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
          <label className="share-field share-field--grow"><span>{t('share.install.link')}</span><input value={ref} disabled={installing} onChange={(e) => { setRef(e.target.value); asked.current++; setBusy((b) => (b === 'preview' ? null : b)); setPv(null); setUnderstood(false); }} placeholder="https://github.com/owner/repo" autoFocus /></label>
          <button type="submit" className="app-card__stop" disabled={!ref.trim() || busy !== null}>{busy === 'preview' ? t('share.checking') : t('share.install.look')}</button>
        </form>
      )}
      {busy === 'preview' && initialRef && <p className="share-muted">{t('share.checking')}</p>}
      {pv && f && (
        <>
          <ProductTop
            icon={pv.icon ?? null}
            name={pv.name}
            slug={pv.slug}
            by={pv.publisher}
            tagline={st?.readme.tagline}
            actions={<>{installBtn}<span className="app-chip">{chip}</span>{st?.readme.category && <span className="app-chip">{st.readme.category}</span>}</>}
            note={note}
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
                {(f.agent || f.mcp.length > 0 || f.dangerActions > 0) && (
                  <dl className="share-facts">
                    {f.agent && <div><dt>{t('share.install.assistant')}</dt><dd>{f.agent}</dd></div>}
                    {f.mcp.length > 0 && <div><dt>MCP</dt><dd>{f.mcp.join(', ')}</dd></div>}
                    {f.dangerActions > 0 && <div><dt>{t('share.install.does')}</dt><dd>{t('share.install.danger', { n: String(f.dangerActions) })}</dd></div>}
                  </dl>
                )}
                <p className="share-muted">{t('store.safety.nothing')}</p>
                {/* The technical lines are true but not what he decides on: folded (K5). */}
                <details className="share-details">
                  <summary>{t('share.install.details')}</summary>
                  <dl className="share-facts">
                    <div><dt>{t('share.install.runs')}</dt><dd>{f.backend ? <code>{f.backend}</code> : t('share.install.pageOnly')}{f.build ? <> · <code>{f.build}</code></> : null}</dd></div>
                    {f.dependencies > 0 && <div><dt>npm</dt><dd>{tn('share.install.deps', f.dependencies)}</dd></div>}
                    <div><dt>{t('share.install.talksTo')}</dt><dd>{f.urls.length ? f.urls.join(', ') : t('share.install.noUrls')}</dd></div>
                    <div><dt>{t('store.fact.repo')}</dt><dd>{pv.fullName} · {pv.public ? t('share.public') : t('share.private')} · {t(`share.license.${pv.license}`)}</dd></div>
                  </dl>
                </details>
                {!pv.gate.ok && <ul className="share-blocks">{pv.gate.blocks.map((b) => <li key={b.id}><code>{b.file}</code> {b.label}</li>)}</ul>}
                {pv.public && <label className="share-check"><input type="checkbox" checked={understood} disabled={installing} onChange={(e) => setUnderstood(e.target.checked)} /> {t('share.install.understand')}</label>}
              </div>
            </div>
          </section>
        </>
      )}
      {/* Before a preview an error stands under the link field. */}
      {err && !pv && <p className="app-card__note app-card__note--bad">{err}</p>}
    </Sheet>
  );
}
