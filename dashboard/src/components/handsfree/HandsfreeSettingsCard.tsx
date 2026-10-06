import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { isDesktop } from '../../lib/desktop';
import { RunCard } from '../sleepy/chat/RunCard';
import { startHandsfreeJob } from './handsfreeActions';
import { openHandsfreeReceipt, useHandsfree } from './handsfreeStore';
import { coreHours, fill, InlineConfirm } from './HandsfreeParts';
import { HANDSFREE_PUBLIC, handsfreeVisible } from './handsfreeReveal';
import '../sleepy/chat/ChatViews.css';
import './handsfree.css';

/** The CLI-only hands-free commands, each launched from the existing run card (a real PTY). */
const RUNS = [
  { id: 'hf-run-setup', command: 'dreamcontext handsfree setup', why: 'handsfree.settings.run.setup' },
  { id: 'hf-run-password', command: 'dreamcontext handsfree password', why: 'handsfree.settings.run.password' },
  { id: 'hf-run-accounts', command: 'dreamcontext handsfree account-login --all', why: 'handsfree.settings.run.accounts' },
  { id: 'hf-run-teardown', command: 'dreamcontext handsfree teardown', why: 'handsfree.settings.run.teardown' },
] as const;

/**
 * Settings → hands-free: is it set up, which machine, the phase, the month's uptime against
 * the quota, the phone verifier (generation + anything still pending), "Sign out every phone",
 * the last trip's receipt, and run cards for setup / password / account logins / teardown.
 */
export function HandsfreeSettingsCard() {
  const { t } = useI18n();
  const { status, unavailable, job } = useHandsfree();
  const [error, setError] = useState<string | null>(null);
  if (!isDesktop() || unavailable) return null;
  if (!status) return HANDSFREE_PUBLIC ? <p className="hf-quiet" role="status">{t('handsfree.settings.loading')}</p> : null;
  if (!handsfreeVisible(status)) return null;

  const cores = status.codespace?.machine && /^standard/i.test(status.codespace.machine) ? 4 : 2;
  const revoking = job?.kind === 'revoke-all' && job.status === 'running';
  const revokeResult = job?.kind === 'revoke-all' && job.status === 'success' ? job.result as { generation: number; confirmed: boolean } : null;
  const v = status.verifier;

  return (
    <div className="hf-settings" data-testid="hf-settings">
      <h3 className="hf-settings-title">{t('handsfree.settings.title')}</h3>
      <p className="hf-quiet">{t('handsfree.settings.lead')}</p>
      <dl className="hf-facts">
        <dt>{t('handsfree.settings.setUp')}</dt>
        <dd data-testid="hf-settings-setup">{status.setUp ? t('handsfree.yes') : t('handsfree.settings.notSetUp')}</dd>
        <dt>{t('handsfree.settings.machine')}</dt>
        <dd>{status.codespace ? `${status.codespace.name} · ${status.codespace.machine} · ${status.codespace.state}` : status.url ?? t('handsfree.unknown')}</dd>
        <dt>{t('handsfree.settings.phase')}</dt>
        <dd data-testid="hf-settings-phase">{t(`handsfree.phase.${status.phase}`)}{status.tripId ? ` · ${status.tripId}` : ''}</dd>
        <dt>{t('handsfree.settings.uptime')}</dt>
        <dd>{fill(t('handsfree.settings.uptimeValue'), { used: coreHours(status.uptime.usedCoreMinutes, cores), budget: coreHours(status.uptime.budgetCoreMinutes, cores) })}</dd>
        <dt>{t('handsfree.settings.verifier')}</dt>
        <dd data-testid="hf-settings-verifier">
          {v ? fill(t('handsfree.settings.verifierValue'), { generation: v.generation, confirmed: v.confirmed }) : t('handsfree.unknown')}
          {v?.pending && <span className="hf-chip" data-tone="warn">{fill(t('handsfree.settings.pending'), { kind: v.pending.kind, generation: v.pending.generation })}</span>}
        </dd>
        {status.lastTrip && (
          <>
            <dt>{t('handsfree.settings.lastTrip')}</dt>
            <dd>
              {status.lastTrip.tripId} · {status.lastTrip.status} · {new Date(status.lastTrip.at).toLocaleString()}
              {' '}
              <button type="button" className="hf-btn hf-btn--sm" onClick={() => openHandsfreeReceipt(status.lastTrip!.tripId)} data-testid="hf-settings-receipt">{t('handsfree.settings.showReceipt')}</button>
            </dd>
          </>
        )}
      </dl>

      {status.setUp && (
        <div className="hf-settings-devices">
          <h4>{t('handsfree.settings.devices')}</h4>
          <p className="hf-quiet">{t('handsfree.settings.devicesLead')}</p>
          <InlineConfirm
            label={t('handsfree.settings.revokeAll')}
            confirmLabel={t('handsfree.settings.revokeAll.confirm')}
            body={<p>{t('handsfree.settings.revokeAll.body')}</p>}
            onConfirm={() => { void startHandsfreeJob('devices/revoke-all').then((r) => setError(r.ok ? null : r.message)); }}
            busy={revoking}
            danger
            testId="hf-revoke-all"
          />
          {revokeResult && (
            <p className="hf-quiet" role="status">{revokeResult.confirmed ? t('handsfree.settings.revoked') : t('handsfree.settings.revokePending')}</p>
          )}
          {error && <div className="hf-error" role="alert">{error}</div>}
        </div>
      )}

      <div className="hf-settings-runs">
        {RUNS.filter((r) => status.setUp || r.id === 'hf-run-setup').map((r) => (
          <RunCard key={r.id} spec={{ type: 'run', id: r.id, command: r.command, why: t(r.why) }} />
        ))}
      </div>
    </div>
  );
}
