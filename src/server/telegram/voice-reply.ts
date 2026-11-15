/**
 * The owner's spoken summary on Telegram (plan telegram-sesli-ozet, C4): one `dream-voice` block of
 * an answer that is ALREADY going to this binding's chat becomes a voice bubble there.
 *
 *  - Destination: only `ab`, the binding the answer itself goes to. Nothing in the block, the
 *    answer or a request names a chat, a bot or a message id; the reply target is the owner's own
 *    message, found by the caller from its own records.
 *  - One voice in flight per binding: a second waits for the first (spend and order).
 *  - While a secret card waits on him (the same test as `present.ts` `secretPending`), nothing is
 *    spoken: the text goes instead.
 *  - Anything that stops the voice (no key, no ffmpeg, a failed chunk) sends its one line and the
 *    summary as text, so a request for a voice never ends in silence.
 *
 * True when a message landed in the chat (the voice, or its text fallback): the turn counts as
 * answered (`hub.queueSend`).
 *
 * Exposure, stated: a prompt-injected agent reaches only the owner's own chat this way, one voice
 * at a time per binding, one per answer section or member post, with spend capped by the Mac's shared `ttsGate`: the
 * same reach as a text reply. `speakSummary` has no `isDesktop()` gate of its own because its
 * only caller, the hub, starts only in the desktop server; a caller outside the hub needs one.
 */
import { noticeHtml, voiceCaptionHtml, VOICE_SUMMARY_LINES, SILENT } from '../../lib/telegram/system-lines.js';
import type { VoiceBlock } from '../../lib/telegram/voice-block.js';
import { speakSummary, type SpeakSummaryResult } from '../voice-speak.js';
import { getChat } from '../../lib/assistant/chat-registry.js';
import type { ActiveBinding, TelegramHub } from './hub.js';

/** How often "recording a voice" is shown again while the voice is made (Telegram drops it after ~5 s). */
export const RECORDING_EVERY_MS = 4_000;
/** One voice may take this long, all chunks and retries included; past it the text goes instead
 *  (a slow upstream must not hold the Super's send chain for minutes). */
export const VOICE_DEADLINE_MS = 90_000;

const inFlight = new Map<string, Promise<unknown>>();

/** A secret card waits on the owner in this chat (present.ts `secretPending`, read directly:
 *  present.ts imports the hub, which imports this). */
function secretWaits(sessionId: string): boolean {
  return !!getChat(sessionId)?.ownerWaits?.some((w) => w.kind === 'secret');
}

export interface VoiceReplyDeps {
  speak?: (text: string) => Promise<SpeakSummaryResult>;
  recordingEveryMs?: number;
  secretWaits?: (sessionId: string) => boolean;
}

export async function sendVoiceSummary(
  hub: TelegramHub,
  ab: ActiveBinding,
  v: VoiceBlock,
  opts: { replyTo?: number | null; sessionId?: string | null; deps?: VoiceReplyDeps } = {},
): Promise<boolean> {
  const prev = inFlight.get(ab.key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => speakAndSend(hub, ab, v, opts));
  inFlight.set(ab.key, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(ab.key) === run) inFlight.delete(ab.key);
  }
}

async function speakAndSend(
  hub: TelegramHub,
  ab: ActiveBinding,
  v: VoiceBlock,
  opts: { replyTo?: number | null; sessionId?: string | null; deps?: VoiceReplyDeps },
): Promise<boolean> {
  const d = opts.deps ?? {};
  const asText = async (line?: string): Promise<boolean> => {
    if (line) await hub.send(ab, noticeHtml('info', line), SILENT).catch(() => {});
    try {
      await hub.sendMarkdown(ab, v.title ? `**${v.title}**\n${v.text}` : v.text);
      return true;
    } catch {
      return false;
    }
  };
  if (opts.sessionId && (d.secretWaits ?? secretWaits)(opts.sessionId)) return asText();

  const chatId = ab.binding.chatId;
  const recording = (): void => { void ab.transport.sendChatAction(chatId, 'record_voice').catch(() => {}); };
  recording();
  const timer = setInterval(recording, d.recordingEveryMs ?? RECORDING_EVERY_MS);
  timer.unref?.();
  let r: SpeakSummaryResult;
  try {
    r = await (d.speak ?? hub.deps.speakSummary ?? ((t: string) => speakSummary(t, { home: hub.home, signal: AbortSignal.timeout(VOICE_DEADLINE_MS) })))(v.text);
  } catch {
    r = { ok: false, reason: 'failed' };
  } finally {
    clearInterval(timer);
  }
  if (!r.ok) {
    if (r.reason === 'nothing_speakable') return asText();
    return asText(VOICE_SUMMARY_LINES[r.reason]);
  }
  try {
    await ab.transport.sendVoice(chatId, { name: 'ozet.ogg', data: r.ogg, contentType: 'audio/ogg' }, {
      caption: voiceCaptionHtml(v.title),
      duration: Math.max(1, Math.ceil(r.seconds)),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
    return true;
  } catch {
    return asText(VOICE_SUMMARY_LINES.failed);
  }
}
