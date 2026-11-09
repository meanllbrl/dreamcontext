/**
 * The device-level manager bot and every Rust-confirmed id record (plan X, Z, AA, AB; W2 lane A).
 *
 * Id records (Z1, AA1, AB): the PAGE mints a short-lived (5 min), single-use, 128-bit id with its
 * own headers (no owner key); the server fixes every value under it, including the vault and
 * `projectKey` it was minted in; Rust takes only the id, shows what the preview says, and confirms
 * with the owner key on a vault-agnostic route. A record whose vault is gone answers 410.
 *  - forward: turning a routine's results ON for the member's bot (V, W3, Y4); OFF is keyless.
 *  - creation: one pending one-tap bot per Mac (X3); a new start voids the previous; voided
 *    usernames kept 10 min; a `managed_bot` is adopted only from the owner id, for the live,
 *    unexpired creation, never for a voided name (Z5, AA3).
 *  - readopt: "Yeniden bağla" a bot in managed-history.json for (target, projectKey), from this
 *    manager, created by the owner id; the preview's hash must come back on start (AA2, AB).
 *
 * Manager (X2, Z4): its paired user id is the OWNER ID. It never converses; a text gets one line.
 * A 409 on its poll, or a 401 on any managed bot, raises the compromise alarm and stops adoption.
 * Entering a new token for the same manager bot re-keys every managed binding (AA3: after the
 * native confirm, no last message, in-memory tokens swapped). Kaldır on the manager deletes
 * managed-history.json; bound bots keep running.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getAutomation, listAutomations } from '../../lib/automations/store.js';
import { manifestHash } from '../../lib/automations/registry.js';
import { projectKey } from '../../lib/local-store.js';
import { memberScope } from '../../lib/agents/scope.js';
import {
  appendManagedHistory, bindingDir, listBindings, readBinding, readForward, readManagedHistory, readManagerBinding,
  removeManager, scopeOfContextRoot, writeBinding, writeTelegramJson,
} from '../../lib/telegram/config.js';
import {
  CREATION_TTL_MS, PAIRING_ID_RE, TG_MANAGER_ALLOWED_UPDATES,
  type BotBinding, type PendingCreation, type TelegramStatusRow,
} from '../../lib/telegram/contract.js';
import { parseManagedBot, TelegramPoller } from '../../lib/telegram/poller.js';
import { escapeHtml } from '../../lib/telegram/format.js';
import { isAuthorized, type TgUpdateLike } from '../../lib/telegram/auth.js';
import type { TelegramTransport } from '../../lib/telegram/transport.js';
import { HubError, keyOf, MANAGER_PAIRING_TARGET, type TelegramHub } from './hub.js';
import { displayNameFor } from './identity.js';

const ID_TTL_MS = 5 * 60 * 1000;
const VOIDED_KEEP_MS = 10 * 60 * 1000;

type IdKind = 'forward' | 'creation' | 'readopt';
interface IdRecord {
  kind: IdKind;
  id: string;
  contextRoot: string;
  projectKey: string;
  projectName: string;
  target: string;
  scope: string;
  expiresAt: number;
  // forward
  routine?: string;
  routineTitle?: string;
  approvalHash?: string;
  botUsername?: string;
  // creation
  suggestedUsername?: string;
  name?: string;
  // readopt
  botId?: number;
  hash?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** `<slug-short>_<4 base36>_bot`, ≤ 32 chars, Telegram's alphabet (Z5). */
export function suggestedUsernameFor(slug: string): string {
  const tail = `_${randomInt(0, 36 ** 4).toString(36).padStart(4, '0')}_bot`;
  const base = slug.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^_+/, '') || 'dc';
  return `${/^[a-z]/.test(base) ? base : `dc_${base}`}`.slice(0, 32 - tail.length) + tail;
}

export class TelegramManager {
  private ids = new Map<string, IdRecord>();
  private pending: (PendingCreation & { contextRoot: string; projectName: string; live: boolean }) | null = null;
  private voided: { username: string; until: number }[] = [];
  private poller: TelegramPoller | null = null;
  private done: Promise<unknown> = Promise.resolve();
  private transport: TelegramTransport | null = null;
  alarm: 'conflict' | 'unauthorized' | 'tamper' | null = null;
  /** `managed_bot` updates refused (another creator, no creation, expired, voided). */
  ignored = 0;
  /** The Mac line for a voided-link creation (AA3), read by the status route. */
  notice: string | null = null;

  constructor(private readonly hub: TelegramHub) {}

  // ── Lifecycle ──

  start(): void {
    const m = readManagerBinding(this.hub.home);
    if (!m.ok) { if (m.reason === 'tamper') this.alarm = 'tamper'; return; }
    this.serve(m.binding);
  }

  private halted = false;
  private serial = 0;

  stop(): void { this.halted = true; this.poller?.stop(); }

  /** A pairing for the manager's own token (re-key, AA3) takes its lock: the loop yields. */
  async yieldToken(token: string): Promise<boolean> {
    const m = readManagerBinding(this.hub.home);
    if (!m.ok || m.binding.token !== token || !this.poller) return false;
    this.halted = true;
    this.poller.stop();
    await this.done;
    return true;
  }

  /** Shutdown: stop and drop the token lock synchronously. */
  releaseNow(): void { this.halted = true; this.poller?.stop(); this.poller?.release(); }

  private serve(b: BotBinding): void {
    this.halted = true;
    this.poller?.stop();
    const before = this.done;
    this.transport = this.hub.transportFor(b.token);
    // The manager keeps no journal: it only adopts, and every adoption is checked live.
    let mem = { v: 1 as const, offset: 0, seenIds: [] as number[], notifiedIds: [] as number[], pending: [] as never[] };
    const io = { read: () => mem, write: (s: typeof mem) => { mem = { ...s, v: 1 }; } };
    let reported = false;
    const poller = new TelegramPoller({
      transport: this.transport, token: b.token, state: io as never, allowedUpdates: TG_MANAGER_ALLOWED_UPDATES,
      // A failed adoption (network blip on the token fetch) is retried by the poller (3 tries).
      onUpdate: async (u) => { try { await this.onUpdate(b, u); return 'accepted'; } catch { return 'retry'; } },
      onStop: (why) => { reported = true; if (why === 'conflict') this.raise('conflict'); if (why === 'unauthorized') this.raise('unauthorized'); },
      home: this.hub.home, now: this.hub.now, sleep: this.hub.deps.sleep, timeoutS: this.hub.deps.pollTimeoutS,
    });
    this.poller = poller;
    // A token lock still held makes run() return 'conflict' without reporting: retry until it frees.
    // The stop check is per serve: `this.poller !== poller` (a newer serve) or a stop/remove after it.
    const serial = ++this.serial;
    this.halted = false;
    const loop = async (): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        if (this.halted || this.poller !== poller || this.serial !== serial) return 'stopped';
        reported = false;
        const why = await poller.run();
        if (why !== 'conflict' || reported || this.halted) return why;
        await new Promise((r) => { const t = setTimeout(r, Math.min(30_000, 2_000 * (attempt + 1))); t.unref?.(); });
      }
    };
    this.done = before.then(loop);
  }

  raise(why: 'conflict' | 'unauthorized' | 'tamper'): void {
    this.alarm = why;
    this.pending = null;
    this.hub.deps.banner?.('Telegram', 'Yönetici anahtarı başka yerde kullanılıyor: BotFather\'da /revoke yap, sonra yeni anahtarı gir.');
  }

  ownerId(): number | null {
    const m = readManagerBinding(this.hub.home);
    return m.ok ? m.binding.userId : null;
  }

  row(): TelegramStatusRow | null {
    const m = readManagerBinding(this.hub.home);
    if (m.ok) return { scope: 'global', target: MANAGER_PAIRING_TARGET, state: this.alarm ? 'disabled' : 'active', botUsername: m.binding.botUsername, ...(this.alarm ? { disabledReason: this.alarm } : {}) };
    if (m.reason === 'tamper') return { scope: 'global', target: MANAGER_PAIRING_TARGET, state: 'disabled', botUsername: '', disabledReason: 'tamper' };
    return null;
  }

  // ── Manager pairing confirmed: first set-up, or the same bot's new token (re-key, AA3) ──

  async onPairingConfirmed(fresh: BotBinding): Promise<void> {
    this.alarm = null;
    const old = this.transport;
    const sameBot = !!old && old.botId === fresh.botId;
    this.serve(fresh);
    if (!sameBot) { this.pending = null; return; }
    // "Tüm botların anahtarını yenile": every managed binding of this manager gets a fresh token.
    for (const row of listBindings(this.hub.home)) {
      if (!row.read.ok || !row.read.binding.managed || row.read.binding.managerBotId !== fresh.botId) continue;
      // Its own poll stops first: the revoked token's in-flight poll must not read as a 401 alarm.
      const live = this.hub.active.get(keyOf(row.scope, row.target));
      if (live) { this.hub.halt(live); await live.done; }
      try {
        const token = await this.transport!.replaceManagedBotToken(row.read.binding.botId);
        const { bindingHash: _h, v: _v, ...rest } = row.read.binding;
        const b = writeBinding(row.scope, row.target, { ...rest, token }, this.hub.home);
        this.hub.activate(row.scope, row.target, b);
      } catch {
        // The old token is still the live one: that bot polls it again (a revoked one comes back
        // as a 401 → the alarm, visible), never deaf-but-active.
        if (live && this.hub.active.get(live.key) === live) this.hub.activate(row.scope, row.target, row.read.binding);
      }
    }
  }

  // ── The manager's own updates ──

  private async onUpdate(b: BotBinding, u: Record<string, unknown>): Promise<void> {
    const mb = parseManagedBot(u);
    if (mb) { await this.adopt(b, mb.bot, mb.creator); return; }
    if (!isAuthorized(u as unknown as TgUpdateLike, { chatId: b.chatId, userId: b.userId })) { this.hub.strangers.note(u as unknown as TgUpdateLike); return; }
    await this.transport!.sendMessage(b.chatId, escapeHtml('Bu bot yalnız yeni bot açar. Super ve üyelerle kendi botlarından konuş.')).catch(() => {});
  }

  private async adopt(manager: BotBinding, bot: { id: number; username?: string }, creator: { id: number }): Promise<void> {
    const now = this.hub.now();
    this.voided = this.voided.filter((v) => v.until > now);
    const p = this.pending;
    const username = (bot.username ?? '').toLowerCase();
    if (this.voided.some((v) => v.username.toLowerCase() === username)) {
      this.ignored += 1;
      this.notice = 'Eski bir bağlantıdan bot açıldı, bağlanmadı.';
      return;
    }
    if (this.alarm || creator.id !== manager.userId || !p || !p.live || now > p.expiresAt) { this.ignored += 1; return; }
    // Single use (Z5), spent only once the bot is really bound: a failed token fetch throws, the
    // poller re-delivers the update, and the same live creation adopts it then.
    await this.bindManaged(manager, bot.id, p.scope, p.target, p.projectKey, p.name, p.projectName);
    if (this.pending === p) this.pending = null;
  }

  private async bindManaged(manager: BotBinding, botId: number, scope: string, target: string, pk: string, name: string, projectName: string): Promise<void> {
    const token = await this.transport!.getManagedBotToken(botId);
    const t = this.hub.transportFor(token);
    const me = await t.getMe();
    const key = keyOf(scope, target);
    const old = this.hub.active.get(key);
    if (old && old.binding.botId !== botId) await this.hub.unbind(scope, target, { keyed: true, replaceManagedToken: this.hub.replaceManagedToken });
    const b = writeBinding(scope, target, {
      token, botId, botUsername: String(me.username ?? ''), chatId: manager.userId, userId: manager.userId,
      boundAt: new Date(this.hub.now()).toISOString(), managed: true, managerBotId: manager.botId,
    }, this.hub.home);
    appendManagedHistory({ target, projectKey: pk, botId, botUsername: b.botUsername, creatorId: manager.userId, managerBotId: manager.botId, adoptedAt: b.boundAt }, this.hub.home);
    const ab = this.hub.activate(scope, target, b);
    try { this.hub.deps.ensureDispatcher?.(); } catch { /* named in the sheet */ }
    await this.hub.send(ab, escapeHtml(`Ben ${name} (${projectName} projesi). Buradan yazabilirsin.`)).catch(() => {
      this.notice = "Botu aç ve Başlat'a bas.";
    });
    // Its profile (a Super's command menu; the member's name, short line, photo), in the background: the bind (and the
    // desktop's 5 s confirm) never waits on them, and a refusal is logged, never fails the bind.
    void this.hub.syncProfile(ab);
  }

  /** Kaldır on a managed target revokes its token through the manager first (X6), 3 tries. */
  async replaceManagedToken(botId: number): Promise<void> {
    if (!this.transport) throw new Error('no manager');
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try { await this.transport.replaceManagedBotToken(botId); return; } catch (err) { last = err; }
    }
    throw last;
  }

  async removeManager(keyed = true): Promise<void> {
    if (!keyed) this.hub.deps.banner?.('Telegram', 'Telegram yöneticisi Mac\'te kaldırıldı.');
    this.halted = true;
    this.poller?.stop();
    await this.done;
    this.transport = null;
    this.pending = null;
    this.alarm = null;
    removeManager(this.hub.home);
  }

  // ── Id records ──

  private mint(rec: Omit<IdRecord, 'id' | 'expiresAt'>): IdRecord {
    for (const [k, r] of this.ids) if (r.expiresAt < this.hub.now()) this.ids.delete(k);
    const full: IdRecord = { ...rec, id: randomBytes(16).toString('base64url'), expiresAt: this.hub.now() + ID_TTL_MS };
    this.ids.set(full.id, full);
    return full;
  }

  /** The live record for a Rust call: shape-checked, unexpired, its vault still there. */
  take(kind: IdKind, id: string): IdRecord | 'gone' | 'vault_gone' {
    if (!PAIRING_ID_RE.test(id)) return 'gone';
    const r = this.ids.get(id);
    if (!r || r.kind !== kind || r.expiresAt < this.hub.now()) return 'gone';
    if (!existsSync(r.contextRoot)) return 'vault_gone';
    return r;
  }

  private spend(id: string): void { this.ids.delete(id); }

  // Forward (V, W3, Y4, Z1)

  forwardList(contextRoot: string, target: string): { routines: { slug: string; title: string; on: boolean }[] } {
    const where = memberScope(contextRoot, target, this.hub.home);
    if (!where) return { routines: [] };
    const scope = where === 'global' ? 'global' : scopeOfContextRoot(contextRoot);
    const fwd = readForward(bindingDir(scope, target, this.hub.home), this.hub.home);
    const pk = projectKey(dirname(contextRoot));
    const routines = listAutomations(contextRoot, this.hub.home).filter((m) => m.agent === target).map((m) => ({
      slug: m.slug, title: m.title,
      on: fwd.routines.some((r) => r.projectKey === pk && r.slug === m.slug && r.approvalHash === manifestHash(m)),
    }));
    return { routines };
  }

  forwardRequest(contextRoot: string, target: string, routine: string): { forwardRequestId: string } {
    const where = memberScope(contextRoot, target, this.hub.home);
    if (!where) throw new HubError(404, 'not_found', 'No such member here.');
    const scope = where === 'global' ? 'global' : scopeOfContextRoot(contextRoot);
    const b = readBinding(scope, target, this.hub.home);
    if (!b.ok) throw new HubError(409, 'not_bound', 'Bind the member\'s bot first.');
    const m = getAutomation(contextRoot, routine, this.hub.home);
    if (!m || m.agent !== target) throw new HubError(404, 'not_found', 'No such routine of this member.');
    const r = this.mint({
      kind: 'forward', contextRoot, projectKey: projectKey(dirname(contextRoot)), projectName: basename(dirname(contextRoot)),
      target, scope, routine, routineTitle: m.title, approvalHash: manifestHash(m), botUsername: b.binding.botUsername,
    });
    return { forwardRequestId: r.id };
  }

  forwardPreview(r: IdRecord): { projectName: string; projectKey: string; routineTitle: string; botUsername: string; approvalHash: string } {
    return { projectName: r.projectName, projectKey: r.projectKey, routineTitle: r.routineTitle ?? '', botUsername: r.botUsername ?? '', approvalHash: r.approvalHash ?? '' };
  }

  /** ON, after the native confirm: stored only if what was shown still holds (Y4). */
  forwardConfirm(r: IdRecord, echo: { projectKey: unknown; approvalHash: unknown }): 'ok' | 'mismatch' {
    this.spend(r.id);
    const m = getAutomation(r.contextRoot, r.routine ?? '', this.hub.home);
    const now = m && m.agent === r.target ? manifestHash(m) : null;
    if (echo.projectKey !== r.projectKey || echo.approvalHash !== r.approvalHash || now !== r.approvalHash) return 'mismatch';
    const b = readBinding(r.scope, r.target, this.hub.home);
    if (!b.ok || b.binding.botUsername !== r.botUsername) return 'mismatch';
    const dir = bindingDir(r.scope, r.target, this.hub.home);
    const cur = readForward(dir, this.hub.home);
    const routines = cur.routines.filter((x) => !(x.projectKey === r.projectKey && x.slug === r.routine));
    routines.push({ projectKey: r.projectKey, slug: r.routine!, approvalHash: r.approvalHash! });
    writeTelegramJson(join(dir, 'forward.json'), { v: 1, routines }, this.hub.home);
    return 'ok';
  }

  /** OFF: keyless (less leaves the Mac). */
  forwardOff(contextRoot: string, target: string, routine: string): void {
    const where = memberScope(contextRoot, target, this.hub.home);
    if (!where) return;
    const scope = where === 'global' ? 'global' : scopeOfContextRoot(contextRoot);
    const dir = bindingDir(scope, target, this.hub.home);
    if (!readBinding(scope, target, this.hub.home).ok) return;
    const pk = projectKey(dirname(contextRoot));
    const cur = readForward(dir, this.hub.home);
    writeTelegramJson(join(dir, 'forward.json'), { v: 1, routines: cur.routines.filter((x) => !(x.projectKey === pk && x.slug === routine)) }, this.hub.home);
  }

  // Creation (X3, Z1, Z5)

  creationRequest(contextRoot: string, target: string, scope: string): { creationId: string } {
    if (!readManagerBinding(this.hub.home).ok) throw new HubError(409, 'no_manager', 'Set up Telegram in Settings first.');
    if (this.alarm) throw new HubError(409, 'manager_alarm', 'The manager key is in use elsewhere.');
    const name = displayNameFor({ scope, target, contextRoot, projectName: basename(dirname(contextRoot)) }, this.hub.home);
    const r = this.mint({
      kind: 'creation', contextRoot, projectKey: projectKey(dirname(contextRoot)), projectName: basename(dirname(contextRoot)),
      target, scope, suggestedUsername: suggestedUsernameFor(target === 'super' ? basename(dirname(contextRoot)) : target), name,
    });
    return { creationId: r.id };
  }

  /** Rust, with the owner key: the pending creation goes live (a newer start voids the previous). */
  creationStart(r: IdRecord): { projectName: string; link: string } {
    this.spend(r.id);
    const m = readManagerBinding(this.hub.home);
    if (!m.ok) throw new HubError(409, 'no_manager', 'Set up Telegram in Settings first.');
    if (this.pending) this.voided.push({ username: this.pending.suggestedUsername, until: this.hub.now() + VOIDED_KEEP_MS });
    this.pending = {
      creationId: r.id, target: r.target, scope: r.scope, projectKey: r.projectKey, suggestedUsername: r.suggestedUsername!, name: r.name!,
      expiresAt: this.hub.now() + CREATION_TTL_MS, contextRoot: r.contextRoot, projectName: r.projectName, live: true,
    };
    const link = `https://t.me/newbot/${m.binding.botUsername}/${r.suggestedUsername}?name=${encodeURIComponent(r.name!).replace(/%20/g, '+')}`;
    return { projectName: r.projectName, link };
  }

  // Re-adopt (AA2, AB)

  readoptAvailable(contextRoot: string, target: string): { available: boolean; botUsername?: string } {
    const row = this.historyRow(contextRoot, target);
    return row ? { available: true, botUsername: row.botUsername } : { available: false };
  }

  private historyRow(contextRoot: string, target: string) {
    const m = readManagerBinding(this.hub.home);
    if (!m.ok) return null;
    const pk = projectKey(dirname(contextRoot));
    const rows = readManagedHistory(this.hub.home).rows
      .filter((r) => r.target === target && r.projectKey === pk && r.managerBotId === m.binding.botId && r.creatorId === m.binding.userId)
      .sort((a, b) => b.adoptedAt.localeCompare(a.adoptedAt));
    return rows[0] ?? null;
  }

  readoptRequest(contextRoot: string, target: string, scope: string): { readoptId: string } {
    const row = this.historyRow(contextRoot, target);
    if (!row) throw new HubError(404, 'no_history', 'No earlier bot to reconnect.');
    for (const ab of this.hub.active.values()) if (ab.binding.botId === row.botId && ab.target !== target) throw new HubError(409, 'bot_in_use', 'That bot is connected to something else.');
    const hash = sha(JSON.stringify([row.target, row.projectKey, row.botId, row.managerBotId, row.creatorId]));
    const r = this.mint({ kind: 'readopt', contextRoot, projectKey: row.projectKey, projectName: basename(dirname(contextRoot)), target, scope, botId: row.botId, botUsername: row.botUsername, hash });
    return { readoptId: r.id };
  }

  readoptPreview(r: IdRecord): { projectName: string; target: string; botUsername: string; approvalHash: string } {
    return { projectName: r.projectName, target: r.target, botUsername: r.botUsername ?? '', approvalHash: r.hash ?? '' };
  }

  async readoptStart(r: IdRecord, echo: unknown): Promise<'ok' | 'mismatch'> {
    this.spend(r.id);
    if (echo !== r.hash) return 'mismatch';
    const m = readManagerBinding(this.hub.home);
    const row = this.historyRow(r.contextRoot, r.target);
    if (!m.ok || !row || row.botId !== r.botId || this.alarm) return 'mismatch';
    const name = displayNameFor({ scope: r.scope, target: r.target, contextRoot: r.contextRoot, projectName: r.projectName }, this.hub.home);
    await this.bindManaged(m.binding, row.botId, r.scope, r.target, r.projectKey, name, r.projectName);
    return 'ok';
  }
}

/** Wires the manager into the hub: status, Kaldır, managed-token revocation, pairing adoption. */
export function wireManager(hub: TelegramHub): TelegramManager {
  const mgr = new TelegramManager(hub);
  hub.managerRow = () => mgr.row();
  hub.removeManager = (keyed) => mgr.removeManager(keyed);
  hub.replaceManagedToken = (botId) => mgr.replaceManagedToken(botId);
  const prevStatus = hub.managerStatus.bind(hub);
  hub.managerStatus = () => ({ ...prevStatus(), ...(mgr.alarm ? { alarm: mgr.alarm } : {}) });
  hub.manager = mgr;
  return mgr;
}

