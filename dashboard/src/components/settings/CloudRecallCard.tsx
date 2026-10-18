import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RequestError } from '../../api/client';
import { useI18n } from '../../context/I18nContext';
import { confirmAction } from '../../lib/desktop';
import { isPhoneSurface } from '../../lib/phoneSurface';
import {
  CLOUD_RECALL_QUERY_KEYS,
  useBuildCloudIndex,
  useCloudIndexStatus,
  useCloudRecallStatus,
  useCopyVoiceKey,
  useDisableCloudRecall,
  useEnableCloudRecall,
  useSetCloudKey,
  type CloudTier,
} from '../../hooks/useCloudRecall';
import './CloudRecallCard.css';
import { fill } from '../../lib/fill';

/**
 * Cloud recall, under the Hybrid recall choice. Opt-in and per vault: nothing leaves this computer
 * until the person has read what would be sent (the disclosure text the CLI shows too) and pressed
 * the button under it. The key is write-only — typed or copied in, never rendered back.
 */

const TIERS: readonly CloudTier[] = ['cloud-index', 'cloud'];

function usd(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="embed-model-bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="embed-model-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export interface CloudRecallCardProps {
  /**
   * Show the card for ONE tier (the recall option card it sits under): only that tier's review
   * button, and the enable flow whenever that tier is not the one currently on. Without it the card
   * offers both tiers, as it did under Hybrid.
   */
  tier?: CloudTier;
  /** Called after cloud recall was turned on (the server also set the recall mode) or off. */
  onEnabled?: () => void;
  onDisabled?: () => void;
  /** Called when the person backs out of the review (Cancel): the parent can close the setup. */
  onCancel?: () => void;
}

export function CloudRecallCard({ tier: onlyTier, onEnabled, onDisabled, onCancel }: CloudRecallCardProps = {}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: status, isLoading, isError } = useCloudRecallStatus();
  const consentGiven = status?.consent === 'valid' && status.tier !== 'local';
  const { data: index } = useCloudIndexStatus(consentGiven);

  const setKey = useSetCloudKey();
  const copyVoice = useCopyVoiceKey();
  const enable = useEnableCloudRecall();
  const disable = useDisableCloudRecall();
  const build = useBuildCloudIndex();

  const [keyDraft, setKeyDraft] = useState('');
  const [reviewing, setReviewing] = useState<CloudTier | null>(onlyTier ?? null);
  const [problem, setProblem] = useState<string | null>(null);

  // A finished build changes coverage and spend: refresh the status once, when the build stops.
  const lastIndexState = useRef(index?.state);
  useEffect(() => {
    if (lastIndexState.current === 'building' && index?.state !== 'building') {
      void queryClient.invalidateQueries({ queryKey: CLOUD_RECALL_QUERY_KEYS.status });
    }
    lastIndexState.current = index?.state;
  }, [index?.state, queryClient]);

  if (isPhoneSurface()) return null;
  if (isLoading) {
    return (
      <div className="embed-model-card cloud-recall">
        <span className="embed-model-status embed-model-status--muted">{t('settings.recall.cloud.checking')}</span>
      </div>
    );
  }
  if (isError || !status) {
    return (
      <div className="embed-model-card cloud-recall">
        <p className="settings-field-hint">{t('settings.recall.cloud.unavailable')}</p>
      </div>
    );
  }

  /** A route's `error` slug → words the person can read; unknown slugs get the generic line. */
  const describe = (code: string | null | undefined): string => {
    const key = `settings.recall.cloud.err.${code ?? 'generic'}`;
    const text = t(key);
    return text === key ? t('settings.recall.cloud.err.generic') : text;
  };
  const fail = (err: unknown): void => setProblem(describe(err instanceof RequestError ? err.code : null));

  const busy = setKey.isPending || copyVoice.isPending || enable.isPending || disable.isPending;

  const onSaveKey = (e: FormEvent): void => {
    e.preventDefault();
    const value = keyDraft.trim();
    if (!value) return;
    setProblem(null);
    setKey.mutate(value, {
      // The page forgets the key the moment it is sent.
      onSuccess: () => setKeyDraft(''),
      onError: fail,
    });
  };

  const onCopyVoice = (): void => {
    void (async () => {
      setProblem(null);
      const ok = await confirmAction({
        title: t('settings.recall.cloud.copy_voice.title'),
        body: t('settings.recall.cloud.copy_voice.body'),
        confirmLabel: t('settings.recall.cloud.copy_voice.confirm'),
      });
      if (ok) copyVoice.mutate(undefined, { onError: fail });
    })();
  };

  const onEnable = (tier: CloudTier): void => {
    if (!status.disclosure) return;
    setProblem(null);
    enable.mutate(
      { tier, rerankModel: tier === 'cloud' ? status.defaultRerankModel : null, disclosureVersion: status.disclosure.version },
      {
        onSuccess: () => {
          setReviewing(null);
          onEnabled?.();
          // The person agreed to the cloud index being built: start it, as the terminal does.
          build.mutate(undefined, { onError: fail });
        },
        onError: fail,
      },
    );
  };

  const onDisable = (): void => {
    setProblem(null);
    disable.mutate(undefined, { onSuccess: () => onDisabled?.(), onError: fail });
  };

  const tierLabel = t(`settings.recall.cloud.tier.${status.tier}`);
  const consentText = status.consent === 'valid'
    ? t(status.consentSurface === 'dashboard' ? 'settings.recall.cloud.consent.valid_dashboard' : 'settings.recall.cloud.consent.valid_cli')
    : t(status.consent === 're-consent-required' ? 'settings.recall.cloud.consent.stale' : 'settings.recall.cloud.consent.none');
  const keyText = !status.key
    ? t('settings.recall.cloud.key.none')
    : `${t(status.keySource === 'env' ? 'settings.recall.cloud.key.present_env' : 'settings.recall.cloud.key.present_file')}${status.keyOrigin === 'voice-copy' ? ` ${t('settings.recall.cloud.key.from_voice')}` : ''}`;

  const tiers = onlyTier ? [onlyTier] : TIERS;
  // For a single tier "on" means THAT tier: another tier being on means this one still needs enabling.
  const isOn = status.consent === 'valid' && status.tier !== 'local' && (!onlyTier || status.tier === onlyTier);

  return (
    <div className={`embed-model-card cloud-recall${status.tier !== 'local' ? ' embed-model-card--ready' : ''}`}>
      {!onlyTier && (
        <>
          <div className="embed-model-row">
            <span className="embed-model-status">{t('settings.recall.cloud.title')}</span>
            <span className={`embed-model-status ${status.tier === 'local' ? 'embed-model-status--muted' : 'embed-model-status--ready'}`}>{tierLabel}</span>
          </div>
          <p className="settings-field-hint">{t('settings.recall.cloud.intro')}</p>
        </>
      )}

      <dl className="cloud-recall-facts">
        <dt>{t('settings.recall.cloud.consent')}</dt>
        <dd>{consentText}</dd>
        <dt>{t('settings.recall.cloud.key')}</dt>
        <dd>{keyText}</dd>
        {status.tier !== 'local' && (
          <>
            <dt>{t('settings.recall.cloud.spend')}</dt>
            <dd>
              {fill(t('settings.recall.cloud.spend.summary'), { usd: usd(status.spend.vaultLifetimeUsd), queries: String(status.spend.todayQueries), max: String(status.spend.maxQueriesPerDay) })}
            </dd>
          </>
        )}
      </dl>

      {/* The key: write-only. The field never receives a value from the server. */}
      <form className="cloud-recall-key" onSubmit={onSaveKey}>
        <label className="cloud-recall-label" htmlFor="cloud-recall-key-input">{t('settings.recall.cloud.key.input_label')}</label>
        <div className="cloud-recall-key-row">
          <input
            id="cloud-recall-key-input"
            className="settings-text-input cloud-recall-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyDraft}
            placeholder={t('settings.recall.cloud.key.placeholder')}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <button type="submit" className="embed-model-btn" disabled={busy || keyDraft.trim() === ''}>
            {setKey.isPending ? t('settings.recall.cloud.saving') : t('settings.recall.cloud.key.save')}
          </button>
          <button
            type="button"
            className="embed-model-btn"
            disabled={busy || !status.voiceKeyAvailable}
            title={status.voiceKeyAvailable ? undefined : t('settings.recall.cloud.key.no_voice')}
            onClick={onCopyVoice}
          >
            {t('settings.recall.cloud.key.copy_voice')}
          </button>
        </div>
      </form>

      {!isOn ? (
        <div className="cloud-recall-tiers">
          <div className="cloud-recall-tier-buttons">
            {tiers.map((tier) => (
              <button
                key={tier}
                type="button"
                className={`embed-model-btn${reviewing === tier ? ' embed-model-btn--primary' : ''}`}
                disabled={busy || !status.key || !status.disclosure}
                aria-pressed={reviewing === tier}
                onClick={() => setReviewing(reviewing === tier ? null : tier)}
              >
                {t(`settings.recall.cloud.review.${tier}`)}
              </button>
            ))}
          </div>
          {!status.key && <p className="settings-field-hint">{t('settings.recall.cloud.needs_key')}</p>}
          {status.consent === 're-consent-required' && <p className="settings-field-hint settings-field-hint--warn">{t('settings.recall.cloud.consent.stale_hint')}</p>}
          {reviewing && status.disclosure && (
            <section className="cloud-recall-disclosure" aria-label={t('settings.recall.cloud.disclosure.title')}>
              <h4 className="cloud-recall-disclosure-title">{t('settings.recall.cloud.disclosure.title')}</h4>
              <p className="settings-field-hint">{t(`settings.recall.cloud.tier.${reviewing}.hint`)}</p>
              <ul className="cloud-recall-disclosure-list">
                {status.disclosure.lines[reviewing].map((line, i) => <li key={i}>{line}</li>)}
              </ul>
              <div className="cloud-recall-tier-buttons">
                <button type="button" className="embed-model-btn embed-model-btn--primary" disabled={busy} onClick={() => onEnable(reviewing)}>
                  {enable.isPending ? t('settings.recall.cloud.enabling') : t('settings.recall.cloud.enable')}
                </button>
                <button type="button" className="embed-model-btn" disabled={busy} onClick={() => { setReviewing(null); onCancel?.(); }}>
                  {t('settings.recall.cloud.cancel')}
                </button>
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="cloud-recall-tiers">
          <IndexBlock status={status} index={index} building={build.isPending} onBuild={() => { setProblem(null); build.mutate(undefined, { onError: fail }); }} describe={describe} />
          <button type="button" className="embed-model-btn" disabled={busy} onClick={onDisable}>
            {disable.isPending ? t('settings.recall.cloud.disabling') : t('settings.recall.cloud.disable')}
          </button>
        </div>
      )}

      {problem && <p className="settings-test-err" role="alert">✗ {problem}</p>}
    </div>
  );
}

function IndexBlock({ status, index, building, onBuild, describe }: {
  status: NonNullable<ReturnType<typeof useCloudRecallStatus>['data']>;
  index: ReturnType<typeof useCloudIndexStatus>['data'];
  building: boolean;
  onBuild: () => void;
  describe: (code: string | null | undefined) => string;
}) {
  const { t } = useI18n();
  const running = index?.state === 'building';
  const coverage = index?.coverage ?? status.indexCoverage;
  return (
    <div className="cloud-recall-index">
      {running ? (
        <>
          <div className="embed-model-row">
            <span className="embed-model-status">⏳ {t('settings.recall.cloud.index.building')} {index.progress}%</span>
            {index.total > 0 && <span className="embed-model-meta">{index.done} / {index.total}</span>}
          </div>
          <ProgressBar pct={index.progress} label={t('settings.recall.cloud.index.building')} />
        </>
      ) : index?.state === 'error' ? (
        <span className="embed-model-status embed-model-status--error">✗ {t('settings.recall.cloud.index.failed')}: {describe(index.error)}</span>
      ) : status.indexReady || index?.state === 'ready' ? (
        <div className="embed-model-row">
          <span className="embed-model-status embed-model-status--ready">✓ {t('settings.recall.cloud.index.ready')}</span>
          {coverage && (
            <span className="embed-model-meta">
              {fill(t('settings.recall.cloud.index.coverage'), { covered: String(coverage.coveredDocs), total: String(coverage.eligibleTotal) })}
            </span>
          )}
        </div>
      ) : (
        <span className="embed-model-status embed-model-status--muted">{t('settings.recall.cloud.index.not_built')}</span>
      )}
      {status.churnGuard && <p className="settings-field-hint settings-field-hint--warn">{t('settings.recall.cloud.churn')}</p>}
      {!running && (
        <button type="button" className="embed-model-btn embed-model-btn--primary" disabled={building} onClick={onBuild}>
          {building ? t('settings.recall.cloud.enabling') : t(status.indexReady ? 'settings.recall.cloud.index.update' : 'settings.recall.cloud.index.build')}
        </button>
      )}
    </div>
  );
}
