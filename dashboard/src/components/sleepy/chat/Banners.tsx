import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BotMark } from '../AgentSetup';
import { useClaudeAccounts, type ClaudeAccountWire } from '../../../hooks/useAgentCapabilities';
import { useApi } from '../../../context/VaultContext';
import { fmtTokens } from '../../../lib/agentComposer';
import type { HandoffProgress } from '../../../lib/chatProtocol';
import {
  Notice, NoticeRow, NoticeButton, NoticeChip, TokenDrop, ContextShrink, Steps, AccountAvatar,
  UsageMeter, Glyph, accountShortName, type StepState,
} from './Notice';

/** The banner states one sentence: what broke, then the reassurance. Keeps the CLI's own
 *  wording, adds the period it usually lacks. */
function reasonSentence(message: string): string {
  const m = message.trim();
  if (!m) return 'The connection dropped mid-response.';
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/**
 * Empty state (1), working indicator, stream-error (12), reconnecting chip (12),
 * session-ended (12). No "idle" status word anywhere (redesign rule 6).
 */

export function EmptyState() {
  return (
    <div className="chat-banner-empty">
      <BotMark />
      <h3 className="chat-banner-empty-title">Say something to start</h3>
      <p className="chat-banner-empty-sub">Ask a question, hand off a task, or just say hi.</p>
    </div>
  );
}

/**
 * The turn is running but has nothing on screen yet — the gap between sending a message and
 * the CLI's first frame (process spawn + SessionStart brain preload: seconds on the first
 * turn), and every later gap between a tool result and the next block. Without it the pane
 * looks idle while it is working, which is how a live session reads as a hung one.
 *
 * The elapsed clock is the point: it is the difference between "waiting" and "stuck". Ticks
 * only while mounted, and mounts only during those gaps.
 */
export function WorkingIndicator({ label, startedAt }: { label: string; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // No `startedAt` (a turn that was already running when this view attached) → the clock
  // starts from mount rather than showing a number that would be a guess.
  const [base] = useState(() => startedAt ?? Date.now());
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? base)) / 1000));

  return (
    <div className="chat-working" role="status" aria-live="polite">
      <span className="chat-working-dots" aria-hidden>
        <span /><span /><span />
      </span>
      <span className="chat-working-label">{label}</span>
      {seconds > 0 && <span className="chat-working-elapsed">{seconds}s</span>}
    </div>
  );
}

/** `m:ss` since `since`, ticking while mounted. */
function useElapsed(since: number, live: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `in 2h 14m` / `in 9m` — how long until a reset, read once at render. */
function untilText(at: number): string {
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (m < 1) return 'now';
  return m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function StreamErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  const reason = reasonSentence(message);
  return (
    <Notice
      tone="bad"
      slim
      role="alert"
      icon={<Glyph.unplug />}
      title="Stream interrupted"
      detail={`${reason} Your message is safe.`}
      meta={<NoticeChip tone="good"><Glyph.check />message safe</NoticeChip>}
      actions={<NoticeButton primary onClick={onRetry}>Retry</NoticeButton>}
    >
      <NoticeRow><span className="chat-notice-meta chat-notice-reason">{reason}</span></NoticeRow>
    </Notice>
  );
}

/**
 * What the fresh-session branch guard did to the working tree, or declined to do
 * (src/lib/session-start-branch.ts).
 *
 * A banner rather than a transcript item because it is a property of how the session STARTED,
 * not a turn in it — and a `git checkout` nobody asked for in this turn must not be something
 * the user only discovers by scrolling. `warn` is the refusal ("staying on feat/x, the tree is
 * dirty"), which is the arm that leaves the session somewhere the user was told new sessions
 * would not start; `info` is a move that was made. Dismissable, because it reports a one-time
 * event: once read, it is history.
 */
export function BranchStartBanner({ tone, message, onDismiss }: {
  tone: 'info' | 'warn';
  message: string;
  onDismiss: () => void;
}) {
  return (
    <Notice
      tone={tone}
      slim
      icon={<Glyph.branch />}
      title={message.replace(/\.$/, '')}
      onDismiss={onDismiss}
    />
  );
}

/**
 * The context handoff, drawn WHILE it happens (server: src/lib/handoff-progress.ts). It is the
 * biggest thing the chat does on its own — the agent's state goes into the task, a digest is
 * written, the conversation is cleared and a fresh session picks the task up — and it used to
 * appear only afterwards, as one grey line (owner, 2026-10-07). Running: a ringed card whose
 * steps tick over, the old context hatched behind a sweep. Done: a receipt with the drop as
 * the big number. Failed: one line, the reason on hover.
 */
export function HandoffCard({ run, onDismiss, onOpenTask }: {
  run: HandoffProgress;
  onDismiss: () => void;
  onOpenTask?: (slug: string) => void;
}) {
  const running = run.stage === 'clearing' || run.stage === 'resuming';
  const elapsed = useElapsed(run.id, running);
  const from = run.contextTokens;

  if (run.stage === 'failed') {
    return (
      <Notice
        tone="bad"
        slim
        icon={<Glyph.leaf />}
        title="Handoff didn't happen — still on this session"
        detail={run.message}
        onDismiss={onDismiss}
        testId="handoff-card"
      />
    );
  }

  const taskChip = run.task ? (
    <button type="button" className="chat-notice-chip is-task" onClick={() => onOpenTask?.(run.task)} title="Open the task">
      <Glyph.task />{run.title || run.task}
    </button>
  ) : null;

  if (running) {
    const clearing: StepState = run.stage === 'clearing' ? 'run' : 'done';
    const resuming: StepState = run.stage === 'resuming' ? 'run' : 'todo';
    return (
      <Notice
        hero
        icon={<Glyph.leaf />}
        title={<span className="chat-notice-live">Moving to a fresh session…</span>}
        meta={<span className="chat-notice-meta">{elapsed}</span>}
        testId="handoff-card"
      >
        <Steps steps={[
          { label: 'State saved to task', state: 'done' },
          { label: 'Digest written', state: 'done' },
          { label: from ? `Clearing ${fmtTokens(from)}` : 'Clearing context', state: clearing },
          { label: 'Resuming task', state: resuming },
        ]} />
        {from !== undefined && (
          <ContextShrink from={from} left="context" right={<><b>{fmtTokens(from)}</b> → …</>} />
        )}
        {taskChip && <NoticeRow>{taskChip}</NoticeRow>}
      </Notice>
    );
  }

  const drop = from !== undefined && run.postTokens !== undefined
    ? Math.round((1 - run.postTokens / from) * 100)
    : null;
  return (
    <Notice
      tone="good"
      icon={<Glyph.leaf />}
      title="Fresh session"
      meta={from !== undefined ? <TokenDrop from={from} to={run.postTokens} /> : undefined}
      onDismiss={onDismiss}
      testId="handoff-card"
    >
      {from !== undefined && run.postTokens !== undefined && (
        <ContextShrink
          from={from}
          to={run.postTokens}
          left={drop !== null && drop > 0 ? `−${drop}% context` : 'context'}
          right="ECO"
        />
      )}
      <NoticeRow>
        {taskChip}
        <NoticeChip tone="good"><Glyph.check />picked up</NoticeChip>
      </NoticeRow>
    </Notice>
  );
}

// ─── Accounts ────────────────────────────────────────────────────────────────────────

/** Re-signs a CONNECTED account in the browser, into its own sandbox. The machine's own
 *  account has no such route (the server answers `primary_account`), so it is never offered. */
function useRelogin() {
  const api = useApi();
  const qc = useQueryClient();
  const [busy, setBusy] = useState('');
  const relogin = (id: string) => {
    setBusy(id);
    api.post('/agent/accounts/relogin', { id })
      .catch(() => { /* the browser flow reports its own failure; the row stays signed out */ })
      .finally(() => {
        setBusy('');
        void qc.invalidateQueries({ queryKey: ['agent-claude-accounts'] });
      });
  };
  return { busy, relogin };
}

function labelFor(id: string, accounts: ClaudeAccountWire[], email?: string): { email: string; short: string; account?: ClaudeAccountWire } {
  const account = accounts.find((a) => a.id === id);
  const e = email || account?.email || id;
  return { email: e, short: e.includes('@') ? accountShortName(e) : e, account };
}

/** One rejected account, from the server's reason sentence to a state a chip can draw. */
function rejectedState(why: string): { tone?: 'bad' | 'warn'; icon?: ReactNode; label: string; signIn?: boolean; session?: number; weekly?: number } {
  const s = /session usage is at (\d+)%/.exec(why);
  if (s) return { label: '', session: Number(s[1]) };
  const w = /weekly usage is at (\d+)%/.exec(why);
  if (w) return { label: '', weekly: Number(w[1]) };
  if (/sign in again/.test(why)) return { tone: 'warn', icon: <Glyph.key />, label: 'signed out', signIn: true };
  if (/refused|locked/.test(why)) return { tone: 'bad', icon: <Glyph.lock />, label: /weekly/.test(why) ? 'weekly limit' : 'limit' };
  return { label: 'usage unknown' };
}

function OtherAccounts({ rejected, exclude, accounts }: {
  rejected: Array<{ id: string; why: string }>;
  exclude: string[];
  accounts: ClaudeAccountWire[];
}) {
  const { busy, relogin } = useRelogin();
  const rows = rejected.filter((r) => !exclude.includes(r.id));
  if (rows.length === 0) return null;
  return (
    <NoticeRow>
      {rows.map((r) => {
        const who = labelFor(r.id, accounts);
        const st = rejectedState(r.why);
        const canSignIn = st.signIn && who.account && !who.account.isPrimary;
        const chip = (
          <NoticeChip tone={st.tone} title={`${who.email}: ${r.why}`}>
            <AccountAvatar email={who.email} off={st.tone !== undefined} />
            {who.short}
            {st.icon}
            {st.session !== undefined && <UsageMeter label="5h" percent={st.session} />}
            {st.weekly !== undefined && <UsageMeter label="wk" percent={st.weekly} />}
            {st.label && !st.icon && <span>· {st.label}</span>}
          </NoticeChip>
        );
        return canSignIn ? (
          <button
            key={r.id}
            type="button"
            className="chat-notice-chipbtn"
            disabled={busy !== ''}
            onClick={() => relogin(r.id)}
            title={`Sign ${who.email} in again`}
          >
            {chip}
            <span className="chat-notice-chipbtn-cta">{busy === r.id ? 'Waiting…' : 'Sign in'}</span>
          </button>
        ) : <span key={r.id}>{chip}</span>;
      })}
    </NoticeRow>
  );
}

type AccountMove = {
  switched: boolean;
  reason: 'limit_near' | 'limit_hit' | 'limit_known' | 'needs_relogin' | 'all_exhausted'
    | 'stayed_put' | 'switch_stalled' | 'auto_switch_disabled';
  accountId: string;
  fromAccountId?: string;
  email?: string;
  sessionPercent?: number;
  weeklyPercent?: number;
  earliestResetAt?: number;
  unmeasured?: boolean;
  rejected?: Array<{ id: string; why: string }>;
};

/** The full sentence for a move — kept as the card's hover `detail`, so the honest long form
 *  is one hover away while the card itself stays a picture. */
function moveSentence(move: AccountMove, who: string, when: string): string {
  const windows = [
    move.sessionPercent === undefined ? '' : `5-hour ${Math.round(move.sessionPercent)}%`,
    move.weeklyPercent === undefined ? '' : `weekly ${Math.round(move.weeklyPercent)}%`,
  ].filter(Boolean).join(' · ');
  const landed = move.unmeasured
    ? ' · its usage could not be read, so this is a best available choice'
    : windows === '' ? '' : ` · ${windows}`;
  if (move.switched) {
    if (move.reason === 'needs_relogin') return `Moved to ${who} — the previous account needs to sign in again.`;
    if (move.reason === 'limit_hit') return `That message hit the limit on the previous account. Resending it on ${who}${landed}.`;
    if (move.reason === 'limit_known') return `The previous account is still at its limit${when ? ` until ${when}` : ''}, so this went to ${who}${landed}.`;
    return `Moved to ${who}${landed}.`;
  }
  if (move.reason === 'all_exhausted') {
    return when
      ? `Every account is at its limit. The first one frees up at ${when} — this message went out on the current account, so you will see its own limit error if it lands.`
      : 'Every account is at its limit. This message went out on the current account.';
  }
  if (move.reason === 'stayed_put') return `This account hit its limit and no other account is in better shape${when ? `, so work resumes at ${when}` : ''}.`;
  if (move.reason === 'switch_stalled') return 'This chat could not be moved to another account, so your messages went out on this one. Open a new chat to start on another account.';
  if (move.reason === 'auto_switch_disabled' && when) return `This account is at its limit until ${when}. Auto-switch is off, so nothing was changed.`;
  return 'This account is close to its limit. Auto-switch is off, so nothing was changed.';
}

/**
 * The account move, SHOWN. The billed account never changes silently — that is a constraint of
 * this feature, not a nicety — so every automatic switch is drawn and NAMES the account it
 * moved to. Drawn, not written (owner, 2026-10-07): the move is a from → to track with the
 * destination's two usage windows as meters, every other account a chip with its state, and
 * the full sentence on hover. Each reason still reads differently, because each means
 * something different:
 *   • limit_hit    — the API had ALREADY refused the turn; the headline says it is being RESENT.
 *   • limit_known  — an EARLIER turn was refused, so this one moved before trying. It must not
 *                    borrow limit_hit's headline: this message did not fail.
 *   • limit_near / other switched — moved ahead of the limit.
 *   • needs_relogin — the old account is signed out; offers to sign it back in.
 *   • unmeasured   — a last-resort pick: the destination says "usage unknown", never meters.
 *   • all_exhausted / stayed_put — nowhere to go: WHEN work resumes is the big number.
 *   • switch_stalled — a move was announced and never performed.
 *   • auto_switch_disabled — reporting without acting, plus the switch that would act.
 */
export function AccountSwitchBanner({ move, onDismiss }: {
  move: AccountMove;
  onDismiss: () => void;
}) {
  const accountsQ = useClaudeAccounts(true);
  const accounts = accountsQ.data?.accounts ?? [];
  const api = useApi();
  const qc = useQueryClient();
  const { busy, relogin } = useRelogin();
  const to = labelFor(move.accountId, accounts, move.email);
  const when = move.earliestResetAt
    ? new Date(move.earliestResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const detail = moveSentence(move, to.email, when);
  const rejected = move.rejected ?? [];

  if (move.switched) {
    const fromId = move.fromAccountId;
    const from = fromId ? labelFor(fromId, accounts) : null;
    const title = move.reason === 'limit_hit' ? 'Limit hit — resending on another account'
      : move.reason === 'limit_known' ? 'Still at limit — sent on another account'
      : move.reason === 'needs_relogin' ? 'Signed out — moved to another account'
      : move.reason === 'limit_near' ? 'Moved before the limit'
      : 'Moved to another account';
    const fromState = move.reason === 'needs_relogin' ? 'signed out'
      : move.reason === 'limit_near' ? 'near its limit'
      : when ? `at limit · back ${when}` : 'at its limit';
    const canReloginFrom = move.reason === 'needs_relogin' && from?.account && !from.account.isPrimary;
    return (
      <Notice
        icon={<Glyph.swap />}
        title={title}
        detail={detail}
        actions={canReloginFrom ? (
          <NoticeButton disabled={busy !== ''} onClick={() => relogin(fromId!)}>
            {busy === fromId ? 'Waiting for the browser…' : 'Sign in back'}
          </NoticeButton>
        ) : undefined}
        onDismiss={onDismiss}
        testId="account-switch"
      >
        <div className="chat-notice-move">
          {from && (
            <>
              <div className="chat-notice-node is-off">
                <AccountAvatar email={from.email} size="lg" off />
                <div><div className="chat-notice-who">{from.short}</div><div className="chat-notice-st">{fromState}</div></div>
              </div>
              <span className="chat-notice-wire" aria-hidden />
            </>
          )}
          <div className="chat-notice-node">
            <AccountAvatar email={to.email} size="lg" />
            <div>
              <div className="chat-notice-who">{to.short}</div>
              {move.unmeasured ? (
                <div className="chat-notice-st">usage unknown</div>
              ) : (move.sessionPercent !== undefined || move.weeklyPercent !== undefined) && (
                <div className="chat-notice-meters">
                  {move.sessionPercent !== undefined && <UsageMeter label="5h" percent={move.sessionPercent} />}
                  {move.weeklyPercent !== undefined && <UsageMeter label="wk" percent={move.weeklyPercent} />}
                </div>
              )}
            </div>
          </div>
        </div>
        <OtherAccounts rejected={rejected} exclude={[move.accountId, ...(fromId ? [fromId] : [])]} accounts={accounts} />
      </Notice>
    );
  }

  if (move.reason === 'all_exhausted' || move.reason === 'stayed_put') {
    return (
      <Notice
        tone="warn"
        icon={<Glyph.clock />}
        title={move.reason === 'all_exhausted' ? 'All accounts at limit' : 'No better account to move to'}
        detail={detail}
        meta={move.earliestResetAt ? (
          <span className="chat-notice-big">{when}<span className="chat-notice-meta">{untilText(move.earliestResetAt)}</span></span>
        ) : undefined}
        onDismiss={onDismiss}
        testId="account-switch"
      >
        <OtherAccounts rejected={rejected} exclude={[]} accounts={accounts} />
      </Notice>
    );
  }

  if (move.reason === 'switch_stalled') {
    return (
      <Notice
        tone="warn"
        slim
        icon={<Glyph.swap />}
        title="Couldn't move this chat — sent on this account"
        detail={detail}
        onDismiss={onDismiss}
        testId="account-switch"
      />
    );
  }

  // auto_switch_disabled: the limit is close (or hit) and the setting is OFF. Reporting
  // without acting is what "off" means — so the card carries the switch that would act.
  const enable = () => {
    void api.post('/agent/accounts/auto-switch', { enabled: true })
      .finally(() => { void qc.invalidateQueries({ queryKey: ['agent-claude-accounts'] }); });
  };
  const autoOn = accountsQ.data?.autoSwitch === true && accounts.length > 0;
  return (
    <Notice
      tone="warn"
      slim
      icon={<Glyph.clock />}
      title={when ? `At the limit until ${when}` : 'Near the limit'}
      detail={detail}
      meta={move.sessionPercent !== undefined ? <UsageMeter label="5h" percent={move.sessionPercent} showValue /> : undefined}
      actions={accounts.length > 1 ? (
        autoOn
          ? <NoticeChip tone="good"><Glyph.check />auto-switch on</NoticeChip>
          : <NoticeButton primary onClick={enable}>Turn on auto-switch</NoticeButton>
      ) : undefined}
      onDismiss={onDismiss}
      testId="account-switch"
    />
  );
}

/** The account this pane started on is signed in as someone else: the picker names the row,
 *  the CLI runs on the credential underneath. Drawn as the two identities side by side, with
 *  the sign-in that fixes it when the picked account is a connected one. */
export function AccountMismatchBanner({ accountId, email, signedInAs, onDismiss }: {
  accountId?: string;
  email: string;
  signedInAs: string;
  onDismiss: () => void;
}) {
  const accounts = useClaudeAccounts(true).data?.accounts ?? [];
  const { busy, relogin } = useRelogin();
  const picked = labelFor(accountId ?? '', accounts, email || undefined);
  const runs = labelFor('', accounts, signedInAs);
  const canFix = accountId && picked.account && !picked.account.isPrimary;
  return (
    <Notice
      tone="warn"
      icon={<Glyph.user />}
      title="Running as a different account"
      detail={`This session runs as ${signedInAs}, not ${email || 'the account you picked'} — that account folder is signed in as someone else. Sign in again from Settings → Agents.`}
      actions={canFix ? (
        <NoticeButton primary disabled={busy !== ''} onClick={() => relogin(accountId!)}>
          {busy ? 'Waiting for the browser…' : 'Fix sign-in'}
        </NoticeButton>
      ) : undefined}
      onDismiss={onDismiss}
      testId="account-mismatch"
    >
      <div className="chat-notice-move">
        <div className="chat-notice-node is-off">
          <AccountAvatar email={picked.email} off />
          <div className="chat-notice-who">{email ? picked.short : 'picked account'}</div>
        </div>
        <span className="chat-notice-meta">runs as</span>
        <div className="chat-notice-node">
          <AccountAvatar email={runs.email} />
          <div className="chat-notice-who">{runs.short}</div>
        </div>
      </div>
    </Notice>
  );
}

export function ReconnectingChip() {
  return (
    <div className="chat-banner-reconnecting">
      <span className="chat-banner-reconnecting-dot" aria-hidden />
      Reconnecting…
    </div>
  );
}
/**
 * The CLI has no usable credentials (chatProtocol's `auth-required`). Replaces the composer,
 * because every message typed into an unauthenticated session comes straight back as the same
 * notice — and because the fix is not on this surface: the headless engine answers `/login`
 * with "/login isn't available in this environment.", so the OAuth flow can only run in the
 * interactive TUI. `canSignInInApp` is whether that TUI can run in-app at all (node-pty + the
 * CLI); without it the honest answer is the command to run in a real terminal, not a button
 * that would open a pane that can't start.
 *
 * "Retry" respawns this same conversation (`--resume`), which is the recovery path whether the
 * CLI stayed alive after the failed turn or exited — a signed-in respawn picks the transcript
 * up where it stopped.
 */
export function SignInBanner({ canSignInInApp, command, accountId, onSignIn, onRetry }: {
  canSignInInApp: boolean;
  /** The sign-in command the INSTALLED CLI actually has (`claude auth login` on 2.1.x; plain
   *  `claude` on one too old for the subcommand). Server-probed rather than hardcoded, so this
   *  text can never name a command this machine doesn't have. */
  command: string;
  /** The account this conversation runs on (`''` = the one new sessions start on). A connected
   *  second account signs in again in the browser, into ITS OWN sandbox; a terminal running
   *  `claude auth login` would sign in the machine's own account instead and leave this one
   *  signed out. */
  accountId: string;
  /** Resolves once the terminal is open, or the account is signed in and the chat resumed. */
  onSignIn: () => Promise<void>;
  onRetry: () => void;
}) {
  const accounts = useClaudeAccounts(true).data?.accounts ?? [];
  const account = accountId ? accounts.find((a) => a.id === accountId) : (accounts.find((a) => a.preferred) ?? accounts[0]);
  const connected = account && !account.isPrimary ? account : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signIn = () => {
    setBusy(true);
    setError('');
    onSignIn()
      .catch((e: unknown) => setError((e as Error)?.message || 'The sign-in did not complete.'))
      .finally(() => setBusy(false));
  };
  const who = connected ? (connected.email || connected.id) : '';
  return (
    // In the COMPOSER's slot (an unauthenticated session has nothing to send), docked like the
    // composer it replaces. Warning-toned, not error-toned: nothing is broken and nothing was
    // lost — a credential is missing, and the next two clicks fix it.
    <Notice
      tone="warn"
      role="alert"
      className="is-dock chat-banner-signin"
      icon={<Glyph.key />}
      title={connected
        ? <><NoticeChip><AccountAvatar email={who} />{accountShortName(who)}</NoticeChip> is signed out</>
        : 'Not signed in to Claude'}
      detail={connected
        ? 'This chat runs on that account. Sign in again opens Claude’s sign-in in your browser, then the chat picks up where it stopped.'
        : canSignInInApp
          ? `Chat runs Claude headlessly, and the sign-in flow needs a real terminal. Opening one here runs ${command} — Claude Code takes it from there.`
          : 'The in-app terminal isn’t available on this machine, so sign in from a real terminal.'}
    >
      {!connected && !canSignInInApp && <code className="chat-notice-cmd">{command}</code>}
      {error && <p className="chat-notice-error">{error}</p>}
      <NoticeRow>
        {(connected || canSignInInApp) && (
          <NoticeButton primary disabled={busy} onClick={signIn}>
            {connected ? (busy ? 'Waiting for the browser…' : 'Sign in again') : 'Sign in in Terminal'}
          </NoticeButton>
        )}
        <NoticeButton disabled={busy} onClick={onRetry}>Signed in — retry</NoticeButton>
        {(connected || canSignInInApp) && (
          <span className="chat-notice-meta">{connected ? 'opens your browser' : `runs ${command}`}</span>
        )}
      </NoticeRow>
    </Notice>
  );
}

export function SessionEndedBanner({ onResume }: { onResume: () => void }) {
  return (
    <Notice
      slim
      className="is-dock chat-banner-ended"
      icon={<Glyph.moon />}
      title={<span className="chat-banner-ended-title">Session ended</span>}
      detail="The process behind this chat exited. Your conversation is saved — resume it any time."
      meta={<NoticeChip><Glyph.check />saved</NoticeChip>}
      actions={<NoticeButton primary onClick={onResume}>Resume session</NoticeButton>}
    />
  );
}
