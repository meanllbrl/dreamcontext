import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { fill } from './HandsfreeParts';
import { macAction, useMacStatus } from './macStore';

/**
 * Settings → Hands-free → the Mac mode's fixed phone address: a hostname on the owner's own
 * Cloudflare domain (a locally-managed named tunnel), so the phone link survives restarts.
 * Setup opens Cloudflare in the browser to authorise the domain; the tunnel's credentials stay
 * in `~/.dreamcontext/handsfree-mac` and never come back through any route.
 */
export function MacFixedAddress() {
  const { t } = useI18n();
  const status = useMacStatus();
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The hostname already has a DNS record: replacing it is the owner's explicit second click.
  const [inUse, setInUse] = useState<string | null>(null);
  if (!status) return null;
  const locked = status.phase !== 'off';

  const setup = async (overwrite = false) => {
    const hostname = host.trim();
    setBusy(true);
    setError(null);
    setInUse(null);
    const r = await macAction<{ hostname: string }>('post', 'tunnel/fixed', { hostname, ...(overwrite ? { overwrite: true } : {}) });
    setBusy(false);
    if (!r.ok && r.code === 'mac_hostname_in_use') setInUse(hostname);
    else if (!r.ok) setError(fill(t('handsfree.mac.error'), { msg: r.message }));
    else setHost('');
  };
  const remove = async () => {
    const r = await macAction('delete', 'tunnel/fixed');
    if (!r.ok) setError(fill(t('handsfree.mac.error'), { msg: r.message }));
  };

  return (
    <div className="hf-settings-devices" data-testid="hf-mac-fixed">
      <h4>{t('handsfree.mac.fixedTitle')}</h4>
      <p className="hf-quiet">{t('handsfree.mac.fixedLead')}</p>
      {status.fixedHostname ? (
        <div className="hf-actions">
          <code className="hf-mono">{fill(t('handsfree.mac.fixedCurrent'), { host: status.fixedHostname })}</code>
          <button type="button" className="hf-btn hf-btn--sm" disabled={locked} onClick={() => void remove()}>{t('handsfree.mac.fixedRemove')}</button>
        </div>
      ) : (
        <div className="hf-actions">
          <input
            className="hf-input"
            type="text"
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t('handsfree.mac.fixedPlaceholder')}
            value={host}
            onChange={(e) => { setHost(e.target.value); setInUse(null); }}
            aria-label={t('handsfree.mac.fixedTitle')}
            disabled={busy || locked}
          />
          <button type="button" className="hf-btn hf-btn--primary" disabled={busy || locked || !host.trim()} onClick={() => void setup(false)}>{t('handsfree.mac.fixedSetup')}</button>
        </div>
      )}
      {inUse && !busy && (
        <div className="hf-error" role="alert" data-testid="hf-mac-fixed-in-use">
          <p>{fill(t('handsfree.mac.fixedInUse'), { host: inUse })}</p>
          <div className="hf-actions">
            <button type="button" className="hf-btn hf-btn--sm" onClick={() => void setup(true)}>{t('handsfree.mac.fixedReplace')}</button>
            <button type="button" className="hf-btn hf-btn--sm" onClick={() => setInUse(null)}>{t('handsfree.mac.fixedKeep')}</button>
          </div>
        </div>
      )}
      {busy && <p className="hf-quiet" role="status">{t('handsfree.mac.fixedWorking')}</p>}
      {error && <div className="hf-error" role="alert">{error}</div>}
    </div>
  );
}
