/**
 * WHAT THE NOTCH SHOWS. Owner, 2026-11-13: "notch'ta sadece önemli bildirimler gözükmeli ...
 * anlamsız önemsiz bildirimler mac bildirimine dönsün".
 *
 * This is the ONE place that decides it. Every producer of a notification (the notch inbox,
 * the automation runner, an app's `dc.notify`) and the inbox route ask here, never a check of
 * their own. Important means it needs HIM, or he is waiting for it:
 *
 *   - a question, approval, permission or command card waiting on him;
 *   - the result of something he started and is waiting on (a chat he wrote to, the Super
 *     Agent's reply, an agent answering his message, a hand-off the Assistant ran for him);
 *   - a failure that stops work (a routine failed, a job stuck, every account at its limit).
 *
 * Everything else (a routine ran fine, an agent started, an account moved and the work went
 * on, an app's notice) is NOT notch news: it goes out as a macOS notification instead. The
 * existing no-twice rule still holds (`notch-state.ts`): a notch item's banner is held back
 * only while the notch is open, and a non-notch item's banner always goes.
 *
 * UNKNOWN IS NOT IMPORTANT: a kind this table does not know goes to macOS, never the notch.
 * Pure: no I/O, so every process (server, runner, tests) reads the same answer.
 */

export type NotchNews =
  /** A chat's permission, question or command card waiting on the owner. */
  | { kind: 'ask' }
  /** A proposal waiting for his yes. */
  | { kind: 'approval' }
  /** The Super Agent (or a member's) reply to him. */
  | { kind: 'super-reply' }
  /** A chat he wrote to finished its turn while he looked elsewhere. */
  | { kind: 'chat-finished' }
  /** A hand-off the Assistant ran for him ended. */
  | { kind: 'handoff-finished' }
  /** The Assistant thinking out loud on his own request. */
  | { kind: 'assistant-progress' }
  /** An agent's run said something. `asked`: the run answers his message. `needsYou`: it stopped
   *  to ask or owes a verdict. `failed`: the run failed or timed out. */
  | { kind: 'agent-post'; asked: boolean; needsYou: boolean; failed: boolean }
  /** An agent started a run. */
  | { kind: 'run-started' }
  /** An account hit a limit. `switched`: a chat moved to another account and went on. */
  | { kind: 'account'; switched: boolean; exhausted: boolean }
  /** A dreamcontext App's `dc.notify`. */
  | { kind: 'app' }
  /** A task job's owner-inbox row (`task-plan`, `task-stuck`, ...). */
  | { kind: 'task-row'; row: string }
  /** Anything else: goes to macOS. */
  | { kind: 'other' };

/**
 * An agent run's facts, read the SAME way by the runner (its banner) and the feed (the notch
 * row), so the two can never disagree about one run (one in the notch and the banner held, or
 * neither). `firstEntry`: the run's first thread entry by id. `status`: the run's end
 * (`failed` / `timeout` are failures, whatever the run posted first).
 */
export function agentRunNews(run: { firstEntry: { kind?: string; via?: string } | null | undefined; status: string; needsYou: boolean }): NotchNews {
  return { kind: 'agent-post', asked: ownerAskedRun(run.firstEntry), needsYou: run.needsYou, failed: runFailed(run.status) };
}

/** The run answers a message the OWNER wrote: it opens with a `user` entry an App did not send. */
export function ownerAskedRun(firstEntry: { kind?: string; via?: string } | null | undefined): boolean {
  return firstEntry?.kind === 'user' && firstEntry.via !== 'app';
}

/** The run ended in a failure that stopped it. */
export function runFailed(status: string): boolean {
  return status === 'failed' || status === 'timeout';
}

/** The task-job rows that wait on him (owner-inbox.ts). Each one needs an answer or is stuck. */
const TASK_ROWS_THAT_NEED_HIM: ReadonlySet<string> = new Set([
  'task-start-missed', 'task-orphaned', 'task-stopped', 'task-blocked', 'task-plan',
  'task-question', 'task-stalled', 'task-review', 'task-stuck',
]);

/** True when the notch shows it; false sends it to macOS instead. */
export function notchShowsNews(n: NotchNews): boolean {
  switch (n.kind) {
    case 'ask':
    case 'approval':
    case 'super-reply':
    case 'chat-finished':
    case 'handoff-finished':
    case 'assistant-progress':
      return true;
    case 'agent-post':
      return n.asked || n.needsYou || n.failed;
    case 'account':
      // The work stopped (no account took over) needs him; a move that kept it going is info.
      return n.exhausted || !n.switched;
    case 'task-row':
      return TASK_ROWS_THAT_NEED_HIM.has(n.row);
    case 'run-started':
    case 'app':
    case 'other':
      return false;
    default:
      return false;
  }
}

// ─── The macOS copy for news the notch no longer shows ──────────────────────────────

type Lang = 'en' | 'tr';

/** The owner's language for a banner the server writes: the Mac's locale, English otherwise. */
export function bannerLang(locale: string | undefined = systemLocale()): Lang {
  return (locale ?? '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

function systemLocale(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; }
}

const COPY: Record<Lang, { accountTitle: string; switched: (from: string, to: string) => string }> = {
  en: { accountTitle: 'Account switched', switched: (from, to) => `${from} hit its limit. Work goes on with ${to}.` },
  tr: { accountTitle: 'Hesap değişti', switched: (from, to) => `${from} limitine ulaştı. İş ${to} ile devam ediyor.` },
};

/** The banner for an account move the work went on through. */
export function accountSwitchBanner(from: string, to: string, vault: string | null, lang: Lang = bannerLang()): { title: string; body: string } {
  const c = COPY[lang];
  return { title: vault ? `${c.accountTitle} · ${vault}` : c.accountTitle, body: c.switched(from, to) };
}
