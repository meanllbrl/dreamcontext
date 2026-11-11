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
 * field: Telegram never takes a value. A checklist or an MCP card (sahip-karti-yerinde K1) is one
 * plain line, "Mac'te yapılır.": no phone link, no secret line.
 *
 * ONLY THE SUPER'S OWN cards are run from here (K4, D3): the Run callback refuses, on the
 * server, a card whose session is not this binding's Super chat, or that a child's owner item
 * stands for. A child's card gets Remind and Not needed instead (asks.ts). A run starts in the
 * card's working folder (K5).
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { buildAppLink } from '../../lib/app-link.js';
import { getCard, newestCard, onCardsChange, openCards, type CardRecordEntry } from '../../lib/cards/records.js';
import type { ChecklistViewSpec, McpViewSpec, RunViewSpec, SecretViewSpec } from '../../lib/chat-view-spec.js';
import { OWNER_CARD_TELEGRAM_LINE } from '../../lib/super/types.js';
import { ownerCardLookup } from '../owner-receipts.js';
import { cardRootOf, pressRoot } from '../routes/run-terminal.js';
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
  checklist: (title: string) => `📋 ${title}`,
  mcp: (names: string) => `🔌 Bağlanacak: ${names}`,
  notHere: "Bu kart buradan çalıştırılamaz; Mac'te çalıştır.",
  noFolder: "Kartın klasörü doğrulanamadı; Mac'ten çalıştır.",
  folderChanged: "Kartın klasörü değişti; hiçbir şey çalışmadı. Mac'te karta yeniden bakıp oradan bas.",
  oldButton: "Bu düğme eski bir sürümden; hiçbir şey çalışmadı. Kartı Mac'te çalıştır.",
} as const;

/** Characters a shown command may not hold (H3, I5): C0/C1, bidi and zero-width, and their kin. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff\u2028\u2029\u3164\u00ad]/;
/**
 * THE rule for "what is shown is what runs" (sahip-karti-yerinde K4), on the server, for every
 * surface: a command holding a character that can draw as something else (UNSAFE_CHARS) or a run
 * of 8+ spaces is never run from a card. The card-ticket mint and every run start ask it
 * (card-actions.ts, run-terminal.ts `runFor`); Telegram adds its own redaction rule below.
 * Mirrored for drawing in dashboard/src/lib/unsafeChars.ts (drift test there).
 */
export function commandShowableAsIs(command: string): boolean {
  return !UNSAFE_CHARS.test(command) && !/ {8,}/.test(command);
}

/** Telegram may offer Çalıştır: shown as is, and nothing in it the redactor would rewrite. */
export function commandShowable(command: string): boolean {
  return commandShowableAsIs(command) && !wouldRedact(command);
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
    // Loud: the agent waits on him here. The line's own leading emoji is dropped (the notice adds one).
    else await hub.notice(ab, 'phone', `${line.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '')} ${RUN_LINES.noPhone}`, true);
  };

  /** Cards told once that their folder could not be proven (a retry announces it later). */
  const noFolderNoted = new Set<string>();

  /** False when the card's folder could not be proven now: nothing with a Run was sent, so a
   *  later change may announce it again (the caller lets go of its `announced` mark). */
  const announceRun = async (ab: ActiveBinding, rec: CardRecordEntry): Promise<boolean> => {
    const spec = rec.spec as RunViewSpec;
    // The folder it runs in, as the Mac draws it (the slot, the bar): the card root's name, then
    // ` · <cwd>` when the card has one. A root that cannot be proven gets no Run here.
    const root = await cardRootOf(rec);
    if (!root) {
      if (!noFolderNoted.has(rec.cardRef)) {
        noFolderNoted.add(rec.cardRef);
        // Same cap as `announced`: the mark set never grows past it.
        if (noFolderNoted.size > 500) noFolderNoted.delete(noFolderNoted.values().next().value as string);
        await hub.notice(ab, 'info', RUN_LINES.noFolder, true);
      }
      return false;
    }
    // Its folder was read: a later failure to read it speaks again.
    noFolderNoted.delete(rec.cardRef);
    const folder = `${basename(root)}${spec.cwd ? ` · ${spec.cwd}` : ''}`;
    const parts = [
      `<b>${escapeHtml(RUN_LINES.ask)}</b>`,
      `<pre>${escapeHtml(spec.command)}</pre>`,
      `Klasör: <code>${escapeHtml(folder)}</code>`,
      escapeHtml(RUN_LINES.shell),
      ...(spec.why ? [`Ajanın notu: ${escapeHtml(redactSecrets(spec.why))}`] : []),
    ];
    if (!commandShowable(spec.command)) {
      await sendPhoneLink(ab, rec, RUN_LINES.noButton, 'Telefonda çalıştır');
      return true;
    }
    // The button keeps the folder this message DREW: the press runs there or nowhere (`pressRoot`).
    await hub.sendButtons(ab, parts.join('\n'), [['Çalıştır'], ['Çalıştır, çıktıyı ajana verme'], ['İptal']], {
      kind: 'run', sessionId: rec.sessionId, cardRef: rec.cardRef, singleUse: true,
    }, { cmdHash: sha(spec.command), cardId: rec.id, root });
    return true;
  };

  const announceSecret = async (ab: ActiveBinding, rec: CardRecordEntry): Promise<void> => {
    const spec = rec.spec as SecretViewSpec;
    secretSessions.set(rec.sessionId, ab.key);
    await sendPhoneLink(ab, rec, RUN_LINES.secret(spec.title, spec.file), 'Şifreyi gir');
  };

  /** A checklist or an MCP card: one plain line, done on the Mac (no phone link, no value). */
  const announceMacOnly = async (ab: ActiveBinding, rec: CardRecordEntry): Promise<void> => {
    const head = rec.kind === 'checklist'
      ? RUN_LINES.checklist((rec.spec as ChecklistViewSpec).title)
      : RUN_LINES.mcp((rec.spec as McpViewSpec).servers.join(', '));
    const line = rec.kind === 'checklist' ? OWNER_CARD_TELEGRAM_LINE.checklist : OWNER_CARD_TELEGRAM_LINE.mcp;
    await hub.send(ab, `${escapeHtml(redactSecrets(head))}\n${escapeHtml(line)}`);
  };

  /** Each of the four kinds by name (sahip-karti-yerinde K1): a new kind is a compile error here. */
  /** True once the card was announced for good (false: try again on a later change). */
  const announce = async (ab: ActiveBinding, rec: CardRecordEntry): Promise<boolean> => {
    switch (rec.kind) {
      case 'run': return announceRun(ab, rec);
      case 'secret': await announceSecret(ab, rec); return true;
      case 'checklist':
      case 'mcp': await announceMacOnly(ab, rec); return true;
      default: { const never: never = rec.kind; void never; return true; }
    }
  };

  const onChange = (sessionId: string): void => {
    const ab = hub.bindingOfSession(sessionId);
    if (!ab || ab.disabled || ab.target !== 'super') return;
    if (!hub.hasTelegramTurn(sessionId) && !deps.streams(ab)) return;
    for (const rec of openCards(sessionId)) {
      if (rec.rebuilt || rec.run || announced.has(rec.cardRef)) continue;
      // Marked before the await (two changes never announce one card twice), let go when its
      // folder could not be proven yet, so a later change retries (a single git failure is no
      // card left without its Run for ever).
      announced.add(rec.cardRef);
      if (announced.size > 500) announced.delete(announced.values().next().value as string);
      void announce(ab, rec)
        .then((done) => { if (!done) announced.delete(rec.cardRef); })
        .catch(() => { announced.delete(rec.cardRef); /* the Mac card is still there */ });
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
        const t = setTimeout(() => { if (!run.ended()) void hub.notice(ab, 'info', RUN_LINES.browser, true); }, 5000);
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
    // G1 (K4): Run only for the SUPER's OWN card, through this very binding; never a child's card
    // (an owner item stands for it), whatever button record names it.
    const own = hub.bindingOfSession(sessionId);
    if (!own || own.key !== ab.key || ab.target !== 'super' || ownerCardLookup(sessionId, cardRef)) return RUN_LINES.notHere;
    const live = getCard(sessionId, cardRef);
    const newest = live ? newestCard(sessionId, 'run', live.id) : null;
    const spec = live?.spec as RunViewSpec | undefined;
    if (!live || live.state !== 'open' || newest?.cardRef !== cardRef || !spec || sha(spec.command) !== rec.data?.cmdHash || !commandShowable(spec.command)) {
      const fresh = live ? newestCard(sessionId, 'run', live.id) : null;
      if (fresh && fresh.state === 'open' && fresh.cardRef !== cardRef) void announceRun(ab, fresh).catch(() => {});
      return RUN_LINES.changed;
    }
    // The folder this message drew is the folder now, or nothing runs (end review r2).
    // A button from before this release drew no folder: say so plainly, never "folder changed".
    if (typeof rec.data?.root !== 'string' || !rec.data.root) return RUN_LINES.oldButton;
    const press = await pressRoot(live, rec.data.root);
    if (!press.ok) return press.why === 'no_folder' ? RUN_LINES.noFolder : RUN_LINES.folderChanged;
    const run = startRun(sessionId, cardRef, 'telegram', { withheld: idx === 1, root: press.root });
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
