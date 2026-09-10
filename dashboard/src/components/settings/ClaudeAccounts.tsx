import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';
import {
  useClaudeAccounts,
  type ClaudeAccountWire,
  type SwitchStrategy,
  type SwitchWeights,
} from '../../hooks/useAgentCapabilities';
import { SettingRow, Toggle } from './SettingRow';
import { AccountSwitchPolicy, DEFAULT_WEIGHTS } from './AccountSwitchPolicy';
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
 * ── Both windows are ALWAYS drawn ─────────────────────────────────────────────────────
 * Owner, 2026-09-05, looking at two accounts side by side: one drew two bars, the other a
 * sentence saying nothing was cached. Two accounts you cannot compare are the one thing this
 * panel exists to make possible, so every account now draws a 5-hour row and a weekly row.
 * A missing reading is an EMPTY, hatched track labelled "not measured" — never a 0% bar,
 * which would read as "nothing used", and never prose, which costs the comparison.
 *
 * ── A reading always carries its age, and goes stale on its own ───────────────────────
 * Owner, 2026-09-05: "why is usage not shown on the normal account?" — it WAS shown, it was
 * just old. The list route deliberately never probes (N spawns on every paint), so the
 * numbers are only as new as whenever the CLI last happened to write them, and the panel
 * printed them with nothing saying so: a two-hour-old 0% looked exactly like a true 0%.
 *
 * Three things follow. Every account states when it was read. A reading past STALE_AFTER_MS
 * says so in warning tone rather than passing itself off as current. And opening this panel
 * with a stale reading probes ONCE — the one moment the user is actually looking at these
 * numbers is the one moment worth spending the spawns on, and it cannot storm because it is
 * gated on staleness and fires once per mount.
 *
 * ── Why "not measured" used to be on every row (2026-09-07) ───────────────────────────
 * The panel was telling the truth about a probe that was asking the wrong question. It
 * treated "Claude rewrote its usage cache" as the definition of a successful reading, and the
 * CLI throttles that write to once per 5 minutes — so any account read in the last five
 * minutes answered with fresh numbers on stdout and left the file untouched, and every row
 * said "not measured" while the toolbar said "Nothing could be re-read". The probe now reads
 * the report itself (claude-usage-report.ts), so a refresh that cannot measure an account is
 * genuinely unusual — and when it happens the row still SAYS SO, per account, because a
 * generic "1 could not be read" leaves the question it was meant to answer: which one, and why?
 *
 * ── Order is the priority, all the way down ───────────────────────────────────────────
 * The top account is the one new sessions start on (position 0 IS `preferred`, server-side in
 * `reorderClaudeAccounts`, so the order and the flag can never disagree the way they did when
 * a "Make preferred" button sat beside a list with its own unrelated order).
 *
 * Below the top it still means something: `chooseAccount` breaks a tie by register position
 * (`orderedIds`), where it used to fall back to alphabetical id — which quietly decided which
 * account got the work whenever two were equally free. Numbers still win first; order only
 * decides between accounts that are equally free.
 *
 * NO PAGE TITLE — owner preference. The section it sits in already says where you are.
 */

/** Past this, a reading is labelled stale and the panel offers to re-read it on open. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** How old a reading is, in the shortest form that is still exact enough to act on. */
function ageLabel(fetchedAtMs: number | null): { text: string; stale: boolean } {
  if (!fetchedAtMs) return { text: 'never read', stale: true };
  const ms = Date.now() - fetchedAtMs;
  const stale = ms > STALE_AFTER_MS;
  if (ms < 60_000) return { text: 'read just now', stale: false };
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return { text: `read ${mins} min ago`, stale };
  const hours = Math.round(mins / 60);
  if (hours < 24) return { text: `read ${hours}h ago`, stale };
  return { text: `read ${Math.round(hours / 24)}d ago`, stale };
}

/** Personal accounts carry a UUID as their "organization name". Showing it is noise. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "max" → "Max". A plan is a proper noun on screen, not a database value. */
function planLabel(tier: string): string {
  const t = tier.trim();
  if (!t) return '';
  if (/^max$/i.test(t)) return 'Max';
  if (/^pro$/i.test(t)) return 'Pro';
  if (/^team$/i.test(t)) return 'Team';
  if (/^enterprise$/i.test(t)) return 'Enterprise';
  if (/^free$/i.test(t)) return 'Free';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function resetLabel(resetsAt: number): string {
  if (!resetsAt) return '';
  const d = new Date(resetsAt);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? `resets ${time}` : `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/**
 * One usage window. `percent === null` means "no reading" and draws an empty hatched track —
 * present, comparable, and honestly blank.
 */
function Bar({ label, percent, resetsAt, locked }: {
  label: string;
  percent: number | null;
  resetsAt: number;
  locked?: string;
}) {
  const unknown = percent === null;
  const pct = unknown ? 0 : Math.min(100, Math.max(0, percent));
  const tone = locked ? 'is-locked' : pct >= 90 ? 'is-hot' : pct >= 70 ? 'is-warm' : '';
  return (
    <div className="dc-acct-bar">
      <div className="dc-acct-bar-head">
        <span className="dc-acct-bar-label">{label}</span>
        <span className={`dc-acct-bar-value${unknown ? ' is-unknown' : ''}`}>
          {locked ? 'limit reached' : unknown ? 'not measured' : `${Math.round(pct)}%`}
          {!unknown && resetsAt ? ` · ${resetLabel(resetsAt)}` : ''}
        </span>
      </div>
      <div className={`dc-acct-bar-track${unknown ? ' is-unknown' : ''}`}>
        {/* A MEASURED window always draws something. At 0% a zero-width fill is
            indistinguishable from the empty track of an unread account, which is the
            confusion this panel was rebuilt to remove — so a real reading keeps a
            minimum stub. `is-zero` marks it as a floor, not a measurement. */}
        {!unknown && (
          <span
            className={`dc-acct-bar-fill ${tone}${pct < 1.5 ? ' is-zero' : ''}`}
            style={{ width: `${Math.max(pct, 1.5)}%` }}
          />
        )}
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  /** Why the last refresh could not move an account, keyed by id. */
  const [probeNotes, setProbeNotes] = useState<Record<string, string>>({});
  /** The order the user is arranging, held locally so rows move under the cursor. */
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const serverAccounts = data?.accounts ?? [];
  const autoSwitch = data?.autoSwitch ?? true;
  const strategy: SwitchStrategy = data?.switchStrategy ?? 'score';
  const savedWeights: SwitchWeights = data?.switchWeights ?? DEFAULT_WEIGHTS;

  // A local order wins while it matches the server's SET of accounts; reconciling on the id
  // list rather than the objects means a background refetch cannot fight a row mid-drag, but
  // an account added or removed elsewhere still drops the stale arrangement.
  const accounts: ClaudeAccountWire[] = order
    ? order.map((id) => serverAccounts.find((a) => a.id === id)).filter((a): a is ClaudeAccountWire => !!a)
    : serverAccounts;

  useEffect(() => {
    if (!order) return;
    const same = order.length === serverAccounts.length && order.every((id) => serverAccounts.some((a) => a.id === id));
    if (!same) setOrder(null);
  }, [order, serverAccounts]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['agent-claude-accounts'] });
  }, [qc]);

  /** Every mutation reports its own failure in place. A silent no-op on a row that manages
   *  credentials is the wrong way to fail. */
  /**
   * Run one mutation with the page's busy/error plumbing. RETURNS whether it worked, because
   * a caller holding optimistic state has to be able to put it back: a control that shows a
   * value the server refused is a lie about what is on disk.
   */
  const run = useCallback(async (tag: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(tag);
    setError('');
    try {
      await fn();
      refresh();
      return true;
    } catch (e) {
      setError((e as Error)?.message || 'That did not work.');
      // Re-read even on failure. The server is the truth about what was stored, and a caller
      // that guessed wrong needs the real answer to come back rather than nothing at all.
      refresh();
      return false;
    } finally {
      setBusy('');
    }
  }, [refresh]);

  const saveStrategy = useCallback((next: SwitchStrategy) => {
    if (next === strategy) return;
    void run('strategy', () => api.post('/agent/accounts/switch-policy', { strategy: next }));
  }, [api, run, strategy]);

  /** Only the coefficients that CHANGED — the route takes a partial patch. */
  const saveWeights = useCallback(
    (patch: Partial<SwitchWeights>) => run('weights', () => api.post('/agent/accounts/switch-policy', { weights: patch })),
    [api, run],
  );

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

  /**
   * Ask for fresh numbers. The list route never probes on its own (N spawns per paint), so
   * without this the readings are only ever as new as the CLI last happened to make them.
   */
  const refreshUsage = useCallback(async () => {
    setRefreshing(true);
    setError('');
    setRefreshNote('');
    try {
      const res = await api.post<{ refreshed: string[]; failed: { id: string; why: string }[] }>(
        '/agent/accounts/refresh', {},
      );
      refresh();
      // Per ACCOUNT, not a count: "1 could not be read" leaves you asking which one and why.
      setProbeNotes(Object.fromEntries(res.failed.map((f) => [f.id, f.why])));
      setRefreshNote(
        res.refreshed.length > 0
          ? `Updated ${res.refreshed.length} account${res.refreshed.length === 1 ? '' : 's'}.`
          : 'Nothing could be re-read.',
      );
    } catch (e) {
      setError((e as Error)?.message || 'Could not refresh usage.');
    } finally {
      setRefreshing(false);
    }
  }, [api, refresh]);

  /**
   * Probe ONCE on open when what we have is stale. The list route stays probe-free — this is
   * not that route, it is the moment a person opened the panel to read these numbers. Gated
   * twice so it cannot become a storm: only when the freshest reading is already past
   * STALE_AFTER_MS, and only once per mount.
   */
  const autoProbed = useRef(false);
  useEffect(() => {
    if (autoProbed.current || refreshing) return;
    if (serverAccounts.length === 0) return;
    // The OLDEST reading decides, not the newest. Gating on the newest let one fresh
    // account mask every stale one beside it — which is the exact shape of the bug this
    // was written to fix: the busy account gets re-read constantly by its own traffic
    // while the quiet one drifts for hours, and the quiet one is the one you came to check.
    // A missing reading counts as infinitely old.
    const oldest = Math.min(...serverAccounts.map((a) => a.fetchedAtMs ?? 0));
    if (Date.now() - oldest <= STALE_AFTER_MS) return;
    autoProbed.current = true;
    void refreshUsage();
  }, [serverAccounts, refreshing, refreshUsage]);

  /** What a probe outcome means for the person reading the row. */
  const probeExplanation = (why: string): string => {
    if (why === 'healthy-unmeasured') {
      // The claim stays at what was actually observed: signed in, asked, no percentage in the
      // answer. Not "Claude never publishes this for you" — one silent answer is not a rule.
      return 'This account is signed in, but Claude answered without any usage percentages for it.';
    }
    if (why === 'needs-relogin') return 'Signed out — sign in again to read its usage.';
    if (why === 'stale') return 'That account folder is signed in as a different account, so the reading was discarded.';
    return 'Its usage could not be read this time.';
  };

  const commitOrder = useCallback(async (ids: string[]) => {
    setOrder(ids);
    await run('order', () => api.post('/agent/accounts/reorder', { ids }));
  }, [api, run]);

  const moveTo = (ids: string[], from: number, to: number) => {
    if (from < 0 || to < 0 || from === to || to >= ids.length) return null;
    const next = ids.slice();
    next.splice(to, 0, next.splice(from, 1)[0]!);
    return next;
  };

  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = accounts.map((a) => a.id);
    const next = moveTo(ids, ids.indexOf(dragId), ids.indexOf(targetId));
    if (next) void commitOrder(next);
  };

  /** Keyboard parity for the drag — a reorder that only works with a mouse is not a control. */
  const nudge = (id: string, delta: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const from = ids.indexOf(id);
    const next = moveTo(ids, from, from + delta);
    if (next) void commitOrder(next);
  };

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
        <>
          <div className="dc-acct-toolbar">
            <span className="dc-acct-toolbar-note">
              Drag to set the priority — new sessions start at the top, and a switch between equally free accounts follows this order.
            </span>
            <div className="dc-acct-toolbar-right">
              {refreshNote && <span className="dc-acct-refresh-note">{refreshNote}</span>}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={refreshing || busy !== ''}
                onClick={() => void refreshUsage()}
                title="Re-read every account's usage from Claude"
              >
                {refreshing ? 'Refreshing…' : '↻ Refresh usage'}
              </button>
            </div>
          </div>

          <ol className="dc-acct-list">
            {accounts.map((a, i) => {
              const session = a.limits.find((l) => l.key === 'session');
              const weekly = a.limits.find((l) => l.key === 'weekly');
              const stale = a.state === 'needs-relogin';
              const org = a.organizationName && !UUID_RE.test(a.organizationName) ? a.organizationName : '';
              return (
                <li
                  key={a.id}
                  className={`dc-acct${stale ? ' is-stale' : ''}${i === 0 ? ' is-top' : ''}${dragId === a.id ? ' is-dragging' : ''}`}
                  draggable
                  onDragStart={() => setDragId(a.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); onDrop(a.id); setDragId(null); }}
                >
                  <span className="dc-acct-grip" aria-hidden="true">⠿</span>

                  <div className="dc-acct-main">
                    <div className="dc-acct-head">
                      <span className="dc-acct-rank" aria-hidden="true">{i + 1}</span>
                      <span className="dc-acct-who">{a.email || a.id}</span>
                      {a.tier && <span className="dc-acct-plan">Claude {planLabel(a.tier)}</span>}
                      {i === 0 && <span className="dc-acct-tag dc-acct-tag--top">new sessions start here</span>}
                      {a.isPrimary && <span className="dc-acct-tag">this machine</span>}
                      {org && <span className="dc-acct-tag">{org}</span>}
                    </div>

                    {stale && <p className="dc-acct-warn">Signed out — sign in again to use this account.</p>}

                    {/* BOTH windows, always. See the header note. */}
                    <div className={`dc-acct-bars${refreshing ? ' is-refreshing' : ''}`}>
                      <Bar
                        label="5-hour session"
                        percent={stale || !session ? null : session.percent}
                        resetsAt={session?.resetsAt ?? 0}
                        locked={session?.lockedReason}
                      />
                      <Bar
                        label="Weekly"
                        percent={stale || !weekly ? null : weekly.percent}
                        resetsAt={weekly?.resetsAt ?? 0}
                        locked={weekly?.lockedReason}
                      />
                    </div>

                    {/* WHEN these numbers were read. Without it a two-hour-old 0% and a true
                        0% are the same pixel, which is what sent the owner looking for a bug
                        in a panel that was merely showing an old truth. */}
                    {!stale && (() => {
                      const age = ageLabel(a.fetchedAtMs);
                      const why = probeNotes[a.id];
                      return (
                        <>
                          <p className={`dc-acct-age${age.stale ? ' is-stale' : ''}`}>
                            {refreshing ? 'Reading usage…' : age.text}
                          </p>
                          {!refreshing && why && (
                            <p className="dc-acct-probe-note">{probeExplanation(why)}</p>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  <div className="dc-acct-side">
                    <div className="dc-acct-move">
                      <button
                        type="button"
                        className="dc-acct-move-btn"
                        disabled={i === 0 || busy !== ''}
                        aria-label={`Move ${a.email || a.id} up`}
                        onClick={() => nudge(a.id, -1)}
                      >↑</button>
                      <button
                        type="button"
                        className="dc-acct-move-btn"
                        disabled={i === accounts.length - 1 || busy !== ''}
                        aria-label={`Move ${a.email || a.id} down`}
                        onClick={() => nudge(a.id, 1)}
                      >↓</button>
                    </div>
                    <button
                      type="button"
                      className="btn btn--danger-ghost btn--sm"
                      disabled={busy !== '' || accounts.length === 1}
                      title={accounts.length === 1 ? 'The last account cannot be removed.' : ''}
                      onClick={() => void run(`rm-${a.id}`, () => api.post('/agent/accounts/remove', { id: a.id }))}
                    >
                      {busy === `rm-${a.id}` ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <div className="dc-acct-foot">
        {adding ? (
          <div className="dc-acct-add">
            <input
              type="email"
              className="settings-text-input"
              placeholder="name@example.com"
              value={addEmail}
              disabled={busy !== ''}
              onChange={(e) => setAddEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addAccount(); }}
              autoFocus
            />
            <button type="button" className="btn btn--secondary" disabled={busy !== '' || !addEmail.trim()} onClick={() => void addAccount()}>
              {busy === 'add' ? 'Waiting for the browser…' : 'Sign in'}
            </button>
            <button type="button" className="btn btn--secondary" disabled={busy !== ''} onClick={() => { setAdding(false); setAddEmail(''); }}>
              Cancel
            </button>
            <p className="settings-field-hint">
              Claude Code opens its own sign-in in your browser. dreamcontext never sees the token.
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

        {/* The one SETTING that belongs to the accounts themselves. It sits with them
            rather than in the panels below, because it is a policy ABOUT this list —
            but it is written in the page's row grammar so it reads as a setting, not
            as another piece of account state. */}
        <div className="setting-rows dc-acct-policy">
          <SettingRow
            title="Auto-switch accounts near a limit"
            hint="When the account in use is about to hit its window, the message moves to a freer one."
            more="The account it moves to is always named, so the billed account never changes silently. With this off, a message about to hit a limit is NOT moved: you are told the window is nearly gone and nothing else changes."
            control={
              <Toggle
                label="Auto-switch accounts near a limit"
                checked={autoSwitch}
                disabled={busy !== ''}
                onChange={() => void run('auto', () => api.post('/agent/accounts/auto-switch', { enabled: !autoSwitch }))}
              />
            }
          />

          {/* The MODE. Only drawn when auto-switch is on and there is something to switch
              between — a rule for picking among accounts is not a setting on a machine with
              one account, and it is not a setting at all when nothing switches. */}
          {autoSwitch && accounts.length > 1 && (
            <AccountSwitchPolicy
              strategy={strategy}
              savedWeights={savedWeights}
              busy={busy}
              onSaveStrategy={saveStrategy}
              onSaveWeights={saveWeights}
            />
          )}
        </div>

        {error && <p className="dc-acct-warn">{error}</p>}
      </div>
    </div>
  );
}
