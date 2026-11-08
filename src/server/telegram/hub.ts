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
 *    from first injection), or the whole text when the turn held only Telegram text; while
 *    Telegram-started hands-free is on, every answer (marks stripped);
 *  - typing while the turn runs; one status message per Telegram message, rows = children and
 *    team jobs whose origin is that ref; a final "Bitti" message;
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
import {
  CALLBACK_DATA_RE, STATUS_EDIT_MIN_MS, STATUS_GLYPH, STATUS_LABEL, TELEGRAM_COMMANDS, TG_ALLOWED_UPDATES, TG_REF_RE,
  TURN_ROUTABLE_MS, TYPING_EVERY_MS, withTelegramRef,
  type BotBinding, type ButtonRecord, type JournalEntry, type PairingPreview, type PairingStart, type StatusState,
  type TelegramHubApi, type TelegramScope, type TelegramStatusRow, type TelegramTarget, type TurnRecord,
} from '../../lib/telegram/contract.js';
import {
  bindingDir, isValidScope, isValidTarget, isValidToken, listBindings, readBinding, readPollState, readTurns,
  redactToken, removeBindingDir, scopeOfContextRoot, writeBinding, writePollState, writeTurns,
} from '../../lib/telegram/config.js';
import { isAuthorized, PairingBook, StrangerCounter, type TgUpdateLike } from '../../lib/telegram/auth.js';
import { TelegramTransport, type FetchLike } from '../../lib/telegram/transport.js';
import { TelegramPoller, type PollStateIO, type UpdateDisposition } from '../../lib/telegram/poller.js';
import { escapeHtml, redactSecrets, splitReplySections, stripReplyMarks, toTelegramMessages } from '../../lib/telegram/format.js';
import { inboundTurnText, pickInboundMedia, saveInbound } from '../../lib/telegram/inbound.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

/** The pairing target the manager uses on the wire (W3 route proposal): never a member slug. */
export const MANAGER_PAIRING_TARGET = '@manager';
/** How long a reopened Super has to register its injector (A3). */
export const INJECTOR_WAIT_MS = 45_000;
/** The last-message send never waits longer than this on a binding loss (D3). */
const LAST_MESSAGE_TIMEOUT_MS = 5_000;

export const LINES = {
  superOff: 'Bu projede Super kapalı.',
  cannotOpen: "Super'i Mac'te açamadım. Mac'te uygulamaya bak, sonra tekrar yaz.",
  notWritten: "Mesajın Mac'te yazılamadı, tekrar gönder.",
  writtenNotDone: "Mesajın Mac'e yazıldı ama iş tamamlanamadı; tekrar göndermeden önce Mac'e bak.",
  stale: 'Bu soru artık geçerli değil.',
  waitingOnMac: "Mac'te seni bekliyor.",
  unknownCommand: 'Bu komut burada yok. Komutlar: /handsfree',
  bound: (who: string) => `Bağlandı: ${who}. Buradan yazabilirsin.`,
  unbound: (keyed: boolean) => `Telegram bağlantısı Mac'te kaldırıldı${keyed ? '' : ' (anahtarsız istek)'}.`,
  conflict: "Bu bot başka bir yerde de dinleniyor; bağlantı durdu. BotFather'da token'ı yenile.",
  tamper: "Bu botun Mac'teki kaydı değişti; güvenlik için bağlantı durdu.",
  done: (jobs: number, minutes: number) => `Bitti · ${jobs} iş · ${minutes} dk`,
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
  private buttons = new Map<string, ButtonRecord & { key: BindingKey; data?: Obj }>();
  private turns = new Map<string, TgTurn>();
  /** Super chat pin id → the binding that routes it. */
  private superSessions = new Map<string, BindingKey>();
  /** Per Super chat: what the running turn's owner inputs were (fallback rule, plan "Which answer"). */
  private turnInputs = new Map<string, { telegram: Set<string>; mac: boolean }>();
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
      onChatAssistantText((sid, text) => { void this.onAssistantText(sid, text).catch(() => { /* best-effort */ }); }),
      onChatChange((c) => this.onChatChange(c.entry, c.from)),
      onChatUserSent((sid, _text, source) => this.noteUserSent(sid, source)),
      telegramRefs.onTelegramRefDropped((id, ref, written) => this.onRefDropped(id, ref, written)),
    );
    for (const row of listBindings(this.home)) {
      if (!row.read.ok) continue;
      this.activate(row.scope, row.target, row.read.binding);
    }
    this.manager?.start();
  }

  /** The device-level manager (manager.ts `wireManager`). */
  manager: import('./manager.js').TelegramManager | null = null;

  async stop(): Promise<void> {
    for (const u of this.unsubs.splice(0)) u();
    this.manager?.stop();
    for (const ab of this.active.values()) ab.poller?.stop();
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
    prev?.poller?.stop();
    const project = this.projectOf(scope);
    const ab: ActiveBinding = {
      key, scope, target, binding, transport: this.transportFor(binding.token), poller: null, done: Promise.resolve(),
      contextRoot: project?.contextRoot ?? null, projectName: project?.name ?? '',
    };
    this.active.set(key, ab);
    this.recoverJournal(ab);
    ab.poller = new TelegramPoller({
      transport: ab.transport,
      token: binding.token,
      state: this.pollIO(scope, target),
      allowedUpdates: TG_ALLOWED_UPDATES,
      onUpdate: (u) => this.onUpdate(key, u),
      onStop: (why) => { if (why !== 'stopped') void this.loseBinding(key, why === 'conflict' ? 'conflict' : 'unauthorized'); },
      home: this.home,
      now: this.now,
      sleep: this.deps.sleep,
      timeoutS: this.deps.pollTimeoutS,
    });
    // One loop per token: the previous loop on this key (or a pairing's) lets go of the lock first.
    const before = Promise.all([prev?.done, ...this.waitTokens.splice(0)]);
    ab.done = before.then(() => (this.active.get(key) === ab && !ab.disabled ? ab.poller!.run() : 'stopped'));
    return ab;
  }

  status(): TelegramStatusRow[] {
    const rows: TelegramStatusRow[] = [];
    for (const ab of this.active.values()) {
      rows.push({
        scope: ab.scope, target: ab.target, state: ab.disabled ? 'disabled' : 'active', botUsername: ab.binding.botUsername,
        ...(ab.binding.managed ? { managed: true } : {}), ...(ab.disabled ? { disabledReason: ab.disabled } : {}),
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
      if (p.scope === scope && p.target === target) { p.poller.stop(); this.pairings.delete(id); await p.done; }
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
    const same = [...this.active.values()].filter((ab) => ab.binding.token === token);
    for (const ab of same) ab.poller?.stop();
    await Promise.all(same.map((ab) => ab.done));
    const live: LivePairing = {
      book, pairingId: pairing.pairingId, scope, target: scope === 'manager' ? MANAGER_PAIRING_TARGET : target, token,
      projectName: input.projectName, contextRoot: input.contextRoot ?? null, transport, poller, done: Promise.resolve(), botId, botUsername,
    };
    this.pairings.set(pairing.pairingId, live);
    live.done = poller.run().then((why) => { if (why === 'conflict' && this.pairings.get(pairing.pairingId) === live) this.pairings.delete(pairing.pairingId); return why; });
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
    if (old && old.binding.botId !== live.botId) await this.lastMessage(old, LINES.unbound(true));
    old?.poller?.stop();
    if (old && (old.binding.botId !== live.botId || old.binding.chatId !== user.chatId || old.binding.userId !== user.userId)) {
      removeBindingDir(live.scope, live.target, this.home);
    }
    const binding = writeBinding(live.scope, live.target, fields, this.home);
    const ab = this.activate(live.scope, live.target, binding);
    try { this.deps.ensureDispatcher?.(); } catch { /* the bind sheet names it; never fails the bind */ }
    void this.afterBound(ab, live.target === 'super' ? `Super · ${live.projectName}` : live.target);
    return 'ok';
  }

  /** The manager's adoption of its own pairing: `manager.ts` writes it (kept out of the Super path). */
  private async adoptManager(fields: Omit<BotBinding, 'v' | 'bindingHash'>): Promise<BotBinding> {
    const { writeManagerBinding } = await import('../../lib/telegram/config.js');
    return writeManagerBinding(fields, this.home);
  }

  async afterBound(ab: ActiveBinding, who: string): Promise<void> {
    if (ab.target === 'super') await ab.transport.setMyCommands(TELEGRAM_COMMANDS.filter((c) => c.command === 'handsfree')).catch(() => {});
    await this.send(ab, escapeHtml(LINES.bound(who))).catch(() => {});
  }

  // ── Losing a binding (C3, D3) ──

  async unbind(scope: TelegramScope, target: TelegramTarget, opts: { keyed: boolean; replaceManagedToken?: (botId: number) => Promise<void> }): Promise<void> {
    const key = keyOf(scope, target);
    const ab = this.active.get(key);
    for (const [id, p] of [...this.pairings]) if (p.scope === scope && p.target === target) { p.poller.stop(); this.pairings.delete(id); }
    if (ab) {
      await this.lastMessage(ab, LINES.unbound(opts.keyed));
      ab.poller?.stop();
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
    ab.poller?.stop();
    if (why !== 'unauthorized') await this.lastMessage(ab, why === 'conflict' ? LINES.conflict : LINES.tamper);
    // A 401 on a bot the manager made: the manager token may be out (Z4, AA3).
    if (why === 'unauthorized' && ab.binding.managed) this.manager?.raise('unauthorized');
    this.deps.handsfree?.onBindingLost?.(ab.scope, ab.target);
    this.deps.banner?.('Telegram', why === 'tamper' ? "Telegram kaydı Mac'te değişti; bağlantı durduruldu." : 'Telegram bağlantısı durdu.');
  }

  /** Best-effort, from the in-memory binding, never longer than 5 s (D3). */
  private async lastMessage(ab: ActiveBinding, line: string): Promise<void> {
    await Promise.race([
      ab.transport.sendMessage(ab.binding.chatId, escapeHtml(line)).catch(() => {}),
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
    return ab.transport.sendMessage(ab.binding.chatId, html, extra) as Promise<{ message_id: number; text?: string }>;
  }

  /** Markdown → one or more Telegram messages. */
  async sendMarkdown(ab: ActiveBinding, md: string): Promise<void> {
    for (const html of toTelegramMessages(redactSecrets(md))) await this.send(ab, html);
  }

  async reply(ab: ActiveBinding, line: string): Promise<void> {
    await this.send(ab, escapeHtml(line)).catch(() => {});
  }

  // ── Inbound ──

  async onUpdate(key: BindingKey, u: Obj): Promise<UpdateDisposition> {
    const ab = this.active.get(key);
    if (!ab || ab.disabled) return 'accepted';
    if (!isAuthorized(u as unknown as TgUpdateLike, ab.binding)) { this.strangers.note(u as unknown as TgUpdateLike); return 'accepted'; }
    if (!this.intact(ab)) { await this.loseBinding(key, 'tamper'); return 'accepted'; }
    const cb = obj(u.callback_query);
    if (cb) { await this.onCallback(ab, cb); return 'accepted'; }
    const msg = obj(u.message);
    if (!msg) return 'accepted';
    if (ab.target !== 'super') return this.deps.member ? this.deps.member.onMessage(this, key, u) : 'accepted';
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (text.startsWith('/')) {
      if (await this.deps.handsfree?.onCommand?.(this, key, u)) return 'accepted';
      if (/^\/start(?:@\w+)?(?:\s|$)/.test(text)) { await this.reply(ab, 'Buradayım. Yaz, Super Mac\'te okusun.'); return 'accepted'; }
      await this.reply(ab, LINES.unknownCommand);
      return 'accepted';
    }
    return this.onOwnerMessage(ab, Number(u.update_id), msg);
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
    void (async () => { for (const l of new Set(lines)) await this.reply(ab, l); })();
  }

  private async onOwnerMessage(ab: ActiveBinding, updateId: number, msg: Obj): Promise<UpdateDisposition> {
    if (!ab.contextRoot) return 'accepted';
    let state;
    try { state = await readSuperState(ab.contextRoot); } catch { state = null; }
    if (!state?.enabled || !state.session) { await this.reply(ab, LINES.superOff); return 'accepted'; }
    const media = pickInboundMedia(msg);
    this.journal(ab, (p) => [...p, { updateId, kind: media ? 'media' : 'text', written: false, at: this.now() }]);
    void this.deliver(ab, updateId, msg, state.session).catch(async () => {
      this.journal(ab, (p) => p.filter((e) => e.updateId !== updateId));
      await this.reply(ab, LINES.notWritten);
    });
    return 'accepted';
  }

  private async deliver(ab: ActiveBinding, updateId: number, msg: Obj, sessionId: string): Promise<void> {
    const drop = () => this.journal(ab, (p) => p.filter((e) => e.updateId !== updateId));
    const paths: string[] = [];
    let spoken: string | null = null;
    const media = pickInboundMedia(msg);
    if (media) {
      const saved = await saveInbound({ transport: ab.transport, contextRoot: ab.contextRoot!, media, now: this.now() });
      if (!saved.ok) { await this.reply(ab, saved.line); if (!msg.text && !msg.caption) { drop(); return; } }
      else if (media.kind === 'voice' || media.kind === 'audio') {
        try {
          spoken = await (this.deps.transcribeVoice ? this.deps.transcribeVoice(saved.path) : Promise.reject(new Error('no_transcriber')));
        } catch (err) {
          const missing = /ffmpeg_missing/.test((err as Error).message);
          await this.reply(ab, missing ? 'Sesli not için ffmpeg gerekli (brew install ffmpeg).' : 'Sesli notu yazıya çeviremedim.');
          paths.push(saved.path);
        }
        if (spoken !== null) await this.reply(ab, `Duyduğum: ${spoken}`);
      } else paths.push(saved.path);
    }
    let text = inboundTurnText(msg, paths);
    if (spoken) text = `🎙 ${spoken}${text ? `\n\n${text}` : ''}`;
    if (!text.trim()) { drop(); return; }
    if (!(await this.injectText(ab, updateId, text, sessionId))) drop();
  }

  /** Writes one owner turn into the project's Super under a fresh Telegram ref (B1, D1): the
   *  window reopened when needed; the ref put in the store BEFORE the text goes; turns.json,
   *  status and typing begun. False = it did not reach the Super (the owner was told). */
  async injectText(ab: ActiveBinding, updateId: number, text: string, sessionId: string): Promise<boolean> {
    const drop = () => this.journal(ab, (p) => p.filter((e) => e.updateId !== updateId));
    const inj = await this.waitInjector(ab, sessionId);
    if (!inj) { await this.reply(ab, LINES.cannotOpen); return false; }
    const ref = this.mintRef(ab);
    telegramRefs.put(inj.chatRegistryId, ref, { updateId, at: this.now(), written: false, kind: 'text' });
    this.journal(ab, (p) => p.map((e) => (e.updateId === updateId ? { ...e, ref, chatRegistryId: inj.chatRegistryId } : e)));
    const dir = bindingDir(ab.scope, ab.target, this.home);
    const turns = readTurns(dir, this.home);
    const fresh = turns.turns.filter((t) => this.now() - t.firstAt < TURN_ROUTABLE_MS);
    const rec: TurnRecord = { ref, updateId, chatId: ab.binding.chatId, sessionId, firstAt: this.now() };
    writeTurns(dir, { v: 1, turns: [...fresh, rec].slice(-500) }, this.home);
    this.superSessions.set(sessionId, ab.key);
    this.beginTurn(ab, ref, sessionId);
    const r = await inj.sendOwnerText(withTelegramRef(ref, text), { ref, source: 'telegram-text' });
    if (!r.ok) {
      telegramRefs.forget(inj.chatRegistryId, ref);
      this.endTurn(ref);
      drop();
      await this.reply(ab, LINES.notWritten);
      return false;
    }
    return true;
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

  private onRefDropped(chatRegistryId: string, ref: string, written: boolean): void {
    for (const ab of this.active.values()) {
      if (ab.target !== 'super') continue;
      const s = this.pollIO(ab.scope, ab.target).read();
      const hit = s.pending.find((e) => e.ref === ref && e.chatRegistryId === chatRegistryId);
      if (!hit) continue;
      this.journal(ab, (p) => p.filter((e) => e !== hit && !(e.ref === ref && e.chatRegistryId === chatRegistryId)));
      // Settled on a clean result while the chat lives = done. Otherwise the owner is told (F5).
      const entry = getChat(chatRegistryId);
      const clean = written && !!entry && entry.status !== 'gone';
      if (!clean) void this.reply(ab, written ? LINES.writtenNotDone : LINES.notWritten);
    }
  }

  // ── Turn status: typing, one status message, the final line (plan "Status message", M2) ──

  private beginTurn(ab: ActiveBinding, ref: string, sessionId: string): void {
    const turn: TgTurn = { ref, key: ab.key, chatId: ab.binding.chatId, sessionId, startedAt: this.now(), statusMessageId: null, statusText: '', lastEditAt: 0, typing: null, answered: false };
    this.turns.set(ref, turn);
    const tick = () => { void ab.transport.sendChatAction(ab.binding.chatId, 'typing').catch(() => {}); void this.refreshStatus(turn).catch(() => {}); };
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
  async statusRows(ab: ActiveBinding, ref: string): Promise<{ state: StatusState; label: string }[]> {
    if (!ab.contextRoot) return [];
    const s = await readSuperState(ab.contextRoot);
    const rows: { state: StatusState; label: string }[] = [];
    for (const c of Object.values(s.children)) {
      if (c.origin !== ref) continue;
      const live = getChat(c.sessionId);
      const pending = live?.pendingQuestion?.isPermission;
      const state: StatusState = pending ? 'waiting' : c.row === 'working' ? 'running' : c.row === 'asking' ? 'asking' : c.row === 'done' ? 'done'
        : c.row === 'stuck' ? 'stuck' : c.row === 'gone' ? 'gone' : c.row === 'waiting' ? 'waiting' : 'running';
      rows.push({ state, label: `${(c.brief || 'iş').slice(0, 60)}${pending ? ' · izin bekliyor' : ''}` });
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
    const text = rows.map((r) => `${STATUS_GLYPH[r.state]} ${escapeHtml(r.label)} · ${STATUS_LABEL[r.state]}`).join('\n');
    if (text === turn.statusText) return;
    if (turn.statusMessageId === null) {
      const sent = await this.send(ab, text, { disable_notification: true });
      turn.statusMessageId = sent.message_id;
    } else {
      if (this.now() - turn.lastEditAt < STATUS_EDIT_MIN_MS) return;
      await ab.transport.editMessageText(ab.binding.chatId, turn.statusMessageId, text).catch(() => {});
    }
    turn.statusText = text;
    turn.lastEditAt = this.now();
  }

  private noteUserSent(sessionId: string, source: string | undefined): void {
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
    if (entry.status === 'idle' && from !== 'idle') {
      this.turnInputs.delete(entry.sessionId);
      for (const t of [...this.turns.values()]) {
        if (t.sessionId !== entry.sessionId) continue;
        this.endTurn(t.ref);
        if (!ab) continue;
        void (async () => {
          await this.refreshStatus({ ...t, lastEditAt: 0 }).catch(() => {});
          if (t.statusMessageId !== null || t.statusText) {
            const rows = await this.statusRows(ab, t.ref).catch(() => []);
            await this.reply(ab, LINES.done(rows.length, Math.max(1, Math.round((this.now() - t.startedAt) / 60_000))));
          }
        })();
      }
    }
  }

  // ── Outbound: which answer goes back (B1, M1, N7, E3) ──

  /** Is `ref` a Telegram ref of this binding, still routable (24 h hard cap from first injection)? */
  routable(ab: ActiveBinding, ref: string): boolean {
    return readTurns(bindingDir(ab.scope, ab.target, this.home), this.home).turns.some((t) => t.ref === ref && this.now() - t.firstAt < TURN_ROUTABLE_MS);
  }

  private bindingOfSession(sessionId: string): ActiveBinding | null {
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

  async onAssistantText(sessionId: string, text: string): Promise<void> {
    let ab = this.bindingOfSession(sessionId);
    if (!ab) { await this.refreshSuperSessions(); ab = this.bindingOfSession(sessionId); }
    if (!ab || ab.disabled || ab.target !== 'super') return;
    if (this.deps.handsfree?.streamsTo(ab.scope, ab.target)) {
      const all = stripReplyMarks(text);
      if (all.trim()) await this.sendMarkdown(ab, all);
      return;
    }
    const sections = splitReplySections(text);
    let sent = false;
    for (const s of sections) {
      const hit = s.refs.find((r) => this.routable(ab!, r));
      if (!hit || !s.text.trim()) continue;
      await this.sendMarkdown(ab, s.text);
      const t = this.turns.get(hit);
      if (t) t.answered = true;
      sent = true;
    }
    if (sent || sections.some((s) => s.refs.length)) return;
    // No `re:` section: the whole text, only when the turn held Telegram text alone.
    const inputs = this.turnInputs.get(sessionId);
    const tgTurn = [...this.turns.values()].some((t) => t.sessionId === sessionId);
    if (tgTurn && !inputs?.mac && text.trim()) await this.sendMarkdown(ab, text);
  }

  // ── Buttons (plan "Button integrity") ──

  /** Sends a message with buttons and binds them: random id, message id, text hash, single use. */
  async sendButtons(ab: ActiveBinding, html: string, labels: string[][], rec: Omit<ButtonRecord, 'id' | 'botId' | 'chatId' | 'messageId' | 'textHash' | 'options'>, data?: Obj): Promise<string> {
    const id = randomBytes(8).toString('hex');
    let idx = 0;
    const keyboard = labels.map((row) => row.map((label) => ({ text: label, callback_data: `a:${id}:${idx++}` })));
    const sent = await this.send(ab, html, { reply_markup: { inline_keyboard: keyboard } });
    this.buttons.set(id, {
      ...rec, id, key: ab.key, botId: ab.binding.botId, chatId: ab.binding.chatId, messageId: sent.message_id,
      textHash: sha256(typeof sent.text === 'string' ? sent.text : ''), options: idx, ...(data ? { data } : {}),
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
      && Number(message?.message_id) === rec.messageId && message?.edit_date === undefined
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
    return { manager: this.managerRow ? this.managerRow() : null, bots };
  }
  managerRow: (() => TelegramStatusRow | null) | null = null;
  removeManager: (() => Promise<void>) | undefined = undefined;

  /** Further button kinds (answer.ts asks, approvals) plug in here. */
  extraButton: ((ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number) => Promise<string | null>) | null = null;

  /** The Super chat's own pending prompt as buttons (permission: allow once / deny only). */
  private async sendPrompt(ab: ActiveBinding, sessionId: string, q: PendingQuestion): Promise<void> {
    if (this.sentPrompts.has(q.requestId)) return;
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
    if (qs.length === 1 && !qs[0].multiSelect && qs[0].options.length > 0 && qs[0].options.length <= 8) {
      const labels = qs[0].options.map((o) => o.label);
      await this.sendButtons(ab, `${prefix}❓ ${escapeHtml(redactSecrets(qs[0].question))}`, labels.map((l) => [l.slice(0, 60)]), { kind: 'question', requestId: q.requestId, sessionId, singleUse: true }, { question: qs[0].question, labels });
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
