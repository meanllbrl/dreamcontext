/**
 * The Telegram hub: the server half of the Telegram channel (W2 lane A).
 *
 * Started by `startDashboardServer` on the desktop only. One long-poll loop per ACTIVE binding
 * (W1 `poller.ts`: pid lock per token, start/wake drain, journal-before-confirm), plus a
 * short-lived loop per live PAIRING (the token is only polled for `/start <payload>` until the
 * native confirm). Everything that reaches a chat goes through the injector the chat registered
 * (`chat-registry.ts`), never a route; everything that leaves goes through the W1 transport
 * (redactor, link previews off, token never in an error).
 *
 * Super target (plan A3, B1, D1, E2, F5, F6, M1/N7, M2, A4, G5, H10):
 *  - an authorized text or file → the project's Super is on and has a session → its injector
 *    (or the Super window is reopened through its session link and the injector awaited) →
 *    `withTelegramRef(ref, text)` with the ref put in the store first; journaled, then confirmed;
 *  - the Super's answer → the sections whose `re:` names a routable Telegram ref (24 h hard cap
 *    from first injection), or the whole text when the turn held only Telegram text; while the
 *    owner is ON TELEGRAM (his latest message to this Super came through this bot, under 24 h,
 *    see `onTelegram`) every section, whatever ref it opens with (job results, owed answers);
 *    while Telegram-started hands-free is on, every answer (marks stripped);
 *  - typing while the turn runs; one status message per Telegram message, rows = children and
 *    team jobs whose origin is that ref; the status line edited to its done state;
 *  - the Super chat's own permission / question prompts as buttons answered through the window
 *    (`hub_command answer_pending`), so the Mac card closes;
 *  - every loss of a binding sends a last message from the IN-MEMORY binding first (C3, D3).
 *
 * Member targets go through `member.ts` (the member's thread), the manager through `manager.ts`.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  chatInjector, getChat, onChatAssistantText, onChatChange, onChatInjector, onChatUserSent, telegramRefs,
  type ChatEntry, type PendingQuestion,
} from '../../lib/assistant/chat-registry.js';
import { appLinkForContextRoot } from '../../lib/app-link.js';
import { listVaults } from '../../lib/vaults.js';
import { readSuperState } from '../../lib/super/store.js';
import { superTokenOfSession, sendHubCommand } from '../../lib/window-control.js';
import { teamJobStatus } from '../../lib/super/team.js';
import { msgRef } from '../../lib/super/types.js';
import {
  CALLBACK_DATA_RE, PAIRING_TTL_MS, STATUS_EDIT_MIN_MS, TELEGRAM_COMMANDS, TG_ALLOWED_UPDATES, TG_REF_RE,
  TURN_ROUTABLE_MS, TYPING_EVERY_MS, withTelegramRef,
  type BotBinding, type ButtonRecord, type JournalEntry, type PairingPreview, type PairingStart, type StatusState,
  type TelegramHubApi, type TelegramScope, type TelegramStatusRow, type TelegramTarget, type TurnRecord,
} from '../../lib/telegram/contract.js';
import {
  bindingDir, isValidScope, isValidTarget, isValidToken, listBindings, readBinding, readPollState, readTurns,
  redactToken, removeBindingDir, scopeOfContextRoot, writeBinding, writePollState, writeTurns,
} from '../../lib/telegram/config.js';
import { onOwnerAtMac } from '../../lib/telegram/back-at-mac.js';
import { isAuthorized, PairingBook, StrangerCounter, type TgUpdateLike } from '../../lib/telegram/auth.js';
import { TelegramTransport, type FetchLike } from '../../lib/telegram/transport.js';
import { TelegramPoller, type PollStateIO, type UpdateDisposition } from '../../lib/telegram/poller.js';
import { escapeHtml, redactSecrets, splitReplySections, stripReplyMarks, toTelegramMessages } from '../../lib/telegram/format.js';
import { SILENT, noticeHtml, statusLineHtml, voiceEchoHtml, type NoticeKind } from '../../lib/telegram/system-lines.js';
import { formatAskCardMessages, formatAskQuestionHtml } from '../../lib/telegram/ask-format.js';
import { inboundTurnText, pickInboundMedia, saveInbound } from '../../lib/telegram/inbound.js';
import { parseReaction, shortQuote, telegramReactionNotes } from '../../lib/telegram/reactions.js';
import { displayNameFor, syncBotIdentity, type IdentityIssue, type JpegConverter } from './identity.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

/** The pairing target the manager uses on the wire (W3 route proposal): never a member slug. */
export const MANAGER_PAIRING_TARGET = '@manager';
/** How long a reopened Super has to register its injector (A3). */
export const INJECTOR_WAIT_MS = 45_000;
/** The last-message send never waits longer than this on a binding loss (D3). */
const LAST_MESSAGE_TIMEOUT_MS = 5_000;
/** Typing and the live status message stop after this, whatever the turn does. */
const TURN_TYPING_CAP_MS = 2 * 60 * 60 * 1000;

export const LINES = {
  superOff: "Bu projede Super kapalı; Mac'te açınca yazabilirsin.",
  cannotOpen: "Super Mac'te açılamadı; uygulamaya bakıp tekrar yaz.",
  notWritten: "Mesajın Mac'e yazılamadı; tekrar gönder.",
  writtenNotDone: "Mesajın Mac'e yazıldı ama iş bitmedi; tekrar göndermeden önce Mac'e bak.",
  stale: 'Bu soru artık geçerli değil.',
  waitingOnMac: "Mac'te seni bekliyor.",
  unknownCommand: 'Bu komut yok. Komutlar: /durum /gundem /dur /handsfree',
  bound: (who: string) => `Bağlandı: ${who}. Buradan yazabilirsin.`,
  unbound: () => "Telegram bağlantısı Mac'te kaldırıldı.",
  conflict: "Bu bot başka yerde de dinleniyor, bağlantı durdu; BotFather'da token'ı yenile.",
  tamper: "Bu botun Mac'teki kaydı değişti; güvenlik için bağlantı durdu.",
  endedSilent: "Bu tur cevap yazmadan bitti; tekrar yaz ya da Mac'e bak.",
} as const;

// ─── Dependencies (tests inject fakes) ──────────────────────────────────────

export interface HubHandsfree {
  /** Streaming is DERIVED (E3): Telegram-started hands-free is on for exactly this binding. */
  streamsTo(scope: TelegramScope, target: TelegramTarget): boolean;
  /** `/handsfree` and its buttons (W2 lane B). Returns true when it handled the update. */
  onCommand?(hub: TelegramHub, key: BindingKey, update: Obj): Promise<boolean>;
  onCallback?(hub: TelegramHub, key: BindingKey, record: ButtonRecord, idx: number): Promise<string | null>;
  /** A binding is lost: Telegram-only hands-free it started ends (C3, D3). */
  onBindingLost?(scope: TelegramScope, target: TelegramTarget): void;
  /** An authorized owner message the hub injected into a Super (`onTelegram`). Only the hub calls
   *  it; it is how Telegram-only hands-free starts by itself. */
  onPresence?(hub: TelegramHub, key: BindingKey, via: 'telegram'): void;
  /** He wrote on the Mac, in any dreamcontext chat (`lib/telegram/back-at-mac.ts`): the automatic
   *  run ends, machine-wide. Returns the binding it tells itself (its own "back" line), or null. */
  onBackAtMac?(hub: TelegramHub): BindingKey | null;
  /** Any hands-free run is on (automatic, or started by hand from Telegram, the Mac panel or the
   *  phone link): the owner counts as away (`ownerAway`). */
  isOn?(): boolean;
}

export interface HubMember {
  /** An authorized message to a member bot. */
  onMessage(hub: TelegramHub, key: BindingKey, update: Obj): Promise<UpdateDisposition>;
}


export interface HubDeps {
  home?: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  now?: () => number;
  /** Long-poll wait in seconds (tests: 0). */
  pollTimeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Registered projects: name + context root. */
  vaults?: () => { name: string; contextRoot: string }[];
  /** `open -g <link>`: reopens the Super window (A3). */
  openLink?: (url: string) => void;
  injectorWaitMs?: number;
  /** Lane C: OGG file → transcript; throws `ffmpeg_missing` when ffmpeg is absent. */
  transcribeVoice?: (oggPath: string) => Promise<string>;
  handsfree?: HubHandsfree;
  member?: HubMember;
  /** Mac banner (tamper, conflict, unkeyed unbind). */
  banner?: (title: string, body: string) => void;
  /** Binding a bot makes sure the launchd dispatcher exists (lane B). */
  ensureDispatcher?: () => void;
  /** A non-JPG member photo → JPG for `setMyProfilePhoto` (default: macOS `sips`; tests inject). */
  toJpeg?: JpegConverter;
}

export type BindingKey = string; // `${scope}/${target}`
export const keyOf = (scope: TelegramScope, target: TelegramTarget): BindingKey => `${scope}/${target}`;

export interface ActiveBinding {
  key: BindingKey;
  scope: TelegramScope;
  target: TelegramTarget;
  binding: BotBinding;
  transport: TelegramTransport;
  poller: TelegramPoller | null;
  /** The poll loop's run: awaited before another loop takes this token's lock. */
  done: Promise<unknown>;
  /** The hub stopped this loop on purpose (unbind, re-pair, replace, shutdown): no lock retry. */
  halted?: boolean;
  /** Deliveries run one after another, in the order Telegram sent them (a photo, then "bunu düzelt"). */
  chain: Promise<void>;
  contextRoot: string | null;
  projectName: string;
  disabled?: TelegramStatusRow['disabledReason'];
}

interface LivePairing {
  book: PairingBook;
  pairingId: string;
  scope: TelegramScope | 'manager';
  target: TelegramTarget;
  token: string;
  projectName: string;
  contextRoot: string | null;
  transport: TelegramTransport;
  poller: TelegramPoller;
  done: Promise<unknown>;
  botId: number;
  botUsername: string;
  /** Bindings on the same token this pairing paused; given back if it is never confirmed. */
  paused?: ActiveBinding[];
  /** The manager's own loop yielded this token to the pairing (re-key): resumed if unconfirmed. */
  managerYielded?: boolean;
}

/** One Telegram message's live turn (status, typing, final line). In memory only. */
interface TgTurn {
  ref: string;
  key: BindingKey;
  chatId: number;
  sessionId: string;
  startedAt: number;
  statusMessageId: number | null;
  statusText: string;
  lastEditAt: number;
  typing: ReturnType<typeof setInterval> | null;
  answered: boolean;
}

// ─── The hub ────────────────────────────────────────────────────────────────

export class TelegramHub implements TelegramHubApi {
  readonly home: string;
  readonly now: () => number;
  readonly strangers = new StrangerCounter();
  readonly active = new Map<BindingKey, ActiveBinding>();
  private pairings = new Map<string, LivePairing>();
  private buttons = new Map<string, ButtonRecord & { key: BindingKey; data?: Obj; hubEdited?: boolean }>();
  private turns = new Map<string, TgTurn>();
  /** Super chat pin id → the binding that routes it. */
  private superSessions = new Map<string, BindingKey>();
  /** Per Super chat: what the running turn's owner inputs were (fallback rule, plan "Which answer"). */
  private turnInputs = new Map<string, { telegram: Set<string>; mac: boolean }>();
  /** Per Super chat: its texts still being sent, chained so they reach Telegram in the order the
   *  Super wrote them; a turn's end waits on it before it may call the turn silent. */
  private textChains = new Map<string, Promise<void>>();
  /** Per Super binding: where the owner's LATEST message came from (`onTelegram`).
   *  DERIVED, never set by an agent: `injectText` (an authorized Telegram message or a button the
   *  hub turned into a turn) marks `telegram`; his own words typed on the Mac in ANY dreamcontext
   *  chat (`onOwnerAtMac`, owner 2026-11-09) mark every binding `mac`. Memory only: a restarted
   *  server starts off Telegram (fails toward fewer sends). */
  private presence = new Map<BindingKey, { via: 'telegram' | 'mac'; at: number }>();
  /** Prompts already sent (requestId), so a re-emitted `asking` does not send twice. */
  private sentPrompts = new Set<string>();
  private unsubs: Array<() => void> = [];
  /** Loops being stopped whose lock the next `activate` must wait for. */
  private waitTokens: Promise<unknown>[] = [];
  private started = false;

  constructor(readonly deps: HubDeps = {}) {
    this.home = deps.home ?? homedir();
    this.now = deps.now ?? Date.now;
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(
      onChatAssistantText((sid, text) => this.queueAssistantText(sid, text)),
      onChatChange((c) => this.onChatChange(c.entry, c.from)),
      onChatUserSent((sid, _text, source) => this.noteUserSent(sid, source)),
      onOwnerAtMac((at) => this.backAtMac(at)),
      telegramRefs.onTelegramRefDropped((id, ref, written) => this.onRefDropped(id, ref, written)),
      telegramRefs.onTelegramRefWritten((id, ref) => this.onRefWritten(id, ref)),
    );
    for (const row of listBindings(this.home)) {
      if (!row.read.ok) continue;
      this.activate(row.scope, row.target, row.read.binding);
    }
    this.manager?.start();
    // Bots already bound get their member's name and photo once, only where it differs.
    void (async () => { for (const ab of [...this.active.values()]) await this.syncIdentity(ab); })();
  }

  /** Last identity issue per binding (name or photo not set), for the status row. */
  private identityIssues = new Map<BindingKey, IdentityIssue>();
  private identityChains = new Map<BindingKey, Promise<void>>();

  /** Sets the bot's name, short line and photo from its member (identity.ts). Never throws. */
  syncIdentity(ab: ActiveBinding): Promise<void> {
    const prev = this.identityChains.get(ab.key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const live = () => this.active.get(ab.key) === ab && !ab.disabled && !ab.halted;
      if (!live()) return;
      const issue = await syncBotIdentity({
        scope: ab.scope, target: ab.target, botId: ab.binding.botId, transport: ab.transport, contextRoot: ab.contextRoot, projectName: ab.projectName,
      }, this.home, this.deps.toJpeg, live).catch(() => undefined);
      // Removed or replaced meanwhile: nothing is recorded for a binding that is gone.
      if (!live()) { this.identityIssues.delete(ab.key); return; }
      if (issue) this.identityIssues.set(ab.key, issue); else this.identityIssues.delete(ab.key);
    });
    this.identityChains.set(ab.key, next);
    return next;
  }

  /** A member's title or photo changed: every bot bound to it takes the new one. */
  refreshIdentity(target: TelegramTarget): void {
    for (const ab of this.active.values()) if (ab.target === target) void this.syncIdentity(ab);
  }

  /** The device-level manager (manager.ts `wireManager`). */
  manager: import('./manager.js').TelegramManager | null = null;

  async stop(): Promise<void> {
    for (const u of this.unsubs.splice(0)) u();
    this.manager?.stop();
    for (const ab of this.active.values()) this.halt(ab);
    for (const p of this.pairings.values()) p.poller.stop();
    for (const t of this.turns.values()) if (t.typing) clearInterval(t.typing);
    this.turns.clear();
    this.pairings.clear();
    this.started = false;
  }

  transportFor(token: string): TelegramTransport {
    return new TelegramTransport({ token, fetchImpl: this.deps.fetchImpl, baseUrl: this.deps.baseUrl });
  }

  /** Name + context root for a scope (a project), null for `global` / unknown. */
  projectOf(scope: TelegramScope): { name: string; contextRoot: string } | null {
    if (scope === 'global') return null;
    const vaults = this.deps.vaults?.() ?? listVaults(this.home).map((v) => ({ name: v.name, contextRoot: join(v.path, '_dream_context') }));
    for (const v of vaults) if (scopeOfContextRoot(v.contextRoot) === scope) return v;
    return null;
  }

  private pollIO(scope: TelegramScope, target: TelegramTarget): PollStateIO {
    const dir = bindingDir(scope, target, this.home);
    return { read: () => readPollState(dir, this.home), write: (s) => writePollState(dir, s, this.home) };
  }

  /** Starts serving one hub-written binding. */
  activate(scope: TelegramScope, target: TelegramTarget, binding: BotBinding): ActiveBinding {
    const key = keyOf(scope, target);
    const prev = this.active.get(key);
    if (prev) this.halt(prev);
    const project = this.projectOf(scope);
    const ab: ActiveBinding = {
      key, scope, target, binding, transport: this.transportFor(binding.token), poller: null, done: Promise.resolve(), chain: Promise.resolve(),
      contextRoot: project?.contextRoot ?? null, projectName: project?.name ?? '',
    };
    this.active.set(key, ab);
    this.recoverJournal(ab);
    let reported = false;
    ab.poller = new TelegramPoller({
      transport: ab.transport,
      token: binding.token,
      state: this.pollIO(scope, target),
      allowedUpdates: TG_ALLOWED_UPDATES,
      onUpdate: (u) => this.onUpdate(key, u),
      onStop: (why) => { reported = true; if (why !== 'stopped') void this.loseBinding(key, why === 'conflict' ? 'conflict' : 'unauthorized'); },
      home: this.home,
      now: this.now,
      sleep: this.deps.sleep,
      timeoutS: this.deps.pollTimeoutS,
    });
    // One loop per token: the previous loop on this key (or a pairing's) lets go of the lock first.
    const before = Promise.all([prev?.done, ...this.waitTokens.splice(0)]);
    // A token lock still held (the tick, a crashed run inside the lock's stale window) makes
    // `run()` return 'conflict' WITHOUT polling or reporting: retry until it frees, never deaf.
    const loop = async (): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        if (this.active.get(key) !== ab || ab.disabled || ab.halted) return 'stopped';
        reported = false;
        const why = await ab.poller!.run();
        if (why !== 'conflict' || reported || ab.halted) return why;
        await new Promise((r) => { const t = setTimeout(r, Math.min(30_000, 2_000 * (attempt + 1))); t.unref?.(); });
      }
    };
    ab.done = before.then(loop);
    return ab;
  }

  /** Bindings a pairing paused poll again (expired or voided without a confirm). */
  private resumePaused(paused: ActiveBinding[] | undefined, after: Promise<unknown>, managerYielded = false): void {
    if (managerYielded) void after.then(() => this.manager?.start());
    for (const ab of paused ?? []) {
      if (this.active.get(ab.key) !== ab || ab.disabled) continue;
      this.waitTokens.push(after);
      this.activate(ab.scope, ab.target, ab.binding);
    }
  }

  /** Stops a binding's loop on purpose (no lock retry afterwards). */
  halt(ab: ActiveBinding): void {
    ab.halted = true;
    ab.poller?.stop();
  }

  /** Shutdown: stop every loop and drop the token locks synchronously (the run's own finally
   *  releases them again, harmlessly). */
  releaseNow(): void {
    for (const ab of this.active.values()) { this.halt(ab); ab.poller?.release(); }
    for (const p of this.pairings.values()) { p.poller.stop(); p.poller.release(); }
    this.manager?.releaseNow();
  }

  status(): TelegramStatusRow[] {
    const rows: TelegramStatusRow[] = [];
    for (const ab of this.active.values()) {
      rows.push({
        scope: ab.scope, target: ab.target, state: ab.disabled ? 'disabled' : 'active', botUsername: ab.binding.botUsername,
        ...(ab.binding.managed ? { managed: true } : {}), ...(ab.disabled ? { disabledReason: ab.disabled } : {}),
        ...(this.identityIssues.has(ab.key) ? { identityIssue: this.identityIssues.get(ab.key) } : {}),
      });
    }
    for (const p of this.pairings.values()) {
      if (p.scope === 'manager') continue;
      const cur = p.book.current();
      // Pending = someone sent the link's /start and the native confirm is due (never before).
      if (!cur?.pendingUser || this.active.has(keyOf(p.scope, p.target))) continue;
      rows.push({ scope: p.scope, target: p.target, state: 'pending', botUsername: p.botUsername, userLabel: cur.pendingUser.label });
    }
    return rows;
  }

  // ── Pairing (B4, A1, C4) ──

  async beginPairing(input: { scope: TelegramScope | 'manager'; target: TelegramTarget; token: string; projectName: string; contextRoot?: string | null }): Promise<PairingStart> {
    const { scope, target, token } = input;
    if (!isValidToken(token)) throw new HubError(400, 'bad_token', 'That is not a bot token.');
    if (scope !== 'manager' && (!isValidScope(scope) || !isValidTarget(target))) throw new HubError(400, 'bad_target', 'Unknown target.');
    const transport = this.transportFor(token);
    let me;
    try {
      me = await transport.getMe();
      const hook = await transport.getWebhookInfo();
      if (hook?.url) throw new HubError(409, 'webhook_set', 'This bot has a webhook set; remove it in BotFather or with deleteWebhook first.');
    } catch (err) {
      if (err instanceof HubError) throw err;
      throw new HubError(400, 'bot_unreachable', redactToken((err as Error).message, token));
    }
    const botId = Number(me.id);
    const botUsername = String(me.username ?? '');
    if (!Number.isSafeInteger(botId) || !/^[A-Za-z0-9_]{1,64}$/.test(botUsername)) throw new HubError(400, 'bot_unreachable', 'Telegram did not name the bot.');
    // A bot already bound to ANOTHER target is refused (one bot, one target).
    for (const ab of this.active.values()) {
      if (ab.binding.botId === botId && !(scope !== 'manager' && ab.scope === scope && ab.target === target)) throw new HubError(409, 'bot_in_use', 'This bot is already connected to something else on this Mac.');
    }
    // A new bind for the target voids its previous pairing (B4).
    for (const [id, p] of [...this.pairings]) {
      if (p.scope === scope && p.target === target) { p.poller.stop(); this.pairings.delete(id); await p.done; this.resumePaused(p.paused, p.done, p.managerYielded); }
    }
    const book = new PairingBook(this.now);
    const pairing = book.mint({ scope: scope === 'manager' ? 'global' : scope, target: scope === 'manager' ? MANAGER_PAIRING_TARGET : target, botId, botUsername });
    const poller = new TelegramPoller({
      transport,
      token,
      state: memoryPollState(),
      allowedUpdates: ['message'],
      onUpdate: async (u) => { await this.onPairingUpdate(pairing.pairingId, u); return 'accepted'; },
      home: this.home,
      now: this.now,
      sleep: this.deps.sleep,
      timeoutS: this.deps.pollTimeoutS,
    });
    // An active binding polling the same token holds its lock: stop it while pairing anew.
    const managerYielded = scope === 'manager' ? (await this.manager?.yieldToken(token)) ?? false : false;
    const same = [...this.active.values()].filter((ab) => ab.binding.token === token);
    for (const ab of same) this.halt(ab);
    await Promise.all(same.map((ab) => ab.done));
    const live: LivePairing = {
      book, pairingId: pairing.pairingId, scope, target: scope === 'manager' ? MANAGER_PAIRING_TARGET : target, token,
      projectName: input.projectName, contextRoot: input.contextRoot ?? null, transport, poller, done: Promise.resolve(), botId, botUsername,
    };
    this.pairings.set(pairing.pairingId, live);
    live.done = poller.run().then((why) => {
      // A lock held elsewhere (e.g. the manager re-paired with its own live token): this pairing
      // cannot serve; whatever it paused polls again.
      if (why === 'conflict' && this.pairings.get(pairing.pairingId) === live) { this.pairings.delete(pairing.pairingId); this.resumePaused(live.paused, Promise.resolve(), live.managerYielded); }
      return why;
    });
    // Never confirmed in its 10 minutes: the loop stops and a binding it paused polls again.
    const expiry = setTimeout(() => {
      if (this.pairings.get(pairing.pairingId) !== live) return;
      this.pairings.delete(pairing.pairingId);
      live.poller.stop();
      this.resumePaused(same, live.done, managerYielded);
    }, PAIRING_TTL_MS + 1_000);
    expiry.unref?.();
    live.paused = same;
    live.managerYielded = managerYielded;
    return { pairingId: pairing.pairingId, deepLink: `https://t.me/${botUsername}?start=${pairing.payload}`, botUsername, expiresAt: pairing.expiresAt };
  }

  private async onPairingUpdate(pairingId: string, u: Obj): Promise<void> {
    const live = this.pairings.get(pairingId);
    if (!live) return;
    const out = live.book.onStart(u as unknown as TgUpdateLike);
    const chatId = Number(obj(obj(u.message)?.chat)?.id);
    if (out.result === 'pending' && Number.isSafeInteger(chatId)) {
      await live.transport.sendMessage(chatId, escapeHtml("Mac'te onay bekleniyor: Mac'teki pencerede «Bağla»ya bas.")).catch(() => {});
    }
  }

  pairingPreview(pairingId: string): PairingPreview | null {
    const live = this.pairings.get(pairingId);
    const p = live?.book.preview(pairingId);
    if (!live || !p || !p.pendingUser) return null;
    return { projectName: live.projectName, target: live.target, botUsername: live.botUsername, botId: live.botId, userId: p.pendingUser.userId, userLabel: p.pendingUser.label };
  }

  /** The vault the pairing was minted in (AA1): null for the manager. */
  pairingContext(pairingId: string): { contextRoot: string | null; scope: TelegramScope | 'manager' } | null {
    const live = this.pairings.get(pairingId);
    return live ? { contextRoot: live.contextRoot, scope: live.scope } : null;
  }

  async confirmPairing(pairingId: string, shown: { botId: number; userId: number }): Promise<'ok' | 'gone' | 'mismatch'> {
    const live = this.pairings.get(pairingId);
    if (!live) return 'gone';
    const out = live.book.confirm(pairingId, shown);
    if (out.result !== 'ok') return out.result;
    this.pairings.delete(pairingId);
    live.poller.stop();
    this.waitTokens.push(live.done);
    const user = out.pairing.pendingUser!;
    const fields = { token: live.token, botId: live.botId, botUsername: live.botUsername, chatId: user.chatId, userId: user.userId, boundAt: new Date(this.now()).toISOString() };
    if (live.scope === 'manager') {
      // The paired user id becomes the OWNER ID (X2); a new token for the same bot re-keys (AA3).
      // The pairing loop lets go of the token's lock before the manager's own loop takes it.
      this.waitTokens = this.waitTokens.filter((p) => p !== live.done);
      await live.done;
      const b = await this.adoptManager(fields);
      await this.manager?.onPairingConfirmed(b);
      return 'ok';
    }
    // A confirmed bind that replaces an active one: the old bot says its last word first (C3).
    const key = keyOf(live.scope, live.target);
    const old = this.active.get(key);
    if (old && old.binding.botId !== live.botId) await this.lastMessage(old, 'info', LINES.unbound());
    if (old) this.halt(old);
    if (old && (old.binding.botId !== live.botId || old.binding.chatId !== user.chatId || old.binding.userId !== user.userId)) {
      removeBindingDir(live.scope, live.target, this.home);
    }
    const binding = writeBinding(live.scope, live.target, fields, this.home);
    const ab = this.activate(live.scope, live.target, binding);
    try { this.deps.ensureDispatcher?.(); } catch { /* the bind sheet names it; never fails the bind */ }
    void this.afterBound(ab, displayNameFor(ab, this.home));
    return 'ok';
  }

  /** The manager's adoption of its own pairing: `manager.ts` writes it (kept out of the Super path). */
  private async adoptManager(fields: Omit<BotBinding, 'v' | 'bindingHash'>): Promise<BotBinding> {
    const { writeManagerBinding } = await import('../../lib/telegram/config.js');
    return writeManagerBinding(fields, this.home);
  }

  async afterBound(ab: ActiveBinding, who: string): Promise<void> {
    if (ab.target === 'super') await ab.transport.setMyCommands(TELEGRAM_COMMANDS).catch(() => {});
    await this.notice(ab, 'info', LINES.bound(who));
    await this.syncIdentity(ab);
  }

  // ── Losing a binding (C3, D3) ──

  async unbind(scope: TelegramScope, target: TelegramTarget, opts: { keyed: boolean; replaceManagedToken?: (botId: number) => Promise<void> }): Promise<void> {
    const key = keyOf(scope, target);
    const ab = this.active.get(key);
    for (const [id, p] of [...this.pairings]) if (p.scope === scope && p.target === target) { p.poller.stop(); this.pairings.delete(id); }
    if (ab) {
      // The route only takes the owner's own page (fromPageHeaders), whose Remove button never sends the key: an unkeyed unbind is his own click, so the last line is quiet.
      await this.lastMessage(ab, 'info', LINES.unbound(), false);
      this.halt(ab);
      this.active.delete(key);
      this.deps.handsfree?.onBindingLost?.(scope, target);
      if (ab.binding.managed && opts.replaceManagedToken) await opts.replaceManagedToken(ab.binding.botId).catch(() => { /* manager.ts marks the row */ });
    }
    removeBindingDir(scope, target, this.home);
    if (!opts.keyed) this.deps.banner?.('Telegram', 'Telegram bağlantısı kaldırıldı');
  }

  private async loseBinding(key: BindingKey, why: 'conflict' | 'unauthorized' | 'tamper'): Promise<void> {
    const ab = this.active.get(key);
    if (!ab || ab.disabled) return;
    ab.disabled = why;
    this.halt(ab);
    if (why !== 'unauthorized') await (why === 'conflict' ? this.lastMessage(ab, 'warn', LINES.conflict, true) : this.lastMessage(ab, 'access', LINES.tamper, true));
    // A 401 on a bot the manager made: the manager token may be out (Z4, AA3).
    if (why === 'unauthorized' && ab.binding.managed) this.manager?.raise('unauthorized');
    this.deps.handsfree?.onBindingLost?.(ab.scope, ab.target);
    this.deps.banner?.('Telegram', why === 'tamper' ? "Telegram kaydı Mac'te değişti; bağlantı durduruldu." : 'Telegram bağlantısı durdu.');
  }

  /** Best-effort, from the in-memory binding, never longer than 5 s (D3). */
  private async lastMessage(ab: ActiveBinding, kind: NoticeKind, line: string, loud = false): Promise<void> {
    await Promise.race([
      ab.transport.sendMessage(ab.binding.chatId, noticeHtml(kind, line), loud ? {} : SILENT).catch(() => {}),
      new Promise((r) => { const t = setTimeout(r, LAST_MESSAGE_TIMEOUT_MS); t.unref?.(); }),
    ]);
  }

  /** The file still says what the hub wrote (tamper alarm). */
  private intact(ab: ActiveBinding): boolean {
    const r = readBinding(ab.scope, ab.target, this.home);
    return r.ok && r.binding.bindingHash === ab.binding.bindingHash;
  }

  // ── Sending ──

  async send(ab: ActiveBinding, html: string, extra: Obj = {}): Promise<{ message_id: number; text?: string }> {
    const sent = await (ab.transport.sendMessage(ab.binding.chatId, html, extra) as Promise<{ message_id: number; text?: string }>);
    // What a reaction to it quotes (reactions.ts): the first words Telegram shows, memory only.
    if (Number.isSafeInteger(sent?.message_id) && typeof sent.text === 'string' && sent.text.trim()) {
      this.sentQuotes.set(`${ab.key}:${sent.message_id}`, shortQuote(sent.text));
      if (this.sentQuotes.size > 2000) this.sentQuotes.delete(this.sentQuotes.keys().next().value as string);
    }
    return sent;
  }

  /** message id → the short quote of what the hub sent there (a reaction's note). Memory only. */
  private sentQuotes = new Map<string, string>();

  /** Markdown → one or more Telegram messages. */
  /** `blocks: 'hub'` only from a caller that draws the blocks itself afterwards (the Super's
   *  answer paths call `answerExtras`); every other caller (members, notices) keeps "Mac'te" lines. */
  async sendMarkdown(ab: ActiveBinding, md: string, reply?: { ref: string; quote?: string }, blocks: 'hub' | 'mac' = 'mac'): Promise<void> {
    for (const html of toTelegramMessages(redactSecrets(md), { blocks })) {
      const sent = await this.send(ab, html);
      if (reply && Number.isSafeInteger(sent?.message_id)) this.noteReply(ab, sent.message_id, { ref: reply.ref, quote: reply.quote ?? md, from: 'super' });
    }
  }

  async reply(ab: ActiveBinding, line: string): Promise<void> {
    await this.send(ab, escapeHtml(line)).catch(() => {});
  }

  /** A fixed system line: meaning emoji + one italic sentence (`noticeHtml`). Silent unless
   *  `loud` (the owner has to do something). The only way the hub says a warning or a state. */
  async notice(ab: ActiveBinding, kind: NoticeKind, sentence: string, loud = false): Promise<void> {
    await this.send(ab, noticeHtml(kind, sentence), loud ? {} : SILENT).catch(() => {});
  }

  // ── Inbound ──

  async onUpdate(key: BindingKey, u: Obj): Promise<UpdateDisposition> {
    const ab = this.active.get(key);
    if (!ab || ab.disabled) return 'accepted';
    if (!isAuthorized(u as unknown as TgUpdateLike, ab.binding)) { this.strangers.note(u as unknown as TgUpdateLike); return 'accepted'; }
    if (!this.intact(ab)) { await this.loseBinding(key, 'tamper'); return 'accepted'; }
    if (u.message_reaction) { await this.onReaction(ab, u); return 'accepted'; }
    const cb = obj(u.callback_query);
    if (cb) { await this.onCallback(ab, cb); return 'accepted'; }
    const msg = obj(u.message);
    if (!msg) return 'accepted';
    if (ab.target !== 'super') return this.deps.member ? this.deps.member.onMessage(this, key, u) : 'accepted';
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    // A reply to a live run's output goes to that run's stdin before anything else (W4, H6).
    if (this.messageHook && await this.messageHook(ab, msg)) return 'accepted';
    if (text.startsWith('/')) {
      if (await this.deps.handsfree?.onCommand?.(this, key, u)) return 'accepted';
      if (this.commandHook && await this.commandHook(ab, u)) return 'accepted';
      if (/^\/start(?:@\w+)?(?:\s|$)/.test(text)) { await this.reply(ab, 'Buradayım. Yaz, Super Mac\'te okusun.'); return 'accepted'; }
      await this.notice(ab, 'info', LINES.unknownCommand);
      return 'accepted';
    }
    if (text && this.interceptText && await this.interceptText(ab, msg)) return 'accepted';
    return this.onOwnerMessage(ab, Number(u.update_id), msg);
  }

  /**
   * His reaction on one of the bot's messages (owner 2026-11-09): a NOTE for the agent's next
   * turn, never a turn of its own, never an answer, never an approval (reactions.ts). Reached
   * only past `isAuthorized`. A removal drops that message's note.
   */
  private async onReaction(ab: ActiveBinding, u: Obj): Promise<void> {
    const r = parseReaction(u);
    if (!r || r.chatId !== ab.binding.chatId || r.userId !== ab.binding.userId) return;
    // Only what the bot sent: a reaction on his own message quotes nothing.
    const mapped = this.replyOf(ab, r.messageId);
    const quote = this.sentQuotes.get(`${ab.key}:${r.messageId}`) ?? (mapped?.from === 'super' ? mapped.quote : null);
    if (ab.target !== 'super') { telegramReactionNotes.add(`member:${ab.key}`, r.messageId, r.emojis, quote, this.now()); return; }
    if (!ab.contextRoot) return;
    let session: string | null = null;
    try { session = (await readSuperState(ab.contextRoot))?.session ?? null; } catch { session = null; }
    if (session) telegramReactionNotes.add(`super:${session}`, r.messageId, r.emojis, quote, this.now());
  }

  private journal(ab: ActiveBinding, fn: (pending: JournalEntry[]) => JournalEntry[]): void {
    const io = this.pollIO(ab.scope, ab.target);
    const s = io.read();
    io.write({ ...s, pending: fn(s.pending) });
  }

  /** Leftovers from a crash: one notice each, then cleared (E2, F5). */
  private recoverJournal(ab: ActiveBinding): void {
    const io = this.pollIO(ab.scope, ab.target);
    const s = io.read();
    if (!s.pending.length) return;
    const lines = s.pending.map((e) => (e.written ? LINES.writtenNotDone : LINES.notWritten));
    io.write({ ...s, pending: [] });
    void (async () => { for (const l of new Set(lines)) await this.notice(ab, 'warn', l, true); })();
  }

  private async onOwnerMessage(ab: ActiveBinding, updateId: number, msg: Obj): Promise<UpdateDisposition> {
    if (!ab.contextRoot) return 'accepted';
    let state;
    try { state = await readSuperState(ab.contextRoot); } catch { state = null; }
    if (!state?.enabled || !state.session) { await (this.superOff ? this.superOff(ab) : this.notice(ab, 'info', LINES.superOff)); return 'accepted'; }
    const media = pickInboundMedia(msg);
    this.journal(ab, (p) => [...p, { updateId, kind: media ? 'media' : 'text', written: false, at: this.now() }]);
    // Confirmed now (journaled); delivered in order behind the previous message.
    const session = state.session;
    ab.chain = ab.chain.then(() => this.deliver(ab, updateId, msg, session).catch(async () => {
      this.journal(ab, (p) => p.filter((e) => e.updateId !== updateId));
      await this.notice(ab, 'warn', LINES.notWritten, true);
    })).catch(() => { /* one failed link never stops the next delivery */ });
    return 'accepted';
  }

  private async deliver(ab: ActiveBinding, updateId: number, msg: Obj, sessionId: string): Promise<void> {
    const drop = () => this.journal(ab, (p) => p.filter((e) => e.updateId !== updateId));
    const paths: string[] = [];
    let spoken: string | null = null;
    const media = pickInboundMedia(msg);
    if (media) {
      const saved = await saveInbound({ transport: ab.transport, contextRoot: ab.contextRoot!, media, now: this.now() });
      if (!saved.ok) { await this.notice(ab, 'file', saved.line, true); if (!msg.text && !msg.caption) { drop(); return; } }
      else if (media.kind === 'voice' || media.kind === 'audio') {
        try {
          spoken = await (this.deps.transcribeVoice ? this.deps.transcribeVoice(saved.path) : Promise.reject(new Error('no_transcriber')));
        } catch (err) {
          const missing = /ffmpeg_missing/.test((err as Error).message);
          await this.notice(ab, 'warn', missing ? 'Sesli not için ffmpeg gerekli: Mac\'te brew install ffmpeg yaz.' : 'Sesli notu yazıya çeviremedim; yazarak gönder.', true);
          paths.push(saved.path);
        }
        if (spoken !== null) await this.send(ab, voiceEchoHtml(spoken), SILENT).catch(() => {});
      } else paths.push(saved.path);
    }
    let text = inboundTurnText(msg, paths);
    if (spoken) text = `🎙 ${spoken}${text ? `\n\n${text}` : ''}`;
    if (!text.trim()) { drop(); return; }
    // A hub-built header (a reply to a bot message, an agenda line's "Yaz", W5 M4/N6) goes first.
    const head = this.turnPrefix ? this.turnPrefix(ab, msg) : '';
    if (head) text = `${head}\n\n${text}`;
    const ref = await this.injectText(ab, updateId, text, sessionId);
    if (!ref) { drop(); return; }
    const mid = Number(msg.message_id);
    if (Number.isSafeInteger(mid)) this.noteReply(ab, mid, { ref, quote: inboundTurnText(msg, []) || (spoken ?? ''), from: 'owner' });
  }

  // ── Replies (M4, N6): message_id → what a reply to it means. Memory only (it holds a quote). ──

  private replies = new Map<string, { ref: string; quote: string; from: 'super' | 'owner' }>();

  noteReply(ab: ActiveBinding, messageId: number, entry: { ref: string; quote: string; from: 'super' | 'owner' }): void {
    this.replies.set(`${ab.key}:${messageId}`, entry);
    if (this.replies.size > 2000) this.replies.delete(this.replies.keys().next().value as string);
  }

  replyOf(ab: ActiveBinding, messageId: number): { ref: string; quote: string; from: 'super' | 'owner' } | null {
    return this.replies.get(`${ab.key}:${messageId}`) ?? null;
  }

  /** W5 seams, set by `wireTelegramW5`: commands (/dur /durum /gundem), the header a turn opens
   *  with, and what an answer's blocks become (pictures, buttons). */
  commandHook: ((ab: ActiveBinding, update: Obj) => Promise<boolean>) | null = null;
  turnPrefix: ((ab: ActiveBinding, msg: Obj) => string) | null = null;
  answerExtras: ((ab: ActiveBinding, text: string, sessionId: string) => Promise<void>) | null = null;
  /** A text that answers the hub itself (a rich ask's "Not ekle", W5): never a turn. */
  interceptText: ((ab: ActiveBinding, msg: Obj) => Promise<boolean>) | null = null;
  /** A prompt richer than one single-select question (multi-select, several questions, M3). */
  richQuestion: ((ab: ActiveBinding, sessionId: string, q: PendingQuestion) => Promise<boolean>) | null = null;
  /** "Bu projede Super kapalı" with a Super'i aç button (N5). */
  superOff: ((ab: ActiveBinding) => Promise<void>) | null = null;
  /** The owner just turned away (`flushAway`): the Super-side senders (asks.ts) send what is still
   *  open, each once (their own sent guards). */
  readonly awayFlushers = new Set<(ab: ActiveBinding) => Promise<void>>();

  /** The answer paths leave the blocks to `answerExtras` only when it is wired. */
  private extrasMode(): 'hub' | 'mac' { return this.answerExtras ? 'hub' : 'mac'; }

  /** The live Telegram turn of a Super chat (its ref), or null. */
  telegramTurnOf(sessionId: string): string | null {
    for (const t of this.turns.values()) if (t.sessionId === sessionId) return t.ref;
    return null;
  }

  /** Writes one owner turn into the project's Super under a fresh Telegram ref (B1, D1): the
   *  window reopened when needed; the ref put in the store BEFORE the text goes; turns.json,
   *  status and typing begun. False = it did not reach the Super (the owner was told). */
  async injectText(ab: ActiveBinding, updateId: number, text: string, sessionId: string, as: { kind: 'run-report'; cardRef: string } | null = null): Promise<string | false> {
    const drop = () => this.journal(ab, (p) => p.filter((e) => e.updateId !== updateId));
    const inj = await this.waitInjector(ab, sessionId);
    if (!inj) { await this.notice(ab, 'warn', LINES.cannotOpen, true); return false; }
    const ref = this.mintRef(ab);
    telegramRefs.put(inj.chatRegistryId, ref, { updateId, at: this.now(), written: false, kind: as?.kind ?? 'text', ...(as ? { cardRef: as.cardRef } : {}) });
    this.journal(ab, (p) => p.map((e) => (e.updateId === updateId ? { ...e, ref, chatRegistryId: inj.chatRegistryId } : e)));
    const dir = bindingDir(ab.scope, ab.target, this.home);
    const turns = readTurns(dir, this.home);
    const fresh = turns.turns.filter((t) => this.now() - t.firstAt < TURN_ROUTABLE_MS);
    const rec: TurnRecord = { ref, updateId, chatId: ab.binding.chatId, sessionId, firstAt: this.now() };
    writeTurns(dir, { v: 1, turns: [...fresh, rec].slice(-500) }, this.home);
    this.superSessions.set(sessionId, ab.key);
    this.beginTurn(ab, ref, sessionId);
    const r = await inj.sendOwnerText(withTelegramRef(ref, text), { ref, source: as ? 'run-report' : 'telegram-text' });
    if (!r.ok) {
      telegramRefs.forget(inj.chatRegistryId, ref);
      this.endTurn(ref);
      drop();
      await this.notice(ab, 'warn', LINES.notWritten, true);
      return false;
    }
    // A run report is the app's, not a message he wrote: it moves no presence.
    if (!as) {
      this.presence.set(ab.key, { via: 'telegram', at: this.now() });
      try { this.deps.handsfree?.onPresence?.(this, ab.key, 'telegram'); } catch { /* best-effort */ }
      this.flushAway();
    }
    return ref;
  }

  /** The Super binding of a project by vault name, or null. */
  superBindingOfVault(vault: string): ActiveBinding | null {
    for (const ab of this.active.values()) if (ab.target === 'super' && !ab.disabled && ab.projectName === vault && ab.contextRoot) return ab;
    return null;
  }

  /** A synthetic update id for turns the hub writes from a button (no Telegram message behind them). */
  private synth = 0;
  syntheticUpdateId(): number { this.synth -= 1; return this.synth; }

  /** A fresh 6-char base-36 ref, never one already in turns.json (B1). */
  private mintRef(ab: ActiveBinding): string {
    const taken = new Set(readTurns(bindingDir(ab.scope, ab.target, this.home), this.home).turns.map((t) => t.ref));
    for (;;) {
      const ref = randomInt(0, 36 ** 6).toString(36).padStart(6, '0');
      if (TG_REF_RE.test(ref) && !taken.has(ref) && !this.turns.has(ref)) return ref;
    }
  }

  /** The live injector, or the Super window reopened through its session link and awaited (A3). */
  private async waitInjector(ab: ActiveBinding, sessionId: string) {
    const have = chatInjector(sessionId);
    if (have) return have;
    const link = ab.contextRoot ? appLinkForContextRoot(ab.contextRoot, { kind: 'session', claudeId: sessionId } as never, this.home) : null;
    if (!link) return null;
    return new Promise<ReturnType<typeof chatInjector>>((resolve) => {
      let done = false;
      const finish = (v: ReturnType<typeof chatInjector>) => { if (done) return; done = true; clearTimeout(timer); off(); resolve(v); };
      const off = onChatInjector((sid) => { if (sid === sessionId) finish(chatInjector(sid)); });
      const timer = setTimeout(() => finish(null), this.deps.injectorWaitMs ?? INJECTOR_WAIT_MS);
      timer.unref?.();
      try { (this.deps.openLink ?? openInBackground)(link); } catch { finish(null); }
    });
  }

  private onRefWritten(chatRegistryId: string, ref: string): void {
    for (const ab of this.active.values()) {
      if (ab.target !== 'super') continue;
      const s = this.pollIO(ab.scope, ab.target).read();
      if (!s.pending.some((e) => e.ref === ref && e.chatRegistryId === chatRegistryId && !e.written)) continue;
      this.journal(ab, (p) => p.map((e) => (e.ref === ref && e.chatRegistryId === chatRegistryId ? { ...e, written: true } : e)));
    }
  }

  private onRefDropped(chatRegistryId: string, ref: string, written: boolean): void {
    // A dropped ref's turn is over, whatever happened to it: its typing and status stop.
    const t = this.turns.get(ref);
    if (t && (!written || getChat(chatRegistryId)?.status === 'gone' || !getChat(chatRegistryId))) this.endTurn(ref);
    for (const ab of this.active.values()) {
      if (ab.target !== 'super') continue;
      const s = this.pollIO(ab.scope, ab.target).read();
      const hit = s.pending.find((e) => e.ref === ref && e.chatRegistryId === chatRegistryId);
      if (!hit) continue;
      this.journal(ab, (p) => p.filter((e) => e !== hit && !(e.ref === ref && e.chatRegistryId === chatRegistryId)));
      // Settled on a clean result while the chat lives = done. Otherwise the owner is told (F5).
      const entry = getChat(chatRegistryId);
      const clean = written && !!entry && entry.status !== 'gone';
      if (!clean) void this.notice(ab, 'warn', written ? LINES.writtenNotDone : LINES.notWritten, true);
    }
  }

  // ── Turn status: typing, one status message, the final line (plan "Status message", M2) ──

  private beginTurn(ab: ActiveBinding, ref: string, sessionId: string): void {
    const turn: TgTurn = { ref, key: ab.key, chatId: ab.binding.chatId, sessionId, startedAt: this.now(), statusMessageId: null, statusText: '', lastEditAt: 0, typing: null, answered: false };
    this.turns.set(ref, turn);
    const tick = () => {
      // Never forever: a chat that died mid-turn, or a turn past its cap, stops typing.
      const live = getChat(sessionId);
      if (!live || live.status === 'gone' || this.now() - turn.startedAt > TURN_TYPING_CAP_MS) { this.endTurn(ref); return; }
      void ab.transport.sendChatAction(ab.binding.chatId, 'typing').catch(() => {});
      void this.refreshStatus(turn).catch(() => {});
    };
    tick();
    turn.typing = setInterval(tick, TYPING_EVERY_MS);
    turn.typing.unref?.();
  }

  private endTurn(ref: string): TgTurn | null {
    const t = this.turns.get(ref);
    if (!t) return null;
    if (t.typing) clearInterval(t.typing);
    t.typing = null;
    this.turns.delete(ref);
    return t;
  }

  /** The rows of one Telegram message: children and team jobs whose origin is its ref. */
  async statusRows(ab: ActiveBinding, ref: string): Promise<{ state: StatusState; label: string; note?: string }[]> {
    if (!ab.contextRoot) return [];
    const s = await readSuperState(ab.contextRoot);
    const rows: { state: StatusState; label: string; note?: string }[] = [];
    for (const c of Object.values(s.children)) {
      if (c.origin !== ref) continue;
      const live = getChat(c.sessionId);
      const pending = live?.pendingQuestion?.isPermission;
      const state: StatusState = pending ? 'waiting' : c.row === 'working' ? 'running' : c.row === 'asking' ? 'asking' : c.row === 'done' ? 'done'
        : c.row === 'stuck' ? 'stuck' : c.row === 'gone' ? 'gone' : c.row === 'waiting' ? 'waiting' : 'running';
      rows.push({ state, label: (c.brief || 'iş').slice(0, 60), note: pending ? 'izin bekliyor' : undefined });
    }
    for (const j of s.team) {
      if (j.origin !== ref) continue;
      let st: string = 'running';
      try { st = teamJobStatus(ab.contextRoot, j, null).status; } catch { /* running */ }
      const state: StatusState = st === 'done' ? 'done' : st === 'failed' ? 'stuck' : st === 'asking' ? 'asking' : 'running';
      rows.push({ state, label: `${j.member}: ${(j.brief || '').slice(0, 50)}` });
    }
    return rows;
  }

  private async refreshStatus(turn: TgTurn): Promise<void> {
    const ab = this.active.get(turn.key);
    if (!ab) return;
    const rows = await this.statusRows(ab, turn.ref);
    if (!rows.length) return;
    const text = rows.map((r) => statusLineHtml(r.state, r.label, r.note)).join('\n');
    if (text === turn.statusText) return;
    if (turn.statusMessageId === null) {
      const sent = await this.send(ab, text, SILENT);
      turn.statusMessageId = sent.message_id;
    } else {
      if (this.now() - turn.lastEditAt < STATUS_EDIT_MIN_MS) return;
      await ab.transport.editMessageText(ab.binding.chatId, turn.statusMessageId, text).catch(() => {});
    }
    turn.statusText = text;
    turn.lastEditAt = this.now();
  }

  private noteUserSent(sessionId: string, source: string | undefined): void {
    // Presence is not read here: only words typed on the Mac end it (`backAtMac`), whichever chat.
    if (!this.superSessions.has(sessionId)) return;
    const cur = this.turnInputs.get(sessionId) ?? { telegram: new Set<string>(), mac: false };
    if (source !== 'telegram-text') cur.mac = true;
    this.turnInputs.set(sessionId, cur);
  }

  private onChatChange(entry: ChatEntry, from: string): void {
    const key = this.superSessions.get(entry.sessionId);
    if (!key) return;
    const ab = this.active.get(key);
    if (entry.status === 'asking' && entry.pendingQuestion && ab) void this.sendPrompt(ab, entry.sessionId, entry.pendingQuestion).catch(() => {});
    if (entry.status === 'gone') for (const t of [...this.turns.values()]) if (t.sessionId === entry.sessionId) this.endTurn(t.ref);
    if (entry.status === 'idle' && from !== 'idle') {
      this.turnInputs.delete(entry.sessionId);
      // Every text of this turn was emitted before its `result`: the ones still sending are here.
      const sending = this.textChains.get(entry.sessionId);
      for (const t of [...this.turns.values()]) {
        if (t.sessionId !== entry.sessionId) continue;
        this.endTurn(t.ref);
        if (!ab) continue;
        void (async () => {
          await sending;
          await this.refreshStatus({ ...t, lastEditAt: 0 }).catch(() => {});
          // No turn-end receipt: the answer is already there. Only a turn that ended with no text
          // for the owner says one plain line (it failed or stopped while he waits).
          if (!t.answered) await this.notice(ab, 'warn', LINES.endedSilent, true);
        })();
      }
    }
  }

  // ── Outbound: which answer goes back (B1, M1, N7, E3) ──

  /** Is `ref` a Telegram ref of this binding, still routable (24 h hard cap from first injection)? */
  routable(ab: ActiveBinding, ref: string): boolean {
    return readTurns(bindingDir(ab.scope, ab.target, this.home), this.home).turns.some((t) => t.ref === ref && this.now() - t.firstAt < TURN_ROUTABLE_MS);
  }

  /** A Telegram owner turn of this Super chat is in flight (W4: a run card posted in it is sent). */
  hasTelegramTurn(sessionId: string): boolean {
    return [...this.turns.values()].some((t) => t.sessionId === sessionId);
  }

  bindingOfSession(sessionId: string): ActiveBinding | null {
    const key = this.superSessions.get(sessionId);
    if (key) return this.active.get(key) ?? null;
    return null;
  }

  /** Refreshes the Super chat → binding map from each bound project's state (streaming needs it
   *  for chats no Telegram text has reached yet). */
  async refreshSuperSessions(): Promise<void> {
    for (const ab of this.active.values()) {
      if (ab.target !== 'super' || !ab.contextRoot) continue;
      try {
        const s = await readSuperState(ab.contextRoot);
        if (s.session) this.superSessions.set(s.session, ab.key);
      } catch { /* unreadable: nothing routes */ }
    }
  }

  /** He wrote on the Mac, in any dreamcontext chat of any project (owner 2026-11-09): the automatic
   *  Telegram part ends machine-wide, silently (owner 2026-11-09: no unprompted mode note; the
   *  answers simply stop coming to Telegram). A hands-free run started by hand is never touched
   *  (`onBackAtMac` ends only an `auto` run). */
  private backAtMac(at: number): void {
    for (const ab of this.active.values()) {
      if (ab.target !== 'super') continue;
      if (this.presence.has(ab.key)) this.presence.set(ab.key, { via: 'mac', at });
    }
    try { this.deps.handsfree?.onBackAtMac?.(this); } catch { /* best-effort */ }
  }

  /** The owner is ON TELEGRAM for this Super binding: his latest message to it came through
   *  this bot, under 24 h ago (N7's cap). Derived from the hub's own injections and the chats'
   *  owner turns only: no CLI, route or agent text can set it. */
  onTelegram(ab: ActiveBinding): boolean {
    const p = this.presence.get(ab.key);
    return !!p && p.via === 'telegram' && this.now() - p.at < TURN_ROUTABLE_MS;
  }

  /** THE gate on every Super-side question and permission sent to Telegram (owner 2026-11-09,
   *  "Yalnız uzaktayken"): the owner is AWAY while Telegram's automatic part is on for him (his
   *  latest owner message to a Super bot came through Telegram, `onTelegram`, and no typing on the
   *  Mac ended it) or while any hands-free run is on, automatic or started by hand. At the Mac the
   *  Mac card is the only one: the senders (the `asks.ts` sink and child permissions, `sendPrompt`)
   *  send nothing and mark nothing sent, so `flushAway` can send it later. Machine-wide, like
   *  back-at-Mac. AI Team member bots never read it (their rule: questions and failures always). */
  ownerAway(): boolean {
    try { if (this.deps.handsfree?.isOn?.()) return true; } catch { /* unknown: the presence fact decides */ }
    for (const ab of this.active.values()) if (ab.target === 'super' && !ab.disabled && this.onTelegram(ab)) return true;
    return false;
  }

  /** The owner turned away (a Telegram owner message, a hands-free run starting): every Super
   *  question and permission still open goes to its bot now, once. Idempotent: each sender keeps
   *  its own sent guard, so a call on every Telegram message re-sends nothing. Coming back to the
   *  Mac withdraws nothing already sent; those buttons still answer. */
  flushAway(): void {
    if (!this.ownerAway()) return;
    for (const ab of [...this.active.values()]) {
      if (ab.target !== 'super' || ab.disabled || !ab.contextRoot) continue;
      const root = ab.contextRoot;
      void (async () => {
        try {
          const s = await readSuperState(root);
          if (s.enabled && s.session) {
            this.superSessions.set(s.session, ab.key);
            const own = getChat(s.session);
            if (own?.status === 'asking' && own.pendingQuestion) await this.sendPrompt(ab, s.session, own.pendingQuestion);
          }
        } catch { /* unreadable: the next turn-away tries again */ }
        for (const f of [...this.awayFlushers]) await f(ab).catch(() => {});
      })();
    }
  }

  private turnsOf(sessionId: string): TgTurn[] {
    return [...this.turns.values()].filter((t) => t.sessionId === sessionId);
  }

  /**
   * One send for this Super chat, after the ones before it (a text, a card, a text: in that order).
   * The running turn is read NOW, as the Super writes; it counts as having spoken only when `send`
   * says a message LANDED on Telegram (a failed send leaves the turn silent, so its end says so).
   * The turn's end waits on this chain before it judges.
   */
  queueSend(sessionId: string, send: (turns: TgTurn[]) => Promise<boolean>): void {
    const turns = this.turnsOf(sessionId);
    const next = (this.textChains.get(sessionId) ?? Promise.resolve())
      .then(() => send(turns))
      .then((landed) => { if (landed) for (const t of turns) t.answered = true; })
      .catch(() => { /* best-effort: nothing landed, the turn stays silent */ });
    this.textChains.set(sessionId, next);
    void next.then(() => { if (this.textChains.get(sessionId) === next) this.textChains.delete(sessionId); });
  }

  /** One Super text: its turn's inputs read now, as it is written, never after a send. */
  private queueAssistantText(sessionId: string, text: string): void {
    const inputs = this.turnInputs.get(sessionId);
    this.queueSend(sessionId, (turns) => this.onAssistantText(sessionId, text, { turns, inputs }));
  }

  /** True when a message of this text landed on Telegram. */
  async onAssistantText(sessionId: string, text: string, at?: { turns: TgTurn[]; inputs: { telegram: Set<string>; mac: boolean } | undefined }): Promise<boolean> {
    const turns = at?.turns ?? this.turnsOf(sessionId);
    const inputs = at ? at.inputs : this.turnInputs.get(sessionId);
    let ab = this.bindingOfSession(sessionId);
    if (!ab) { await this.refreshSuperSessions(); ab = this.bindingOfSession(sessionId); }
    if (!ab || ab.disabled || ab.target !== 'super') return false;
    if (this.deps.handsfree?.streamsTo(ab.scope, ab.target)) {
      const all = stripReplyMarks(text);
      if (!all.trim()) return false;
      await this.sendMarkdown(ab, all, { ref: msgRef(text), quote: all }, this.extrasMode());
      await this.answerExtras?.(ab, all, sessionId).catch(() => {});
      return true;
    }
    const sections = splitReplySections(text);
    // On Telegram, every owner-facing section goes, whatever ref it opens with (a job's result
    // under a Mac ref, an owed answer); each section once, through this one sender.
    const wide = this.onTelegram(ab);
    let sent = false;
    let tried = false;
    for (const s of sections) {
      const hit = s.refs.find((r) => this.routable(ab!, r));
      if ((!hit && !wide) || !s.text.trim()) continue;
      tried = true;
      // One section that does not land does not stop the next.
      try { await this.sendMarkdown(ab, s.text, { ref: msgRef(text), quote: s.text }, this.extrasMode()); } catch { continue; }
      sent = true;
      await this.answerExtras?.(ab, s.text, sessionId).catch(() => {});
    }
    // A section tried (landed or not) is this text's one way out: never sent again as a whole.
    if (tried || sections.some((s) => s.refs.length)) return sent;
    // No `re:` section: the whole text, only when the turn held Telegram text alone.
    if (!turns.length || inputs?.mac || !text.trim()) return false;
    await this.sendMarkdown(ab, text, { ref: msgRef(text) }, this.extrasMode());
    await this.answerExtras?.(ab, text, sessionId).catch(() => {});
    return true;
  }

  // ── Buttons (plan "Button integrity") ──

  /** Sends a message with buttons and binds them: random id, message id, text hash, single use. */
  async sendButtons(ab: ActiveBinding, html: string, labels: string[][], rec: Omit<ButtonRecord, 'id' | 'botId' | 'chatId' | 'messageId' | 'textHash' | 'options'>, data?: Obj, urlRows: unknown[][] = []): Promise<string> {
    const id = randomBytes(8).toString('hex');
    let idx = 0;
    const keyboard: unknown[][] = labels.map((row) => row.map((label) => ({ text: label, callback_data: `a:${id}:${idx++}` })));
    keyboard.push(...urlRows);
    const sent = await this.send(ab, html, { reply_markup: { inline_keyboard: keyboard } });
    this.buttons.set(id, {
      ...rec, id, key: ab.key, botId: ab.binding.botId, chatId: ab.binding.chatId, messageId: sent.message_id,
      textHash: sha256(typeof sent.text === 'string' ? sent.text : ''), options: idx, ...(data ? { data } : {}),
    });
    return id;
  }

  /** The message a button record was sent on (`sendButtons`' id), or null. */
  buttonMessageId(recId: string): number | null {
    return this.buttons.get(recId)?.messageId ?? null;
  }

  /** The question on this message was answered elsewhere: its text says so and its buttons go
   *  (an edit with no reply_markup removes the keyboard; every record bound to it dies). */
  async closeAnswered(ab: ActiveBinding, messageId: number, html: string): Promise<boolean> {
    for (const b of [...this.buttons.values()]) if (b.key === ab.key && b.messageId === messageId) this.buttons.delete(b.id);
    return ab.transport.editMessageText(ab.binding.chatId, messageId, html).then(() => true, () => false);
  }

  /** A multi-select toggle (P4): the message's buttons re-drawn under a FRESH record bound to the
   *  same message and text; the records it replaces die. Only the hub edits its own messages. */
  async reissueButtons(ab: ActiveBinding, messageId: number, labels: string[][], rec: Omit<ButtonRecord, 'id' | 'botId' | 'chatId' | 'messageId' | 'textHash' | 'options'>, data?: Obj): Promise<string | null> {
    const old = [...this.buttons.values()].filter((b) => b.key === ab.key && b.messageId === messageId);
    if (!old.length) return null;
    const id = randomBytes(8).toString('hex');
    let idx = 0;
    const keyboard = labels.map((row) => row.map((label) => ({ text: label, callback_data: `a:${id}:${idx++}` })));
    await ab.transport.call('editMessageReplyMarkup', { chat_id: ab.binding.chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    for (const b of old) this.buttons.delete(b.id);
    this.buttons.set(id, {
      ...rec, id, key: ab.key, botId: ab.binding.botId, chatId: ab.binding.chatId, messageId, textHash: old[0].textHash, options: idx, hubEdited: true,
      ...(data ? { data } : {}),
    });
    return id;
  }

  /** A tap: every binding checked, consumed on first use (single-use records). */
  private async onCallback(ab: ActiveBinding, cb: Obj): Promise<void> {
    const id = typeof cb.id === 'string' ? cb.id : '';
    const m = CALLBACK_DATA_RE.exec(typeof cb.data === 'string' ? cb.data : '');
    const rec = m ? this.buttons.get(m[1]) : undefined;
    const message = obj(cb.message);
    const idx = m ? Number(m[2]) : -1;
    const ok = !!rec && rec.key === ab.key && rec.botId === ab.binding.botId && rec.chatId === ab.binding.chatId
      && Number(message?.message_id) === rec.messageId && (message?.edit_date === undefined || rec.hubEdited === true)
      && sha256(typeof message?.text === 'string' ? message.text : '') === rec.textHash && idx >= 0 && idx < rec.options;
    if (!ok) { await ab.transport.answerCallbackQuery(id, LINES.stale).catch(() => {}); return; }
    if (rec!.singleUse) this.buttons.delete(rec!.id);
    let answer: string | null = null;
    try {
      answer = await this.handleButton(ab, rec!, idx);
    } catch {
      answer = LINES.stale;
    }
    await ab.transport.answerCallbackQuery(id, answer ?? undefined).catch(() => {});
    if (answer && rec!.singleUse) {
      await ab.transport.editMessageText(ab.binding.chatId, rec!.messageId, `${escapeHtml(String(message?.text ?? ''))}\n\n${escapeHtml(answer)}`).catch(() => {});
    }
  }

  private async handleButton(ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string | null> {
    if (rec.kind === 'handsfree') return this.deps.handsfree?.onCallback?.(this, ab.key, rec, idx) ?? LINES.stale;
    if ((rec.kind === 'permission' || rec.kind === 'question') && rec.data?.queue !== true) {
      const sessionId = rec.sessionId ?? '';
      const entry = getChat(sessionId);
      const pending = [entry?.pendingQuestion, ...(entry?.earlierPending ?? [])].find((p) => p?.requestId === rec.requestId);
      if (!pending) return LINES.stale;
      const token = superTokenOfSession(sessionId) ?? (await import('../../lib/window-control.js')).tokenOfSession(sessionId);
      if (!token) return LINES.waitingOnMac;
      const args = rec.kind === 'permission'
        ? { kind: 'permission', requestId: rec.requestId, choice: idx === 0 ? 'allow_once' : 'deny' }
        : { kind: 'question', requestId: rec.requestId, picked: { [String(rec.data?.question ?? '')]: String((rec.data?.labels as string[] | undefined)?.[idx] ?? '') } };
      const r = await sendHubCommand(token, 'answer_pending', args);
      if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
      return rec.kind === 'permission' ? (idx === 0 ? '✓ İzin verildi (bir kez)' : '✗ Reddedildi') : `✓ ${String((rec.data?.labels as string[] | undefined)?.[idx] ?? '')}`;
    }
    return this.extraButton ? this.extraButton(ab, rec, idx) : LINES.stale;
  }

  /** Kaldır on a managed target revokes its token through the manager first (X6); manager.ts sets it. */
  replaceManagedToken: ((botId: number) => Promise<void>) | undefined = undefined;
  /** Settings → Telegram (W3 route proposal); manager.ts widens it. */
  managerStatus(): { manager: TelegramStatusRow | null; bots: { projectName: string; target: string; label: string; botUsername: string; state: string }[]; alarm?: 'conflict' | 'unauthorized' | 'tamper' } {
    const bots = [...this.active.values()].map((ab) => ({
      projectName: ab.scope === 'global' ? 'Tüm projeler' : ab.projectName, target: ab.target,
      label: ab.target === 'super' ? 'Super' : ab.target, botUsername: ab.binding.botUsername, state: ab.disabled ? 'disabled' : 'active',
    }));
    return { manager: this.managerNow(), bots };
  }
  managerRow: (() => TelegramStatusRow | null) | null = null;

  /**
   * The manager's row as Settings must see it: a manager pairing whose /start arrived is
   * `pending` with the user's label (that row is what raises the native confirm), else the bound
   * manager. Every status surface reads the manager through here, never `managerRow` alone:
   * `status()` skips manager pairings, so without this the confirm never came (2026-11-08).
   */
  managerNow(): TelegramStatusRow | null {
    for (const p of this.pairings.values()) {
      if (p.scope !== 'manager') continue;
      const cur = p.book.current();
      if (!cur?.pendingUser) continue;
      return { scope: 'global', target: MANAGER_PAIRING_TARGET, state: 'pending', botUsername: p.botUsername, userLabel: cur.pendingUser.label };
    }
    return this.managerRow ? this.managerRow() : null;
  }
  removeManager: ((keyed?: boolean) => Promise<void>) | undefined = undefined;

  /** Further button kinds (answer.ts asks, approvals) plug in here. */
  extraButton: ((ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number) => Promise<string | null>) | null = null;
  /** W4 (runs.ts): an owner message the run cards take (a reply into a live run). True = handled. */
  messageHook: ((ab: ActiveBinding, msg: Obj) => Promise<boolean>) | null = null;

  /** The Super chat's own pending prompt as buttons (permission: allow once / deny only). */
  private async sendPrompt(ab: ActiveBinding, sessionId: string, q: PendingQuestion): Promise<void> {
    // At the Mac: the Mac card only, and nothing marked sent (`flushAway` sends it if he turns away).
    if (!this.ownerAway() || this.sentPrompts.has(q.requestId)) return;
    this.sentPrompts.add(q.requestId);
    if (this.sentPrompts.size > 500) this.sentPrompts.delete(this.sentPrompts.values().next().value as string);
    await this.sendPendingQuestion(ab, sessionId, q);
  }

  /** Shared with child permissions (A4): the prompt as a buttoned message, or the Mac line. */
  async sendPendingQuestion(ab: ActiveBinding, sessionId: string, q: PendingQuestion, prefix = ''): Promise<void> {
    if (q.isPermission) {
      const body = `${prefix}🔐 İzin istiyor: <b>${escapeHtml(q.toolName)}</b>\n<pre>${escapeHtml(redactSecrets(q.text).slice(0, 1500))}</pre>`;
      await this.sendButtons(ab, body, [['İzin ver (bir kez)', 'Reddet']], { kind: 'permission', requestId: q.requestId, sessionId, singleUse: true });
      return;
    }
    const qs = q.questions ?? [];
    // Option previews are pictures: the rich path (W5) sends them before the buttons.
    const previews = !!this.richQuestion && qs.some((x) => x.options.some((o) => typeof o.preview === 'string' && o.preview.trim()));
    if (qs.length === 1 && !qs[0].multiSelect && qs[0].options.length > 0 && qs[0].options.length <= 8 && !previews) {
      const labels = qs[0].options.map((o) => o.label);
      await this.sendButtons(ab, formatAskQuestionHtml(qs[0], { title: q.title, prefix }), labels.map((l) => [l.slice(0, 60)]), { kind: 'question', requestId: q.requestId, sessionId, singleUse: true }, { question: qs[0].question, labels });
      return;
    }
    if (this.richQuestion && await this.richQuestion(ab, sessionId, q).catch(() => false)) return;
    if (qs.length) {
      for (const html of formatAskCardMessages(qs, { title: q.title, prefix, footer: escapeHtml(LINES.waitingOnMac) })) await this.send(ab, html).catch(() => {});
      return;
    }
    await this.reply(ab, `${prefix ? `${prefix} ` : ''}❓ ${redactSecrets(q.text).slice(0, 300)}\n${LINES.waitingOnMac}`);
  }
}

export class HubError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A pairing poll keeps no file (nothing is bound yet). */
function memoryPollState(): PollStateIO {
  let s = { v: 1 as const, offset: 0, seenIds: [] as number[], notifiedIds: [] as number[], pending: [] as JournalEntry[] };
  return { read: () => s, write: (n) => { s = { ...n, v: 1 }; } };
}

/** `open -g <dreamcontext://…>`: argv, never a shell. */
function openInBackground(url: string): void {
  if (!/^dreamcontext:\/\//.test(url)) return;
  const child = spawn('/usr/bin/open', ['-g', url], { stdio: 'ignore', detached: true });
  child.on('error', () => { /* no open: the wait times out */ });
  child.unref();
}

// ─── The process's hub ──────────────────────────────────────────────────────

let hub: TelegramHub | null = null;
export function telegramHub(): TelegramHub | null { return hub; }
export function setTelegramHub(h: TelegramHub | null): void { hub = h; }
