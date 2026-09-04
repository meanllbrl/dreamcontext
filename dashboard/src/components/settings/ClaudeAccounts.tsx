import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';
import { useClaudeAccounts, type ClaudeAccountWire } from '../../hooks/useAgentCapabilities';
import './ClaudeAccounts.css';

/**
 * Connected Claude accounts — the Settings surface for multi-account.
 *
 * ── The token is never shown, stored, or pasted ───────────────────────────────────────
 * "Add an account" runs the CLI's OWN `claude auth login` inside that account's sandbox: the
 * browser does the OAuth, the CLI writes its own credential into its own directory, and this
 * UI only ever learns an email and an org. There is no field to paste a token into, because
 * there is no token to paste.
 *
 * ── Each row shows a NON-ACTIVE account's real limits ─────────────────────────────────
 * That is the whole point of the design: each account's usage lives in its own
 * `<configDir>/.claude.json`, written by the CLI, so the numbers here are read WITHOUT
 * switching to the account they describe.
 *
 * NO PAGE TITLE — owner preference. The section it sits in already says where you are.
 */

/** A row whose credential is gone SAYS SO. Never an ambiguous blank or an "unknown". */
function stateLabel(a: ClaudeAccountWire): string {
  return a.state === 'needs-relogin' ? 'Needs to sign in again' : '';
}

function Bar({ label, percent, resetsAt, locked }: {
  label: string;
  percent: number;
  resetsAt: number;
  locked?: string;
}) {
  return (
    <div className="dc-acct-bar">
      <div className="dc-acct-bar-head">
        <span className="dc-acct-bar-label">{label}</span>
        <span className="dc-acct-bar-value">
          {locked ? 'locked' : `${Math.round(percent)}%`}
          {resetsAt ? ` · resets ${new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
      </div>
      <div className="dc-acct-bar-track">
        <span
          className={`dc-acct-bar-fill${locked ? ' is-locked' : ''}`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}

export function ClaudeAccounts() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useClaudeAccounts(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [adding, setAdding] = useState(false);

  const accounts = data?.accounts ?? [];
  const autoSwitch = data?.autoSwitch ?? true;

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['agent-claude-accounts'] });
  }, [qc]);

  /** Every mutation reports its own failure in place. A silent no-op on a row that manages
   *  credentials is the wrong way to fail. */
  const run = useCallback(async (tag: string, fn: () => Promise<unknown>) => {
    setBusy(tag);
    setError('');
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error)?.message || 'That did not work.');
    } finally {
      setBusy('');
    }
  }, [refresh]);

  const addAccount = useCallback(async () => {
    const email = addEmail.trim();
    if (!email) return;
    // The browser handles the OAuth; this request just waits for the CLI's child to finish.
    await run('add', async () => {
      await api.post('/agent/accounts/login', { email });
      setAddEmail('');
      setAdding(false);
    });
  }, [addEmail, api, run]);

  if (isLoading) return <p className="settings-field-hint">Loading accounts…</p>;

  return (
    <div className="dc-accts">
      {accounts.length === 0 ? (
        <p className="settings-field-hint">
          No accounts are connected yet. Add the one this machine is already signed in to, then
          connect a second — both stay signed in at the same time, so switching needs no
          sign-out.
        </p>
      ) : (
        <div className="dc-acct-list">
          {accounts.map((a) => {
            const session = a.limits.find((l) => l.key === 'session');
            const weekly = a.limits.find((l) => l.key === 'weekly');
            return (
              <div key={a.id} className={`dc-acct${a.state === 'needs-relogin' ? ' is-stale' : ''}`}>
                <div className="dc-acct-head">
                  <span className="dc-acct-who">{a.email || a.id}</span>
                  {a.preferred && <span className="settings-beta-badge">preferred</span>}
                  {a.isPrimary && <span className="dc-acct-tag">this machine</span>}
                  {a.tier && <span className="dc-acct-tag">{a.tier}</span>}
                </div>
                {a.organizationName && <p className="dc-acct-org">{a.organizationName}</p>}

                {a.state === 'needs-relogin' ? (
                  <p className="dc-acct-warn">{stateLabel(a)}</p>
                ) : a.limits.length === 0 ? (
                  // "Show what's found, hide what isn't": no cached reading yet is said in
                  // words, never drawn as an empty bar (which reads as "none used").
                  <p className="settings-field-hint">No usage cached yet for this account.</p>
                ) : (
                  <div className="dc-acct-bars">
                    {session && (
                      <Bar label="5-hour session" percent={session.percent} resetsAt={session.resetsAt} locked={session.lockedReason} />
                    )}
                    {weekly && (
                      <Bar label="Weekly" percent={weekly.percent} resetsAt={weekly.resetsAt} locked={weekly.lockedReason} />
                    )}
                  </div>
                )}

                <div className="dc-acct-actions">
                  {!a.preferred && (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      disabled={busy !== ''}
                      onClick={() => void run(`pref-${a.id}`, () => api.post('/agent/accounts/preferred', { id: a.id }))}
                    >
                      {busy === `pref-${a.id}` ? 'Setting…' : 'Make preferred'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    disabled={busy !== '' || accounts.length === 1}
                    title={accounts.length === 1 ? 'The last account cannot be removed.' : ''}
                    onClick={() => void run(`rm-${a.id}`, () => api.post('/agent/accounts/remove', { id: a.id }))}
                  >
                    {busy === `rm-${a.id}` ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="dc-acct-foot">
        {adding ? (
          <div className="dc-acct-add">
            <input
              type="email"
              className="settings-text-input"
              placeholder="the account's email"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addAccount(); }}
            />
            <button type="button" className="btn btn--secondary" disabled={busy !== '' || !addEmail.trim()} onClick={() => void addAccount()}>
              {busy === 'add' ? 'Waiting for the browser…' : 'Sign in'}
            </button>
            <button type="button" className="btn btn--secondary" disabled={busy !== ''} onClick={() => { setAdding(false); setAddEmail(''); }}>
              Cancel
            </button>
            <p className="settings-field-hint">
              Your browser opens Claude&apos;s own sign-in. The app never sees or stores the
              credential — the Claude CLI writes it into this account&apos;s own directory.
            </p>
          </div>
        ) : (
          <div className="dc-acct-add-row">
            <button type="button" className="btn btn--secondary" disabled={busy !== ''} onClick={() => setAdding(true)}>
              Add an account
            </button>
            {accounts.length === 0 && (
              <button
                type="button"
                className="btn btn--secondary"
                disabled={busy !== ''}
                onClick={() => void run('adopt', () => api.post('/agent/accounts/adopt', {}))}
              >
                {busy === 'adopt' ? 'Adding…' : 'Add the one already signed in'}
              </button>
            )}
          </div>
        )}

        <label className="settings-checkbox-label">
          <input
            type="checkbox"
            className="settings-checkbox"
            checked={autoSwitch}
            disabled={busy !== ''}
            onChange={() => void run('auto', () => api.post('/agent/accounts/auto-switch', { enabled: !autoSwitch }))}
          />
          <span>Move a message to another account before a limit lands</span>
        </label>
        <p className="settings-field-hint">
          When this is off, a message that is about to hit a limit is NOT moved — you are told
          the window is nearly gone and nothing changes. Either way, an account that is
          switched to is always named: the billed account never changes silently.
        </p>

        {error && <p className="dc-acct-warn">{error}</p>}
      </div>
    </div>
  );
}
