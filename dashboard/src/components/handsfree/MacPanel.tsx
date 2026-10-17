import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { CopyButton, fill, HandsfreeQr } from './HandsfreeParts';
import { macAction, macDevices, refreshMacStatus, useMacStatus } from './macStore';
import type { MacDevice, MacStatus } from './macContract';

/**
 * The Hands-free sheet's "Bu Mac'ten" panel: set up once (one admin prompt; the phone password
 * is shown ONCE), Start (tunnel link + QR on click), the Mac's power state, the signed-in
 * phones with "Hepsini çıkar", the risk line, and Return. Everything it shows comes from
 * `/api/handsfree/mac/*`; nothing here holds a secret past the moment it is shown.
 */
/** `vault`: the project this window shows, pre-checked in the start checklist (AC16): the phone
 *  sees only the projects checked at start; changing them = Return + start again. */
export function MacPanel({ vault, onClose }: { vault: string; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const status = useMacStatus();
  const { data: registered } = useQuery({
    queryKey: ['mac-start-vaults'],
    queryFn: () => api.get<{ vaults: Array<{ name: string; exists: boolean }> }>('/vaults'),
    staleTime: 30_000,
    retry: false,
  });
  const projects = (registered?.vaults ?? []).filter((v) => v.exists).map((v) => v.name);
  const [chosen, setChosen] = useState<string[]>([vault]);
  const toggle = (name: string) => setChosen((c) => (c.includes(name) ? c.filter((n) => n !== name) : [...c, name]));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The passphrase, held only until the sheet closes (shown once). */
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [devices, setDevices] = useState<MacDevice[]>([]);
  const qrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phase = status?.phase ?? 'off';
  const ready = !!status?.setup.sudoers && !!status?.setup.passphrase;
  const deviceCount = status?.deviceCount ?? 0;

  // Opening the panel reads the state fresh: setup or start may have run from the CLI since the
  // last poll (up to 30 s ago while off).
  useEffect(() => { void refreshMacStatus(); }, []);
  const loadDevices = useCallback(async () => { setDevices(await macDevices()); }, []);
  useEffect(() => { if (phase === 'on') void loadDevices(); }, [phase, deviceCount, loadDevices]);

  // The QR is a one-time login: hidden after the first sign-in, or after its 5 minutes.
  const shownAtCount = useRef<number | null>(null);
  useEffect(() => {
    if (qr && shownAtCount.current !== null && deviceCount > shownAtCount.current) setQr(null);
  }, [deviceCount, qr]);
  useEffect(() => () => { if (qrTimer.current) clearTimeout(qrTimer.current); }, []);

  const act = async <T,>(key: string, method: 'post' | 'delete', path: string, body: Record<string, unknown> = {}): Promise<T | null> => {
    setBusy(key);
    setError(null);
    const r = await macAction<T>(method, path, body);
    setBusy(null);
    if (!r.ok) { setError(fill(t('handsfree.mac.error'), { msg: r.message })); return null; }
    return r.value;
  };

  const setup = async (newPassphrase = false) => {
    const r = await act<{ passphrase: string | null }>('setup', 'post', 'setup', { newPassphrase });
    if (r?.passphrase) setPassphrase(r.passphrase);
  };
  const newPassword = async () => {
    const r = await act<{ passphrase: string }>('password', 'post', 'password');
    if (r?.passphrase) setPassphrase(r.passphrase);
  };
  const startVaults = chosen.filter((n) => projects.includes(n));
  const start = async () => { await act<MacStatus>('start', 'post', 'start', { vaults: startVaults }); };
  const showQr = async () => {
    const r = await act<{ url: string }>('qr', 'post', 'qr');
    if (!r) return;
    setQr(r.url);
    shownAtCount.current = deviceCount;
    if (qrTimer.current) clearTimeout(qrTimer.current);
    qrTimer.current = setTimeout(() => setQr(null), 5 * 60_000);
  };
  const revokeAll = async () => { await act('revoke', 'post', 'devices/revoke-all'); setQr(null); void loadDevices(); };
  const stop = async () => { await act('stop', 'post', 'stop'); setQr(null); void refreshMacStatus(); };

  return (
    <section className="hf-sheet-body hf-mac" data-testid="hf-mac-panel" data-phase={phase}>
      {passphrase && (
        <div className="hf-mac-pass" data-testid="hf-mac-pass">
          <p className="hf-quiet">{t('handsfree.mac.passOnce')}</p>
          <code className="hf-mono hf-mac-pass-value">{passphrase}</code>
          <div className="hf-actions"><CopyButton text={passphrase} testId="hf-mac-copy-pass" /></div>
        </div>
      )}

      {phase === 'off' && !ready && (
        <>
          <p className="hf-lead">{t('handsfree.mac.setupLead')}</p>
          <div className="hf-actions hf-actions--end">
            <button type="button" className="hf-btn" onClick={onClose}>{t('handsfree.cancel')}</button>
            <button type="button" className="hf-btn hf-btn--primary" data-testid="hf-mac-setup" disabled={!!busy} onClick={() => void setup()}>
              {busy === 'setup' ? t('handsfree.mac.settingUp') : t('handsfree.mac.setup')}
            </button>
          </div>
        </>
      )}

      {phase === 'off' && ready && (
        <>
          <p className="hf-lead">{t('handsfree.mac.modeMacSub')}</p>
          <p className="hf-quiet">{status?.mode === 'fixed' && status.fixedHostname ? fill(t('handsfree.mac.fixedCurrent'), { host: status.fixedHostname }) : t('handsfree.mac.fixedLead')}</p>
          <fieldset className="hf-mac-projects" data-testid="hf-mac-projects">
            <legend className="hf-quiet">{t('handsfree.mac.projects')}</legend>
            {projects.map((name) => (
              <label key={name} className="hf-mac-project">
                <input type="checkbox" checked={chosen.includes(name)} onChange={() => toggle(name)} disabled={!!busy} />
                <span>{name}</span>
              </label>
            ))}
          </fieldset>
          <div className="hf-actions hf-actions--end">
            <button type="button" className="hf-btn" disabled={!!busy} onClick={() => void newPassword()}>{t('handsfree.mac.newPassword')}</button>
            <button type="button" className="hf-btn hf-btn--primary" data-testid="hf-mac-start" disabled={!!busy || startVaults.length === 0} onClick={() => void start()}>
              {busy === 'start' ? t('handsfree.mac.starting') : t('handsfree.mac.start')}
            </button>
          </div>
        </>
      )}

      {phase === 'starting' && <p className="hf-quiet" role="status">{t('handsfree.mac.starting')}</p>}

      {(phase === 'on' || phase === 'stopping') && status && (
        <>
          <div className="hf-mac-address">
            <p className="hf-quiet">{t('handsfree.mac.address')}</p>
            {status.url && <code className="hf-mono hf-url" data-testid="hf-mac-url">{status.url}</code>}
            <div className="hf-actions">
              {status.url && <CopyButton text={status.url} testId="hf-mac-copy-url" />}
              <button type="button" className="hf-btn" data-testid="hf-mac-show-qr" disabled={!!busy || !status.url} onClick={() => void showQr()}>{t('handsfree.mac.showQr')}</button>
            </div>
            {qr && (
              <div className="hf-link" data-testid="hf-mac-qr">
                <HandsfreeQr value={qr} label={t('handsfree.mac.showQr')} />
                <p className="hf-quiet">{t('handsfree.mac.qrHint')}</p>
              </div>
            )}
            <p className="hf-quiet">{t('handsfree.mac.passHint')}</p>
            {status.exposedVaults.length > 0 && (
              <p className="hf-quiet" data-testid="hf-mac-exposed">{fill(t('handsfree.mac.exposed'), { list: status.exposedVaults.join(', ') })}</p>
            )}
            {status.mode === 'quick' && <p className="hf-quiet" data-testid="hf-mac-push-needs-fixed">{t('handsfree.mac.pushNeedsFixed')}</p>}
          </div>

          <div className="hf-mac-power" data-testid="hf-mac-power">
            <p className="hf-quiet">
              {status.sleepAllowed ? t('handsfree.mac.sleepAllowed') : t('handsfree.mac.power')}
              {status.battery.percent !== null && <> · {fill(t('handsfree.mac.battery'), { pct: String(status.battery.percent) })}</>}
            </p>
            {(status.thermal?.slowed ?? 0) > 0 && (
              <p className="hf-quiet" data-testid="hf-mac-thermal">{fill(t('handsfree.mac.thermalSlowed'), { n: String(status.thermal.slowed) })}</p>
            )}
          </div>

          <div className="hf-mac-devices" data-testid="hf-mac-devices">
            <div className="hf-mac-row">
              <p className="hf-quiet">{t('handsfree.mac.devices')}</p>
              <button type="button" className="hf-btn hf-btn--sm hf-btn--danger-quiet" data-testid="hf-mac-revoke-all" disabled={!!busy || devices.length === 0} onClick={() => void revokeAll()}>{t('handsfree.mac.revokeAll')}</button>
            </div>
            {devices.length === 0 ? <p className="hf-quiet">{t('handsfree.mac.noDevices')}</p> : (
              <ul className="hf-mac-device-list">
                {devices.map((d) => <li key={d.id}>{d.label} <span className="hf-quiet">{new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></li>)}
              </ul>
            )}
          </div>

          <p className="hf-mac-risk" data-testid="hf-mac-risk">{t('handsfree.mac.risk')}</p>
          <div className="hf-actions hf-actions--end">
            <button type="button" className="hf-btn hf-btn--primary" data-testid="hf-mac-return" disabled={!!busy || phase === 'stopping'} onClick={() => void stop()}>{t('handsfree.mac.return')}</button>
          </div>
        </>
      )}

      {error && <div className="hf-error" role="alert">{error}</div>}
    </section>
  );
}
