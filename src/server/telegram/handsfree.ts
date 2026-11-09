/**
 * Hands-free from Telegram (plan "Hands-free from Telegram", B5, C3, D2, D3, E3, E4, F3; W2 lane B).
 *
 *  - `/handsfree` on the Super's bot: two buttons, **Yalnız Telegram** (power only: lid closed,
 *    no tunnel) and **Telegram + telefon linki** (today's hands-free for THIS project; the bot
 *    sends the BARE origin, sign-in by passphrase). `/handsfree kapat` ends what it started.
 *  - Streaming is DERIVED, never stored: the live session is on and its `startedVia` names this
 *    binding. A Mac- or HTTP-started run has none and never streams.
 *  - Every end of a Telegram-started run is told once: "Hands-free kapandı: <neden>" (+ "(anahtarsız
 *    istek)" only for an HTTP stop without the owner key; a Mac-panel stop reads "Mac'ten
 *    kapatıldı"). Battery floor and heat are relayed; a new tunnel origin is re-sent.
 *  - Losing the binding that started Telegram-only hands-free ends it (C3, D3).
 *  - On Telegram, by itself (owner 2026-11-09): an authorized owner message to the Super's bot
 *    (the hub's presence fact, `onPresence`) starts power-only hands-free marked `auto` when
 *    nothing is on; it ends by itself ONLY when he types a message on the Mac in ANY dreamcontext
 *    chat, any project (`onBackAtMac`, `lib/telegram/back-at-mac.ts`; the keyboard, the mouse,
 *    the Telegram desktop app or the phone link never end it).
 *  - Manual hands-free is never automatic: a run started by the `/handsfree` buttons (either
 *    channel), the Mac panel or the phone link ends only by hand or `/handsfree kapat`.
 * Only the hub (after an authorized tap or message) starts hands-free with `startedVia`; no CLI
 * or HTTP path.
 */
import type { ButtonRecord, HandsfreeEvent, StartedVia } from '../../lib/telegram/contract.js';
import type { MacStatus } from '../../lib/handsfree/mac/contract.js';
import { LINES, keyOf, type BindingKey, type HubHandsfree, type TelegramHub } from './hub.js';

/** What the adapter needs of the live Mac session (`macSession()`), injectable for tests. */
export interface HandsfreeSessionLike {
  isOn(): boolean;
  readonly startedVia: StartedVia | null;
  readonly channel: 'telegram' | 'full' | null;
  startPowerOnly(v: StartedVia): Promise<MacStatus>;
  start(o: { vaults: string[]; startedVia?: StartedVia }): Promise<MacStatus>;
  stop(o?: { reason?: string; keyed?: boolean }): Promise<void>;
  onEvent(fn: (e: HandsfreeEvent) => void): () => void;
  status(): { url: string | null };
}

/** Ends the owner caused himself: no line. */
const OWN_ENDS = new Set(['mac', 'telegram', 'back']);

const REASONS: Record<string, string> = {
  mac: "Mac'ten kapatıldı",
  http: 'istekle kapatıldı',
  telegram: "Telegram'dan kapatıldı",
  tunnel: 'telefon bağlantısı koptu',
  binding_lost: 'Telegram bağlantısı kaldırıldı',
  shutdown: 'uygulama kapandı',
  crash: 'uygulama beklenmedik şekilde kapandı',
  failed: 'açılamadı',
};

export const HF_LINES = {
  offer: 'Hands-free nasıl açılsın?',
  macOn: "Hands-free Mac'ten açık, cevaplar Telegram'a gelmiyor; Telegram'a almak için önce Mac'te kapatıp /handsfree yaz.",
  notSetup: "Hands-free için önce Mac'te bir kez kurulum gerekli; Mac'te hands-free ayarlarını aç.",
  telegramOn: "Hands-free açık: Mac kapağı kapalıyken de çalışır, bütün cevaplar buraya gelir.",
  linkOn: (origin: string) => `Hands-free açık, cevaplar buraya da gelir. Telefon linki: ${origin} (şifreni yalnız bu adrese yaz).`,
  newLink: (origin: string) => `Telefon linki değişti: ${origin} (şifreni yalnız bu adrese yaz).`,
  notOn: "Hands-free'yi buradan açmadın; kapatmak için Mac'e bak.",
  ended: (why: string, keyed: boolean) => `Hands-free kapandı: ${why}${keyed ? '' : ' (anahtarsız istek)'}; Mac artık uyuyabilir.`,
  battery: 'Pil düşük; Mac uyuyabilir, işler durabilir.',
  heat: 'Mac çok ısındı; işler yavaşlayabilir.',
  noGrant: "Mac'i uyanık tutamıyorum; izni Mac'te vermen gerekiyor.",
} as const;

export interface HandsfreeAdapterOpts {
}

export function handsfreeAdapter(session: () => HandsfreeSessionLike, opts: HandsfreeAdapterOpts = {}): HubHandsfree & { wire(hub: TelegramHub): () => void } {
  const matches = (v: StartedVia | null | undefined, scope: string, target: string) => !!v && v.scope === scope && v.target === target;
  /** Bindings already told the sleep permission is missing (once per process). */
  const noGrantTold = new Set<string>();
  let arming = false;
  /** The binding whose automatic run is starting right now. */
  let armingKey: BindingKey | null = null;
  /** He came back to the Mac while the run was still starting: end it once it is on. */
  let backWhileArming = false;
  /** The live run is one the hub started by itself (never one started by hand). */
  const autoRun = () => {
    const s = session();
    return s.isOn() && s.channel === 'telegram' && s.startedVia?.auto === true;
  };
  const endAuto = async () => {
    if (autoRun()) await session().stop({ reason: 'back', keyed: true });
  };
  return {
    onBackAtMac() {
      if (arming) { backWhileArming = true; return armingKey; }
      const v = session().startedVia;
      if (!autoRun() || !v) return null;
      void endAuto().catch(() => {});
      return keyOf(v.scope, v.target);
    },

    onPresence(hub: TelegramHub, key: BindingKey, via: 'telegram') {
      const ab = hub.active.get(key);
      if (!ab || ab.target !== 'super' || via !== 'telegram') return;
      const s = session();
      if (s.isOn() || arming) return;
      arming = true;
      armingKey = key;
      backWhileArming = false;
      void s.startPowerOnly({ scope: ab.scope, target: ab.target, auto: true })
        .then(async () => {
          arming = false;
          if (backWhileArming) { backWhileArming = false; await endAuto(); }
        })
        .catch(async (err) => {
          backWhileArming = false;
          const code = (err as { code?: string }).code;
          if ((code === 'mac_not_setup' || code === 'mac_sudo_missing') && !noGrantTold.has(key)) {
            noGrantTold.add(key);
            await hub.notice(ab, 'warn', HF_LINES.noGrant, true);
          }
        })
        .finally(() => { arming = false; });
    },

    streamsTo(scope, target) {
      const s = session();
      return s.isOn() && matches(s.startedVia, scope, target);
    },

    /** Any run on, however it started: the owner is away (`hub.ownerAway`). */
    isOn() {
      return session().isOn();
    },

    async onCommand(hub: TelegramHub, key: BindingKey, update: Record<string, unknown>) {
      const ab = hub.active.get(key);
      const text = String((update.message as { text?: unknown } | undefined)?.text ?? '').trim();
      if (!ab || ab.target !== 'super' || !/^\/handsfree(?:@\w+)?(?:\s|$)/i.test(text)) return false;
      const s = session();
      if (/\bkapat\b/i.test(text)) {
        if (s.isOn() && matches(s.startedVia, ab.scope, ab.target)) await s.stop({ reason: 'telegram', keyed: true });
        else await hub.notice(ab, 'info', HF_LINES.notOn);
        return true;
      }
      if (s.isOn() && !s.startedVia) { await hub.notice(ab, 'phone', HF_LINES.macOn); return true; }
      await hub.sendButtons(ab, HF_LINES.offer, [['Yalnız Telegram'], ['Telegram + telefon linki']], { kind: 'handsfree', singleUse: true });
      return true;
    },

    async onCallback(hub: TelegramHub, key: BindingKey, _rec: ButtonRecord, idx: number) {
      const ab = hub.active.get(key);
      if (!ab) return LINES.stale;
      const s = session();
      if (s.isOn()) return s.startedVia ? 'Hands-free zaten açık.' : HF_LINES.macOn;
      const via: StartedVia = { scope: ab.scope, target: ab.target };
      try {
        if (idx === 0) {
          await s.startPowerOnly(via);
          await hub.notice(ab, 'info', HF_LINES.telegramOn);
          return '✓ Yalnız Telegram';
        }
        if (!ab.projectName) return LINES.stale;
        const st = await s.start({ vaults: [ab.projectName], startedVia: via });
        const origin = st.url ? new URL(st.url).origin : null;
        if (origin) await hub.notice(ab, 'phone', HF_LINES.linkOn(origin));
        return '✓ Telegram + telefon linki';
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'mac_not_setup' || code === 'mac_sudo_missing') { await hub.notice(ab, 'warn', HF_LINES.notSetup, true); return '✗'; }
        if (code === 'mac_already_on') { await hub.notice(ab, 'phone', HF_LINES.macOn); return '✗'; }
        await hub.notice(ab, 'warn', "Hands-free açılamadı; Mac'e bakıp tekrar dene.", true);
        return '✗';
      }
    },

    onBindingLost(scope, target) {
      const s = session();
      if (s.isOn() && matches(s.startedVia, scope, target) && s.channel === 'telegram') void s.stop({ reason: 'binding_lost', keyed: true });
    },

    wire(hub: TelegramHub) {
      return session().onEvent((e) => {
        // A run started (by hand from the Mac panel or the phone link too): he is away now, so
        // every Super question and permission still open goes to its bot, once.
        if (e.type === 'started') { hub.flushAway(); return; }
        if (!e.startedVia) return;
        const ab = hub.active.get(keyOf(e.startedVia.scope, e.startedVia.target));
        if (!ab) return;
        if (e.type === 'ended') {
          // Only an end he did not cause is news (the link dropped, the app quit, it failed to
          // open); closing it himself, or coming back to the Mac, gets no note.
          if (!OWN_ENDS.has(e.reason)) void hub.notice(ab, 'warn', HF_LINES.ended(REASONS[e.reason] ?? e.reason, e.keyed), true);
        }
        else if (e.type === 'batteryFloor') void hub.notice(ab, 'warn', HF_LINES.battery, true);
        else if (e.type === 'heat') void hub.notice(ab, 'warn', HF_LINES.heat, true);
        else if (e.type === 'url') void hub.notice(ab, 'phone', HF_LINES.newLink(e.origin), true);
      });
    },
  };
}
