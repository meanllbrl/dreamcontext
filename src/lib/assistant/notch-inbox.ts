import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listClaudeAccounts } from '../claude-accounts.js';
import { readAccountRejections } from '../claude-limit-rejections.js';
import { getChat, onChatChange, type ChatChange, type ChatEntry } from './chat-registry.js';
import { isDelegatedSession } from './delegations.js';

/**
 * The notch's INBOX: the things that happened while the owner was looking somewhere else.
 *
 * Owner, 2026-10-04: the notch is where every chat, automation and account event reaches him,
 * and a click lands in the window it is about. Three kinds live in this server's memory:
 *
 *   finished — a chat finished a turn while its project was NOT the one on screen
 *   account  — an account hit its limit, and (when a chat moved) which account took over
 *   presence — which project the owner is looking at right now (the input to `finished`)
 *
 * Automation posts and running automations are NOT here: they live on disk per project and
 * are joined at read time (`src/server/assistant-inbox.ts`). The mute list for them is here,
 * because it is machine-local owner state like the rest.
 *
 * "NOT ON SCREEN" is the presence report: every project window says which project it shows
 * while it has focus (`POST /api/assistant/presence`) and withdraws it on blur. A report goes
 * stale after PRESENCE_TTL_MS so a window that died while focused cannot hide finishes forever.
 * A finish in the project the owner is looking at is not news; looking at a project later
 * clears its finishes, since the owner has now seen them.
 *
 * EVERY KEY HAS A DEATH (`pattern-every-store-key-needs-a-death`): events are capped at
 * EVENTS_CAP and die after EVENT_TTL_MS; a pending finish timer dies with its session's next
 * change. Delegated sessions are skipped: their turn ends already reach the owner as hand-offs.
 */

/** A turn that ends must stay ended this long before it is a finish (a background agent's
 *  hand-back can restart a turn seconds after its `result`). */
export const FINISH_DEBOUNCE_MS = 2_500;
/** A presence report older than this is not believed. Windows re-report every 20 s. */
export const PRESENCE_TTL_MS = 60_000;
export const EVENTS_CAP = 40;
export const EVENT_TTL_MS = 12 * 60 * 60_000;
/** A limit and a switch for the same account this close together are one event. */
const MERGE_WINDOW_MS = 2 * 60_000;
/** Rejections recorded before this server started are not news to announce. */
const BOOT_AT = Date.now();

export interface FinishedEvent {
  id: string;
  kind: 'finished';
  at: number;
  sessionId: string;
  vault: string;
  mode: string;
  /** PROJECT text (the chat's first message): callers wrap it before it leaves the server. */
  title: string;
  /** PROJECT text (the turn's last reply). */
  lastText: string;
}

export interface AccountEvent {
  id: string;
  kind: 'account';
  at: number;
  /** The account that hit its limit or was left. */
  accountId: string;
  /** The account that took over, when a chat moved. */
  toAccountId: string | null;
  /** Which cap refused, when known. */
  window: 'session' | 'weekly' | 'unknown' | null;
  /** When the refused account comes back, epoch ms, when known. */
  until: number | null;
  /** No account had room left. */
  exhausted: boolean;
  /** The chat that moved, when one did. */
  vault: string | null;
  sessionId: string | null;
}

export type NotchEvent = FinishedEvent | AccountEvent;

/** An account event as the notch draws it: ids resolved to the names the owner knows. */
export type AccountEventView = AccountEvent & { account: string; toAccount: string | null };

// ─── Presence ───────────────────────────────────────────────────────────────────────

interface Presence { label: string; vault: string | null; at: number }
let presence: Presence | null = null;

/** A window reports what it shows while focused (`vault`), or that it lost focus (`null`). */
export function setPresence(label: string, vault: string | null, now = Date.now()): void {
  if (vault === null) {
    // Only the window that holds the report may withdraw it: a blur in window A arriving after
    // window B gained focus must not erase B.
    if (presence && presence.label === label) presence = null;
    return;
  }
  presence = { label, vault, at: now };
  dropFinishedFor(vault);
}

/** The project the owner is looking at right now, or null (another app, or nothing reported). */
export function lookingAt(now = Date.now()): string | null {
  if (!presence || now - presence.at > PRESENCE_TTL_MS) return null;
  return presence.vault;
}

// ─── Events ─────────────────────────────────────────────────────────────────────────

let events: NotchEvent[] = [];
const finishTimers = new Map<string, ReturnType<typeof setTimeout>>();
let unsubscribe: (() => void) | null = null;
const seenRejections = new Set<string>();

function prune(now = Date.now()): void {
  events = events.filter((e) => now - e.at <= EVENT_TTL_MS);
  if (events.length > EVENTS_CAP) events.length = EVENTS_CAP;
}

function push(e: NotchEvent): void {
  events = [e, ...events.filter((x) => x.id !== e.id)];
  prune(e.at);
}

function dropFinishedFor(vault: string): void {
  events = events.filter((e) => !(e.kind === 'finished' && e.vault === vault));
}

function dropFinishedSession(sessionId: string): void {
  events = events.filter((e) => !(e.kind === 'finished' && e.sessionId === sessionId));
}

function clearFinishTimer(sessionId: string): void {
  const t = finishTimers.get(sessionId);
  if (t) clearTimeout(t);
  finishTimers.delete(sessionId);
}

function onChange({ entry, from }: ChatChange): void {
  const id = entry.sessionId;
  if (entry.status === 'working' || entry.status === 'starting' || entry.status === 'asking') {
    // Someone is in it again (the owner typed, or it resumed): an older finish is old news.
    clearFinishTimer(id);
    if (entry.status !== 'asking') dropFinishedSession(id);
    return;
  }
  if (entry.status === 'gone') { clearFinishTimer(id); return; }
  // idle: a turn ended. Only a turn that was running is a finish (not a restored tab settling).
  if (entry.status !== 'idle' || from !== 'working') return;
  if (entry.origin === 'assistant' || isDelegatedSession(id)) return;
  clearFinishTimer(id);
  const t = setTimeout(() => {
    finishTimers.delete(id);
    const now = getChat(id);
    if (!now || now.status !== 'idle' || isDelegatedSession(id)) return;
    if (lookingAt() === now.vault) return;
    recordFinished(now);
  }, FINISH_DEBOUNCE_MS);
  t.unref?.();
  finishTimers.set(id, t);
}

/** Exported for tests: a finished turn, recorded as if its debounce had already stood. */
export function recordFinished(e: ChatEntry, now = Date.now()): FinishedEvent {
  const ev: FinishedEvent = {
    id: `fin:${e.sessionId}`,
    kind: 'finished',
    at: now,
    sessionId: e.sessionId,
    vault: e.vault,
    mode: e.mode,
    title: e.title,
    lastText: e.lastAssistantText[e.lastAssistantText.length - 1] ?? '',
  };
  push(ev);
  return ev;
}

/** Subscribe to the chat registry. Idempotent; called at server boot and on the first read. */
export function wireNotchInbox(): void {
  if (!unsubscribe) unsubscribe = onChatChange(onChange);
}

/** The newest account event for `accountId` inside the merge window, if any. */
function recentAccountEvent(accountId: string, now: number): AccountEvent | null {
  for (const e of events) {
    if (e.kind === 'account' && e.accountId === accountId && Math.abs(now - e.at) <= MERGE_WINDOW_MS) return e;
  }
  return null;
}

/**
 * A chat moved accounts (agent-chat.ts `decideAndAnnounce`), or found none with room left.
 * Merged into a limit event for the same account seen moments ago, so one wall is one row.
 */
export function recordAccountSwitch(input: {
  fromAccountId: string;
  toAccountId: string | null;
  vault: string | null;
  sessionId: string | null;
  exhausted?: boolean;
  until?: number | null;
}, now = Date.now()): AccountEvent {
  const prev = recentAccountEvent(input.fromAccountId, now);
  const ev: AccountEvent = {
    id: prev?.id ?? `acct:${input.fromAccountId}:${now}`,
    kind: 'account',
    at: now,
    accountId: input.fromAccountId,
    toAccountId: input.toAccountId ?? prev?.toAccountId ?? null,
    window: prev?.window ?? null,
    until: input.until ?? prev?.until ?? null,
    exhausted: !!input.exhausted,
    vault: input.vault ?? prev?.vault ?? null,
    sessionId: input.sessionId ?? prev?.sessionId ?? null,
  };
  push(ev);
  return ev;
}

/**
 * Turn limit refusals written to disk (by any process: a chat, an automation, a terminal) into
 * events. Only refusals observed since this server started, each once.
 */
export function syncAccountRejections(home: string = homedir(), now = Date.now()): void {
  let all: ReturnType<typeof readAccountRejections>;
  try { all = readAccountRejections(home, now); } catch { return; }
  for (const [accountId, r] of Object.entries(all)) {
    const key = `${accountId}:${r.at}`;
    if (seenRejections.has(key) || r.at < BOOT_AT) continue;
    seenRejections.add(key);
    const prev = recentAccountEvent(accountId, r.at);
    push({
      id: prev?.id ?? `acct:${accountId}:${r.at}`,
      kind: 'account',
      at: prev ? Math.max(prev.at, r.at) : r.at,
      accountId,
      toAccountId: prev?.toAccountId ?? null,
      window: r.window,
      until: r.until,
      exhausted: prev?.exhausted ?? false,
      vault: prev?.vault ?? null,
      sessionId: prev?.sessionId ?? null,
    });
  }
}

/** The name the owner knows an account by: its email, else its organisation, else its id. */
function accountName(id: string, accounts: ReturnType<typeof listClaudeAccounts>): string {
  const a = accounts.find((x) => x.id === id);
  return a?.email || a?.organizationName || id;
}

/** Every live event, newest first, account ids resolved to names. */
export function listNotchEvents(home: string = homedir(), now = Date.now()): Array<FinishedEvent | AccountEventView> {
  prune(now);
  let accounts: ReturnType<typeof listClaudeAccounts> = [];
  try { accounts = listClaudeAccounts(home); } catch { accounts = []; }
  return events.map((e) => (e.kind === 'account'
    ? { ...e, account: accountName(e.accountId, accounts), toAccount: e.toAccountId ? accountName(e.toAccountId, accounts) : null }
    : e));
}

/** The owner waved one away, or clicked it (and was taken there). */
export function dismissNotchEvent(id: string): boolean {
  const before = events.length;
  events = events.filter((e) => e.id !== id);
  return events.length < before;
}

// ─── Muted automations ──────────────────────────────────────────────────────────────

/** `~/.dreamcontext/notch-muted.json` — `{ "<project root>": ["<slug>", …] }`, machine-local. */
export function notchMutedPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'notch-muted.json');
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Never throws: an unreadable file is "nothing muted" (over-notifying beats a silent miss). */
export function readMutedAutomations(home: string = homedir()): Record<string, string[]> {
  const p = notchMutedPath(home);
  if (!existsSync(p)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [root, slugs] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(slugs)) continue;
      const ok = slugs.filter((s): s is string => typeof s === 'string' && SLUG_RE.test(s));
      if (ok.length) out[root] = [...new Set(ok)];
    }
    return out;
  } catch {
    return {};
  }
}

export function isAutomationMuted(projectRoot: string, slug: string, muted = readMutedAutomations()): boolean {
  return (muted[projectRoot] ?? []).includes(slug);
}

/** Mute or unmute one automation's notch notifications. Atomic temp + rename, mode 0600. */
export function setAutomationMuted(projectRoot: string, slug: string, mute: boolean, home: string = homedir()): void {
  if (!SLUG_RE.test(slug)) return;
  const all = readMutedAutomations(home);
  const list = new Set(all[projectRoot] ?? []);
  if (mute) list.add(slug); else list.delete(slug);
  if (list.size) all[projectRoot] = [...list].sort(); else delete all[projectRoot];
  const p = notchMutedPath(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, p);
}

/** Test-only reset. */
export function _resetNotchInbox(): void {
  for (const t of finishTimers.values()) clearTimeout(t);
  finishTimers.clear();
  events = [];
  presence = null;
  seenRejections.clear();
  unsubscribe?.();
  unsubscribe = null;
}
