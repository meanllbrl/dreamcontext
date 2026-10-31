import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useCodexAccounts, type ToolAccountWire } from '../../hooks/useAgentCapabilities';
import { Bar, ageLabel, fmtLeft, resetLabel } from './ClaudeAccounts';
import './ClaudeAccounts.css';

/**
 * Connected Codex (ChatGPT) accounts, beside the Claude ones (Track T W2, plan r5 §4b).
 *
 * The same panel shape as `ClaudeAccounts`, on purpose: two providers whose 5-hour and weekly
 * windows read the same way can be compared at a glance. What differs is only the sign-in:
 * "Add an account" runs `codex login` inside a new private folder, the browser does the ChatGPT
 * sign-in, and this panel learns an email and a plan, never a credential.
 *
 * The first row is `~/.codex`, this machine's own Codex sign-in. Removing it only hides it here
 * (its folder and sign-in stay); removing any other account signs it out and deletes its folder.
 * Removal is a two-step button, never a browser `confirm()`: that is a silent no-op in the
 * desktop app's web view.
 */

const STALE_AFTER_MS = 10 * 60 * 1000;

/** "plus" → "Plus". ChatGPT's plan names. */
function planLabel(plan: string): string {
  const p = plan.trim();
  if (!p) return '';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function CodexAccounts() {
  const api = useApi();
  const qc = useQueryClient();
  const { t } = useI18n();
  const { data, isLoading, dataUpdatedAt } = useCodexAccounts(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const [confirmRemove, setConfirmRemove] = useState('');

  const accounts: ToolAccountWire[] = data?.accounts ?? [];
  const startsHereId = data?.nextSessionAccountId ?? accounts[0]?.id ?? null;

  const refetch = useCallback(() => { void qc.invalidateQueries({ queryKey: ['agent-codex-accounts'] }); }, [qc]);

  const run = useCallback(async (tag: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(tag);
    setError('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error)?.message || t('settings.codexAccounts.failed'));
      return false;
    } finally {
      setBusy('');
      refetch();
    }
  }, [refetch, t]);

  const refreshUsage = useCallback(async () => {
    setRefreshing(true);
    setNote('');
    try {
      const res = await api.post<{ refreshed: string[]; failed: { id: string; why: string }[] }>('/agent/accounts/codex/refresh', {});
      setNote(res.refreshed.length > 0 ? t('settings.codexAccounts.updated').replace('{n}', String(res.refreshed.length)) : t('settings.codexAccounts.notReread'));
    } catch (e) {
      setError((e as Error)?.message || t('settings.codexAccounts.failed'));
    } finally {
      setRefreshing(false);
      refetch();
    }
  }, [api, refetch, t]);

  // Read once on open when the oldest reading is stale (the list route never probes).
  const autoProbed = useRef(false);
  useEffect(() => {
    if (autoProbed.current || refreshing || accounts.length === 0) return;
    const oldest = Math.min(...accounts.map((a) => a.fetchedAtMs ?? 0));
    if (Date.now() - oldest <= STALE_AFTER_MS) return;
    autoProbed.current = true;
    void refreshUsage();
  }, [accounts, refreshing, refreshUsage]);

  const add = () => run('add', () => api.post('/agent/accounts/codex/login', {}));
  const remove = (id: string) => run(`remove-${id}`, () => api.post('/agent/accounts/codex/remove', { id })).then(() => setConfirmRemove(''));
  const nudge = (id: string, delta: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = ids.slice();
    next.splice(to, 0, next.splice(from, 1)[0]!);
    void run('order', () => api.post('/agent/accounts/codex/reorder', { ids: next }));
  };

  if (isLoading) return <p className="settings-field-hint">{t('common.loading')}</p>;
  const now = Math.max(Date.now(), dataUpdatedAt);

  return (
    <div className="dc-accts" data-testid="codex-accounts">
      {accounts.length === 0 ? (
        <p className="settings-field-hint">{t('settings.codexAccounts.none')}</p>
      ) : (
        <>
          <div className="dc-acct-toolbar">
            <span className="dc-acct-toolbar-note">{t('settings.codexAccounts.note')}</span>
            <div className="dc-acct-toolbar-right">
              {note && <span className="dc-acct-refresh-note">{note}</span>}
              <button type="button" className="btn btn--secondary btn--sm" disabled={refreshing || busy !== ''} onClick={() => void refreshUsage()}>
                {refreshing ? t('settings.codexAccounts.refreshing') : t('settings.codexAccounts.refresh')}
              </button>
            </div>
          </div>
          <ol className="dc-acct-list">
            {accounts.map((a, i) => {
              const session = a.limits.find((l) => l.key === 'session');
              const weekly = a.limits.find((l) => l.key === 'weekly');
              const signedOut = a.state === 'needs-relogin';
              // ChatGPT Free/Go: one monthly window and no 5-hour or weekly one (T3's mapping).
              const monthly = a.windows.find((w) => w.kind === 'monthly' && w.resetsAt);
              const age = ageLabel(a.fetchedAtMs);
              return (
                <li key={a.id} className={`dc-acct${signedOut ? ' is-stale' : ''}${a.id === startsHereId ? ' is-top' : ''}`} data-testid={`codex-account-${a.id}`}>
                  <span className="dc-acct-grip" aria-hidden="true">⠿</span>
                  <div className="dc-acct-main">
                    <div className="dc-acct-head">
                      <span className="dc-acct-rank" aria-hidden="true">{i + 1}</span>
                      <span className="dc-acct-who">{a.email || (a.isPrimary ? t('settings.codexAccounts.thisMachine') : a.id)}</span>
                      {a.planType && <span className="dc-acct-plan">ChatGPT {planLabel(a.planType)}</span>}
                      {a.id === startsHereId && <span className="dc-acct-tag dc-acct-tag--top">{t('settings.codexAccounts.startsHere')}</span>}
                      {a.refusedUntil && a.refusedUntil > now && (
                        <span className="dc-acct-tag dc-acct-tag--refused" title={resetLabel(a.refusedUntil)}>
                          {t('settings.codexAccounts.limitHit').replace('{left}', fmtLeft(a.refusedUntil - now))}
                        </span>
                      )}
                      {a.isPrimary && <span className="dc-acct-tag">~/.codex</span>}
                    </div>
                    {signedOut && <p className="dc-acct-warn">{t('settings.codexAccounts.signedOut')}</p>}
                    <div className={`dc-acct-bars${refreshing ? ' is-refreshing' : ''}`}>
                      <Bar label={t('settings.codexAccounts.session')} percent={signedOut || !session ? null : session.percent} resetsAt={session?.resetsAt ?? 0} now={now} />
                      <Bar label={t('settings.codexAccounts.weekly')} percent={signedOut || !weekly ? null : weekly.percent} resetsAt={weekly?.resetsAt ?? 0} now={now} />
                      {monthly && (
                        <Bar label={t('settings.codexAccounts.monthly')} percent={signedOut ? null : monthly.usedPercent} resetsAt={Date.parse(monthly.resetsAt!)} now={now} />
                      )}
                    </div>
                    {!signedOut && <p className={`dc-acct-age${age.stale ? ' is-stale' : ''}`}>{refreshing ? t('settings.codexAccounts.reading') : age.text}</p>}
                  </div>
                  <div className="dc-acct-side">
                    <div className="dc-acct-move">
                      <button type="button" className="dc-acct-move-btn" disabled={i === 0 || busy !== ''} aria-label={t('settings.codexAccounts.up')} onClick={() => nudge(a.id, -1)}>↑</button>
                      <button type="button" className="dc-acct-move-btn" disabled={i === accounts.length - 1 || busy !== ''} aria-label={t('settings.codexAccounts.down')} onClick={() => nudge(a.id, 1)}>↓</button>
                    </div>
                    {confirmRemove === a.id ? (
                      <button type="button" className="btn btn--danger-ghost btn--sm" disabled={busy !== ''} onClick={() => void remove(a.id)}>
                        {a.isPrimary ? t('settings.codexAccounts.confirmHide') : t('settings.codexAccounts.confirmRemove')}
                      </button>
                    ) : (
                      <button type="button" className="btn btn--danger-ghost btn--sm" disabled={busy !== ''} onClick={() => setConfirmRemove(a.id)}>
                        {t('settings.codexAccounts.remove')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
      <div className="dc-acct-foot">
        <div className="dc-acct-add-row">
          <button type="button" className="btn btn--secondary" disabled={busy !== ''} onClick={() => void add()} data-testid="codex-add-account">
            {busy === 'add' ? t('settings.codexAccounts.adding') : t('settings.codexAccounts.add')}
          </button>
          {/* `~/.codex` hidden from the list comes back here: hiding was never a delete. */}
          {data?.primaryHidden && (
            <button type="button" className="btn btn--secondary" disabled={busy !== ''} onClick={() => void run('adopt', () => api.post('/agent/accounts/codex/adopt', {}))} data-testid="codex-adopt-primary">
              {t('settings.codexAccounts.adopt')}
            </button>
          )}
        </div>
        <p className="settings-field-hint">{busy === 'add' ? t('settings.codexAccounts.addingHint') : t('settings.codexAccounts.addHint')}</p>
      </div>
      {error && <p className="settings-field-hint settings-field-hint--warn" role="alert">{error}</p>}
    </div>
  );
}
