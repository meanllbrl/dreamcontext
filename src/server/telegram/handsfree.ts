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
 *    nothing is on; it ends by itself when he is back at the Mac: he writes to the Super there,
 *    or the Mac sees real keyboard or mouse input after it started (HIDIdleTime drops). A run
 *    he started by the button or the link mode is never ended this way.
 * Only the hub (after an authorized tap or message) starts hands-free with `startedVia`; no CLI
 * or HTTP path.
 */
import { execFile } from 'node:child_process';
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

const REASONS: Record<string, string> = {
  mac: "Mac'ten kapatıldı",
  http: 'istekle kapatıldı',
  telegram: "Telegram'dan kapatıldı",
  tunnel: 'telefon bağlantısı koptu',
  binding_lost: 'Telegram bağlantısı kaldırıldı',
  shutdown: 'uygulama kapandı',
  crash: 'uygulama beklenmedik şekilde kapandı',
  failed: 'açılamadı',
  back: "Mac'e döndün",
};

export const HF_LINES = {
  offer: 'Hands-free nasıl açılsın?',
  macOn: "Hands-free zaten Mac'ten açık; Telegram'a akış için önce Mac'ten kapat.",
  notSetup: "Önce Mac'te bir kez hands-free kurulumu gerekli.",
  telegramOn: "Hands-free açık (yalnız Telegram). Mac kapağı kapalıyken de çalışır; bütün cevaplar buraya gelir.",
  linkOn: (origin: string) => `🔐 Mac'in kendi bağlantısı: ${origin}\nŞifreni yalnız bu adrese yaz. Hands-free açık; bütün cevaplar buraya da gelir.`,
  newLink: (origin: string) => `🔐 Mac'in kendi bağlantısı değişti: ${origin}\nŞifreni yalnız bu adrese yaz.`,
  notOn: "Hands-free'yi buradan açmadın; kapatmak için Mac'e bak.",
  ended: (why: string, keyed: boolean) => `Hands-free kapandı: ${why}${keyed ? '' : ' (anahtarsız istek)'}. Mac uyuyabilir.`,
  battery: 'Pil düşük, Mac uyuyabilir.',
  heat: 'Mac çok ısındı; işler yavaşlayabilir.',
  noGrant: "Mac'i uyanık tutamıyorum: izin Mac'te verilmeli",
  back: "Mac'e döndün, Mac normal uykusuna döndü",
} as const;

/** How often an auto run checks for local input on the Mac. */
export const HID_POLL_MS = 15_000;
/** Input this close to the start is the start itself (a click that sent nothing), never a return. */
const HID_MARGIN_MS = 2_000;

/** Milliseconds since the last keyboard or mouse input on this Mac (`ioreg` HIDIdleTime, ns), or
 *  null when it cannot be read (then nothing ends by itself on input). */
export function readHidIdleMs(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) { resolve(null); return; }
      const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(out));
      resolve(m ? Number(m[1]) / 1e6 : null);
    });
  });
}

export interface HandsfreeAdapterOpts {
  readHidIdleMs?: () => Promise<number | null>;
  hidPollMs?: number;
  now?: () => number;
}

export function handsfreeAdapter(session: () => HandsfreeSessionLike, opts: HandsfreeAdapterOpts = {}): HubHandsfree & { wire(hub: TelegramHub): () => void } {
  const matches = (v: StartedVia | null | undefined, scope: string, target: string) => !!v && v.scope === scope && v.target === target;
  const now = opts.now ?? Date.now;
  const readIdle = opts.readHidIdleMs ?? readHidIdleMs;
  /** Bindings already told the sleep permission is missing (once per process). */
  const noGrantTold = new Set<string>();
  let arming = false;
  let watch: ReturnType<typeof setInterval> | null = null;
  const unwatch = () => { if (watch) clearInterval(watch); watch = null; };
  /** The live run is one the hub started by itself for this binding. */
  const autoRun = (scope: string, target: string) => {
    const s = session();
    return s.isOn() && s.channel === 'telegram' && s.startedVia?.auto === true && matches(s.startedVia, scope, target);
  };
  const backAtMac = async (scope: string, target: string) => {
    unwatch();
    if (autoRun(scope, target)) await session().stop({ reason: 'back', keyed: true });
  };
  /** While an auto run is on: real input on the Mac after it started ends it. */
  const watchInput = (scope: string, target: string) => {
    unwatch();
    const startedAt = now();
    let busy = false;
    watch = setInterval(() => {
      if (busy) return;
      if (!autoRun(scope, target)) { unwatch(); return; }
      busy = true;
      void readIdle().then(async (idle) => {
        if (idle !== null && idle + HID_MARGIN_MS < now() - startedAt) await backAtMac(scope, target);
      }).catch(() => {}).finally(() => { busy = false; });
    }, opts.hidPollMs ?? HID_POLL_MS);
    watch.unref?.();
  };
  return {
    onPresence(hub: TelegramHub, key: BindingKey, via: 'telegram' | 'mac') {
      const ab = hub.active.get(key);
      if (!ab || ab.target !== 'super') return;
      if (via === 'mac') { void backAtMac(ab.scope, ab.target).catch(() => {}); return; }
      const s = session();
      if (s.isOn() || arming) return;
      arming = true;
      void s.startPowerOnly({ scope: ab.scope, target: ab.target, auto: true })
        .then(() => watchInput(ab.scope, ab.target))
        .catch(async (err) => {
          const code = (err as { code?: string }).code;
          if ((code === 'mac_not_setup' || code === 'mac_sudo_missing') && !noGrantTold.has(key)) {
            noGrantTold.add(key);
            await hub.reply(ab, HF_LINES.noGrant).catch(() => {});
          }
        })
        .finally(() => { arming = false; });
    },

    streamsTo(scope, target) {
      const s = session();
      return s.isOn() && matches(s.startedVia, scope, target);
    },

    async onCommand(hub: TelegramHub, key: BindingKey, update: Record<string, unknown>) {
      const ab = hub.active.get(key);
      const text = String((update.message as { text?: unknown } | undefined)?.text ?? '').trim();
      if (!ab || ab.target !== 'super' || !/^\/handsfree(?:@\w+)?(?:\s|$)/i.test(text)) return false;
      const s = session();
      if (/\bkapat\b/i.test(text)) {
        if (s.isOn() && matches(s.startedVia, ab.scope, ab.target)) await s.stop({ reason: 'telegram', keyed: true });
        else await hub.reply(ab, HF_LINES.notOn);
        return true;
      }
      if (s.isOn() && !s.startedVia) { await hub.reply(ab, HF_LINES.macOn); return true; }
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
          await hub.reply(ab, HF_LINES.telegramOn);
          return '✓ Yalnız Telegram';
        }
        if (!ab.projectName) return LINES.stale;
        const st = await s.start({ vaults: [ab.projectName], startedVia: via });
        const origin = st.url ? new URL(st.url).origin : null;
        if (origin) await hub.reply(ab, HF_LINES.linkOn(origin));
        return '✓ Telegram + telefon linki';
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'mac_not_setup' || code === 'mac_sudo_missing') { await hub.reply(ab, HF_LINES.notSetup); return '✗'; }
        if (code === 'mac_already_on') { await hub.reply(ab, HF_LINES.macOn); return '✗'; }
        await hub.reply(ab, "Hands-free açılamadı; Mac'e bak.");
        return '✗';
      }
    },

    onBindingLost(scope, target) {
      const s = session();
      if (s.isOn() && matches(s.startedVia, scope, target) && s.channel === 'telegram') void s.stop({ reason: 'binding_lost', keyed: true });
    },

    wire(hub: TelegramHub) {
      return session().onEvent((e) => {
        if (!e.startedVia) return;
        const ab = hub.active.get(keyOf(e.startedVia.scope, e.startedVia.target));
        if (!ab) return;
        if (e.type === 'ended') {
          if (e.startedVia.auto) unwatch();
          void hub.reply(ab, e.reason === 'back' ? HF_LINES.back : HF_LINES.ended(REASONS[e.reason] ?? e.reason, e.keyed || e.reason === 'mac'));
        }
        else if (e.type === 'batteryFloor') void hub.reply(ab, HF_LINES.battery);
        else if (e.type === 'heat') void hub.reply(ab, HF_LINES.heat);
        else if (e.type === 'url') void hub.reply(ab, HF_LINES.newLink(e.origin));
      });
    },
  };
}
