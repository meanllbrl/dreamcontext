/**
 * The Telegram Super contract: every shape the later waves build against.
 *
 * W1 pins it; W2 (server hub, hands-free, voice), W3 (window and shell), W4 (remote runs)
 * and W5 (presentations, rich asks, commands) consume it. Types and constants only, plus a
 * few pure helpers whose ONE implementation every side must share (the sentinel rule, the
 * answer builder). Nothing here reads a file or the network.
 *
 * Plan: `state/assets/super-agent-lar-ve-ai-team-uyeleri-kisisel-telegram-botlariyla-konusur-
 * hands-free-telegram-dan-acilir/plan-final.md` (later sections win). The section that
 * decided each pin is named beside it.
 *
 * Never on disk anywhere in this contract: a message text (journal, turns), a token outside
 * `bot.json`, a pairing payload outside the hub's memory.
 */

// ─── Telegram limits (plan "Facts from the code") ───────────────────────────

export const TG_TEXT_MAX = 4096;
export const TG_CAPTION_MAX = 1024;
export const TG_CALLBACK_DATA_MAX_BYTES = 64;
export const TG_START_PAYLOAD_MAX = 64;
/** What a bot may download through `getFile`. */
export const TG_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** What a bot may upload in one request. */
export const TG_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Long-poll wait, seconds. */
export const TG_LONG_POLL_TIMEOUT_S = 50;
/** A poll gap longer than this (wall clock vs monotonic) means the Mac slept: drain, never process (H10, I5). */
export const TG_WAKE_GAP_MS = 2 * TG_LONG_POLL_TIMEOUT_S * 1000;
/** Updates the hub asks for. The manager adds `managed_bot` (X2). `message_reaction` must be
 *  named explicitly or Telegram never sends it (owner 2026-11-09: a reaction is a note). */
export const TG_ALLOWED_UPDATES = ['message', 'callback_query', 'message_reaction'] as const;
export const TG_MANAGER_ALLOWED_UPDATES = ['managed_bot', 'message'] as const;

// ─── Identity, scope, target, token ─────────────────────────────────────────

/** `super` or a member slug. */
export const TELEGRAM_TARGET_RE = /^[a-z0-9-]{1,64}$/;
/** A bot token as BotFather issues it. Checked before any use; never logged. */
export const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
/** `<sha256(realpath contextRoot)[:16]>` for a project, `global` for a global member. */
export const TELEGRAM_SCOPE_RE = /^(?:[0-9a-f]{16}|global)$/;
/** The device-level manager bot's scope directory (X2). Never a project scope. */
export const TELEGRAM_MANAGER_DIR = 'manager';

export type TelegramScope = string;
export type TelegramTarget = 'super' | string;

// ─── bot.json, poll.json, turns.json, forward.json, managed-history.json ────

/** `~/.dreamcontext/telegram/<scope>/<target>/bot.json`, 0600, written only by the hub. */
export interface BotBinding {
  v: 1;
  token: string;
  botId: number;
  botUsername: string;
  /** The paired private chat (= the owner's user id for a private chat). */
  chatId: number;
  userId: number;
  /** ISO time the binding became active. */
  boundAt: string;
  /** Created through the manager (X3); `managerBotId` names it. */
  managed?: boolean;
  managerBotId?: number;
  /** sha256 over the canonical binding without this field (config.ts `bindingHashOf`).
   *  A file whose hash does not match was not written by the hub: the binding is disabled. */
  bindingHash: string;
}

/** The manager binding (`~/.dreamcontext/telegram/manager/bot.json`): its paired user is the OWNER
 *  ID, the root of trust for every bot created later (X2). Same shape, same rules. */
export type ManagerBinding = BotBinding;

/** One accepted update awaiting its effect (E2, F3, F5). NO message text, ever: a tampered
 *  journal can only cause a "tekrar gönder" notice (F3). */
export interface JournalEntry {
  updateId: number;
  /** The Telegram ref the update was injected under, once known. */
  ref?: string;
  chatRegistryId?: string;
  kind: 'text' | 'media' | 'callback' | 'command';
  /** The turn reached a live child (`takeTelegramRef` honoured it). */
  written: boolean;
  /** Epoch ms of acceptance. */
  at: number;
}

/** `poll.json`, 0600, beside `bot.json`. */
export interface PollState {
  v: 1;
  /** The next `getUpdates` offset (last confirmed update_id + 1). */
  offset: number;
  /** Ring of handled update ids (replays dropped). */
  seenIds: number[];
  /** Ring of update ids the tick already answered "ulaşılamıyor" for (G5). */
  notifiedIds: number[];
  pending: JournalEntry[];
}
export const POLL_RING_SIZE = 200;

/** `turns.json`: which Telegram refs route back, and to which chat (A5, N7, P4). No text. */
export interface TurnRecord {
  ref: string;
  updateId: number;
  chatId: number;
  sessionId: string;
  /** Epoch ms of the first injection: routable for a HARD 24 h from here (P4). */
  firstAt: number;
}
export interface TurnsFile {
  v: 1;
  turns: TurnRecord[];
}
export const TURN_ROUTABLE_MS = 24 * 60 * 60 * 1000;

/** `forward.json` (V2, W5): routines whose `ok` results the member bot also sends. */
export interface ForwardEntry {
  projectKey: string;
  slug: string;
  approvalHash: string;
}
export interface ForwardFile {
  v: 1;
  routines: ForwardEntry[];
}

/** `~/.dreamcontext/telegram/managed-history.json` rows (AA2, AB): written at each owner-checked
 *  adoption, read by "Yeniden bağla". */
export interface ManagedHistoryRow {
  target: string;
  projectKey: string;
  botId: number;
  botUsername: string;
  creatorId: number;
  managerBotId: number;
  adoptedAt: string;
}
export interface ManagedHistoryFile {
  v: 1;
  rows: ManagedHistoryRow[];
}

// ─── Pairing (B4, A1, C4) ───────────────────────────────────────────────────

export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Wrong payloads one sender may try before that sender is ignored for the TTL (A1). */
export const PAIRING_MAX_WRONG = 5;
/** 128-bit, base64url, no padding = 22 chars. Payload and pairingId share the shape. */
export const PAIRING_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** What `GET /api/telegram-pairing/<id>` returns to Rust (B4, AA1). Never the payload, never a token. */
export interface PairingPreview {
  projectName: string;
  target: TelegramTarget;
  botUsername: string;
  botId: number;
  userId: number;
  /** Username or first name, control and bidi characters removed. */
  userLabel: string;
}

/** What the bind POST returns, ONLY in its response (B4). */
export interface PairingStart {
  pairingId: string;
  deepLink: string;
  botUsername: string;
  expiresAt: number;
}

/** `GET /api/telegram` row: status only, never a token or payload (plan "Binding routes"). */
export interface TelegramStatusRow {
  scope: TelegramScope;
  target: TelegramTarget;
  state: 'active' | 'pending' | 'disabled';
  botUsername: string;
  userLabel?: string;
  managed?: boolean;
  /** Why a binding is disabled: hash mismatch (tamper), 409 (another poller), 401 (revoked). */
  disabledReason?: 'tamper' | 'conflict' | 'unauthorized';
  /** Telegram refused the member's name/short line (`name`) or its photo (`photo`); the bot works. */
  identityIssue?: 'name' | 'photo';
}

// ─── The hub API (W2 lane A implements it, W3 consumes it through routes) ────

export interface TelegramHubApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): TelegramStatusRow[];
  /** Token in, deep link out: creates a PENDING pairing that never serves until confirmed. */
  beginPairing(input: { scope: TelegramScope; target: TelegramTarget; token: string; projectName: string }): Promise<PairingStart>;
  pairingPreview(pairingId: string): PairingPreview | null;
  /** Activates only if pairingId, botId and userId still match the live pending pairing. */
  confirmPairing(pairingId: string, shown: { botId: number; userId: number }): Promise<'ok' | 'gone' | 'mismatch'>;
  /** Sends the last message with the IN-MEMORY binding first (C3, D3), then removes the files. */
  unbind(scope: TelegramScope, target: TelegramTarget, opts: { keyed: boolean }): Promise<void>;
}

// ─── The injector and the owner turn (D1, E1, F2, F6, I4, J1) ───────────────

/** A private-use code point framing a Telegram ref INSIDE the turn text, so the ref rides every
 *  hold path byte for byte (D1). */
export const TG_SENTINEL = '';
/** The Super's ref shape (`MSG_REF_RE`, `src/lib/super/types.ts`): Telegram refs reuse it (B1). */
export const TG_REF_RE = /^[0-9a-z]{6}$/;
/** An unwritten pending ref dies after this (D1); a written one is exempt while its child lives (F5, F6). */
export const TG_PENDING_REF_TTL_MS = 30 * 60 * 1000;

/** `TG_SENTINEL + ref + TG_SENTINEL + text`. The injector removes every sentinel from `text`
 *  first (E4), so the only pair is the one written here. */
export function withTelegramRef(ref: string, text: string): string {
  if (!TG_REF_RE.test(ref)) throw new Error('bad telegram ref');
  return `${TG_SENTINEL}${ref}${TG_SENTINEL}${stripSentinels(text)}`;
}

/** Every sentinel removed: inbound Telegram text (injector) and owner-typed text (composer, F3). */
export function stripSentinels(text: string): string {
  return text.split(TG_SENTINEL).join('');
}

/**
 * THE sentinel rule (E4): parse a LEADING pair exactly once. Returns the claimed ref (still to be
 * validated against the pending-ref store: a claim is never authority) and the body with the
 * pair removed. A text without a leading well-formed pair returns `ref: null` and the text with
 * every sentinel stripped, so an owner-typed sentinel can neither route nor survive into a turn.
 * The body is NOT re-parsed: a second pair inside it is just stripped characters.
 */
export function parseTelegramPrefix(text: string): { ref: string | null; body: string } {
  if (text.startsWith(TG_SENTINEL)) {
    const end = text.indexOf(TG_SENTINEL, 1);
    const ref = end > 0 ? text.slice(1, end) : '';
    if (end > 0 && TG_REF_RE.test(ref)) return { ref, body: stripSentinels(text.slice(end + 1)) };
  }
  return { ref: null, body: stripSentinels(text) };
}

/** One pending-ref store entry (`src/lib/assistant/chat-registry.ts`, keyed by chatRegistryId =
 *  `resumeId || sessionId`). Written ONLY by the hub and the run registry; no HTTP route (E4). */
export interface PendingTelegramRef {
  updateId: number;
  at: number;
  /** Set when `writeOwnerTurn` honoured it; honoured again for the same chat (idempotent re-write, E1). */
  written: boolean;
  /** `run-report` clears exactly its cardRef's wait; `text` clears no run/secret wait (J1).
   *  `schedule` (super-rutin C5): a job the owner scheduled for his Super, answered on Telegram
   *  like his text, clearing no wait and moving no presence. */
  kind: 'text' | 'run-report' | 'schedule';
  cardRef?: string;
}

/**
 * The store's API (W2 lane A, `chat-registry.ts`). Lifetime = the REGISTRY ENTRY, not the child
 * (F2): kept across `exited()` + re-register under the same id within the grace, deleted with the
 * registry entry's death (only inside the `entries.get(id) === e` branch, F5), and on the turn's
 * clean `result` (written entries). When a child exits, the TTL clock restarts on its written
 * entries (F6).
 */
export interface PendingTelegramRefStore {
  put(chatRegistryId: string, ref: string, entry: PendingTelegramRef): void;
  /** `writeOwnerTurn`'s one call: parses the prefix ONCE, honours the ref only if it is in this
   *  chat's store, marks it written. Never honoured → `ref: null` (an ordinary Mac turn). */
  take(chatRegistryId: string, text: string): { ref: string | null; entry: PendingTelegramRef | null; body: string };
  /** The turn's main `result` with no limit/auth failure: delete the written entries of that turn. */
  settle(chatRegistryId: string, ref: string): void;
  /** Fires from the clean-`result` deletion and from the registry-death branch (F6). */
  onTelegramRefDropped(listener: TelegramRefDropped): () => void;
}
export type TelegramRefDropped = (chatRegistryId: string, ref: string, written: boolean) => void;

/** Who wrote an injected turn (I4, J1). Read by `writeOwnerTurn` from the HONOURED entry only. */
export type InjectedSource = 'telegram-text' | 'run-report' | 'schedule';
/** A source whose answer goes back to Telegram and that answers no wait on the Mac. */
export function telegramSideSource(source: InjectedSource | string | undefined): boolean {
  return source === 'telegram-text' || source === 'schedule';
}

/**
 * The injector one live Super chat registers (`registerChatInjector(sessionId, injector)` in
 * `chat-registry.ts`, beside the mirror wiring; unregistered on socket end). `sendOwnerText`
 * runs the SAME `switchGate → writeOwnerTurn` path a mirror frame takes and sends the window an
 * `owner_echo` frame itself (B1).
 */
export interface ChatInjector {
  sessionId: string;
  chatRegistryId: string;
  /** `text` already carries `withTelegramRef(ref, …)`; the hub has `put` the ref first. */
  sendOwnerText(text: string, opts: { ref: string; source: InjectedSource }): Promise<{ ok: true } | { ok: false; reason: 'closed' | 'refused' }>;
  /** `/dur` fallback ONLY when no window is mounted (P4); a mounted window gets `hub_command interrupt`. */
  interrupt(): void;
}

/** The `owner_echo` `_meta` frame (`phone-mirror.ts`): `{ref, source}` ride along (B1, C1). */
export interface OwnerEchoFrame {
  type: '_meta';
  subtype: 'owner_echo';
  text: string;
  ref?: string;
  source?: 'telegram';
}

// ─── hub_command: window verbs only the hub can send (A2, B3) ────────────────

/** Never in `WINDOW_VERBS` or `WindowVerb`; no HTTP surface. */
export type HubVerb = 'answer_pending' | 'render_card' | 'html_snapshot' | 'run_report' | 'super_handover' | 'interrupt';
export const HUB_VERBS: readonly HubVerb[] = ['answer_pending', 'render_card', 'html_snapshot', 'run_report', 'super_handover', 'interrupt'];

export interface HubCommandFrame {
  type: '_meta';
  subtype: 'hub_command';
  id: string;
  verb: HubVerb;
  args: Record<string, unknown>;
}
/** The window's answer: its own subtype, so a `window_command_result` never settles it (B3). */
export interface HubCommandResultFrame {
  type: '_meta';
  subtype: 'hub_command_result';
  id: string;
  result: HubResult;
}
export type HubResult = { ok: true; [k: string]: unknown } | { ok: false; error: string; [k: string]: unknown };

/** `sendHubCommand` in `src/lib/window-control.ts` (W2): server-internal, by token
 *  (`superTokenOfSession` / `tokenOfSession`), never by root (A2). `deliverHubResult` settles it. */
export type SendHubCommand = (token: string, verb: HubVerb, args: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<HubResult>;
export type DeliverHubResult = (token: string, id: unknown, result: HubResult) => boolean;

/** `answer_pending` args (P3): one tagged union for permissions, AskUserQuestion, super ask and
 *  child questions (W2) and rich asks (W5). The window builds the frame with its own
 *  `PermissionCard` / `buildQuestionAnswer` code and refuses secret/run/checklist/mcp/approval. */
export type AnswerPending =
  | { kind: 'permission'; requestId: string; choice: 'allow_once' | 'deny' }
  | { kind: 'question'; requestId: string; item?: string; picked: Record<string, string>; notes?: Record<string, string> }
  | { kind: 'unclear'; requestId: string; item?: string; unclear: string };

/** The question shape a hub answer is built against (`RegistryQuestion`). */
export interface AnswerQuestion {
  question: string;
  multiSelect?: boolean;
  options: { label: string }[];
}

/**
 * The hub's answer builder (P3): per question, the picked labels in OPTION order, a multiSelect
 * joined with ", " exactly as the dashboard does; keys are the exact question texts; a label
 * that is not one of that question's options, or an unknown question, is dropped. Questions with
 * nothing picked are left out. The result passes `cleanPhoneAnswer` unchanged.
 */
export function buildQuestionPicks(questions: readonly AnswerQuestion[], selections: Record<string, readonly string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const chosen = new Set(selections[q.question] ?? []);
    const labels = q.options.map((o) => o.label).filter((l) => chosen.has(l));
    if (!labels.length) continue;
    out[q.question] = q.multiSelect ? labels.join(', ') : labels[0];
  }
  return out;
}

/** `render_card` (R5, S2, T4): only insight targets reach it; the window answers `unsupported`
 *  for any other kind and the server sends that card as text. */
export type RenderCardTarget = { kind: 'container'; id: string } | { kind: 'item'; itemId: string; block: number };
/** An html/v1 insight frame: the window sends only slug + geometry; the server rebuilds the
 *  srcdoc from its own lab cache (T4). */
export interface RenderCardFrame {
  id: number;
  slug: string;
  w: number;
  h: number;
  scale?: number;
  scheme: 'light' | 'dark';
}
export interface RenderCardRoot {
  theme: string;
  cls: string[];
  zoom: number;
  scheme: 'light' | 'dark';
  tokens: Record<string, string>;
}
export type RenderCardResult =
  | { ok: true; body: string; frames: RenderCardFrame[]; root: RenderCardRoot; size: { w: number; h: number } }
  | { ok: false; reason: 'not_mounted' | 'hidden' | 'too_large' | 'web' | 'unsupported' };
/** `html_snapshot`: one at a time, at most 6 a minute (A6, R5). Server-built pages render at 720 CSS px (T5). */
export const HTML_SNAPSHOT_PER_MIN = 6;
export const SERVER_RENDER_WIDTH_PX = 720;
export const RENDER_MAX_EDGE_PX = 2048;
export const RENDER_MAX_SLICES = 4;

/** `super_handover` (N5, P4): the window's own hand-over, adopting nothing. */
export interface SuperHandoverArgs { adopt: [] }
export type SuperHandoverResult = { ok: true; sessionId: string } | { ok: false; reason: 'tab_cap' | 'reversing' | 'super_off' | 'no_window' };

/** `run_report` (H5): a run report delivered through the chat's own socket. Only NON-crew hosts
 *  (a plain chat, the Super's own card, a Telegram-started Super run) take it: a crew child's
 *  result is held by the server and delivered as an `ownerReceipt` frame (sahip-karti-yerinde K6). */
export interface RunReportArgs { sessionId: string; cardRef: string; report: RunReport }

// ─── Cards and remote runs (H1, H4, H5, H8, I1, J1, K1) ─────────────────────

export interface RunCardSpec { command: string; cwd?: string; why?: string; output?: boolean }
export interface SecretCardSpec { file: string; fields: { key: string; label?: string; hint?: string }[] }
export interface ChecklistCardSpec { title: string; items: { id: string; text: string }[] }
export interface McpCardSpec { servers: string[]; why?: string }
/** Per-chat card record in `chat-registry.ts`. `cardRef = sha256(sessionId, assistant message
 *  uuid, fence index, canonical spec JSON)`; every lookup is `(sessionId, cardRef)`. Four kinds
 *  (sahip-karti-yerinde K1): every reader handles each one by name, never "not run = secret". */
export type CardRecord = {
  sessionId: string;
  id: string;
  cardRef: string;
  state: 'open' | 'closed';
} & ({ kind: 'run'; spec: RunCardSpec } | { kind: 'secret'; spec: SecretCardSpec } | { kind: 'checklist'; spec: ChecklistCardSpec } | { kind: 'mcp'; spec: McpCardSpec });
/** Per chat; CLOSED records are evicted first (K3). */
export const CARD_RECORD_CAP = 16;
/** `~/.dreamcontext/cards/<sessionId>.json` (0700 dir, 0600 file), newest 500 closures (J1). */
export const CLOSED_CARDS_CAP = 500;

/** The run registry (H4): one run per chat across Mac, phone and Telegram, keyed `(sessionId, cardRef)`. */
export interface RunHandle {
  runId: string;
  sessionId: string;
  cardRef: string;
  startedBy: 'mac' | 'phone' | 'telegram';
  /** One line to stdin (the caller already passed I3's checks). */
  write(line: string): void;
  /** Ctrl-C: writes `\x03`. */
  interrupt(): void;
  onOutput(listener: (chunk: string, seq: number) => void): () => void;
  onExit(listener: (report: RunReport) => void): () => void;
  /** The scrubbed 64 KB replay buffer for an attaching client. */
  replay(): string;
}
export interface RunRegistry {
  start(sessionId: string, cardRef: string, by: RunHandle['startedBy']): RunHandle | { refused: 'closed' | 'busy' | 'no_record' | 'changed' };
  attach(sessionId: string, cardRef: string): RunHandle | null;
}
export const RUN_REPLAY_BYTES = 64 * 1024;
export const RUN_CAP_MS = 30 * 60 * 1000;
export interface RunReport {
  exitCode: number | null;
  /** Absent when the owner chose "Çalıştır, çıktıyı ajana verme" (H7). */
  tail?: string;
  withheld: boolean;
  text: string;
}
/** The phone's narrow run-terminal WebSocket path (H8): reads only `session` and `card`. */
export const PHONE_RUN_TERMINAL_PATH = '/api/agent/run-terminal';

/** What an approval message shows (H2, I2): exactly what the approval hash covers. */
export interface ApprovalReviewMessage {
  kind: 'automation' | 'agent';
  slug: string;
  review: string;
  diff?: string;
  foreignRunEvidence?: string;
  /** Bound into the button record; a tap re-hashes and must match. */
  hash: string;
}

// ─── Buttons (plan "Button integrity", N6) ──────────────────────────────────

/** `a:<random 64-bit hex id>:<idx>`. */
export const CALLBACK_DATA_RE = /^a:([0-9a-f]{16}):(\d{1,2})$/;
/** The hub's in-memory record behind one button set: a tap is accepted only when every field
 *  still matches. Dies with the server (a tap after a restart: "Bu soru artık geçerli değil"). */
export interface ButtonRecord {
  id: string;
  botId: number;
  chatId: number;
  messageId: number;
  /** sha256 of the exact text the hub sent. */
  textHash: string;
  /** `owner-card`: a CHILD's owner card (sahip-karti-yerinde K7, D3): Remind and Not needed only,
   *  never Run. */
  kind: 'permission' | 'question' | 'approval' | 'run' | 'secret' | 'handsfree' | 'agenda' | 'confirm' | 'owner-card';
  requestId?: string;
  sessionId?: string;
  cardRef?: string;
  options: number;
  /** Multi-select toggles re-issue the record per tap; only Gönder is single use (P4). */
  singleUse: boolean;
}

/** message_id → what a reply to it means (M4, N6). In hub MEMORY only (it holds a quote). */
export interface ReplyMapEntry {
  messageId: number;
  /** The transcript item's text the header's `ref=msgRef(…)` is built from. */
  itemRefText: string;
  quote: string;
  from: 'super' | 'owner';
}

// ─── Commands and status rows (M2, M4, M7) ──────────────────────────────────

export const TELEGRAM_COMMANDS = [
  { command: 'handsfree', description: 'Hands-free: Yalnız Telegram ya da telefon linki' },
  { command: 'dur', description: 'Çalışan işi durdur' },
  { command: 'durum', description: 'İşler, seni bekleyenler' },
  { command: 'gundem', description: 'Gündem' },
] as const;
/** An AI Team member's bot: its own work only. /gundem and /handsfree stay the Super's. */
export const MEMBER_TELEGRAM_COMMANDS = [
  { command: 'dur', description: 'Çalışan işini durdur' },
  { command: 'durum', description: 'İşleri, seni bekleyenler' },
] as const;
export type TelegramCommand = (typeof TELEGRAM_COMMANDS)[number]['command'] | 'start';

export type StatusState = 'running' | 'done' | 'stuck' | 'waiting' | 'asking' | 'gone';
export const STATUS_GLYPH: Record<StatusState, string> = {
  running: '⏳',
  done: '✅',
  stuck: '⚠',
  waiting: '✋',
  asking: '❓',
  gone: '✖',
};
export const STATUS_LABEL: Record<StatusState, string> = {
  running: 'çalışıyor',
  done: 'bitti',
  stuck: 'takıldı',
  waiting: 'seni bekliyor',
  asking: 'soru soruyor',
  gone: 'gitti',
};
/** The live status message is edited at most this often; typing every 4 s while busy. */
export const STATUS_EDIT_MIN_MS = 2000;
export const TYPING_EVERY_MS = 4000;

// ─── Hands-free events (D2, E3, E4) ─────────────────────────────────────────

export type HandsfreeChannel = 'telegram' | 'full';
/** `auto`: the hub started this power-only run BY ITSELF on the owner's Telegram presence (his
 *  message reached the Super through its bot); only such a run ends by itself when he is back at
 *  the Mac. A run he started by the `/handsfree` button or the link mode never carries it. */
export interface StartedVia { scope: TelegramScope; target: TelegramTarget; auto?: true }
/** `MacSession` emits these (W2 lane B). Streaming is DERIVED: `isOn() && startedVia` names the
 *  binding, evaluated per message (E3); there is no stored flag. */
export type HandsfreeEvent =
  /** A run is on (automatic or by hand): the owner is away, Super questions go out (`hub.flushAway`). */
  | { type: 'started'; channel: HandsfreeChannel; startedVia?: StartedVia }
  | { type: 'ended'; channel: HandsfreeChannel; reason: string; keyed: boolean; startedVia?: StartedVia }
  | { type: 'batteryFloor'; startedVia?: StartedVia }
  | { type: 'heat'; level: string; startedVia?: StartedVia }
  /** The tunnel origin changed: the BARE origin is re-sent, never a login token. */
  | { type: 'url'; origin: string; startedVia?: StartedVia };

// ─── Voice (A6) ─────────────────────────────────────────────────────────────

/** `src/lib/voice/transcribe.ts` (W2 lane C), extracted from `handleVoiceStt`: WAV bytes in, text out. */
export type TranscribeAudio = (wav: Buffer, opts?: { language?: string }) => Promise<string>;

// ─── Routine forwarding (Y2, Z2, AA3) ───────────────────────────────────────

/** In `RunOptionsBase` (W2): `tickProject` collects deferred sends instead of awaiting each. */
export type OnDeferredSend = (send: () => Promise<void>) => void;

// ─── Managed bots (X1, X3, Z5, AA3) ─────────────────────────────────────────

export interface TgUserRef {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
/** A `managed_bot` update, normalised (`parseManagedBot` in poller.ts). The spike settles the
 *  wire field names; the parser accepts both spellings the sources disagree on. */
export interface ManagedBotUpdate {
  updateId: number;
  bot: TgUserRef;
  creator: TgUserRef;
}
/** A pending creation, one per Mac (X3): a new start voids the previous; voided usernames are
 *  kept 10 min so a late `managed_bot` for one is refused (AA3). */
export interface PendingCreation {
  creationId: string;
  target: TelegramTarget;
  scope: TelegramScope;
  projectKey: string;
  suggestedUsername: string;
  name: string;
  expiresAt: number;
}
export const CREATION_TTL_MS = 10 * 60 * 1000;

// ─── URL classification (Q3, Q6, N4) ────────────────────────────────────────

/** Tunnel providers: a URL on one of these never becomes a button or a link (Q6). */
export const TUNNEL_PROVIDER_DOMAINS: readonly string[] = [
  'trycloudflare.com',
  'ngrok-free.app',
  'ngrok.io',
  'ngrok.app',
  'loca.lt',
  'localtunnel.me',
  'serveo.net',
  'ts.net',
];

/** True when `hostname` is a tunnel provider's domain or a subdomain of one. */
export function isTunnelHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return TUNNEL_PROVIDER_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

// ─── A child's owner card on Telegram (sahip-karti-yerinde K7, D3) ─────────────────────────────

/** The two buttons a child's card gets on Telegram: never Run (the Mac's terminal runs it). */
export const OWNER_CARD_REMIND_LABEL = "Mac'e dönünce hatırlat";
export const OWNER_CARD_NOT_NEEDED_LABEL = 'Gerek yok';
/** What a tap answers. */
export const OWNER_CARD_REMIND_DONE = "✓ Mac'e dönünce hatırlatırım.";
export const OWNER_CARD_NOT_NEEDED_DONE = '✓ Gerek yok dendi.';
/** The one desktop notification at his next owner-at-Mac (titles joined in its body). */
export const OWNER_CARD_REMIND_TITLE = 'Mac\'te seni bekleyen kartlar';
