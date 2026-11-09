/**
 * Run and secret cards over Telegram (plan G2, G3, H3, H6, H7, I3, I5, J1, J4).
 *
 * A run card the Super posts while a Telegram turn of it is in flight (or while Telegram-started
 * hands-free streams) becomes ONE message: the full command as an escaped `<pre>` (what is shown
 * is what runs: the bytes are hashed into the button record), its folder, the agent's `why`
 * labelled as the agent's words, and Çalıştır / Çalıştır, çıktıyı ajana verme / İptal. No
 * Çalıştır when the command holds an invisible or control character, a run of 8+ spaces, or
 * anything the redactor would rewrite: the phone page runs it instead.
 *
 * A tap starts the card's run in the SERVER's run registry (never a string from Telegram), only if
 * the newest record of that card id in that chat is still this cardRef and still open, and the
 * command bytes still hash alike; else "Kart değişti" and the card is sent again. Output: one
 * message edited at most every 2 s with the last ~3500 characters (ANSI stripped, redacted;
 * nothing at all when the owner withheld the output). A separate, never-edited message carries
 * the Ctrl-C button, so the output edits never break that button's integrity check.
 *
 * Input: a REPLY to the output message, plain text, goes to stdin only through the registry's
 * fail-closed rule (`relayLine`: ECHO on, no secret-shaped prompt, no output after the edit it
 * answers). Anything else is refused with the phone link. A secret card becomes "Şifre gerekiyor"
 * with a URL button to the phone page card (bare tunnel origin, sign-in by passphrase), never a
 * field: Telegram never takes a value.
 */
import { createHash } from 'node:crypto';
import { buildAppLink } from '../../lib/app-link.js';
import { getCard, newestCard, onCardsChange, openCards, type CardRecordEntry } from '../../lib/cards/records.js';
import type { RunViewSpec, SecretViewSpec } from '../../lib/chat-view-spec.js';
import { escapeHtml, redactSecrets, wouldRedact } from '../../lib/telegram/format.js';
import type { ButtonRecord } from '../../lib/telegram/contract.js';
import { lastLine, relayLine, runOfSession, SECRET_PROMPT_RE, startRun, type Run } from '../runs/registry.js';
import { setTelegramRunSink } from '../runs/delivery.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

type Obj = Record<string, unknown>;

export const RUN_LINES = {
  ask: '▶️ Bu komut Mac\'te çalıştırılsın mı?',
  shell: 'Bir kabuk komutu olarak, kartın klasöründe çalışır.',
  noButton: "Bu komutta görünmeyen ya da gizlenecek karakterler var; buradan çalıştırılamaz. Telefon sayfasından ya da Mac'ten çalıştır.",
  changed: 'Kart değişti; yenisini gönderiyorum.',
  busy: 'Bu sohbette zaten bir komut çalışıyor.',
  started: (withheld: boolean) => (withheld ? '✓ Çalışıyor (çıktı ajana verilmeyecek)' : '✓ Çalışıyor'),
  cancelled: '✗ İptal edildi',
  running: '⏳ Çalışıyor…',
  hidden: '⏳ Çalışıyor. Çıktı burada gösterilmiyor; telefon sayfasından görebilirsin.',
  stopHint: 'Durdurmak için:',
  stopped: '✓ Ctrl-C gönderildi',
  exited: (code: number | null) => (code === null ? 'Bitti (çıkış kodu yok).' : `Bitti · exit ${code}`),
  refused: "Bu yanıtı komuta yazamam (şifre ya da gizli bir şey istiyor olabilir); telefon linkinden gir.",
  changedOutput: 'Çıktı değişti, tekrar bak.',
  secretPrompt: 'Şifre istiyor: telefon linkinden gir.',
  noPhone: "Telefon linki kapalı; /handsfree yazıp 'Telegram + telefon linki'ni seçersen bu kartın düğmesi çalışır.",
  browser: "Mac'te tarayıcı açıldıysa giriş oradan yapılmalı.",
  secret: (title: string, file: string) => `🔑 Şifre gerekiyor: ${title} → ${file}`,
  secretHere: 'Şifreyi buraya yazma; kartın Şifreyi gir düğmesini kullan.',
} as const;

/** Characters a shown command may not hold (H3, I5): C0/C1, bidi and zero-width, and their kin. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff\u2028\u2029\u3164\u00ad]/;
export function commandShowable(command: string): boolean {
  return !UNSAFE_CHARS.test(command) && !/ {8,}/.test(command) && !wouldRedact(command);
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const OUTPUT_EDIT_MS = 2000;
const OUTPUT_CHARS = 3500;

interface LiveOutput {
  run: Run;
  ab: ActiveBinding;
  messageId: number;
  editedSeq: number;
  lastEditAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  promptNoted: boolean;
  browserNoted: boolean;
  off: Array<() => void>;
}

export interface RunCardsDeps {
  /** The hands-free tunnel origin when the phone link is on (bare, no login token). */
  phoneOrigin: () => string | null;
  /** Streaming is on for this Super binding (Telegram-started hands-free). */
  streams: (ab: ActiveBinding) => boolean;
  now?: () => number;
}

/** The phone page URL that lands on a chat (H9): bare origin + vault + the session link. */
export function phoneCardUrl(origin: string, vault: string, sessionId: string): string | null {
  try {
    const link = buildAppLink({ kind: 'session', vault, claudeId: sessionId });
    const u = new URL(origin);
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    u.searchParams.set('vault', vault);
    u.searchParams.set('open', link);
    return u.toString();
  } catch { return null; }
}

export function wireRunCards(hub: TelegramHub, deps: RunCardsDeps): () => void {
  const announced = new Set<string>();
  /** Chats whose secret card this binding was shown (the reminder reads them). */
  const secretSessions = new Map<string, string>();
  const outputs = new Map<number, LiveOutput>(); // by output message id
  const now = deps.now ?? Date.now;

  const phoneButton = (rec: CardRecordEntry, label: string): Obj | null => {
    const origin = deps.phoneOrigin();
    const url = origin ? phoneCardUrl(origin, rec.vault, rec.sessionId) : null;
    return url ? { reply_markup: { inline_keyboard: [[{ text: label, url }]] } } : null;
  };

  const sendPhoneLink = async (ab: ActiveBinding, rec: CardRecordEntry, line: string, label = 'Telefonda aç'): Promise<void> => {
    const extra = phoneButton(rec, label);
    if (extra) await hub.send(ab, escapeHtml(line), extra).catch(() => {});
    else await hub.notice(ab, 'phone', `${line} ${RUN_LINES.noPhone}`);
  };

  const announceRun = async (ab: ActiveBinding, rec: CardRecordEntry): Promise<void> => {
    const spec = rec.spec as RunViewSpec;
    const parts = [
      `<b>${escapeHtml(RUN_LINES.ask)}</b>`,
      `<pre>${escapeHtml(spec.command)}</pre>`,
      ...(spec.cwd ? [`Klasör: <code>${escapeHtml(spec.cwd)}</code>`] : []),
      escapeHtml(RUN_LINES.shell),
      ...(spec.why ? [`Ajanın notu: ${escapeHtml(redactSecrets(spec.why))}`] : []),
    ];
    if (!commandShowable(spec.command)) {
      await sendPhoneLink(ab, rec, RUN_LINES.noButton, 'Telefonda çalıştır');
      return;
    }
    await hub.sendButtons(ab, parts.join('\n'), [['Çalıştır'], ['Çalıştır, çıktıyı ajana verme'], ['İptal']], {
      kind: 'run', sessionId: rec.sessionId, cardRef: rec.cardRef, singleUse: true,
    }, { cmdHash: sha(spec.command), cardId: rec.id });
  };

  const announceSecret = async (ab: ActiveBinding, rec: CardRecordEntry): Promise<void> => {
    const spec = rec.spec as SecretViewSpec;
    secretSessions.set(rec.sessionId, ab.key);
    await sendPhoneLink(ab, rec, RUN_LINES.secret(spec.title, spec.file), 'Şifreyi gir');
  };

  const onChange = (sessionId: string): void => {
    const ab = hub.bindingOfSession(sessionId);
    if (!ab || ab.disabled || ab.target !== 'super') return;
    if (!hub.hasTelegramTurn(sessionId) && !deps.streams(ab)) return;
    for (const rec of openCards(sessionId)) {
      if (rec.rebuilt || rec.run || announced.has(rec.cardRef)) continue;
      announced.add(rec.cardRef);
      if (announced.size > 500) announced.delete(announced.values().next().value as string);
      void (rec.kind === 'run' ? announceRun(ab, rec) : announceSecret(ab, rec)).catch(() => { /* the Mac card is still there */ });
    }
  };

  const editOutput = async (o: LiveOutput, final: { code: number | null } | null = null): Promise<void> => {
    if (o.timer) { clearTimeout(o.timer); o.timer = null; }
    const seq = o.run.seq();
    const body = o.run.withheld
      ? escapeHtml(final ? RUN_LINES.exited(final.code) : RUN_LINES.hidden)
      : `${final ? `<b>${escapeHtml(RUN_LINES.exited(final.code))}</b>\n` : ''}<pre>${escapeHtml(redactSecrets(o.run.textTail().slice(-OUTPUT_CHARS)) || '…')}</pre>`;
    o.lastEditAt = now();
    await o.ab.transport.editMessageText(o.ab.binding.chatId, o.messageId, body).catch(() => {});
    o.editedSeq = seq;
  };

  const scheduleEdit = (o: LiveOutput): void => {
    if (o.timer) return;
    const wait = Math.max(0, OUTPUT_EDIT_MS - (now() - o.lastEditAt));
    o.timer = setTimeout(() => { o.timer = null; void editOutput(o); }, wait);
    o.timer.unref?.();
  };

  const followRun = async (ab: ActiveBinding, rec: CardRecordEntry, run: Run): Promise<void> => {
    const sent = await hub.send(ab, escapeHtml(run.withheld ? RUN_LINES.hidden : RUN_LINES.running));
    await hub.sendButtons(ab, escapeHtml(RUN_LINES.stopHint), [['Ctrl-C']], { kind: 'run', sessionId: rec.sessionId, cardRef: rec.cardRef, singleUse: false }, { ctrlC: true, runId: run.runId }).catch(() => '');
    const o: LiveOutput = { run, ab, messageId: sent.message_id, editedSeq: run.seq(), lastEditAt: 0, timer: null, promptNoted: false, browserNoted: false, off: [] };
    outputs.set(o.messageId, o);
    o.off.push(run.onOutput(() => {
      if (!run.withheld) scheduleEdit(o);
      const tail = run.textTail();
      if (!o.promptNoted && SECRET_PROMPT_RE.test(lastLine(tail))) {
        o.promptNoted = true;
        void sendPhoneLink(ab, rec, RUN_LINES.secretPrompt, 'Telefonda gir');
      }
      if (!o.browserNoted && /https?:\/\/(?:localhost|127\.0\.0\.1)[:/]/.test(tail)) {
        o.browserNoted = true;
        const t = setTimeout(() => { if (!run.ended()) void hub.notice(ab, 'info', RUN_LINES.browser); }, 5000);
        t.unref?.();
      }
    }));
    o.off.push(run.onExit((_report, code) => {
      for (const f of o.off) f();
      void editOutput(o, { code }).finally(() => { setTimeout(() => outputs.delete(o.messageId), 60_000).unref?.(); });
    }));
  };

  const prevButton = hub.extraButton;
  hub.extraButton = async (ab, rec: ButtonRecord & { data?: Obj }, idx) => {
    if (rec.kind !== 'run') return prevButton ? prevButton(ab, rec, idx) : LINES.stale;
    const sessionId = rec.sessionId ?? '';
    const cardRef = rec.cardRef ?? '';
    if (rec.data?.ctrlC === true) {
      const run = runOfSession(sessionId);
      if (!run || run.cardRef !== cardRef || run.runId !== rec.data.runId || run.ended()) return LINES.stale;
      run.interrupt();
      return RUN_LINES.stopped;
    }
    if (idx === 2) return RUN_LINES.cancelled;
    const live = getCard(sessionId, cardRef);
    const newest = live ? newestCard(sessionId, 'run', live.id) : null;
    const spec = live?.spec as RunViewSpec | undefined;
    if (!live || live.state !== 'open' || newest?.cardRef !== cardRef || !spec || sha(spec.command) !== rec.data?.cmdHash || !commandShowable(spec.command)) {
      const fresh = live ? newestCard(sessionId, 'run', live.id) : null;
      if (fresh && fresh.state === 'open' && fresh.cardRef !== cardRef) void announceRun(ab, fresh).catch(() => {});
      return RUN_LINES.changed;
    }
    const run = startRun(sessionId, cardRef, 'telegram', { withheld: idx === 1 });
    if ('refused' in run) return run.refused === 'busy' ? RUN_LINES.busy : run.refused === 'closed' ? LINES.stale : LINES.waitingOnMac;
    void followRun(ab, live, run).catch(() => { /* the run goes on; its report still arrives */ });
    return RUN_LINES.started(idx === 1);
  };

  const prevHook = hub.messageHook;
  hub.messageHook = async (ab, msg) => {
    if (prevHook && await prevHook(ab, msg)) return true;
    const replyTo = (msg.reply_to_message as Obj | undefined)?.message_id;
    const o = typeof replyTo === 'number' ? outputs.get(replyTo) : undefined;
    if (o && o.ab.key === ab.key && !o.run.ended()) {
      // Only plain text reaches stdin; a voice, photo or document reply is a normal turn (I3).
      if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.startsWith('/')) return false;
      const r = await relayLine(o.run, msg.text, o.editedSeq);
      if (r.ok) return true;
      const rec = getCard(o.run.sessionId, o.run.cardRef);
      if (r.why === 'output_changed') { await editOutput(o); await hub.notice(ab, 'info', RUN_LINES.changedOutput); return true; }
      if (rec) await sendPhoneLink(ab, rec, RUN_LINES.refused, 'Telefonda gir');
      else await hub.notice(ab, 'access', RUN_LINES.refused, true);
      return true;
    }
    // A plain message while a secret card waits: it goes on as a normal turn, never into a
    // file, and the owner is reminded where the value goes (G2).
    if (ab.target === 'super' && typeof msg.text === 'string' && !msg.text.startsWith('/')) {
      for (const [sid, key] of secretSessions) {
        if (key === ab.key && openCards(sid, 'secret').length) { await hub.notice(ab, 'access', RUN_LINES.secretHere, true); break; }
      }
    }
    return false;
  };

  // The report of a Telegram-started run goes back through the hub under a fresh ref (H5, J1).
  setTelegramRunSink({
    async deliverRunReport(sessionId, cardRef, text) {
      const ab = hub.bindingOfSession(sessionId);
      if (!ab || ab.disabled || ab.target !== 'super') return false;
      return (await hub.injectText(ab, hub.syntheticUpdateId(), text, sessionId, { kind: 'run-report', cardRef })) !== false;
    },
  });

  const offCards = onCardsChange(onChange);
  return () => {
    offCards();
    setTelegramRunSink(null);
    hub.extraButton = prevButton;
    hub.messageHook = prevHook;
    for (const o of outputs.values()) { for (const f of o.off) f(); if (o.timer) clearTimeout(o.timer); }
    outputs.clear();
  };
}
